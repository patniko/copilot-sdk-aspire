import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type pg from "pg";
import {
  HandoffErrorCode, HandoffPayload, HandoffTarget, HandoffView, HostingPrerequisite, PROMOTION_EXCLUDED_STATE_FILES,
  SharedHarnessRef, SharedSessionDefinition,
  type HandoffApprover, type HandoffHistory, type HandoffState, type HostingApproval, type PlacementKind,
} from "@copilot-agent/contracts";
import type { SessionFileLease } from "./session-files.js";
import type { SharedStore } from "./shared-store.js";
import { StoreError } from "./store.js";

export interface HandoffRecord {
  id: string;
  sessionId: string;
  principal: string;
  requestKey: string;
  state: HandoffState;
  fromGeneration: number;
  fromPlacement: PlacementKind;
  source: SharedHarnessRef;
  target: HandoffTarget;
  toPlacement?: PlacementKind;
  history: HandoffHistory;
  approval: HostingApproval;
  approvedBy?: HandoffApprover;
  payload: HandoffPayload;
  toGeneration?: number;
  ahpSessionId?: string;
  notified: boolean;
  /** Whether the target's storage was prepared; see {@link HandoffStore.prepareStorage}. */
  prepared: boolean;
  view: HandoffView;
}

export interface HandoffRequest {
  principal: string;
  sessionId: string;
  /** Idempotency: the transfer tool call that asked. */
  requestKey: string;
  /** The segment the source runs in; the handoff is refused when the session has moved on. */
  fromGeneration: number;
  fromPlacement: PlacementKind;
  source: SharedHarnessRef;
  /** The target's name, with the version, digest, and mode it resolved to when the checks got that far. */
  target: HandoffTarget;
  toPlacement?: PlacementKind;
  history: HandoffHistory;
  approval: HostingApproval;
  approvedBy?: HandoffApprover;
  payload: HandoffPayload;
  /** A check before transfer failed: the handoff is recorded as refused and nothing else changes. */
  refusal?: { code: HandoffErrorCode; message: string; prerequisite?: HostingPrerequisite };
}

/** Provider keys a cutover rewrites in the session's storage namespace. */
export interface HandoffStorageAreas {
  /** The runtime's session-state root (`sessionStatePath`). */
  state: string;
  /** Where a fresh runtime session moves the source's runtime state aside. It must not exist yet. */
  archive: string;
}

/** What a same-placement cutover installs. */
export interface SharedHandoffCutover {
  /** The target's admitted session definition, which replaces the session's definition. */
  definition: SharedSessionDefinition;
  /** The runtime session the target's segment runs and clients attach to. */
  ahpSessionId: string;
}

interface HandoffRow {
  id: string; session_id: string; principal: string; request_key: string; state: HandoffState;
  from_generation: number; from_placement: PlacementKind; source: unknown; target_name: string; target: unknown;
  to_placement: PlacementKind | null; history: HandoffHistory; approval: HostingApproval; approved_by: HandoffApprover | null;
  payload: unknown; to_generation: number | null; ahp_session_id: string | null;
  error_code: string | null; error_message: string | null; error_prerequisite: unknown;
  notified_at: Date | null; storage_prepared_at: Date | null; created_at: Date; committed_at: Date | null; failed_at: Date | null;
}

/** A cutover the ledger refused; the transaction rolls back and the handoff fails with `code`. */
class CutoverRefused extends Error {
  constructor(readonly code: HandoffErrorCode, message: string) { super(message); }
}

const PROVIDER_KEY = /^\/[^\0\\]*$/;

/**
 * The handoff ledger (docs/HOSTING-MODES-PLAN.md, section 7.5). It records each transfer once per tool call, with the
 * source and target snapshots, history policy, payload, and approval, keeps at most one handoff of a session open,
 * and performs the cutover commit that starts the target's segment under the same application session.
 */
export class HandoffStore {
  constructor(private readonly pool: pg.Pool, private readonly shared: SharedStore) {}

  /**
   * Records a handoff, or returns the one already recorded for this request key. A refusal passed by the caller, a
   * session that changed segment, or a handoff or promotion already in progress records it as `refused`; otherwise
   * it is `accepted`. `created` is true only for a new record.
   */
  async request(input: HandoffRequest): Promise<{ handoff: HandoffRecord; created: boolean }> {
    const payload = HandoffPayload.parse(input.payload);
    const source = SharedHarnessRef.parse(input.source);
    const target = HandoffTarget.parse(input.target);
    if (!input.principal || !input.requestKey || input.requestKey.length > 200 || !Number.isSafeInteger(input.fromGeneration) || input.fromGeneration < 1) {
      throw new StoreError("invalid_request", "Invalid handoff request.");
    }
    if (!input.refusal && (!input.toPlacement || !input.approvedBy || !target.version || !target.digest || !target.mode)) {
      throw new StoreError("invalid_request", "An accepted handoff needs a resolved target, its placement, and its approver.");
    }
    return this.shared.transaction(async (db) => {
      const repeated = (await db.query<HandoffRow>("SELECT * FROM session_handoffs WHERE session_id=$1 AND request_key=$2",
        [input.sessionId, input.requestKey])).rows[0];
      if (repeated) {
        if (repeated.principal !== input.principal) throw new StoreError("not_found", "The conversation was not found.");
        return { handoff: record(repeated), created: false };
      }
      const session = (await db.query<{ principal: string; closed: boolean; placement: string; placement_generation: number }>(
        "SELECT principal,closed,placement,placement_generation FROM shared_sessions WHERE id=$1 FOR UPDATE", [input.sessionId])).rows[0];
      if (!session || session.principal !== input.principal) throw new StoreError("not_found", "The conversation was not found.");
      let refusal = input.refusal;
      if (!refusal && input.fromPlacement === "container" && input.toPlacement === "shared") {
        refusal = { code: "handoff_one_way", message: "A conversation in a container never moves back to shared placement." };
      }
      if (!refusal && (session.closed || session.placement !== input.fromPlacement || session.placement_generation !== input.fromGeneration)) {
        refusal = { code: "session_changed", message: "The conversation closed or moved before the handoff could start." };
      }
      if (!refusal) {
        const busy = await db.query(
          `SELECT 1 FROM session_handoffs WHERE session_id=$1 AND state='accepted'
           UNION ALL SELECT 1 FROM session_promotions WHERE session_id=$1 AND state IN ('requested','moving','starting')`, [input.sessionId]);
        if (busy.rowCount) refusal = { code: "handoff_busy", message: "Another handoff or a promotion of this conversation is in progress." };
      }
      const inserted = await db.query<HandoffRow>(
        `INSERT INTO session_handoffs(id,session_id,principal,request_key,state,from_generation,from_placement,source,target_name,target,
           to_placement,history,approval,approved_by,payload,error_code,error_message,error_prerequisite,failed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,CASE WHEN $5::text='refused' THEN clock_timestamp() END)
         RETURNING *`,
        [randomUUID(), input.sessionId, input.principal, input.requestKey, refusal ? "refused" : "accepted", input.fromGeneration,
          input.fromPlacement, JSON.stringify(source), target.name, target.version ? JSON.stringify(target) : null, input.toPlacement ?? null,
          input.history, input.approval, refusal ? null : input.approvedBy, JSON.stringify(payload),
          refusal ? HandoffErrorCode.parse(refusal.code) : null, refusal ? refusal.message.slice(0, 500) : null,
          refusal?.prerequisite ? JSON.stringify(HostingPrerequisite.parse(refusal.prerequisite)) : null]);
      return { handoff: record(inserted.rows[0]!), created: true };
    });
  }

  async byId(id: string): Promise<HandoffRecord | undefined> {
    const row = (await this.pool.query<HandoffRow>("SELECT * FROM session_handoffs WHERE id=$1", [id])).rows[0];
    return row ? record(row) : undefined;
  }

  /** The handoff recorded for one request key of a session, if any. */
  async byRequest(sessionId: string, requestKey: string): Promise<HandoffRecord | undefined> {
    const row = (await this.pool.query<HandoffRow>("SELECT * FROM session_handoffs WHERE session_id=$1 AND request_key=$2", [sessionId, requestKey])).rows[0];
    return row ? record(row) : undefined;
  }

  /** The session's accepted handoff: while one exists, the conversation admits no new turns. */
  async open(sessionId: string): Promise<HandoffRecord | undefined> {
    const row = (await this.pool.query<HandoffRow>("SELECT * FROM session_handoffs WHERE session_id=$1 AND state='accepted'", [sessionId])).rows[0];
    return row ? record(row) : undefined;
  }

  /** Accepted handoffs whose cutover has not happened, oldest first, for recovery after a restart. */
  async pending(placement: PlacementKind, limit = 16): Promise<HandoffRecord[]> {
    return (await this.pool.query<HandoffRow>(
      "SELECT * FROM session_handoffs WHERE state='accepted' AND from_placement=$1 ORDER BY created_at LIMIT $2", [placement, limit])).rows.map(record);
  }

  /** The committed handoff that started a session's segment, if that segment came from a handoff. */
  async forSegment(sessionId: string, generation: number): Promise<HandoffRecord | undefined> {
    const row = (await this.pool.query<HandoffRow>(
      "SELECT * FROM session_handoffs WHERE session_id=$1 AND state='committed' AND to_generation=$2", [sessionId, generation])).rows[0];
    return row ? record(row) : undefined;
  }

  /** A session's handoffs for its owner, newest first. */
  async list(principal: string, sessionId: string, limit = 50): Promise<HandoffView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError("invalid_request", "Invalid handoff page size.");
    return (await this.pool.query<HandoffRow>(
      "SELECT * FROM session_handoffs WHERE session_id=$1 AND principal=$2 ORDER BY created_at DESC, id LIMIT $3", [sessionId, principal, limit]))
      .rows.map((row) => record(row).view);
  }

  /**
   * The same-placement cutover commit, in one ledger transaction: replace the session's definition with the target's,
   * move it to the next generation in the same placement (the connection broker then closes attached clients with
   * "moved"), void its outstanding tickets and activation, record the new segment, and commit the handoff. It writes no
   * session files: the target's first activation prepares storage with {@link prepareStorage} before its runtime opens.
   * A session that closed or changed fails the handoff instead and leaves the source in control.
   */
  async commitShared(id: string, cutover: SharedHandoffCutover): Promise<{ generation: number }> {
    const definition = SharedSessionDefinition.parse(cutover.definition);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(cutover.ahpSessionId)) throw new StoreError("invalid_request", "Invalid runtime session.");
    try {
      return await this.shared.transaction(async (db) => {
        const handoff = (await db.query<HandoffRow>("SELECT * FROM session_handoffs WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!handoff || handoff.state !== "accepted" || handoff.to_placement !== "shared" || handoff.from_placement !== "shared") {
          throw new StoreError("invalid_state", "The handoff is not ready for a shared cutover.");
        }
        const target = HandoffTarget.parse(handoff.target);
        if (definition.harness?.name !== target.name || definition.harness.version !== target.version || definition.harness.digest !== target.digest) {
          throw new StoreError("invalid_request", "The cutover definition is not the handoff's target.");
        }
        const continuing = await this.#currentRuntime(db, handoff.session_id, handoff.from_generation);
        if ((handoff.history === "full") !== (cutover.ahpSessionId === continuing)) {
          throw new StoreError("invalid_request", "Full history continues the source's runtime session; other history starts a new one.");
        }
        const moved = (await db.query<{ placement_generation: number }>(
          `UPDATE shared_sessions SET definition=$5,placement_generation=placement_generation+1,last_activity_at=clock_timestamp()
           WHERE id=$1 AND principal=$2 AND NOT closed AND placement=$3 AND placement_generation=$4 RETURNING placement_generation`,
          [handoff.session_id, handoff.principal, handoff.from_placement, handoff.from_generation, JSON.stringify(definition)])).rows[0];
        if (!moved) throw new CutoverRefused("session_changed", "The conversation closed or moved during the handoff.");
        await db.query("DELETE FROM shared_connection_tickets WHERE session_id=$1 AND used_at IS NULL", [handoff.session_id]);
        await db.query("DELETE FROM shared_activations WHERE session_id=$1", [handoff.session_id]);
        const generation = moved.placement_generation;
        await db.query(
          `INSERT INTO session_segments(session_id,generation,placement,reason,harness,ahp_session_id,handoff_id)
           VALUES($1,$2,'shared','handoff',$3,$4,$5)`,
          [handoff.session_id, generation, JSON.stringify({ name: target.name, version: target.version, digest: target.digest }), cutover.ahpSessionId, id]);
        await db.query(
          `UPDATE session_handoffs SET state='committed',to_generation=$2,ahp_session_id=$3,committed_at=clock_timestamp(),updated_at=clock_timestamp()
           WHERE id=$1`, [id, generation, cutover.ahpSessionId]);
        return { generation };
      });
    } catch (error) {
      if (!(error instanceof CutoverRefused)) throw error;
      await this.fail(id, error.code, error.message);
      throw new StoreError("invalid_state", error.message);
    }
  }

  /**
   * Prepares the session's storage for the segment a committed handoff started, once, under the activation's lease
   * and before its runtime opens: without full history the source's runtime state moves to `areas.archive`, where it is
   * retained, so the target starts a fresh runtime session; with full history the runtime session continues without
   * the source's session-scoped consent files. Returns false when the segment's storage was already prepared.
   */
  async prepareStorage(id: string, lease: SessionFileLease, areas: HandoffStorageAreas): Promise<boolean> {
    const { state, archive } = areas;
    for (const key of [state, archive]) {
      if (!PROVIDER_KEY.test(key) || key === "/" || key.endsWith("/") || key.split("/").includes("..")) throw new StoreError("invalid_request", "Invalid handoff storage area.");
    }
    if (archive === state || archive.startsWith(`${state}/`) || state.startsWith(`${archive}/`)) throw new StoreError("invalid_request", "Handoff storage areas must not overlap.");
    return this.shared.transaction(async (db) => {
      const handoff = (await db.query<HandoffRow>("SELECT * FROM session_handoffs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!handoff || handoff.state !== "committed" || handoff.session_id !== lease.id || handoff.principal !== lease.principal) {
        throw new StoreError("invalid_state", "The handoff has no committed segment to prepare.");
      }
      if (handoff.storage_prepared_at) return false;
      const namespace = await db.query(
        "SELECT 1 FROM session_file_namespaces WHERE id=$1 AND principal=$2 AND epoch=$3 AND lease_until>clock_timestamp() FOR UPDATE",
        [lease.id, lease.principal, lease.epoch]);
      if (!namespace.rowCount) throw new StoreError("invalid_state", "The conversation's storage lease is no longer active.");
      if (handoff.history === "full") {
        await db.query("DELETE FROM session_files WHERE namespace_id=$1 AND NOT directory AND path=ANY($2::text[])",
          [lease.id, PROMOTION_EXCLUDED_STATE_FILES.map((name) => `${state}/${name}`)]);
      } else {
        await this.#archive(db, lease.id, state, archive);
      }
      await db.query("UPDATE session_handoffs SET storage_prepared_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id]);
      return true;
    });
  }

  /**
   * Fails an accepted handoff before its cutover: the source stays in control and the conversation admits turns again.
   * Failing a refused or failed handoff returns it unchanged; a committed handoff cannot fail.
   */
  async fail(id: string, code: HandoffErrorCode, message: string): Promise<HandoffRecord> {
    HandoffErrorCode.parse(code);
    const row = (await this.pool.query<HandoffRow>(
      `UPDATE session_handoffs SET state='failed',failed_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=$2,error_message=$3
       WHERE id=$1 AND state='accepted' RETURNING *`, [id, code, message.slice(0, 500)])).rows[0];
    if (row) return record(row);
    const current = await this.byId(id);
    if (!current) throw new StoreError("not_found", "The handoff was not found.");
    if (current.state === "committed") throw new StoreError("invalid_state", "A committed handoff cannot fail; the target is in control.");
    return current;
  }

  /** Records that the conversation was told about the handoff's outcome; returns false when it already was. */
  async markNotified(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE session_handoffs SET notified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state IN ('committed','failed') AND notified_at IS NULL", [id]);
    return result.rowCount === 1;
  }

  /** The latest failed handoff from a session's current segment that the source was not yet told about. */
  async unnotifiedFailure(sessionId: string, generation: number): Promise<HandoffRecord | undefined> {
    const row = (await this.pool.query<HandoffRow>(
      `SELECT * FROM session_handoffs WHERE session_id=$1 AND state='failed' AND from_generation=$2 AND notified_at IS NULL
       ORDER BY failed_at DESC LIMIT 1`, [sessionId, generation])).rows[0];
    return row ? record(row) : undefined;
  }

  async #currentRuntime(db: pg.PoolClient, sessionId: string, generation: number): Promise<string> {
    const row = (await db.query<{ ahp_session_id: string }>(
      "SELECT ahp_session_id FROM session_segments WHERE session_id=$1 AND generation=$2", [sessionId, generation])).rows[0];
    return row?.ahp_session_id ?? sessionId;
  }

  /** Moves the runtime state subtree to `archive`, creating its missing parent directories. */
  async #archive(db: pg.PoolClient, namespace: string, state: string, archive: string): Promise<void> {
    const present = await db.query("SELECT 1 FROM session_files WHERE namespace_id=$1 AND path=$2", [namespace, state]);
    if (!present.rowCount) return;
    const occupied = await db.query("SELECT 1 FROM session_files WHERE namespace_id=$1 AND (path=$2 OR starts_with(path,$3)) LIMIT 1",
      [namespace, archive, `${archive}/`]);
    if (occupied.rowCount) throw new StoreError("invalid_state", "The handoff's storage area is already in use.");
    const ancestors: string[] = [];
    for (let parent = posix.dirname(archive); parent !== "/"; parent = posix.dirname(parent)) ancestors.unshift(parent);
    ancestors.unshift("/");
    const files = await db.query("SELECT 1 FROM session_files WHERE namespace_id=$1 AND path=ANY($2::text[]) AND NOT directory", [namespace, ancestors]);
    if (files.rowCount) throw new StoreError("invalid_state", "A file occupies the handoff's storage area.");
    await db.query(
      "INSERT INTO session_files(namespace_id,path,directory) SELECT $1,unnest($2::text[]),true ON CONFLICT (namespace_id,path) DO NOTHING",
      [namespace, ancestors]);
    await db.query(
      `UPDATE session_files SET path=$3 || substring(path from length($2)+1),updated_at=clock_timestamp(),
         display_name=CASE WHEN path=$2 THEN NULL ELSE display_name END
       WHERE namespace_id=$1 AND (path=$2 OR starts_with(path,$4))`,
      [namespace, state, archive, `${state}/`]);
  }
}

function record(row: HandoffRow): HandoffRecord {
  const source = SharedHarnessRef.parse(row.source);
  const target = HandoffTarget.parse(row.target ?? { name: row.target_name });
  const payload = HandoffPayload.parse(row.payload);
  const error = row.error_code ? {
    code: HandoffErrorCode.parse(row.error_code), message: row.error_message ?? "",
    ...(row.error_prerequisite ? { prerequisite: HostingPrerequisite.parse(row.error_prerequisite) } : {}),
  } : undefined;
  return {
    id: row.id, sessionId: row.session_id, principal: row.principal, requestKey: row.request_key, state: row.state,
    fromGeneration: row.from_generation, fromPlacement: row.from_placement, source, target,
    ...(row.to_placement ? { toPlacement: row.to_placement } : {}),
    history: row.history, approval: row.approval, ...(row.approved_by ? { approvedBy: row.approved_by } : {}), payload,
    ...(row.to_generation ? { toGeneration: row.to_generation } : {}),
    ...(row.ahp_session_id ? { ahpSessionId: row.ahp_session_id } : {}),
    notified: row.notified_at !== null,
    prepared: row.storage_prepared_at !== null,
    view: HandoffView.parse({
      id: row.id, state: row.state, source, target, history: row.history, approval: row.approval,
      ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
      reason: payload.reason, ...(payload.summary ? { summary: payload.summary } : {}),
      from: { generation: row.from_generation, placement: row.from_placement },
      ...(row.to_generation && row.to_placement && row.ahp_session_id
        ? { to: { generation: row.to_generation, placement: row.to_placement, ahpSessionId: row.ahp_session_id } }
        : {}),
      requestedAt: row.created_at.toISOString(),
      ...(row.committed_at ? { committedAt: row.committed_at.toISOString() } : {}),
      ...(row.failed_at ? { failedAt: row.failed_at.toISOString() } : {}),
      ...(error ? { error } : {}),
    }),
  };
}
