import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  PlacementKind, SharedServerKey, SharedSessionDefinition, SharedWorkerLimits, sharedHarnessLimits,
  type CapabilityIntrospection, type SharedSessionView,
} from "@copilot-agent/contracts";
import type { SessionFileLease } from "./session-files.js";
import { StoreError } from "./store.js";

export interface SharedSessionRecord {
  id: string;
  principal: string;
  githubUserId: number;
  /** Where the session's loop runs. The shared worker activates and authorizes only `shared` sessions. */
  placement: PlacementKind;
  definition: SharedSessionDefinition;
  view: SharedSessionView;
}
export interface SharedTurn {
  id: string;
  sessionId: string;
  state: "queued" | "running" | "finished" | "interrupted";
  tokenBudget: number;
  deadline?: string;
}
interface SessionRow {
  id: string; principal: string; github_user_id: string; label: string;
  definition: SharedSessionDefinition; closed: boolean; online?: boolean;
  tokens_used: string; tokens_reserved: string; jobs: number; continuations: number;
  placement: string; placement_generation: number;
  created_at: Date; last_activity_at: Date;
  /** The current segment's runtime session and start, when a promotion or handoff started it. */
  segment_ahp_session_id?: string | null; segment_started_at?: Date | null;
}
interface TurnRow {
  id: string; session_id: string; principal: string; epoch: string; state: SharedTurn["state"];
  token_budget: number; tokens_used: string; deadline: Date | null; settled: boolean;
}
const SHARED_ADMISSION_LOCK = 7_310_442_002;
/** The current segment's runtime session and start; generation 1 is implicit in the session row. */
export const CURRENT_SEGMENT_COLUMNS = `g.ahp_session_id AS segment_ahp_session_id, g.started_at AS segment_started_at`;
export const CURRENT_SEGMENT_JOIN = `LEFT JOIN session_segments g ON g.session_id=s.id AND g.generation=s.placement_generation`;
const SESSION_SELECT = `SELECT s.*, EXISTS (
  SELECT 1 FROM shared_activations a JOIN session_file_namespaces n ON n.id=a.session_id AND n.epoch=a.epoch
  WHERE a.session_id=s.id AND n.principal=s.principal AND n.lease_until>clock_timestamp()
) AS online, ${CURRENT_SEGMENT_COLUMNS} FROM shared_sessions s ${CURRENT_SEGMENT_JOIN}`;

/** Durable admission authority. The bounded prototype serializes shared-ledger mutations, never network I/O. */
export class SharedStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(principal: string, githubUserId: number, label: string, definition: SharedSessionDefinition, maximum: number): Promise<SharedSessionRecord> {
    const snapshot = SharedSessionDefinition.parse(definition);
    if (!principal || !Number.isSafeInteger(githubUserId) || githubUserId < 1 || label.length > 120
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) throw new StoreError("invalid_request", "Invalid shared session admission.");
    return this.transaction(async (db) => {
      await this.checkIdentity(principal, githubUserId, db);
      const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM shared_sessions WHERE principal=$1", [principal]);
      if (count.rows[0]!.count >= maximum) throw new StoreError("quota_exceeded", "The retained conversation limit is exhausted.");
      const rows = await db.query<SessionRow>(
        "INSERT INTO shared_sessions(id,principal,github_user_id,label,definition) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [randomUUID(), principal, githubUserId, label, JSON.stringify(snapshot)]);
      return record(rows.rows[0]!);
    });
  }

  async checkIdentity(principal: string, githubUserId: number, db: pg.Pool | pg.PoolClient = this.pool): Promise<void> {
    const conflict = await db.query("SELECT 1 FROM shared_sessions WHERE principal=$1 AND github_user_id<>$2 LIMIT 1", [principal, githubUserId]);
    if (conflict.rowCount) throw new StoreError("invalid_state", "A retained principal cannot be rebound to a different GitHub account.");
  }

  async get(principal: string, id: string): Promise<SharedSessionRecord | undefined> {
    const row = (await this.pool.query<SessionRow>(`${SESSION_SELECT} WHERE s.id=$1 AND s.principal=$2`, [id, principal])).rows[0];
    return row ? record(row) : undefined;
  }

  async list(principal: string, limit = 100): Promise<SharedSessionView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError("invalid_request", "Invalid session page size.");
    return (await this.pool.query<SessionRow>(`${SESSION_SELECT} WHERE s.principal=$1 ORDER BY s.created_at DESC LIMIT $2`, [principal, limit]))
      .rows.map((row) => record(row).view);
  }

  async close(principal: string, id: string, cancelChildren: boolean): Promise<boolean> {
    return this.transaction(async (db) => {
      const result = await db.query("UPDATE shared_sessions SET closed=true,cancel_children=cancel_children OR $3 WHERE id=$1 AND principal=$2", [id, principal, cancelChildren]);
      await db.query("DELETE FROM shared_connection_tickets WHERE session_id=$1 AND principal=$2", [id, principal]);
      return result.rowCount === 1;
    });
  }

  async publish(lease: SessionFileLease, serverKey: SharedServerKey): Promise<void> {
    await this.transaction(async (db) => {
      await this.authorize(db, lease);
      await db.query(
        `INSERT INTO shared_activations(session_id,epoch,server_key) VALUES($1,$2,$3)
         ON CONFLICT(session_id) DO UPDATE SET epoch=EXCLUDED.epoch,server_key=EXCLUDED.server_key,published_at=clock_timestamp()`,
        [lease.id, lease.epoch, JSON.stringify(SharedServerKey.parse(serverKey))]);
    });
  }

  async issueTicket(principal: string, id: string): Promise<{ token: string; expiresAt: string; serverKey: SharedServerKey }> {
    return this.transaction(async (db) => {
      await db.query("DELETE FROM shared_connection_tickets WHERE expires_at<clock_timestamp()");
      const row = (await db.query<{ epoch: string; server_key: SharedServerKey; placement_generation: number }>(
        `SELECT a.epoch,a.server_key,s.placement_generation FROM shared_sessions s JOIN shared_activations a ON a.session_id=s.id
         JOIN session_file_namespaces n ON n.id=s.id AND n.epoch=a.epoch AND n.principal=s.principal
         WHERE s.id=$1 AND s.principal=$2 AND NOT s.closed AND s.placement='shared' AND n.lease_until>clock_timestamp()`, [id, principal])).rows[0];
      if (!row) throw new StoreError("not_found", "The shared conversation is unavailable.");
      const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM shared_connection_tickets WHERE session_id=$1 AND used_at IS NULL", [id]);
      if (count.rows[0]!.count >= 16) throw new StoreError("quota_exceeded", "Too many outstanding connection tickets.");
      const token = randomBytes(32).toString("base64url");
      const inserted = await db.query<{ expires_at: Date }>(
        `INSERT INTO shared_connection_tickets(digest,session_id,principal,epoch,placement_generation,expires_at)
         VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds') RETURNING expires_at`,
        [digest(token), id, principal, row.epoch, row.placement_generation]);
      return { token, expiresAt: inserted.rows[0]!.expires_at.toISOString(), serverKey: SharedServerKey.parse(row.server_key) };
    });
  }

  async enqueueTurn(lease: SessionFileLease, operationKey: string, source: "user" | "completion" | "handoff", limits: SharedWorkerLimits): Promise<SharedTurn> {
    SharedWorkerLimits.parse(limits);
    if (!operationKey || operationKey.length > 200) throw new StoreError("invalid_request", "Invalid turn operation key.");
    return this.transaction(async (db) => {
      const session = await this.authorize(db, lease);
      const existing = (await db.query<TurnRow>("SELECT * FROM shared_turns WHERE session_id=$1 AND operation_key=$2", [lease.id, operationKey])).rows[0];
      if (existing) return turn(existing);
      const moving = await db.query("SELECT 1 FROM session_handoffs WHERE session_id=$1 AND state='accepted'", [lease.id]);
      if (moving.rowCount) throw new StoreError("invalid_state", "The conversation is being handed off to another harness; it admits no new turns until the move completes.");
      const harness = session.definition.harness?.name;
      const counts = await db.query<{ queued: number; own: number; harness: number }>(
        `SELECT count(*) FILTER(WHERE t.state='queued')::int AS queued,
          count(*) FILTER(WHERE t.session_id=$1 AND t.state IN ('queued','running'))::int AS own,
          count(*) FILTER(WHERE t.state='queued' AND s.definition->'harness'->>'name'=$2)::int AS harness
         FROM shared_turns t JOIN shared_sessions s ON s.id=t.session_id`, [lease.id, harness ?? null]);
      if (counts.rows[0]!.own || counts.rows[0]!.queued >= limits.queuedTurns) throw new StoreError("quota_exceeded", "The shared turn queue is full or this conversation already has work.");
      if (harness && counts.rows[0]!.harness >= sharedHarnessLimits(limits, harness).queuedTurns) {
        throw new StoreError("quota_exceeded", "The shared turn queue is full for this harness.");
      }
      if (source === "completion" && session.continuations >= session.definition.limits.maxContinuations) {
        throw new StoreError("quota_exceeded", "The conversation continuation limit is exhausted.");
      }
      const rows = await db.query<TurnRow>(
        "INSERT INTO shared_turns(id,session_id,principal,epoch,operation_key,source,state) VALUES($1,$2,$3,$4,$5,$6,'queued') RETURNING *",
        [randomUUID(), lease.id, lease.principal, lease.epoch, operationKey, source]);
      return turn(rows.rows[0]!);
    });
  }

  async startTurn(lease: SessionFileLease, id: string, limits: SharedWorkerLimits): Promise<SharedTurn | undefined> {
    SharedWorkerLimits.parse(limits);
    return this.transaction(async (db) => {
      const session = await this.authorize(db, lease);
      const current = (await db.query<TurnRow>("SELECT * FROM shared_turns WHERE id=$1 AND session_id=$2 AND epoch=$3", [id, lease.id, lease.epoch])).rows[0];
      if (!current || (current.state !== "queued" && current.state !== "running")) throw new StoreError("invalid_state", "The turn is no longer available.");
      if (current.state === "running") return turn(current);
      const running = await db.query<{ harness: string | null; count: number }>(
        `SELECT s.definition->'harness'->>'name' AS harness,count(*)::int AS count
         FROM shared_turns r JOIN shared_sessions s ON s.id=r.session_id WHERE r.state='running' GROUP BY 1`);
      if (running.rows.reduce((sum, row) => sum + row.count, 0) >= limits.activeTurns) return undefined;
      // Harnesses at their own active-turn ceiling are skipped, so their queued turns cannot block other harnesses.
      const full = running.rows.flatMap((row) => row.harness && row.count >= sharedHarnessLimits(limits, row.harness).activeTurns ? [row.harness] : []);
      const next = await db.query<{ id: string }>(
        `SELECT t.id FROM shared_turns t JOIN shared_sessions s ON s.id=t.session_id
         JOIN session_file_namespaces n ON n.id=t.session_id AND n.epoch=t.epoch AND n.principal=t.principal
         WHERE t.state='queued' AND NOT s.closed AND n.lease_until>clock_timestamp()
           AND (SELECT count(*) FROM shared_turns r WHERE r.principal=t.principal AND r.state='running') < $1
           AND COALESCE(s.definition->'harness'->>'name','') <> ALL($2::text[])
         ORDER BY t.created_at,t.id LIMIT 1`, [limits.activeTurnsPerPrincipal, full]);
      if (next.rows[0]?.id !== id) return undefined;
      const remaining = session.definition.limits.tokenBudget - Number(session.tokens_used) - Number(session.tokens_reserved);
      if (remaining <= 0) throw new StoreError("quota_exceeded", "The aggregate conversation budget is exhausted.");
      const budget = Math.min(remaining, session.definition.limits.turnTokenBudget);
      const rows = await db.query<TurnRow>(
        `UPDATE shared_turns SET state='running',token_budget=$2,started_at=clock_timestamp(),
         deadline=clock_timestamp()+$3*interval '1 second' WHERE id=$1 RETURNING *`,
        [id, budget, session.definition.limits.maxTurnSeconds]);
      await db.query(
        `UPDATE shared_sessions SET tokens_reserved=tokens_reserved+$2,last_activity_at=clock_timestamp(),
         continuations=continuations+(SELECT CASE WHEN source='completion' THEN 1 ELSE 0 END FROM shared_turns WHERE id=$3) WHERE id=$1`,
        [lease.id, budget, id]);
      return turn(rows.rows[0]!);
    });
  }

  async finishTurn(lease: SessionFileLease, id: string, interrupted = false): Promise<void> {
    await this.transaction(async (db) => {
      const own = await db.query("SELECT id FROM shared_turns WHERE id=$1 AND session_id=$2 AND epoch=$3 AND principal=$4",
        [id, lease.id, lease.epoch, lease.principal]);
      if (!own.rowCount) throw new StoreError("not_found", "The turn does not belong to this activation.");
      await db.query(
        `UPDATE shared_turns SET state=$4,finished_at=clock_timestamp() WHERE id=$1 AND session_id=$2 AND epoch=$3 AND state IN ('queued','running')`,
        [id, lease.id, lease.epoch, interrupted ? "interrupted" : "finished"]);
      await this.settleTurn(db, id);
    });
  }

  async introspect(id: string, db: pg.Pool | pg.PoolClient = this.pool, allowedModels?: readonly string[]): Promise<CapabilityIntrospection> {
    const row = (await db.query<{ valid: boolean; remaining: string; model: string }>(
      `SELECT (t.state='running' AND t.deadline>clock_timestamp() AND NOT s.closed
        AND n.epoch=t.epoch AND n.principal=t.principal AND n.lease_until>clock_timestamp()
        AND s.tokens_used+s.tokens_reserved <= (s.definition->'limits'->>'tokenBudget')::bigint) AS valid,
        (t.token_budget-t.tokens_used)::text AS remaining,s.definition->>'model' AS model
       FROM shared_turns t JOIN shared_sessions s ON s.id=t.session_id LEFT JOIN session_file_namespaces n ON n.id=t.session_id
       WHERE t.id=$1`, [id])).rows[0];
    if (!row) return { active: false, reason: "unknown", remainingTokens: 0 };
    if (allowedModels && !allowedModels.includes(row.model)) row.valid = false;
    const remainingTokens = Math.max(0, Number(row.remaining));
    return { active: row.valid && remainingTokens > 0, remainingTokens,
      ...(!row.valid ? { reason: "revoked" as const } : !remainingTokens ? { reason: "budget_exhausted" as const } : {}),
      reservationRequired: true };
  }

  async beginInference(id: string, requestId: string, allowedModels?: readonly string[]): Promise<number> {
    return this.transaction(async (db) => {
      await db.query(
        `SELECT n.id FROM session_file_namespaces n JOIN shared_turns t ON t.session_id=n.id
         WHERE t.id=$1 AND n.epoch=t.epoch AND n.principal=t.principal AND n.lease_until>clock_timestamp() FOR SHARE OF n`, [id]);
      const status = await this.introspect(id, db, allowedModels);
      if (!status.active) throw new StoreError("invalid_state", "The conversation inference grant is inactive.");
      const pending = await db.query("SELECT 1 FROM shared_inference_requests WHERE turn_id=$1 AND state='pending'", [id]);
      if (pending.rowCount) throw new StoreError("quota_exceeded", "This conversation already has an inference request in flight.");
      const inserted = await db.query(
        "INSERT INTO shared_inference_requests(request_id,turn_id,reserved_tokens,state) VALUES($1,$2,$3,'pending') ON CONFLICT DO NOTHING",
        [requestId, id, status.remainingTokens]);
      if (!inserted.rowCount) throw new StoreError("idempotency_conflict", "The inference request identity was already used.");
      return status.remainingTokens;
    });
  }

  async grant(lease: SessionFileLease, id: string): Promise<{ model: string; tokenBudget: number; expiresAt: Date }> {
    return this.transaction(async (db) => {
      const session = await this.authorize(db, lease);
      const row = (await db.query<TurnRow>(
        `SELECT * FROM shared_turns WHERE id=$1 AND session_id=$2 AND epoch=$3 AND principal=$4
         AND state='running' AND deadline>clock_timestamp()`, [id, lease.id, lease.epoch, lease.principal])).rows[0];
      if (!row) throw new StoreError("invalid_state", "The conversation turn is not running.");
      const tokenBudget = Math.max(0, row.token_budget - Number(row.tokens_used));
      if (!tokenBudget) throw new StoreError("quota_exceeded", "The conversation turn budget is exhausted.");
      return { model: session.definition.model, tokenBudget, expiresAt: row.deadline! };
    });
  }

  async recordUsage(id: string, requestId: string, input: number, output: number, known: boolean): Promise<boolean> {
    if (![input, output].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)) {
      throw new StoreError("invalid_request", "Invalid inference usage.");
    }
    return this.transaction(async (db) => {
      const row = (await db.query<{ reserved_tokens: number; state: string; input_tokens: string; output_tokens: string; charged_tokens: string }>(
        "SELECT * FROM shared_inference_requests WHERE request_id=$1 AND turn_id=$2", [requestId, id])).rows[0];
      if (!row) return false;
      if (row.state === "completed") {
        if (!known || Number(row.input_tokens) !== input || Number(row.output_tokens) !== output) {
          throw new StoreError("idempotency_conflict", "The usage report differs from its recorded value.");
        }
        return true;
      }
      const charged = Math.max(Number(row.charged_tokens), known ? input + output : row.reserved_tokens);
      const additional = charged - Number(row.charged_tokens);
      await db.query(
        "UPDATE shared_inference_requests SET state=$2,input_tokens=$3,output_tokens=$4,charged_tokens=$5,finished_at=clock_timestamp() WHERE request_id=$1",
        [requestId, known ? "completed" : "unknown", input, output, charged]);
      const updated = await db.query<TurnRow>("UPDATE shared_turns SET tokens_used=tokens_used+$2 WHERE id=$1 RETURNING *", [id, additional]);
      if (updated.rows[0]!.settled) {
        await db.query("UPDATE shared_sessions SET tokens_used=tokens_used+$2 WHERE id=$1", [updated.rows[0]!.session_id, additional]);
      }
      await this.settleTurn(db, id);
      return true;
    });
  }

  async recover(): Promise<SessionFileLease[]> {
    return this.transaction(async (db) => {
      const stale = await db.query<TurnRow>(
        `UPDATE shared_turns t SET state='interrupted',finished_at=clock_timestamp()
         FROM shared_sessions s WHERE s.id=t.session_id AND t.state IN ('queued','running')
           AND (s.closed OR t.deadline<=clock_timestamp() OR NOT EXISTS (
             SELECT 1 FROM session_file_namespaces n WHERE n.id=t.session_id AND n.principal=t.principal
               AND n.epoch=t.epoch AND n.lease_until>clock_timestamp()))
         RETURNING t.*`);
      const unfinished = await db.query<TurnRow>(
        `SELECT * FROM shared_turns t WHERE NOT settled AND state IN ('finished','interrupted')
         AND (deadline<=clock_timestamp() OR NOT EXISTS (
           SELECT 1 FROM session_file_namespaces n WHERE n.id=t.session_id AND n.epoch=t.epoch AND n.lease_until>clock_timestamp()))`);
      for (const row of [...stale.rows, ...unfinished.rows]) {
        const pending = await db.query<{ reserved_tokens: number }>(
          "UPDATE shared_inference_requests SET state='unknown',charged_tokens=reserved_tokens,finished_at=clock_timestamp() WHERE turn_id=$1 AND state='pending' RETURNING reserved_tokens", [row.id]);
        const charge = pending.rows.reduce((sum, request) => sum + request.reserved_tokens, 0);
        if (charge) await db.query("UPDATE shared_turns SET tokens_used=tokens_used+$2 WHERE id=$1", [row.id, charge]);
        await this.settleTurn(db, row.id);
      }
      return [...new Map(stale.rows.map((row) => [`${row.session_id}:${row.epoch}`,
        { id: row.session_id, principal: row.principal, epoch: row.epoch }])).values()];
    });
  }

  async authorize(db: pg.PoolClient, lease: SessionFileLease): Promise<SessionRow> {
    const row = (await db.query<SessionRow>(
      `SELECT s.* FROM shared_sessions s JOIN session_file_namespaces n ON n.id=s.id
       WHERE s.id=$1 AND s.principal=$2 AND NOT s.closed AND s.placement='shared' AND n.principal=s.principal
         AND n.epoch=$3 AND n.lease_until>clock_timestamp() FOR SHARE OF n`, [lease.id, lease.principal, lease.epoch])).rows[0];
    if (!row) throw new StoreError("not_found", "The conversation activation is unavailable.");
    row.definition = SharedSessionDefinition.parse(row.definition);
    return row;
  }

  private async settleTurn(db: pg.PoolClient, id: string): Promise<void> {
    const row = (await db.query<TurnRow>(
      `UPDATE shared_turns t SET settled=true WHERE id=$1 AND NOT settled AND state IN ('finished','interrupted')
       AND NOT EXISTS (SELECT 1 FROM shared_inference_requests r WHERE r.turn_id=t.id AND r.state='pending') RETURNING *`, [id])).rows[0];
    if (!row) return;
    await db.query(
      "UPDATE shared_sessions SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$3,last_activity_at=clock_timestamp() WHERE id=$1",
      [row.session_id, row.token_budget, Number(row.tokens_used)]);
  }

  async transaction<T>(action: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      try {
        await db.query("SELECT pg_advisory_xact_lock($1)", [SHARED_ADMISSION_LOCK]);
        const result = await action(db);
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
    } finally { db.release(); }
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function turn(row: TurnRow): SharedTurn {
  return { id: row.id, sessionId: row.session_id, state: row.state, tokenBudget: row.token_budget,
    ...(row.deadline ? { deadline: row.deadline.toISOString() } : {}) };
}
function record(row: SessionRow): SharedSessionRecord {
  const definition = SharedSessionDefinition.parse(row.definition);
  const usedTokens = Number(row.tokens_used);
  const reservedTokens = Number(row.tokens_reserved);
  const placement = PlacementKind.parse(row.placement);
  const harness = definition.harness
    ? { name: definition.harness.name, version: definition.harness.version, digest: definition.harness.digest }
    : undefined;
  const createdAt = row.created_at.toISOString();
  return {
    id: row.id, principal: row.principal, githubUserId: Number(row.github_user_id), placement, definition,
    view: { id: row.id, label: row.label, model: definition.model, closed: row.closed, online: row.online ?? false,
      createdAt, lastActivityAt: row.last_activity_at.toISOString(),
      ...(harness ? { harness } : {}),
      mode: definition.harness?.mode ?? (placement === "shared" ? "shared" : "isolated"),
      placement,
      // Generation 1 is implicit: its runtime session keeps the application session's ID. Promotion and handoff record
      // the segments they start, and a handoff without full history starts a new runtime session.
      segment: {
        generation: row.placement_generation, placement, ...(harness ? { harness } : {}),
        ahpSessionId: row.segment_ahp_session_id ?? row.id, startedAt: row.segment_started_at?.toISOString() ?? createdAt,
      },
      limits: definition.limits,
      budget: { usedTokens, reservedTokens, remainingTokens: Math.max(0, definition.limits.tokenBudget - usedTokens - reservedTokens) },
      jobs: row.jobs, continuations: row.continuations },
  };
}

/** The view builder for every placement, so placement-agnostic readers in this package build identical views. */
export { record as sharedSessionRecord };
export type { SessionRow as SharedSessionRow };
