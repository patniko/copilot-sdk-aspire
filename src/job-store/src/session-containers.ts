import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ContainerSize, HarnessDefinition, SharedServerKey, SharedSessionDefinition, SharedSessionLimits,
  type CapabilityIntrospection, type HarnessSnapshot, type SessionContainerSpec,
} from "@copilot-agent/contracts";
import { SharedStore } from "./shared-store.js";
import { StoreError } from "./store.js";

/** The admitted container placement of one isolated conversation session. */
export interface ContainerSessionAdmission {
  /** The admitted harness snapshot, kept with the container placement rather than in the session's definition. */
  harness: HarnessSnapshot;
  model: string;
  /** The session's limits; `idleSeconds` is the container's idle stop and `maxTurnSeconds` its turn deadline. */
  limits: SharedSessionLimits;
  /** Digest of the harness's effective operator policy at admission, for provenance. */
  policyDigest: string;
  size: string;
  resources: ContainerSize;
}
export interface ContainerSessionRecord extends ContainerSessionAdmission {
  id: string;
  principal: string;
  githubUserId: number;
  closed: boolean;
  generation: number;
  activations: number;
}
export interface ContainerGrant {
  jti: string;
  sessionId: string;
  allocationId: string;
  principal: string;
  models: string[];
  remainingTokens: number;
  expiresAt: Date;
  harness: HarnessSnapshot;
  model: string;
}
interface RecordRow {
  id: string; principal: string; github_user_id: string; closed: boolean; placement_generation: number;
  definition: SharedSessionDefinition; harness: HarnessSnapshot; size: string; resources: ContainerSize; activations: number;
}

/**
 * Ledger operations for sessions whose loop runs in a dedicated session container. Sessions are application sessions
 * (`shared_sessions` rows) with placement `container`; their tickets bind to an allocation instead of a shared epoch.
 */
export class SessionContainerStore {
  constructor(private readonly pool: pg.Pool, private readonly shared: SharedStore) {}

  async create(principal: string, githubUserId: number, label: string, admitted: ContainerSessionAdmission, maximum: number): Promise<ContainerSessionRecord> {
    const snapshot = { definition: HarnessDefinition.parse(admitted.harness.definition), digest: admitted.harness.digest };
    ContainerSize.parse(admitted.resources);
    if (!principal || !Number.isSafeInteger(githubUserId) || githubUserId < 1 || label.length > 120
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) throw new StoreError("invalid_request", "Invalid container session admission.");
    const definition = SharedSessionDefinition.parse({
      model: admitted.model,
      limits: SharedSessionLimits.parse({ ...admitted.limits, maxJobs: 0, maxContinuations: 0 }),
      harness: {
        name: snapshot.definition.name, version: snapshot.definition.version, digest: snapshot.digest, mode: "isolated",
        policyDigest: admitted.policyDigest,
      },
    });
    return this.shared.transaction(async (db) => {
      await this.shared.checkIdentity(principal, githubUserId, db);
      const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM shared_sessions WHERE principal=$1", [principal]);
      if (count.rows[0]!.count >= maximum) throw new StoreError("quota_exceeded", "The retained conversation limit is exhausted.");
      const id = randomUUID();
      await db.query(
        "INSERT INTO shared_sessions(id,principal,github_user_id,label,definition,placement) VALUES($1,$2,$3,$4,$5,'container')",
        [id, principal, githubUserId, label, JSON.stringify(definition)]);
      await db.query("INSERT INTO session_containers(session_id,harness,size,resources) VALUES($1,$2,$3,$4)",
        [id, JSON.stringify(snapshot), admitted.size, JSON.stringify(admitted.resources)]);
      return (await this.#record(db, principal, id))!;
    });
  }

  /** The principal's container-placed session, or undefined for unknown, other-principal, or shared-placement sessions. */
  async get(principal: string, id: string): Promise<ContainerSessionRecord | undefined> {
    return this.#record(this.pool, principal, id);
  }

  /** Closes the session, revokes its unused tickets, and releases its volumes for retention; the controller retires its allocation. */
  async close(principal: string, id: string): Promise<boolean> {
    return this.shared.transaction(async (db) => {
      const result = await db.query("UPDATE shared_sessions SET closed=true WHERE id=$1 AND principal=$2 AND placement='container'", [id, principal]);
      if (!result.rowCount) return false;
      await db.query("DELETE FROM shared_connection_tickets WHERE session_id=$1 AND used_at IS NULL", [id]);
      await db.query("UPDATE execution_volumes SET released_at=COALESCE(released_at,clock_timestamp()) WHERE session_id=$1", [id]);
      return true;
    });
  }

  /** The session's active allocation readiness, for connection provisioning. */
  async allocation(principal: string, id: string): Promise<{ id: string; state: string; ready: boolean; error?: string } | undefined> {
    const row = (await this.pool.query<{ id: string; state: string; ready: boolean; last_error: string | null }>(
      `SELECT e.id,e.state,(e.state='running' AND e.ready_at IS NOT NULL AND e.ingress IS NOT NULL AND e.expires_at>clock_timestamp()) AS ready,e.last_error
       FROM execution_allocations e JOIN shared_sessions s ON s.id=e.session_id
       WHERE e.session_id=$1 AND s.principal=$2 AND e.kind='session' ORDER BY e.created_at DESC LIMIT 1`, [id, principal])).rows[0];
    return row ? { id: row.id, state: row.state, ready: row.ready, ...(row.last_error ? { error: row.last_error } : {}) } : undefined;
  }

  /**
   * Issues a 60-second, one-use ticket bound to the session's ready allocation and current placement generation, with
   * the server key the container published through its allocation credential. The connection broker consumes it.
   */
  async issueTicket(principal: string, id: string, allocationId: string): Promise<{ token: string; expiresAt: string; serverKey: SharedServerKey }> {
    return this.shared.transaction(async (db) => {
      await db.query("DELETE FROM shared_connection_tickets WHERE expires_at<clock_timestamp()");
      const row = (await db.query<{ generation: number; server_key: SharedServerKey }>(
        `SELECT s.placement_generation AS generation,e.server_key FROM shared_sessions s
         JOIN execution_allocations e ON e.session_id=s.id
         WHERE s.id=$1 AND s.principal=$2 AND NOT s.closed AND s.placement='container' AND e.id=$3 AND e.kind='session'
           AND e.state='running' AND e.ready_at IS NOT NULL AND e.ingress IS NOT NULL AND e.expires_at>clock_timestamp()`,
        [id, principal, allocationId])).rows[0];
      if (!row) throw new StoreError("not_found", "The session container is unavailable.");
      const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM shared_connection_tickets WHERE session_id=$1 AND used_at IS NULL", [id]);
      if (count.rows[0]!.count >= 16) throw new StoreError("quota_exceeded", "Too many outstanding connection tickets.");
      const token = randomBytes(32).toString("base64url");
      const inserted = await db.query<{ expires_at: Date }>(
        `INSERT INTO shared_connection_tickets(digest,session_id,principal,epoch,placement_generation,expires_at)
         VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds') RETURNING expires_at`,
        [digest(token), id, principal, allocationId, row.generation]);
      return { token, expiresAt: inserted.rows[0]!.expires_at.toISOString(), serverKey: SharedServerKey.parse(row.server_key) };
    });
  }


  async spec(allocationId: string, heartbeatSeconds: number): Promise<SessionContainerSpec> {
    // An allocation started to move a shared session here runs before its cutover, while the session is still shared,
    // under the move's target definition when it has one.
    const row = (await this.pool.query<RecordRow & {
      allocation_id: string; promotion_id: string | null; snapshot_digest: string | null; previous_workspace: string | null;
      runtime_session_id: string | null; history: boolean | null; notice: string | null; target_definition: unknown;
    }>(
      `SELECT s.*,c.harness,c.size,c.resources,c.activations,e.id AS allocation_id,p.id AS promotion_id,p.snapshot_digest,p.previous_workspace,
         p.runtime_session_id,p.history,p.notice,p.target_definition
       FROM execution_allocations e JOIN shared_sessions s ON s.id=e.session_id JOIN session_containers c ON c.session_id=s.id
       LEFT JOIN session_promotions p ON p.session_id=s.id AND p.allocation_id=e.id AND p.state='starting'
       WHERE e.id=$1 AND e.kind='session' AND e.state IN ('starting','running') AND NOT s.closed
         AND (s.placement='container' OR (s.placement='shared' AND p.id IS NOT NULL))`,
      [allocationId])).rows[0];
    if (!row) throw new StoreError("not_found", "The session allocation is not active.");
    const definition = SharedSessionDefinition.parse(row.promotion_id && row.target_definition ? row.target_definition : row.definition);
    return {
      sessionId: row.id, allocationId: row.allocation_id, githubUserId: Number(row.github_user_id), harness: row.harness,
      model: definition.model, maxTurnSeconds: definition.limits.maxTurnSeconds, heartbeatSeconds,
      ...(row.promotion_id && row.snapshot_digest && row.runtime_session_id ? { promotion: {
        id: row.promotion_id, digest: row.snapshot_digest, ...(row.previous_workspace ? { previousWorkspace: row.previous_workspace } : {}),
        runtimeSessionId: row.runtime_session_id, history: row.history ?? true, ...(row.notice ? { notice: row.notice } : {}),
      } } : {}),
    };
  }

  /** Renews the allocation's two-minute inference grant while it is active, its session is open, and budget remains. */
  async grant(allocationId: string): Promise<ContainerGrant> {
    return this.shared.transaction(async (db) => {
      const row = (await db.query<{ session_id: string; principal: string; definition: SharedSessionDefinition; harness: HarnessSnapshot; tokens_used: string }>(
        `SELECT s.id AS session_id,s.principal,s.definition,c.harness,s.tokens_used FROM execution_allocations e
         JOIN shared_sessions s ON s.id=e.session_id JOIN session_containers c ON c.session_id=s.id
         WHERE e.id=$1 AND e.kind='session' AND e.state IN ('starting','running') AND e.ready_at IS NOT NULL
           AND e.expires_at>clock_timestamp() AND NOT s.closed AND s.placement='container' FOR UPDATE OF s`, [allocationId])).rows[0];
      if (!row) throw new StoreError("not_found", "The session allocation is not active.");
      const definition = SharedSessionDefinition.parse(row.definition);
      const remainingTokens = definition.limits.tokenBudget - Number(row.tokens_used);
      if (remainingTokens <= 0) throw new StoreError("quota_exceeded", "The session inference budget is exhausted.");
      const grant = (await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO session_container_grants(id,session_id,allocation_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 minutes')
         ON CONFLICT(allocation_id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING id,expires_at`,
        [randomUUID(), row.session_id, allocationId])).rows[0]!;
      const harness = { definition: HarnessDefinition.parse(row.harness.definition), digest: row.harness.digest };
      return {
        jti: grant.id, sessionId: row.session_id, allocationId, principal: row.principal, model: definition.model,
        models: [...new Set([definition.model, ...(harness.definition.agents ?? []).flatMap((agent) => agent.model ? [agent.model] : [])])],
        remainingTokens, expiresAt: grant.expires_at, harness,
      };
    });
  }

  async introspect(jti: string): Promise<CapabilityIntrospection> {
    const row = (await this.pool.query<{ valid: boolean; budget: string; used: string }>(
      `SELECT (g.expires_at>clock_timestamp() AND e.state IN ('starting','running') AND e.expires_at>clock_timestamp()
           AND NOT s.closed AND s.placement='container') AS valid,
         (s.definition->'limits'->>'tokenBudget') AS budget,s.tokens_used::text AS used
       FROM session_container_grants g JOIN execution_allocations e ON e.id=g.allocation_id JOIN shared_sessions s ON s.id=g.session_id
       WHERE g.id=$1`, [jti])).rows[0];
    if (!row) return { active: false, reason: "unknown", remainingTokens: 0 };
    const remainingTokens = Math.max(0, Number(row.budget) - Number(row.used));
    if (!row.valid) return { active: false, reason: "revoked", remainingTokens };
    if (!remainingTokens) return { active: false, reason: "budget_exhausted", remainingTokens };
    return { active: true, remainingTokens };
  }

  /** Records usage once per gateway request ID; late reports after closure or retirement still count. */
  async recordUsage(jti: string, requestId: string, input: number, output: number): Promise<boolean> {
    if (![input, output].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)) {
      throw new StoreError("invalid_request", "Invalid inference usage.");
    }
    return this.shared.transaction(async (db) => {
      const grant = (await db.query<{ session_id: string }>("SELECT session_id FROM session_container_grants WHERE id=$1", [jti])).rows[0];
      if (!grant) return false;
      const inserted = await db.query(
        "INSERT INTO session_container_usage(request_id,grant_id,input_tokens,output_tokens) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [requestId, jti, input, output]);
      if (inserted.rowCount) {
        await db.query("UPDATE shared_sessions SET tokens_used=tokens_used+$2,last_activity_at=clock_timestamp() WHERE id=$1", [grant.session_id, input + output]);
      }
      return true;
    });
  }

  async #record(db: pg.Pool | pg.PoolClient, principal: string, id: string): Promise<ContainerSessionRecord | undefined> {
    const row = (await db.query<RecordRow>(
      `SELECT s.*,c.harness,c.size,c.resources,c.activations
       FROM shared_sessions s JOIN session_containers c ON c.session_id=s.id
       WHERE s.id=$1 AND s.principal=$2 AND s.placement='container'`, [id, principal])).rows[0];
    if (!row) return undefined;
    const definition = SharedSessionDefinition.parse(row.definition);
    return {
      id: row.id, principal: row.principal, githubUserId: Number(row.github_user_id), closed: row.closed,
      generation: row.placement_generation, activations: row.activations,
      harness: { definition: HarnessDefinition.parse(row.harness.definition), digest: row.harness.digest },
      model: definition.model, limits: definition.limits, policyDigest: definition.harness?.policyDigest ?? "",
      size: row.size, resources: ContainerSize.parse(row.resources),
    };
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
