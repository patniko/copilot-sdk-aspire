import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type pg from "pg";
import {
  ContainerSize, HarnessDefinition, PROMOTION_EXCLUDED_STATE_DIRECTORIES, PROMOTION_EXCLUDED_STATE_FILES, PROMOTION_SNAPSHOT_LIMITS, PromotionErrorCode,
  PromotionKind, PromotionNotice, PromotionSnapshotManifest, PromotionSnapshotPath, PromotionView, promotionSnapshotDigestInput, RuntimeSessionId,
  SharedSessionDefinition, type HarnessSnapshot, type PromotionSnapshotEntry, type PromotionSource, type PromotionState, type SharedWorkerLimits,
} from "@copilot-agent/contracts";
import { AllocationStore } from "./allocations.js";
import { promotionView } from "./promotion-views.js";
import type { SessionFileLease } from "./session-files.js";
import type { SharedStore } from "./shared-store.js";
import { StoreError } from "./store.js";

/** What a move changes besides placement: the harness snapshot the container runs and the definition the cutover installs. */
export interface PromotionTarget {
  harness: HarnessSnapshot;
  /** Replaces `shared_sessions.definition` at cutover (model, limits, harness reference); unchanged when absent. */
  definition?: SharedSessionDefinition;
}

export interface PromotionRecord {
  id: string;
  sessionId: string;
  principal: string;
  source: PromotionSource;
  requestKey: string;
  kind: PromotionKind;
  /** Whether the snapshot carries the runtime history; without it the container creates `runtimeSessionId` fresh. */
  history: boolean;
  /** The runtime (AHP) session the new segment runs. */
  runtimeSessionId: string;
  notice?: string;
  target?: PromotionTarget;
  state: PromotionState;
  size: string;
  resources: ContainerSize;
  fromGeneration: number;
  snapshotEpoch?: string;
  snapshotDigest?: string;
  allocationId?: string;
  notified: boolean;
  view: PromotionView;
}

export interface PromotionRequest {
  principal: string;
  sessionId: string;
  source: PromotionSource;
  /** Idempotency: the tool call, the API request, or the handoff that asked. */
  requestKey: string;
  reason?: string;
  /** The container size the harness's effective hosting resolved, and its resources from the operator's catalog. */
  size: string;
  resources: ContainerSize;
  /** `handoff` for stage-6 handoffs, which their own ledger reports; `promotion` by default. */
  kind?: PromotionKind;
  /** Whether the snapshot carries the runtime history; true by default. */
  history?: boolean;
  /**
   * The runtime session the new segment runs. With history it must be the session's current one (the default);
   * without, it must be new (default: a new UUID).
   */
  runtimeSessionId?: string;
  /** Sent once by the container in place of the standard move continuation; see {@link PromotionNotice}. */
  notice?: string;
  /** A harness snapshot, and optionally a session definition, that differ from the session's admitted ones. */
  target?: PromotionTarget;
}

/** How long and how long idle the session container started for a promotion may run (the session-container settings). */
export interface PromotionContainerSettings { idleSeconds: number; startupSeconds: number; maxLifetimeSeconds: number }

/** The volume a promoted session's container keeps: its retained session volume, as for mode-1 sessions. */
export const PROMOTION_VOLUME_TARGET = "/data";

/** Provider keys of the two snapshot areas in the session's storage namespace. */
export interface PromotionStorageAreas {
  /** The runtime's session-state directory (`sessionStatePath`), stored flat per session. */
  state: string;
  /** The session's workspace anchor. */
  workspace: string;
  /** The anchor's provider path in its original spelling, as the conversation's history names it. */
  workspacePath?: string;
}

export interface PromotionSnapshotPage {
  promotionId: string;
  sessionId: string;
  digest: string;
  manifest: PromotionSnapshotManifest;
  /** File contents for manifest ordinals in ascending order, starting at the requested ordinal. */
  files: Array<{ ordinal: number; content: Buffer }>;
  /** The ordinal to request next, or undefined when every file was returned. */
  next?: number;
}

interface PromotionRow {
  id: string; session_id: string; principal: string; source: PromotionSource; request_key: string; reason: string;
  kind: PromotionKind; history: boolean; runtime_session_id: string; notice: string | null;
  target_harness: HarnessSnapshot | null; target_definition: unknown;
  state: PromotionState; size: string; resources: ContainerSize; from_generation: number;
  snapshot_epoch: string | null; snapshot_digest: string | null; allocation_id: string | null; previous_workspace: string | null;
  error_code: string | null; error_message: string | null; notified_at: Date | null;
  created_at: Date; committed_at: Date | null; failed_at: Date | null;
}
interface StoredEntry { path: string; directory: boolean; display_name: string | null; size: number | null; sha256: string | null }

const OPEN = ["requested", "moving", "starting"] as const;
const PAGE_BYTES = 4 * 1024 * 1024;

/** A cutover the ledger refused; the transaction rolls back and the promotion fails with `code`. */
class CutoverRefused extends Error {
  constructor(readonly code: PromotionErrorCode, message: string) { super(message); }
}

/**
 * The promotion ledger (docs/HOSTING-MODES-PLAN.md, section 7.3). It records requests idempotently, captures the
 * snapshot under a fenced storage lease, serves it only to the allocation started for the move, and performs the
 * one-way cutover commit. Nothing here demotes a session; the ledger's trigger refuses any return to shared placement.
 */
export class PromotionStore {
  readonly #allocations: AllocationStore;

  constructor(private readonly pool: pg.Pool, private readonly shared: SharedStore, allocations?: AllocationStore) {
    this.#allocations = allocations ?? new AllocationStore(pool, shared);
  }

  /**
   * Records a move for a shared session, or returns the one that already answers it: the same request, the session's
   * open move of any kind, or, for a promotion, its committed promotion. `created` is true only for a new record.
   */
  async request(input: PromotionRequest): Promise<{ promotion: PromotionRecord; created: boolean }> {
    const resources = ContainerSize.parse(input.resources);
    const reason = (input.reason ?? "").trim();
    const kind = PromotionKind.safeParse(input.kind ?? "promotion");
    if (!input.principal || !input.requestKey || input.requestKey.length > 200 || reason.length > 500 || !/^[a-z][a-z0-9-]{0,62}$/.test(input.size)
      || !kind.success || (input.history !== undefined && typeof input.history !== "boolean")
      || (input.notice !== undefined && !PromotionNotice.safeParse(input.notice).success)
      || (input.runtimeSessionId !== undefined && !RuntimeSessionId.safeParse(input.runtimeSessionId).success)) {
      throw new StoreError("invalid_request", "Invalid promotion request.");
    }
    const target = input.target === undefined ? undefined : promotionTarget(input.target);
    const history = input.history ?? true;
    return this.shared.transaction(async (db) => {
      const repeated = (await db.query<PromotionRow>("SELECT * FROM session_promotions WHERE session_id=$1 AND request_key=$2",
        [input.sessionId, input.requestKey])).rows[0];
      if (repeated) {
        if (repeated.principal !== input.principal) throw new StoreError("not_found", "The conversation was not found.");
        return { promotion: record(repeated), created: false };
      }
      const session = (await db.query<{ id: string; principal: string; closed: boolean; placement: string; placement_generation: number }>(
        "SELECT id,principal,closed,placement,placement_generation FROM shared_sessions WHERE id=$1 FOR UPDATE", [input.sessionId])).rows[0];
      if (!session || session.principal !== input.principal) throw new StoreError("not_found", "The conversation was not found.");
      const existing = (await db.query<PromotionRow>(
        `SELECT * FROM session_promotions WHERE session_id=$1
           AND (state IN ('requested','moving','starting') OR (state='committed' AND kind='promotion' AND $2='promotion'))
         ORDER BY created_at DESC LIMIT 1`, [input.sessionId, kind.data])).rows[0];
      if (existing) return { promotion: record(existing), created: false };
      if (session.closed) throw new StoreError("not_found", "The conversation is closed.");
      if (session.placement !== "shared") throw new StoreError("invalid_state", "Only a conversation in shared placement can be promoted.");
      // The runtime session the conversation runs now: the latest recorded segment's, else the implicit first one's.
      const current = (await db.query<{ ahp_session_id: string }>(
        "SELECT ahp_session_id FROM session_segments WHERE session_id=$1 ORDER BY generation DESC LIMIT 1", [session.id])).rows[0]?.ahp_session_id ?? session.id;
      const runtimeSessionId = input.runtimeSessionId ?? (history ? current : randomUUID());
      if (history && runtimeSessionId !== current) {
        throw new StoreError("invalid_request", "A move that carries the history continues the conversation's current runtime session.");
      }
      if (!history && runtimeSessionId === current) throw new StoreError("invalid_request", "A fresh runtime session needs a new identifier.");
      const inserted = await db.query<PromotionRow>(
        `INSERT INTO session_promotions(id,session_id,principal,source,request_key,reason,kind,history,runtime_session_id,notice,target_harness,
           target_definition,state,size,resources,from_generation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'requested',$13,$14,$15) RETURNING *`,
        [randomUUID(), session.id, input.principal, input.source, input.requestKey, reason, kind.data, history, runtimeSessionId, input.notice ?? null,
          target ? JSON.stringify(target.harness) : null, target?.definition ? JSON.stringify(target.definition) : null, input.size,
          JSON.stringify(resources), session.placement_generation]);
      return { promotion: record(inserted.rows[0]!), created: true };
    });
  }

  async byId(id: string): Promise<PromotionRecord | undefined> {
    const row = (await this.pool.query<PromotionRow>("SELECT * FROM session_promotions WHERE id=$1", [id])).rows[0];
    return row ? record(row) : undefined;
  }

  /** The session's open promotion, if any: while one exists, the shared placement admits no new turns. */
  async open(sessionId: string): Promise<PromotionRecord | undefined> {
    const row = (await this.pool.query<PromotionRow>(
      "SELECT * FROM session_promotions WHERE session_id=$1 AND state = ANY($2::text[])", [sessionId, OPEN])).rows[0];
    return row ? record(row) : undefined;
  }

  /** The session's latest promotion, for its owner's views; handoffs are reported by their own ledger. */
  async latest(principal: string, sessionId: string): Promise<PromotionRecord | undefined> {
    const row = (await this.pool.query<PromotionRow>(
      "SELECT * FROM session_promotions WHERE session_id=$1 AND principal=$2 AND kind='promotion' ORDER BY created_at DESC LIMIT 1",
      [sessionId, principal])).rows[0];
    return row ? record(row) : undefined;
  }

  /** Every open promotion, oldest first, for a worker resuming the ones it was driving. */
  async unfinished(): Promise<PromotionRecord[]> {
    return (await this.pool.query<PromotionRow>(
      "SELECT * FROM session_promotions WHERE state = ANY($1::text[]) ORDER BY created_at", [OPEN])).rows.map(record);
  }

  /** Whether the deployment's container limits leave room for one more container for `principal` now. */
  async hasCapacity(principal: string, limits: SharedWorkerLimits): Promise<boolean> {
    const counts = (await this.pool.query<{ total: number; own: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER (WHERE principal=$1)::int AS own
       FROM execution_allocations WHERE state<>'retired'`, [principal])).rows[0]!;
    return counts.total < limits.executionContainers && counts.own < limits.containersPerPrincipal;
  }

  /** `requested` → `moving`: the turn that asked has ended and the shared activation is closing. */
  async begin(id: string): Promise<PromotionRecord> {
    const row = (await this.pool.query<PromotionRow>(
      "UPDATE session_promotions SET state='moving',updated_at=clock_timestamp() WHERE id=$1 AND state IN ('requested','moving') RETURNING *", [id])).rows[0];
    if (!row) throw new StoreError("invalid_state", "The promotion is no longer waiting to move.");
    return record(row);
  }

  /**
   * `moving` → `starting`: reads the session's runtime history and workspace under `lease` in one transaction that
   * holds the namespace lock, so no writer can interleave, and stores an immutable, digest-bound snapshot. State-root
   * consent files are left behind. Entries keep the names they were created with.
   */
  async capture(id: string, lease: SessionFileLease, areas: PromotionStorageAreas): Promise<PromotionRecord> {
    for (const area of [areas.state, areas.workspace]) {
      if (!area.startsWith("/") || area === "/" || area.endsWith("/")) throw new StoreError("invalid_request", "Invalid promotion storage area.");
    }
    if (areas.state.startsWith(`${areas.workspace}/`) || areas.workspace.startsWith(`${areas.state}/`) || areas.state === areas.workspace) {
      throw new StoreError("invalid_request", "Promotion storage areas must not overlap.");
    }
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      try {
        await db.query("SET LOCAL statement_timeout='60s'");
        const promotion = (await db.query<PromotionRow>("SELECT * FROM session_promotions WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!promotion || promotion.state !== "moving" || promotion.session_id !== lease.id || promotion.principal !== lease.principal) {
          throw new StoreError("invalid_state", "The promotion is not ready for its snapshot.");
        }
        const namespace = await db.query(
          "SELECT 1 FROM session_file_namespaces WHERE id=$1 AND principal=$2 AND epoch=$3 AND lease_until>clock_timestamp() FOR UPDATE",
          [lease.id, lease.principal, lease.epoch]);
        if (!namespace.rowCount) throw new StoreError("invalid_state", "The snapshot's storage lease is no longer active.");
        const stored = (await db.query<StoredEntry>(
          `SELECT path,directory,display_name,octet_length(content) AS size,encode(sha256(content),'hex') AS sha256
           FROM session_files WHERE namespace_id=$1 AND (starts_with(path,$2) OR starts_with(path,$3)) ORDER BY path`,
          [lease.id, `${areas.state}/`, `${areas.workspace}/`])).rows
          // A move without history carries only the workspace; the container starts a fresh runtime session.
          .filter((entry) => promotion.history || entry.path.startsWith(`${areas.workspace}/`));
        const { manifest, keys } = snapshotManifest(lease.id, stored, areas);
        const digest = `sha256:${createHash("sha256").update(promotionSnapshotDigestInput(manifest)).digest("hex")}`;
        const files = manifest.entries.flatMap((entry, ordinal) => entry.kind === "file" ? [{ key: keys[ordinal]!, ordinal }] : []);
        const bytes = manifest.entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0);
        await db.query(
          "INSERT INTO session_promotion_snapshots(promotion_id,session_id,digest,manifest,bytes,entries,epoch) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, lease.id, digest, JSON.stringify(manifest), bytes, manifest.entries.length, lease.epoch]);
        const copied = await db.query(
          `INSERT INTO session_promotion_snapshot_files(promotion_id,ordinal,content)
           SELECT $1,m.ordinal,f.content FROM unnest($2::text[],$3::int[]) AS m(key,ordinal)
           JOIN session_files f ON f.namespace_id=$4 AND f.path=m.key AND NOT f.directory`,
          [id, files.map((file) => file.key), files.map((file) => file.ordinal), lease.id]);
        if (copied.rowCount !== files.length) throw new StoreError("invalid_state", "The session storage changed while its snapshot was read.");
        const updated = await db.query<PromotionRow>(
          `UPDATE session_promotions SET state='starting',snapshot_epoch=$2,snapshot_digest=$3,previous_workspace=$4,updated_at=clock_timestamp()
           WHERE id=$1 RETURNING *`, [id, lease.epoch, digest, areas.workspacePath?.slice(0, 4096) || null]);
        await db.query("COMMIT");
        return record(updated.rows[0]!);
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    } finally { db.release(); }
  }

  /** Binds the session allocation started for the move; only that allocation can fetch the snapshot. */
  async attachAllocation(id: string, allocationId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE session_promotions SET allocation_id=$2,updated_at=clock_timestamp()
       WHERE id=$1 AND state='starting' AND (allocation_id IS NULL OR allocation_id=$2)`, [id, allocationId]);
    if (!result.rowCount) throw new StoreError("invalid_state", "The promotion cannot take this allocation.");
  }

  /**
   * Reserves the session container for a captured promotion, in one admission transaction: the container placement
   * record (the session's admitted harness snapshot at the promotion's size) and a session allocation with the
   * session's retained volume, counted against the deployment's container limits. The controller starts it with an
   * allocation-scoped credential; the container then fetches the snapshot. Refuses when the session still has a
   * container from an earlier attempt, or capacity is exhausted (`quota_exceeded`).
   */
  async allocate(id: string, settings: PromotionContainerSettings, limits: SharedWorkerLimits): Promise<string> {
    return this.shared.transaction(async (db) => {
      const promotion = (await db.query<PromotionRow>("SELECT * FROM session_promotions WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!promotion || promotion.state !== "starting" || promotion.allocation_id) throw new StoreError("invalid_state", "The promotion is not ready for a container.");
      const session = (await db.query<{ definition: unknown }>(
        "SELECT definition FROM shared_sessions WHERE id=$1 AND principal=$2 AND NOT closed AND placement='shared' FOR UPDATE",
        [promotion.session_id, promotion.principal])).rows[0];
      if (!session) throw new StoreError("invalid_state", "The conversation closed or changed placement during the move.");
      const admitted = SharedSessionDefinition.parse(session.definition).harness;
      const harness = promotion.target_harness
        ?? (admitted?.definition ? { definition: admitted.definition, digest: admitted.digest } : undefined);
      if (!harness) throw new StoreError("invalid_state", "The conversation has no admitted harness snapshot to run in a container.");
      const earlier = await db.query("SELECT 1 FROM execution_allocations WHERE session_id=$1 AND state<>'retired'", [promotion.session_id]);
      if (earlier.rowCount) throw new StoreError("quota_exceeded", "A container from an earlier attempt is still stopping for this conversation.");
      await db.query(
        `INSERT INTO session_containers(session_id,harness,size,resources) VALUES($1,$2,$3,$4)
         ON CONFLICT(session_id) DO UPDATE SET harness=EXCLUDED.harness,size=EXCLUDED.size,resources=EXCLUDED.resources`,
        [promotion.session_id, JSON.stringify({ definition: HarnessDefinition.parse(harness.definition), digest: harness.digest }),
          promotion.size, JSON.stringify(ContainerSize.parse(promotion.resources))]);
      const allocation = await this.#allocations.request({
        sessionId: promotion.session_id, principal: promotion.principal, purpose: "session", size: promotion.size,
        resources: ContainerSize.parse(promotion.resources),
        volumes: [{ purpose: "session", sessionId: promotion.session_id, target: PROMOTION_VOLUME_TARGET, readOnly: false }],
        idleSeconds: settings.idleSeconds, startupSeconds: settings.startupSeconds, maxLifetimeSeconds: settings.maxLifetimeSeconds,
      }, limits, db);
      await db.query("UPDATE session_promotions SET allocation_id=$2,updated_at=clock_timestamp() WHERE id=$1", [id, allocation.id]);
      return allocation.id;
    });
  }

  /** The state of the allocation started for a promotion, so its driver notices a container that stopped before cutover. */
  async allocationState(id: string): Promise<{ state: string; error?: string } | undefined> {
    const row = (await this.pool.query<{ state: string; last_error: string | null }>(
      "SELECT e.state,e.last_error FROM session_promotions p JOIN execution_allocations e ON e.id=p.allocation_id WHERE p.id=$1", [id])).rows[0];
    return row ? { state: row.state, ...(row.last_error ? { error: row.last_error } : {}) } : undefined;
  }

  /** The promotion an allocation was started for, in any state. */
  async byAllocation(allocationId: string): Promise<PromotionRecord | undefined> {
    const row = (await this.pool.query<PromotionRow>(
      "SELECT * FROM session_promotions WHERE allocation_id=$1 ORDER BY created_at DESC LIMIT 1", [allocationId])).rows[0];
    return row ? record(row) : undefined;
  }

  /**
   * One page of the snapshot for the allocation started for its promotion: the manifest, its digest, and file contents
   * from `from` on, up to about four MiB per page. No other allocation, and no allocation after the promotion settled,
   * can read it.
   */
  async snapshotPage(allocationId: string, from = 0, maxBytes = PAGE_BYTES): Promise<PromotionSnapshotPage> {
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new StoreError("invalid_request", "Invalid snapshot page.");
    const snapshot = (await this.pool.query<{ promotion_id: string; session_id: string; digest: string; manifest: unknown }>(
      `SELECT s.promotion_id,s.session_id,s.digest,s.manifest FROM session_promotions p
       JOIN session_promotion_snapshots s ON s.promotion_id=p.id AND s.session_id=p.session_id AND s.digest=p.snapshot_digest
       WHERE p.allocation_id=$1 AND p.state='starting'`, [allocationId])).rows[0];
    if (!snapshot) throw new StoreError("not_found", "No promotion snapshot is available to this allocation.");
    const manifest = PromotionSnapshotManifest.parse(snapshot.manifest);
    const sizes = (await this.pool.query<{ ordinal: number; size: number }>(
      "SELECT ordinal,octet_length(content) AS size FROM session_promotion_snapshot_files WHERE promotion_id=$1 AND ordinal>=$2 ORDER BY ordinal",
      [snapshot.promotion_id, from])).rows;
    const selected: number[] = [];
    let total = 0;
    for (const row of sizes) {
      if (selected.length && total + row.size > maxBytes) break;
      selected.push(row.ordinal);
      total += row.size;
    }
    const files = selected.length ? (await this.pool.query<{ ordinal: number; content: Buffer }>(
      "SELECT ordinal,content FROM session_promotion_snapshot_files WHERE promotion_id=$1 AND ordinal=ANY($2::int[]) ORDER BY ordinal",
      [snapshot.promotion_id, selected])).rows : [];
    const next = sizes.length > selected.length ? sizes[selected.length]!.ordinal : undefined;
    return {
      promotionId: snapshot.promotion_id, sessionId: snapshot.session_id, digest: snapshot.digest, manifest,
      files: files.map((file) => ({ ordinal: file.ordinal, content: file.content })), ...(next !== undefined ? { next } : {}),
    };
  }

  /**
   * The cutover commit, in one transaction: fence the shared storage lease (its epoch must still be the one the snapshot
   * was read under, so no shared write followed the snapshot), move the session to `container` placement at the next
   * generation, void its outstanding shared tickets and activation, record the new segment, and commit the promotion.
   * A stale snapshot or a changed session fails the promotion instead; the session stays shared.
   */
  async commit(id: string, allocationId?: string): Promise<{ generation: number }> {
    try {
      return await this.shared.transaction(async (db) => {
        const promotion = (await db.query<PromotionRow>("SELECT * FROM session_promotions WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!promotion || promotion.state !== "starting" || !promotion.snapshot_epoch) {
          throw new StoreError("invalid_state", "The promotion is not ready to commit.");
        }
        if (allocationId !== undefined && promotion.allocation_id !== allocationId) {
          throw new StoreError("invalid_state", "Only the allocation started for the promotion can complete it.");
        }
        if (promotion.allocation_id) {
          const running = await db.query(
            "SELECT 1 FROM execution_allocations WHERE id=$1 AND state IN ('starting','running') AND expires_at>clock_timestamp()",
            [promotion.allocation_id]);
          if (!running.rowCount) throw new CutoverRefused("startup_failed", "The promotion's container stopped before the cutover.");
        }
        // A target definition (a handoff's model, limits, and harness reference) replaces the session's in the same commit.
        const session = (await db.query<{ definition: unknown }>(
          `UPDATE shared_sessions SET placement='container',placement_generation=placement_generation+1,last_activity_at=clock_timestamp(),
             definition=COALESCE($4::jsonb,definition)
           WHERE id=$1 AND principal=$2 AND NOT closed AND placement='shared' AND placement_generation=$3 RETURNING definition`,
          [promotion.session_id, promotion.principal, promotion.from_generation,
            promotion.target_definition ? JSON.stringify(promotion.target_definition) : null])).rows[0];
        if (!session) throw new CutoverRefused("session_changed", "The conversation closed or changed placement during the move.");
        const fenced = await db.query(
          `UPDATE session_file_namespaces SET epoch=$3,worker=$4,lease_until='infinity'
           WHERE id=$1 AND principal=$2 AND epoch=$5`,
          [promotion.session_id, promotion.principal, randomUUID(), `promoted:${id}`, promotion.snapshot_epoch]);
        if (!fenced.rowCount) throw new CutoverRefused("snapshot_stale", "The conversation's storage changed after its snapshot was read.");
        await db.query("DELETE FROM shared_connection_tickets WHERE session_id=$1 AND used_at IS NULL", [promotion.session_id]);
        await db.query("DELETE FROM shared_activations WHERE session_id=$1", [promotion.session_id]);
        const generation = promotion.from_generation + 1;
        const admitted = SharedSessionDefinition.parse(session.definition).harness;
        const harness = promotion.target_harness
          ? { name: promotion.target_harness.definition.name, version: promotion.target_harness.definition.version, digest: promotion.target_harness.digest }
          : admitted ? { name: admitted.name, version: admitted.version, digest: admitted.digest } : undefined;
        await db.query(
          `INSERT INTO session_segments(session_id,generation,placement,reason,harness,ahp_session_id,promotion_id)
           VALUES($1,$2,'container',$3,$4,$5,$6)`,
          [promotion.session_id, generation, promotion.kind, harness ? JSON.stringify(harness) : null, promotion.runtime_session_id, id]);
        await db.query(
          "UPDATE session_promotions SET state='committed',committed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id]);
        return { generation };
      });
    } catch (error) {
      if (!(error instanceof CutoverRefused)) throw error;
      // The cutover rolled back; the session stays shared and the promotion fails.
      await this.fail(id, error.code, error.message);
      throw new StoreError("invalid_state", error.message);
    }
  }

  /**
   * Fails an open promotion: the session stays shared and admits turns again. Returns the promotion so the caller can
   * release its allocation. Failing a failed promotion returns it unchanged; a committed promotion cannot fail,
   * because after cutover the container is authoritative.
   */
  async fail(id: string, code: PromotionErrorCode, message: string): Promise<PromotionRecord> {
    PromotionErrorCode.parse(code);
    const row = await this.shared.transaction(async (db) => {
      const failed = (await db.query<PromotionRow>(
        `UPDATE session_promotions SET state='failed',failed_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=$2,error_message=$3
         WHERE id=$1 AND state = ANY($4::text[]) RETURNING *`, [id, code, message.slice(0, 500), OPEN])).rows[0];
      if (failed?.allocation_id) {
        // Before cutover the container is not authoritative: the controller stops it and keeps its volume.
        await db.query(
          "UPDATE execution_allocations SET state='retiring',last_error=$2 WHERE id=$1 AND state IN ('starting','running')",
          [failed.allocation_id, `The promotion failed: ${message}`.slice(0, 500)]);
      }
      return failed;
    });
    if (row) return record(row);
    const current = await this.byId(id);
    if (!current) throw new StoreError("not_found", "The promotion was not found.");
    if (current.state === "committed") throw new StoreError("invalid_state", "A committed promotion cannot fail; the container is authoritative.");
    return current;
  }

  /** Records that the agent was told about this promotion's outcome; returns false when it already was. */
  async markNotified(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE session_promotions SET notified_at=clock_timestamp() WHERE id=$1 AND notified_at IS NULL AND state IN ('committed','failed')", [id]);
    return result.rowCount === 1;
  }
}

/**
 * Builds the manifest for the entries under the two areas: relative paths spelled with each component's kept name,
 * consent files at the state root excluded, parents before children, within the session storage bounds.
 */
function snapshotManifest(sessionId: string, stored: StoredEntry[], areas: PromotionStorageAreas): { manifest: PromotionSnapshotManifest; keys: string[] } {
  const names = new Map(stored.map((entry) => [entry.path, entry.display_name ?? posix.basename(entry.path)]));
  const candidates: Array<{ entry: PromotionSnapshotEntry; key: string; depth: number }> = [];
  for (const entry of stored) {
    const area = entry.path.startsWith(`${areas.state}/`) ? "state" as const : "workspace" as const;
    const root = area === "state" ? areas.state : areas.workspace;
    const parts = entry.path.slice(root.length + 1).split("/");
    const path = parts.map((part, index) => names.get(`${root}/${parts.slice(0, index + 1).join("/")}`) ?? part).join("/");
    if (area === "state" && parts.length === 1 && PROMOTION_EXCLUDED_STATE_FILES.includes(path.toLowerCase())) continue;
    if (area === "state" && PROMOTION_EXCLUDED_STATE_DIRECTORIES.includes(path.split("/")[0]!.toLowerCase())) continue;
    if (!PromotionSnapshotPath.safeParse(path).success) {
      throw new StoreError("invalid_state", "A session file name cannot be restored in a container.");
    }
    if (entry.directory) candidates.push({ entry: { area, kind: "directory", path }, key: entry.path, depth: parts.length });
    else candidates.push({ entry: { area, kind: "file", path, size: Number(entry.size), sha256: entry.sha256! }, key: entry.path, depth: parts.length });
  }
  candidates.sort((a, b) => a.entry.area.localeCompare(b.entry.area) || a.depth - b.depth || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  const bytes = candidates.reduce((sum, item) => sum + (item.entry.kind === "file" ? item.entry.size : 0), 0);
  if (candidates.length > PROMOTION_SNAPSHOT_LIMITS.entries || bytes > PROMOTION_SNAPSHOT_LIMITS.bytes) {
    throw new StoreError("quota_exceeded", "The conversation's storage exceeds the promotion snapshot limits.");
  }
  const parsed = PromotionSnapshotManifest.safeParse({ schemaVersion: 1, sessionId, entries: candidates.map((item) => item.entry) });
  if (!parsed.success) throw new StoreError("invalid_state", "The conversation's storage cannot be restored in a container.");
  return { manifest: parsed.data, keys: candidates.map((item) => item.key) };
}

/** Validates a move's target: a well-formed harness snapshot, and a definition that names the same snapshot if it names one. */
function promotionTarget(target: PromotionTarget): PromotionTarget {
  const harness = HarnessDefinition.safeParse(target.harness?.definition);
  const definition = target.definition === undefined ? undefined : SharedSessionDefinition.safeParse(target.definition);
  if (!harness.success || !/^sha256:[a-f0-9]{64}$/.test(target.harness.digest ?? "") || (definition && !definition.success)
    || (definition?.data?.harness && definition.data.harness.digest !== target.harness.digest)) {
    throw new StoreError("invalid_request", "Invalid promotion target.");
  }
  return { harness: { definition: harness.data, digest: target.harness.digest }, ...(definition?.data ? { definition: definition.data } : {}) };
}

function record(row: PromotionRow): PromotionRecord {
  return {
    id: row.id, sessionId: row.session_id, principal: row.principal, source: row.source, requestKey: row.request_key,
    kind: row.kind, history: row.history, runtimeSessionId: row.runtime_session_id,
    ...(row.notice ? { notice: row.notice } : {}),
    ...(row.target_harness ? { target: {
      harness: { definition: HarnessDefinition.parse(row.target_harness.definition), digest: row.target_harness.digest },
      ...(row.target_definition ? { definition: SharedSessionDefinition.parse(row.target_definition) } : {}),
    } } : {}),
    state: row.state, size: row.size, resources: ContainerSize.parse(row.resources), fromGeneration: row.from_generation,
    ...(row.snapshot_epoch ? { snapshotEpoch: row.snapshot_epoch } : {}),
    ...(row.snapshot_digest ? { snapshotDigest: row.snapshot_digest } : {}),
    ...(row.allocation_id ? { allocationId: row.allocation_id } : {}),
    notified: row.notified_at !== null,
    view: promotionView(row),
  };
}
