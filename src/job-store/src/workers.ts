import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  APPROVAL_MODES, ContainerSize, HarnessDefinition, InputRequestBody, InputResponseBody, MIN_WORKER_TOKENS, SEMVER, SLUG,
  summarizeInputRequest, WORKER_DELIVERIES, WORKER_SHARED_ACCESS, WORKER_SOURCES, WORKER_TEXT_MAX, workerBackstop,
  workerCapacityProblem,
  type ApprovalMode, type InputRequestState, type InputResponseSubmission, type WorkerAnswerer, type WorkerCapacity,
  type WorkerDefinitionExport, type WorkerDelivery, type WorkerEvent, type WorkerEventKind, type WorkerInputRequestView,
  type WorkerSharedAccess, type WorkerSource, type WorkerState, type WorkerStopReason, type WorkerView,
} from "@copilot-agent/contracts";
import type { SessionFileLease } from "./session-files.js";
import { SharedStore } from "./shared-store.js";
import { StoreError } from "./store.js";

/** A worker the coordinator's tools admitted, ready to record. Planning has already validated it against policy. */
export interface NewWorker {
  /** The creating tool call, unique within the coordinator session. */
  operationKey: string;
  /** SHA-256 hex of the canonical tool arguments, so a replayed call with other arguments is refused. */
  argumentsHash: string;
  name: string;
  source: WorkerSource;
  harness: { name: string; version: string; digest: string };
  definition: HarnessDefinition;
  template?: string;
  policyDigest?: string;
  size: string;
  resources: ContainerSize;
  sharedVolume: WorkerSharedAccess;
  approvalMode: ApprovalMode;
  inheritHumanAuthority: boolean;
  coordinatorAnswers: boolean;
  model: string;
  /** The most of the conversation's aggregate budget the worker may reserve. */
  tokenBudget: number;
  maxTurnSeconds: number;
  idleSeconds: number;
  lifetimeSeconds: number;
  /** The first task, recorded as message 1. */
  task: string;
}

/** A durable coordinator message waiting for delivery to its worker. */
export interface WorkerMessage {
  id: string;
  workerId: string;
  seq: number;
  delivery: WorkerDelivery;
  content: string;
  createdAt: string;
}

/** A worker a backstop or closure stopped, for the controller and operators. */
export interface StoppedWorker {
  id: string;
  sessionId: string;
  principal: string;
  reason: WorkerStopReason;
  allocationId?: string;
}

/** A stopped worker whose container is not yet confirmed gone. */
export interface RetiringWorker {
  id: string;
  sessionId: string;
  allocationId: string;
}

/** A coordinator session with undelivered worker events. */
export interface InboxSession {
  sessionId: string;
  principal: string;
}

/** Inbox events claimed together and delivered as one continuation. */
export interface InboxBatch {
  batchId: string;
  sessionId: string;
  events: WorkerEvent[];
}

export interface WorkerTurnOutcome {
  /** The final assistant message of the turn; absent when the turn produced none. */
  result?: string;
  interrupted?: boolean;
}

export interface WorkerAuthorityGrant {
  sourceSessionId: string;
  messageCount: number;
  overLimitCount: number;
  digest: string;
  createdAt: string;
}

interface WorkerRow {
  id: string; session_id: string; principal: string; name: string; source: WorkerSource;
  harness_name: string; harness_version: string; harness_digest: string; definition: unknown; template: string | null;
  policy_digest: string | null; operation_key: string; arguments_hash: string; turn_id: string | null;
  size: string; resources: unknown; shared_volume: WorkerSharedAccess; approval_mode: ApprovalMode;
  inherit_authority: boolean; coordinator_answers: boolean; model: string; max_turn_seconds: number; idle_seconds: number;
  state: WorkerState; stop_reason: WorkerStopReason | null; interrupt_requested_at: Date | null;
  result: string | null; result_truncated: boolean; result_at: Date | null; last_error: string | null;
  token_budget: number; tokens_used: string; charged_tokens: string; settled: boolean; turns: number;
  container_ms: string; container_started_at: Date | null; allocation_id: string | null;
  created_at: Date; last_activity_at: Date; idle_since: Date | null; expires_at: Date; stopped_at: Date | null; released_at: Date | null;
  pending_messages?: number; pending_inputs?: number; now?: Date;
}
interface InboxRow {
  id: string; session_id: string; worker_id: string; kind: WorkerEventKind; detail: Record<string, unknown>;
  created_at: Date; worker_name: string;
}
interface InputRow {
  id: string; worker_id: string; runtime_request_id: string; kind: "permission" | "question"; request: unknown;
  state: InputRequestState; response: unknown; answered_by: string | null; answered_as: WorkerAnswerer | null;
  created_at: Date; expires_at: Date; resolved_at: Date | null;
  session_id: string; worker_name: string; harness_name: string; harness_version: string; coordinator_answers: boolean;
  worker_state: WorkerState;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const RUNTIME_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_PENDING_MESSAGES = 16;
const MAX_PENDING_INPUTS = 8;
const MAX_DELIVERY_ATTEMPTS = 5;
/** The longest result preview an inbox event carries; the full result stays on the worker. */
const EVENT_RESULT_PREVIEW = 4000;
const BACKSTOPS = new Set<WorkerStopReason>(["idle_timeout", "max_lifetime", "budget_exhausted"]);

const WORKER_SELECT = `SELECT w.*, clock_timestamp() AS now,
  (SELECT count(*)::int FROM worker_messages m WHERE m.worker_id=w.id AND m.state='pending') AS pending_messages,
  (SELECT count(*)::int FROM worker_input_requests r WHERE r.worker_id=w.id AND r.state='pending' AND r.expires_at>clock_timestamp()) AS pending_inputs
  FROM session_workers w`;
const INPUT_SELECT = `SELECT r.*, w.session_id, w.name AS worker_name, w.harness_name, w.harness_version,
  w.coordinator_answers, w.state AS worker_state FROM worker_input_requests r JOIN session_workers w ON w.id=r.worker_id`;

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function bounded(text: string, maximum: number): { text: string; truncated: boolean } {
  return text.length > maximum ? { text: text.slice(0, maximum), truncated: true } : { text, truncated: false };
}

function validateNewWorker(worker: NewWorker, capacity: WorkerCapacity): void {
  const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
  const valid = worker.operationKey.length > 0 && worker.operationKey.length <= 200 && HASH.test(worker.argumentsHash)
    && SLUG.test(worker.name) && !UUID.test(worker.name) && (WORKER_SOURCES as readonly string[]).includes(worker.source)
    && SLUG.test(worker.harness.name) && SEMVER.test(worker.harness.version) && worker.harness.digest.length > 0 && worker.harness.digest.length <= 200
    && SLUG.test(worker.size) && ContainerSize.safeParse(worker.resources).success
    && (WORKER_SHARED_ACCESS as readonly string[]).includes(worker.sharedVolume) && (APPROVAL_MODES as readonly string[]).includes(worker.approvalMode)
    && worker.model.length > 0 && worker.model.length <= 200 && integer(worker.tokenBudget, MIN_WORKER_TOKENS, 5_000_000)
    && integer(worker.maxTurnSeconds, 10, 3600) && integer(worker.idleSeconds, 30, 86_400) && integer(worker.lifetimeSeconds, 60, 86_400)
    && worker.task.trim().length > 0 && worker.task.length <= WORKER_TEXT_MAX
    && (worker.source === "crafted") === (worker.template !== undefined)
    && HarnessDefinition.safeParse(worker.definition).success
    && [capacity.maxPerSession, capacity.maxConcurrent, capacity.maxPerPrincipal, capacity.deployment].every((value) => integer(value, 1, 10_000));
  if (!valid) throw new StoreError("invalid_request", "Invalid worker admission.");
}

function view(row: WorkerRow): WorkerView {
  const now = row.now ?? new Date();
  const running = row.container_started_at ? Math.max(0, now.getTime() - row.container_started_at.getTime()) : 0;
  return {
    id: row.id, sessionId: row.session_id, name: row.name, source: row.source,
    harness: { name: row.harness_name, version: row.harness_version, digest: row.harness_digest },
    ...(row.template ? { template: row.template } : {}),
    size: row.size, resources: ContainerSize.parse(row.resources), sharedVolume: row.shared_volume,
    approvalMode: row.approval_mode, inheritsHumanAuthority: row.inherit_authority, state: row.state,
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.result !== null && row.result_at ? { result: { text: row.result, truncated: row.result_truncated, at: row.result_at.toISOString() } } : {}),
    ...(row.last_error ? { error: row.last_error } : {}),
    usage: {
      tokenBudget: row.token_budget, tokensUsed: Number(row.tokens_used), turns: row.turns,
      containerSeconds: (Number(row.container_ms) + running) / 1000,
    },
    pendingMessages: row.pending_messages ?? 0, pendingInputs: row.pending_inputs ?? 0,
    capacityReleased: row.released_at !== null,
    createdAt: row.created_at.toISOString(), lastActivityAt: row.last_activity_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    ...(row.stopped_at ? { stoppedAt: row.stopped_at.toISOString() } : {}),
  };
}

function inputView(row: InputRow): WorkerInputRequestView {
  return {
    id: row.id, sessionId: row.session_id, workerId: row.worker_id, worker: row.worker_name,
    harness: { name: row.harness_name, version: row.harness_version }, state: row.state,
    request: InputRequestBody.parse(row.request),
    ...(row.response ? { response: InputResponseBody.parse(row.response) } : {}),
    ...(row.answered_as ? { answeredBy: row.answered_as } : {}),
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
  };
}

function event(row: InboxRow): WorkerEvent {
  return { id: row.id, workerId: row.worker_id, worker: row.worker_name, kind: row.kind, at: row.created_at.toISOString(), detail: row.detail };
}

function stopped(row: WorkerRow, reason: WorkerStopReason): StoppedWorker {
  return { id: row.id, sessionId: row.session_id, principal: row.principal, reason, ...(row.allocation_id ? { allocationId: row.allocation_id } : {}) };
}

/**
 * The orchestrator worker ledger (docs/HOSTING-MODES-PLAN.md, section 7.4): admission and backstops, durable messages,
 * the coordinator inbox, and the worker request queue. Every mutation runs under the shared ledger's admission lock, so
 * concurrent creations count each other. Reads are principal-scoped.
 */
export class WorkerStore {
  constructor(private readonly pool: pg.Pool, private readonly shared: SharedStore) {}

  /**
   * Admits a worker for a running coordinator turn: idempotent per creating tool call, within the session, principal,
   * and deployment ceilings, with a reservation from the conversation's aggregate budget that leaves the coordinator one
   * turn's budget. The first task becomes message 1.
   */
  async admit(lease: SessionFileLease, turnId: string, worker: NewWorker, capacity: WorkerCapacity): Promise<{ view: WorkerView; created: boolean }> {
    validateNewWorker(worker, capacity);
    return this.shared.transaction(async (db) => {
      const session = await this.shared.authorize(db, lease);
      if (session.definition.harness?.mode !== "orchestrator") {
        throw new StoreError("invalid_state", "Only an orchestrator conversation can start workers.");
      }
      const existing = (await db.query<{ id: string; arguments_hash: string }>(
        "SELECT id,arguments_hash FROM session_workers WHERE session_id=$1 AND operation_key=$2", [lease.id, worker.operationKey])).rows[0];
      if (existing) {
        if (existing.arguments_hash !== worker.argumentsHash) throw new StoreError("idempotency_conflict", "The worker creation was reused with different arguments.");
        return { view: await this.#view(db, existing.id), created: false };
      }
      const turn = await db.query(
        `SELECT 1 FROM shared_turns WHERE id=$1 AND session_id=$2 AND epoch=$3 AND principal=$4
         AND state='running' AND deadline>clock_timestamp()`, [turnId, lease.id, lease.epoch, lease.principal]);
      if (!turn.rowCount) throw new StoreError("invalid_state", "Only a running coordinator turn can start workers.");
      const named = await db.query("SELECT 1 FROM session_workers WHERE session_id=$1 AND name=$2", [lease.id, worker.name]);
      if (named.rowCount) throw new StoreError("invalid_request", `This conversation already has a worker named '${worker.name}'.`);
      const counts = (await db.query<{ session_total: number; session_active: number; principal_active: number; deployment_active: number }>(
        `SELECT count(*) FILTER (WHERE session_id=$1)::int AS session_total,
          count(*) FILTER (WHERE session_id=$1 AND released_at IS NULL)::int AS session_active,
          count(*) FILTER (WHERE principal=$2 AND released_at IS NULL)::int AS principal_active,
          count(*) FILTER (WHERE released_at IS NULL)::int AS deployment_active
         FROM session_workers WHERE session_id=$1 OR released_at IS NULL`, [lease.id, lease.principal])).rows[0]!;
      const problem = workerCapacityProblem({
        sessionTotal: counts.session_total, sessionActive: counts.session_active,
        principalActive: counts.principal_active, deploymentActive: counts.deployment_active,
      }, capacity);
      if (problem) throw new StoreError("quota_exceeded", problem);
      const limits = session.definition.limits;
      const remaining = limits.tokenBudget - Number(session.tokens_used) - Number(session.tokens_reserved) - limits.turnTokenBudget;
      const reservation = Math.min(worker.tokenBudget, remaining);
      if (reservation < MIN_WORKER_TOKENS) {
        throw new StoreError("quota_exceeded", "The conversation's aggregate token budget cannot fund another worker.");
      }
      const id = randomUUID();
      await db.query(
        `INSERT INTO session_workers(id,session_id,principal,name,source,harness_name,harness_version,harness_digest,definition,
          template,policy_digest,operation_key,arguments_hash,turn_id,size,resources,shared_volume,approval_mode,inherit_authority,
          coordinator_answers,model,max_turn_seconds,idle_seconds,token_budget,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,clock_timestamp()+$25*interval '1 second')`,
        [id, lease.id, lease.principal, worker.name, worker.source, worker.harness.name, worker.harness.version, worker.harness.digest,
          JSON.stringify(worker.definition), worker.template ?? null, worker.policyDigest ?? null, worker.operationKey, worker.argumentsHash,
          turnId, worker.size, JSON.stringify(ContainerSize.parse(worker.resources)), worker.sharedVolume, worker.approvalMode,
          worker.inheritHumanAuthority, worker.coordinatorAnswers, worker.model, worker.maxTurnSeconds, worker.idleSeconds, reservation,
          worker.lifetimeSeconds]);
      await db.query(
        "INSERT INTO worker_messages(id,worker_id,seq,operation_key,arguments_hash,delivery,content) VALUES($1,$2,1,$3,$4,'enqueue',$5)",
        [randomUUID(), id, worker.operationKey, worker.argumentsHash, worker.task]);
      await db.query("UPDATE shared_sessions SET tokens_reserved=tokens_reserved+$2,last_activity_at=clock_timestamp() WHERE id=$1", [lease.id, reservation]);
      return { view: await this.#view(db, id), created: true };
    });
  }

  /** The worker a creating tool call already admitted, so a replay returns it even if policy changed since. */
  async find(lease: SessionFileLease, operationKey: string, argumentsHash: string): Promise<WorkerView | undefined> {
    return this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const row = (await db.query<{ id: string; arguments_hash: string }>(
        "SELECT id,arguments_hash FROM session_workers WHERE session_id=$1 AND operation_key=$2", [lease.id, operationKey])).rows[0];
      if (!row) return undefined;
      if (row.arguments_hash !== argumentsHash) throw new StoreError("idempotency_conflict", "The worker creation was reused with different arguments.");
      return this.#view(db, row.id);
    });
  }

  /** The session's workers, oldest first. Unknown sessions and other principals' sessions are not found. */
  async list(principal: string, sessionId: string): Promise<WorkerView[]> {
    await this.#owned(principal, sessionId);
    return (await this.pool.query<WorkerRow>(
      `${WORKER_SELECT} WHERE w.session_id=$1 AND w.principal=$2 ORDER BY w.created_at,w.id LIMIT 256`, [sessionId, principal])).rows.map(view);
  }

  /** One worker by id or name; undefined when it is not the principal's. */
  async get(principal: string, sessionId: string, reference: string): Promise<WorkerView | undefined> {
    const row = (await this.pool.query<WorkerRow>(
      `${WORKER_SELECT} JOIN shared_sessions s ON s.id=w.session_id
       WHERE w.session_id=$1 AND w.principal=$2 AND s.principal=$2 AND ${UUID.test(reference) ? "w.id=$3" : "w.name=$3"}`,
      [sessionId, principal, UUID.test(reference) ? reference.toLowerCase() : reference])).rows[0];
    return row ? view(row) : undefined;
  }

  /** A worker's recorded definition with its provenance. */
  async definition(principal: string, sessionId: string, reference: string): Promise<WorkerDefinitionExport | undefined> {
    const row = (await this.pool.query<WorkerRow>(
      `SELECT w.* FROM session_workers w JOIN shared_sessions s ON s.id=w.session_id
       WHERE w.session_id=$1 AND w.principal=$2 AND s.principal=$2 AND ${UUID.test(reference) ? "w.id=$3" : "w.name=$3"}`,
      [sessionId, principal, UUID.test(reference) ? reference.toLowerCase() : reference])).rows[0];
    if (!row) return undefined;
    return {
      workerId: row.id, sessionId: row.session_id, name: row.name, source: row.source,
      ...(row.template ? { template: row.template } : {}), digest: row.harness_digest, toolCallId: row.operation_key,
      createdAt: row.created_at.toISOString(), definition: HarnessDefinition.parse(row.definition),
    };
  }

  /**
   * A durable coordinator message for one worker, idempotent per tool call. `immediate` messages steer the worker at its
   * next turn boundary; `enqueue` messages wait for its current work. Stopped workers accept nothing.
   */
  async send(
    lease: SessionFileLease, operationKey: string, argumentsHash: string, reference: string, content: string, delivery: WorkerDelivery,
  ): Promise<{ message: WorkerMessage; worker: WorkerView }> {
    if (!operationKey || operationKey.length > 200 || !HASH.test(argumentsHash) || !(WORKER_DELIVERIES as readonly string[]).includes(delivery)
      || !content.trim() || content.length > WORKER_TEXT_MAX) {
      throw new StoreError("invalid_request", "Invalid worker message.");
    }
    return this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const worker = await this.#resolve(db, lease.id, reference);
      const existing = (await db.query<{ id: string; seq: number; arguments_hash: string; delivery: WorkerDelivery; content: string; created_at: Date }>(
        "SELECT * FROM worker_messages WHERE worker_id=$1 AND operation_key=$2", [worker.id, operationKey])).rows[0];
      if (existing) {
        if (existing.arguments_hash !== argumentsHash) throw new StoreError("idempotency_conflict", "The worker message was reused with different arguments.");
        return { message: { id: existing.id, workerId: worker.id, seq: existing.seq, delivery: existing.delivery, content: existing.content,
          createdAt: existing.created_at.toISOString() }, worker: await this.#view(db, worker.id) };
      }
      if (worker.state === "stopped") throw new StoreError("invalid_state", "The worker has stopped; create a new worker instead.");
      const pending = (await db.query<{ count: number; next: number }>(
        `SELECT count(*) FILTER (WHERE state='pending')::int AS count,COALESCE(max(seq),0)+1 AS next FROM worker_messages WHERE worker_id=$1`,
        [worker.id])).rows[0]!;
      if (pending.count >= MAX_PENDING_MESSAGES) throw new StoreError("quota_exceeded", "The worker already has the maximum of undelivered messages.");
      const id = randomUUID();
      const inserted = (await db.query<{ created_at: Date }>(
        `INSERT INTO worker_messages(id,worker_id,seq,operation_key,arguments_hash,delivery,content) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,
        [id, worker.id, pending.next, operationKey, argumentsHash, delivery, content])).rows[0]!;
      await db.query("UPDATE shared_sessions SET last_activity_at=clock_timestamp() WHERE id=$1", [lease.id]);
      return { message: { id, workerId: worker.id, seq: pending.next, delivery, content, createdAt: inserted.created_at.toISOString() },
        worker: await this.#view(db, worker.id) };
    });
  }

  /** Requests an abort of the worker's current turn; a worker that is not working has nothing to interrupt. */
  async interrupt(lease: SessionFileLease, reference: string): Promise<{ interrupted: boolean; worker: WorkerView }> {
    return this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const worker = await this.#resolve(db, lease.id, reference);
      if (worker.state === "stopped") throw new StoreError("invalid_state", "The worker has stopped.");
      const interrupted = worker.state === "working" || worker.state === "needs_input";
      if (interrupted) {
        await db.query("UPDATE session_workers SET interrupt_requested_at=COALESCE(interrupt_requested_at,clock_timestamp()) WHERE id=$1", [worker.id]);
      }
      return { interrupted, worker: await this.#view(db, worker.id) };
    });
  }

  /**
   * Stops a worker for its coordinator and cancels its undelivered messages and requests. Capacity returns when the
   * container is confirmed gone; a worker that never had a container releases at once. Its volumes are retained.
   */
  async archive(lease: SessionFileLease, reference: string): Promise<WorkerView> {
    return this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const worker = await this.#resolve(db, lease.id, reference);
      if (worker.state !== "stopped") await this.#stop(db, worker, "archived");
      return this.#view(db, worker.id);
    });
  }

  /** Stops every running worker of a closed coordinator session. */
  async stopSession(sessionId: string): Promise<StoppedWorker[]> {
    return this.shared.transaction(async (db) => {
      const closed = await db.query("SELECT 1 FROM shared_sessions WHERE id=$1 AND closed", [sessionId]);
      if (!closed.rowCount) throw new StoreError("invalid_state", "Workers stop with their coordinator only after it closes.");
      const rows = (await db.query<WorkerRow>("SELECT * FROM session_workers WHERE session_id=$1 AND state<>'stopped' FOR UPDATE", [sessionId])).rows;
      for (const row of rows) await this.#stop(db, row, "coordinator_closed");
      return rows.map((row) => stopped(row, "coordinator_closed"));
    });
  }

  /**
   * Applies the backstops: workers of closed coordinators stop, and lifetime, budget, and idle time stop the rest. Overdue
   * input requests expire. Returns the workers stopped now.
   */
  async sweep(limit = 200): Promise<StoppedWorker[]> {
    return this.shared.transaction(async (db) => {
      await this.#expireInputs(db);
      const rows = (await db.query<WorkerRow & { session_closed: boolean }>(
        `SELECT w.*,s.closed AS session_closed,clock_timestamp() AS now FROM session_workers w JOIN shared_sessions s ON s.id=w.session_id
         WHERE w.state<>'stopped' ORDER BY w.created_at,w.id LIMIT $1 FOR UPDATE OF w`, [limit])).rows;
      const result: StoppedWorker[] = [];
      for (const row of rows) {
        const reason: WorkerStopReason | undefined = row.session_closed ? "coordinator_closed" : workerBackstop({
          state: row.state, ...(row.idle_since ? { idleSince: row.idle_since } : {}), idleSeconds: row.idle_seconds,
          expiresAt: row.expires_at, tokensUsed: Number(row.tokens_used), tokenBudget: row.token_budget,
        }, row.now!);
        if (!reason) continue;
        await this.#stop(db, row, reason);
        result.push(stopped(row, reason));
      }
      return result;
    });
  }

  /** Stopped workers whose containers the controller must still remove. */
  async retiring(limit = 100): Promise<RetiringWorker[]> {
    return (await this.pool.query<{ id: string; session_id: string; allocation_id: string }>(
      `SELECT id,session_id,allocation_id FROM session_workers WHERE state='stopped' AND released_at IS NULL AND allocation_id IS NOT NULL
       ORDER BY stopped_at LIMIT $1`, [limit])).rows.map((row) => ({ id: row.id, sessionId: row.session_id, allocationId: row.allocation_id }));
  }

  /** The controller confirmed the worker's container is gone: capacity returns and its reservation settles. */
  async released(workerId: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      if (row.state !== "stopped") throw new StoreError("invalid_state", "Only a stopped worker's capacity can be released.");
      await this.#release(db, row.id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Worker runtime reports. Phase 2 authenticates the worker's container before it reaches these.
  // ---------------------------------------------------------------------------------------------------------------

  /** The worker's container is running under an allocation; container time starts counting. */
  async containerStarted(workerId: string, allocationId: string): Promise<void> {
    if (!UUID.test(allocationId)) throw new StoreError("invalid_request", "Invalid allocation identity.");
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      if (row.released_at) throw new StoreError("invalid_state", "The worker's capacity was already released.");
      if (row.allocation_id && row.allocation_id !== allocationId.toLowerCase()) throw new StoreError("invalid_state", "The worker belongs to another allocation.");
      await db.query(
        "UPDATE session_workers SET allocation_id=$2,container_started_at=COALESCE(container_started_at,clock_timestamp()) WHERE id=$1",
        [row.id, allocationId.toLowerCase()]);
    });
  }

  /** What the worker's runtime must act on: undelivered messages in order, and whether to abort or stop. */
  async control(workerId: string): Promise<{ state: WorkerState; interrupt: boolean; messages: WorkerMessage[] }> {
    if (!UUID.test(workerId)) throw new StoreError("not_found", "The worker was not found.");
    const row = (await this.pool.query<{ state: WorkerState; interrupt_requested_at: Date | null }>(
      "SELECT state,interrupt_requested_at FROM session_workers WHERE id=$1", [workerId])).rows[0];
    if (!row) throw new StoreError("not_found", "The worker was not found.");
    const messages = row.state === "stopped" ? [] : (await this.pool.query<{ id: string; seq: number; delivery: WorkerDelivery; content: string; created_at: Date }>(
      "SELECT id,seq,delivery,content,created_at FROM worker_messages WHERE worker_id=$1 AND state='pending' ORDER BY seq LIMIT $2",
      [workerId, MAX_PENDING_MESSAGES])).rows.map((message) => ({
      id: message.id, workerId, seq: message.seq, delivery: message.delivery, content: message.content, createdAt: message.created_at.toISOString(),
    }));
    return { state: row.state, interrupt: row.interrupt_requested_at !== null && row.state !== "stopped", messages };
  }

  /** The runtime accepted these messages into the worker's session. */
  async messagesDelivered(workerId: string, ids: readonly string[]): Promise<void> {
    if (!ids.every((id) => UUID.test(id))) throw new StoreError("invalid_request", "Invalid message identity.");
    await this.shared.transaction(async (db) => {
      await this.#lock(db, workerId);
      await db.query("UPDATE worker_messages SET state='delivered',delivered_at=clock_timestamp() WHERE worker_id=$1 AND id=ANY($2::uuid[]) AND state='pending'",
        [workerId, [...ids]]);
    });
  }

  /** A worker turn started. */
  async turnStarted(workerId: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      if (row.state === "stopped") throw new StoreError("invalid_state", "The worker has stopped.");
      await db.query(
        "UPDATE session_workers SET state='working',turns=turns+1,idle_since=NULL,last_activity_at=clock_timestamp() WHERE id=$1", [row.id]);
    });
  }

  /**
   * A worker turn ended: the worker is idle, its latest result is recorded (bounded), requests from the turn are
   * cancelled, and the coordinator's inbox receives `completed` with a result preview, or `idle` without one.
   */
  async turnFinished(workerId: string, outcome: WorkerTurnOutcome): Promise<void> {
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      if (row.state === "stopped") return;
      const result = outcome.result !== undefined && outcome.result.trim() && !outcome.interrupted ? bounded(outcome.result, WORKER_TEXT_MAX) : undefined;
      await db.query(
        `UPDATE session_workers SET state='idle',idle_since=clock_timestamp(),interrupt_requested_at=NULL,last_activity_at=clock_timestamp(),
         result=CASE WHEN $2::boolean THEN $3 ELSE result END,result_truncated=CASE WHEN $2::boolean THEN $4 ELSE result_truncated END,
         result_at=CASE WHEN $2::boolean THEN clock_timestamp() ELSE result_at END WHERE id=$1`,
        [row.id, result !== undefined, result?.text ?? null, result?.truncated ?? false]);
      await db.query("UPDATE worker_input_requests SET state='cancelled',resolved_at=clock_timestamp() WHERE worker_id=$1 AND state='pending'", [row.id]);
      if (result) {
        const preview = bounded(result.text, EVENT_RESULT_PREVIEW);
        await this.#notify(db, row, "completed", { result: preview.text, truncated: preview.truncated || result.truncated });
      } else {
        await this.#notify(db, row, "idle", { reason: outcome.interrupted ? "interrupted" : "no_result" });
      }
    });
  }

  /** The worker failed: it stops, and its coordinator is told. */
  async failed(workerId: string, message: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      if (row.state !== "stopped") await this.#stop(db, row, "failed", message || "The worker failed.");
    });
  }

  /** Counts inference against the worker's reservation; a worker that uses it up stops. Late usage is charged directly. */
  async recordUsage(workerId: string, tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 10_000_000) throw new StoreError("invalid_request", "Invalid worker usage.");
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      const updated = (await db.query<{ tokens_used: string }>(
        "UPDATE session_workers SET tokens_used=tokens_used+$2,charged_tokens=CASE WHEN settled THEN tokens_used+$2 ELSE charged_tokens END WHERE id=$1 RETURNING tokens_used",
        [row.id, tokens])).rows[0]!;
      if (row.settled) await db.query("UPDATE shared_sessions SET tokens_used=tokens_used+$2 WHERE id=$1", [row.session_id, tokens]);
      if (row.state !== "stopped" && Number(updated.tokens_used) >= row.token_budget) await this.#stop(db, row, "budget_exhausted");
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The coordinator's inbox: worker events delivered as bounded continuations, at least once, deduplicated by a
  // runtime-history marker per batch.
  // ---------------------------------------------------------------------------------------------------------------

  /** Open coordinator sessions with undelivered events, oldest first. */
  async inboxSessions(limit = 100): Promise<InboxSession[]> {
    return (await this.pool.query<{ session_id: string; principal: string }>(
      `SELECT i.session_id,s.principal FROM worker_inbox i JOIN shared_sessions s ON s.id=i.session_id
       WHERE i.state='pending' AND NOT s.closed GROUP BY i.session_id,s.principal ORDER BY min(i.created_at) LIMIT $1`, [limit]))
      .rows.map((row) => ({ sessionId: row.session_id, principal: row.principal }));
  }

  /**
   * Claims up to `maximum` pending events for one activation. A batch that was claimed before and timed out is claimed
   * again with the same members, so its marker identifies a continuation that may already have been delivered.
   */
  async claimInbox(lease: SessionFileLease, maximum = 8): Promise<InboxBatch | undefined> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) throw new StoreError("invalid_request", "Invalid inbox batch size.");
    return this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const claim = `state='delivering',activation_epoch=$2,delivery_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1`;
      const stale = (await db.query<{ batch_id: string }>(
        `SELECT batch_id FROM worker_inbox WHERE session_id=$1 AND state='pending' AND batch_id IS NOT NULL AND attempts<$2
         ORDER BY created_at,id LIMIT 1`, [lease.id, MAX_DELIVERY_ATTEMPTS])).rows[0];
      const batchId = stale?.batch_id ?? randomUUID();
      const claimed = stale
        ? await db.query<{ id: string }>(
          `UPDATE worker_inbox SET ${claim} WHERE session_id=$1 AND batch_id=$3 AND state='pending' AND attempts<$4 RETURNING id`,
          [lease.id, lease.epoch, batchId, MAX_DELIVERY_ATTEMPTS])
        : await db.query<{ id: string }>(
          `UPDATE worker_inbox SET batch_id=$3,${claim} WHERE id IN (
             SELECT id FROM worker_inbox WHERE session_id=$1 AND state='pending' AND batch_id IS NULL AND attempts<$5
             ORDER BY created_at,id LIMIT $4) RETURNING id`,
          [lease.id, lease.epoch, batchId, maximum, MAX_DELIVERY_ATTEMPTS]);
      if (!claimed.rowCount) return undefined;
      const rows = (await db.query<InboxRow>(
        `SELECT i.*,w.name AS worker_name FROM worker_inbox i JOIN session_workers w ON w.id=i.worker_id
         WHERE i.session_id=$1 AND i.batch_id=$2 AND i.state='delivering' ORDER BY i.created_at,i.id`, [lease.id, batchId])).rows;
      return { batchId, sessionId: lease.id, events: rows.map(event) };
    });
  }

  /** Records a batch's delivery outcome for the activation that claimed it. */
  async finishInbox(lease: SessionFileLease, batchId: string, state: "delivered" | "pending" | "needs_review", error?: string): Promise<void> {
    if (!UUID.test(batchId)) throw new StoreError("invalid_request", "Invalid inbox batch.");
    await this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      await db.query(
        `UPDATE worker_inbox SET state=CASE WHEN $4='pending' AND attempts>=$6 THEN 'needs_review' ELSE $4 END,
         delivered_at=CASE WHEN $4='delivered' THEN clock_timestamp() ELSE delivered_at END,
         activation_epoch=CASE WHEN $4='pending' THEN NULL ELSE activation_epoch END,last_error=$5
         WHERE session_id=$1 AND batch_id=$2 AND activation_epoch=$3 AND state='delivering'`,
        [lease.id, batchId, lease.epoch, state, error?.slice(0, 500) ?? null, MAX_DELIVERY_ATTEMPTS]);
    });
  }

  /**
   * Closes events of closed coordinators, sends events that can no longer be delivered (continuations or aggregate budget
   * exhausted) to review, and returns timed-out deliveries to pending with their batch intact.
   */
  async reconcileInbox(): Promise<void> {
    await this.shared.transaction(async (db) => {
      await db.query(
        `UPDATE worker_inbox i SET state='closed' FROM shared_sessions s
         WHERE i.session_id=s.id AND s.closed AND i.state IN ('pending','delivering')`);
      await db.query(
        `UPDATE worker_inbox i SET state='needs_review',last_error='Continuation or aggregate budget exhausted; read the workers explicitly.'
         FROM shared_sessions s WHERE i.session_id=s.id AND i.state='pending' AND NOT s.closed AND
           (s.continuations >= (s.definition->'limits'->>'maxContinuations')::integer OR
             s.tokens_used >= (s.definition->'limits'->>'tokenBudget')::bigint)`);
      await db.query(
        `UPDATE worker_inbox SET state=CASE WHEN attempts>=$1 THEN 'needs_review' ELSE 'pending' END,activation_epoch=NULL
         WHERE state='delivering' AND delivery_until<clock_timestamp()`, [MAX_DELIVERY_ATTEMPTS]);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Worker approvals and questions for a person. The coordinator never decides a permission request.
  // ---------------------------------------------------------------------------------------------------------------

  /** Records a worker's request for a person; the worker waits for input and its coordinator is told. Idempotent per runtime request. */
  async createInputRequest(workerId: string, runtimeRequestId: string, request: InputRequestBody, timeoutSeconds: number): Promise<{ id: string; expiresAt: string; created: boolean }> {
    const body = InputRequestBody.safeParse(request);
    if (!RUNTIME_REQUEST_ID.test(runtimeRequestId) || !body.success || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
      throw new StoreError("invalid_request", "Invalid worker input request.");
    }
    return this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      const existing = (await db.query<{ id: string; expires_at: Date }>(
        "SELECT id,expires_at FROM worker_input_requests WHERE worker_id=$1 AND runtime_request_id=$2", [row.id, runtimeRequestId])).rows[0];
      if (existing) return { id: existing.id, expiresAt: existing.expires_at.toISOString(), created: false };
      if (row.state === "stopped") throw new StoreError("invalid_state", "The worker has stopped.");
      const pending = (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM worker_input_requests WHERE worker_id=$1 AND state='pending'", [row.id])).rows[0]!;
      if (pending.count >= MAX_PENDING_INPUTS) throw new StoreError("quota_exceeded", "The worker already waits for the maximum of answers.");
      const id = randomUUID();
      const inserted = (await db.query<{ expires_at: Date }>(
        `INSERT INTO worker_input_requests(id,worker_id,runtime_request_id,kind,request,expires_at)
         VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second') RETURNING expires_at`,
        [id, row.id, runtimeRequestId, body.data.kind, JSON.stringify(body.data), timeoutSeconds])).rows[0]!;
      await db.query("UPDATE session_workers SET state='needs_input',idle_since=NULL,last_activity_at=clock_timestamp() WHERE id=$1", [row.id]);
      await this.#notify(db, row, "needs_input", { requestId: id, kind: body.data.kind, summary: summarizeInputRequest(body.data) });
      return { id, expiresAt: inserted.expires_at.toISOString(), created: true };
    });
  }

  /** The worker side: the request's state and, once answered, the answer. Overdue requests expire here. */
  async pollInputRequest(workerId: string, id: string): Promise<{ state: InputRequestState; response?: InputResponseBody; answeredBy?: WorkerAnswerer } | undefined> {
    if (!UUID.test(workerId) || !UUID.test(id)) return undefined;
    return this.shared.transaction(async (db) => {
      await this.#expireInputs(db, workerId);
      const row = (await db.query<InputRow>(`${INPUT_SELECT} WHERE r.id=$1 AND r.worker_id=$2`, [id, workerId])).rows[0];
      if (!row) return undefined;
      return {
        state: row.state,
        ...(row.response ? { response: InputResponseBody.parse(row.response) } : {}),
        ...(row.answered_as ? { answeredBy: row.answered_as } : {}),
      };
    });
  }

  /** Worker requests of the principal, across sessions or for one session. Pending requests come oldest first. */
  async listInputRequests(principal: string, options: { sessionId?: string; state?: "pending" | "all"; limit?: number }): Promise<WorkerInputRequestView[]> {
    const state = options.state ?? "pending";
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (state !== "pending" && state !== "all")) {
      throw new StoreError("invalid_request", "Invalid worker input request query.");
    }
    if (options.sessionId !== undefined) await this.#owned(principal, options.sessionId);
    return this.shared.transaction(async (db) => {
      await this.#expireInputs(db);
      const order = state === "pending" ? "ASC" : "DESC";
      return (await db.query<InputRow>(
        `${INPUT_SELECT} JOIN shared_sessions s ON s.id=w.session_id
         WHERE w.principal=$1 AND s.principal=$1 AND ($2::uuid IS NULL OR w.session_id=$2)
           AND ($4::text='all' OR (r.state='pending' AND r.expires_at>clock_timestamp()))
         ORDER BY r.created_at ${order},r.id ${order} LIMIT $3`,
        [principal, options.sessionId ?? null, limit, state])).rows.map(inputView);
    });
  }

  /** A person's answer through the API. Stale, expired, cancelled, or answered requests cannot be answered again. */
  async respondInputRequest(principal: string, sessionId: string, requestId: string, submission: InputResponseSubmission): Promise<WorkerInputRequestView> {
    if (!UUID.test(sessionId) || !UUID.test(requestId)) throw new StoreError("not_found", "Input request not found.");
    const result = await this.shared.transaction(async (db) => {
      const row = (await db.query<InputRow>(
        `${INPUT_SELECT} JOIN shared_sessions s ON s.id=w.session_id
         WHERE r.id=$1 AND w.session_id=$2 AND w.principal=$3 AND s.principal=$3 FOR UPDATE OF r`, [requestId, sessionId, principal])).rows[0];
      if (!row) throw new StoreError("not_found", "Input request not found.");
      if (row.state === "pending" && row.expires_at <= new Date()) {
        await this.#expireInputs(db, row.worker_id);
        return { expired: true as const };
      }
      const response = this.#answer(row, submission);
      return { view: await this.#resolveInput(db, row, response, principal, "principal") };
    });
    if ("expired" in result) throw new StoreError("invalid_state", "Input request has expired and cannot be answered.");
    return result.view;
  }

  /**
   * The coordinator answers a worker's question, when the policy recorded on the worker allows it. A permission request is
   * always refused: only a person decides those.
   */
  async answerAsCoordinator(lease: SessionFileLease, requestId: string, answer: string): Promise<WorkerInputRequestView> {
    if (!UUID.test(requestId)) throw new StoreError("not_found", "Input request not found.");
    const result = await this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const row = (await db.query<InputRow>(`${INPUT_SELECT} WHERE r.id=$1 AND w.session_id=$2 FOR UPDATE OF r`, [requestId, lease.id])).rows[0];
      if (!row) throw new StoreError("not_found", "Input request not found.");
      if (row.kind !== "question") throw new StoreError("invalid_request", "Only a person can decide a worker's permission request.");
      if (!row.coordinator_answers) throw new StoreError("invalid_state", "The operator policy does not let the coordinator answer worker questions; a person must answer.");
      if (row.state === "pending" && row.expires_at <= new Date()) {
        await this.#expireInputs(db, row.worker_id);
        return { expired: true as const };
      }
      const response = this.#answer(row, { kind: "question", answer });
      return { view: await this.#resolveInput(db, row, response, `coordinator:${lease.id}`, "coordinator") };
    });
    if ("expired" in result) throw new StoreError("invalid_state", "Input request has expired and cannot be answered.");
    return result.view;
  }

  #answer(row: InputRow, submission: InputResponseSubmission): InputResponseBody {
    if (row.state !== "pending") throw new StoreError("invalid_state", `Input request is ${row.state} and cannot be answered.`);
    if (row.kind !== submission.kind) throw new StoreError("invalid_request", `Cannot answer a ${row.kind} request with a ${submission.kind} response.`);
    if (submission.kind === "permission") {
      return {
        kind: "permission", approved: submission.approved,
        ...(submission.scope !== undefined ? { scope: submission.scope } : {}),
        ...(submission.feedback !== undefined ? { feedback: submission.feedback } : {}),
      };
    }
    const request = InputRequestBody.parse(row.request);
    if (request.kind !== "question" || !submission.answer || submission.answer.length > 8000) {
      throw new StoreError("invalid_request", "The answer is invalid.");
    }
    const choices = request.choices ?? [];
    if (request.allowFreeform === false && choices.length > 0 && !choices.includes(submission.answer)) {
      throw new StoreError("invalid_request", "The answer must be one of the request choices.");
    }
    return { kind: "question", answer: submission.answer, wasFreeform: !choices.includes(submission.answer) };
  }

  async #resolveInput(db: pg.PoolClient, row: InputRow, response: InputResponseBody, answeredBy: string, answeredAs: WorkerAnswerer): Promise<WorkerInputRequestView> {
    await db.query(
      `UPDATE worker_input_requests SET state='answered',response=$2,answered_by=$3,answered_as=$4,resolved_at=clock_timestamp()
       WHERE id=$1 AND state='pending'`, [row.id, JSON.stringify(response), answeredBy, answeredAs]);
    await this.#resume(db, row.worker_id);
    return inputView((await db.query<InputRow>(`${INPUT_SELECT} WHERE r.id=$1`, [row.id])).rows[0]!);
  }

  /** Expires overdue requests (all, or one worker's) and resumes workers that no longer wait for anyone. */
  async #expireInputs(db: pg.PoolClient, workerId?: string): Promise<void> {
    const expired = (await db.query<{ worker_id: string }>(
      `UPDATE worker_input_requests SET state='expired',resolved_at=clock_timestamp()
       WHERE state='pending' AND expires_at<=clock_timestamp() AND ($1::uuid IS NULL OR worker_id=$1) RETURNING worker_id`,
      [workerId ?? null])).rows;
    for (const id of new Set(expired.map((row) => row.worker_id))) await this.#resume(db, id);
  }

  async #resume(db: pg.PoolClient, workerId: string): Promise<void> {
    await db.query(
      `UPDATE session_workers SET state='working',last_activity_at=clock_timestamp() WHERE id=$1 AND state='needs_input'
       AND NOT EXISTS (SELECT 1 FROM worker_input_requests r WHERE r.worker_id=$1 AND r.state='pending')`, [workerId]);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Inherited human authority, recorded for audit.
  // ---------------------------------------------------------------------------------------------------------------

  /** Records the coordinator's human messages the platform supplied to an assisted worker's judge, and the runtime's counts. */
  async recordAuthority(workerId: string, sourceSessionId: string, messages: readonly string[], result: { messageCount: number; overLimitMessageCount: number }): Promise<void> {
    const count = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
    if (!UUID.test(sourceSessionId) || !messages.every((message) => typeof message === "string") || !count(result.messageCount) || !count(result.overLimitMessageCount)) {
      throw new StoreError("invalid_request", "Invalid authority record.");
    }
    await this.shared.transaction(async (db) => {
      const row = await this.#lock(db, workerId);
      if (!row.inherit_authority) throw new StoreError("invalid_state", "This worker does not inherit human authority.");
      if (row.session_id !== sourceSessionId.toLowerCase()) throw new StoreError("invalid_request", "Authority comes only from the worker's own coordinator session.");
      await db.query(
        `INSERT INTO worker_authority_grants(id,worker_id,source_session_id,messages,message_count,over_limit_count,digest)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), row.id, row.session_id, JSON.stringify(messages), result.messageCount, result.overLimitMessageCount,
          `sha256:${digest(JSON.stringify(messages))}`]);
    });
  }

  /** The authority records of one of the principal's workers, newest first. */
  async authority(principal: string, sessionId: string, workerId: string): Promise<WorkerAuthorityGrant[]> {
    if (!UUID.test(sessionId) || !UUID.test(workerId)) return [];
    return (await this.pool.query<{ source_session_id: string; message_count: number; over_limit_count: number; digest: string; created_at: Date }>(
      `SELECT g.* FROM worker_authority_grants g JOIN session_workers w ON w.id=g.worker_id JOIN shared_sessions s ON s.id=w.session_id
       WHERE g.worker_id=$1 AND w.session_id=$2 AND w.principal=$3 AND s.principal=$3 ORDER BY g.created_at DESC LIMIT 100`,
      [workerId, sessionId, principal])).rows.map((row) => ({
      sourceSessionId: row.source_session_id, messageCount: row.message_count, overLimitCount: row.over_limit_count,
      digest: row.digest, createdAt: row.created_at.toISOString(),
    }));
  }

  async #stop(db: pg.PoolClient, row: WorkerRow, reason: WorkerStopReason, error?: string): Promise<void> {
    const updated = await db.query(
      `UPDATE session_workers SET state='stopped',stop_reason=$2,stopped_at=clock_timestamp(),last_error=COALESCE($3,last_error),
       idle_since=NULL,interrupt_requested_at=NULL,last_activity_at=clock_timestamp() WHERE id=$1 AND state<>'stopped'`,
      [row.id, reason, error?.slice(0, 1000) ?? null]);
    if (!updated.rowCount) return;
    await db.query("UPDATE worker_messages SET state='cancelled' WHERE worker_id=$1 AND state='pending'", [row.id]);
    await db.query("UPDATE worker_input_requests SET state='cancelled',resolved_at=clock_timestamp() WHERE worker_id=$1 AND state='pending'", [row.id]);
    if (reason === "failed") await this.#notify(db, row, "failed", { error: (error ?? "The worker failed.").slice(0, 1000) });
    else if (BACKSTOPS.has(reason)) await this.#notify(db, row, "stopped", { reason });
    if (row.allocation_id === null && row.container_started_at === null) await this.#release(db, row.id);
  }

  async #release(db: pg.PoolClient, id: string): Promise<void> {
    const row = (await db.query<{ session_id: string; token_budget: number; tokens_used: string; settled: boolean }>(
      `UPDATE session_workers SET released_at=clock_timestamp(),container_started_at=NULL,
       container_ms=container_ms+CASE WHEN container_started_at IS NULL THEN 0
         ELSE GREATEST(0,floor(extract(epoch FROM clock_timestamp()-container_started_at)*1000))::bigint END
       WHERE id=$1 AND state='stopped' AND released_at IS NULL RETURNING session_id,token_budget,tokens_used,settled`, [id])).rows[0];
    if (!row || row.settled) return;
    await db.query("UPDATE shared_sessions SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$3 WHERE id=$1",
      [row.session_id, row.token_budget, Number(row.tokens_used)]);
    await db.query("UPDATE session_workers SET settled=true,charged_tokens=tokens_used WHERE id=$1", [id]);
  }

  async #notify(db: pg.PoolClient, row: Pick<WorkerRow, "id" | "session_id">, kind: WorkerEventKind, detail: Record<string, unknown>): Promise<void> {
    await db.query("INSERT INTO worker_inbox(id,session_id,worker_id,kind,detail) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), row.session_id, row.id, kind, JSON.stringify(detail)]);
  }

  async #owned(principal: string, sessionId: string, db: pg.Pool | pg.PoolClient = this.pool): Promise<void> {
    if (!UUID.test(sessionId)) throw new StoreError("not_found", "The shared conversation was not found.");
    const owned = await db.query("SELECT 1 FROM shared_sessions WHERE id=$1 AND principal=$2", [sessionId, principal]);
    if (!owned.rowCount) throw new StoreError("not_found", "The shared conversation was not found.");
  }

  async #view(db: pg.PoolClient | pg.Pool, id: string): Promise<WorkerView> {
    const row = (await db.query<WorkerRow>(`${WORKER_SELECT} WHERE w.id=$1`, [id])).rows[0];
    if (!row) throw new StoreError("not_found", "The worker was not found.");
    return view(row);
  }

  async #resolve(db: pg.PoolClient, sessionId: string, reference: string): Promise<WorkerRow> {
    const byId = UUID.test(reference);
    const row = (await db.query<WorkerRow>(
      `SELECT * FROM session_workers WHERE session_id=$1 AND ${byId ? "id=$2" : "name=$2"} FOR UPDATE`,
      [sessionId, byId ? reference.toLowerCase() : reference])).rows[0];
    if (!row) throw new StoreError("not_found", "No worker with that name or id belongs to this conversation.");
    return row;
  }

  async #lock(db: pg.PoolClient, workerId: string): Promise<WorkerRow> {
    if (!UUID.test(workerId)) throw new StoreError("not_found", "The worker was not found.");
    const row = (await db.query<WorkerRow>("SELECT * FROM session_workers WHERE id=$1 FOR UPDATE", [workerId])).rows[0];
    if (!row) throw new StoreError("not_found", "The worker was not found.");
    return row;
  }
}
