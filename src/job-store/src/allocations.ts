import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ContainerSize, ExecutionContainerSettings, SharedServerKey, SharedWorkerLimits,
  type JobState, type SessionContainerHeartbeat,
} from "@copilot-agent/contracts";
import { SharedStore } from "./shared-store.js";
import { JobStore, StoreError } from "./store.js";

export interface ControllerLease { namespace: string; owner: string }
export type AllocationState = "starting" | "running" | "retiring" | "retired";

/** A volume an allocation mounts. `sessionId` owns the volume: the allocation's own session, or a coordinator session for `shared`. */
export interface VolumeRequirement { purpose: "session" | "shared"; sessionId: string; target: string; readOnly: boolean }
export interface BoundVolume extends VolumeRequirement { name: string }

interface AllocationCommon {
  id: string;
  principal: string;
  namespace?: string;
  state: AllocationState;
  containerId?: string;
  startAttempts: number;
  startupUntil: string;
  expiresAt: string;
}
/** A one-shot allocation that may claim exactly one assigned job attempt. */
export interface JobAllocation extends AllocationCommon {
  kind: "job";
  jobId: string;
  namespace: string;
  image: string;
  settings: ExecutionContainerSettings;
  attemptId?: string;
  attemptState?: string;
  jobState: JobState;
  profile: string;
}
/**
 * A resumable allocation bound to one application session. Requested unbound (no image, settings, credential, or
 * volume names); the controller binds those before it creates the container. Stopping it retains its volumes.
 */
export interface SessionAllocation extends AllocationCommon {
  kind: "session";
  sessionId: string;
  purpose: "session";
  size: string;
  resources: ContainerSize;
  idleSeconds: number;
  volumes: VolumeRequirement[] | BoundVolume[];
  image?: string;
  settings?: ExecutionContainerSettings;
  ingress?: { host: string; port: number };
  serverKey?: SharedServerKey;
  readyAt?: string;
  heartbeatAt?: string;
  activityAt?: string;
  sessionClosed: boolean;
}
export type ExecutionAllocation = JobAllocation | SessionAllocation;

/** A general allocation request: one session, its purpose, a size from the operator catalog, and the volumes it mounts. */
export interface AllocationRequest {
  sessionId: string;
  principal: string;
  purpose: "session";
  size: string;
  resources: ContainerSize;
  volumes: VolumeRequirement[];
  idleSeconds: number;
  startupSeconds: number;
  maxLifetimeSeconds: number;
}
export type AuthenticatedAllocation =
  | { kind: "job"; id: string; jobId: string; attemptId?: string }
  | { kind: "session"; id: string; sessionId: string; principal: string };

interface AllocationRow {
  id: string; kind: "job" | "session"; job_id: string | null; session_id: string | null; principal: string; namespace: string | null;
  image: string | null; settings: ExecutionContainerSettings | null; state: AllocationState; attempt_id: string | null;
  attempt_state: string | null; job_state: JobState | null; profile: string | null; container_id: string | null;
  start_attempts: number; startup_until: Date; expires_at: Date; purpose: "session" | null; size: string | null;
  resources: ContainerSize | null; volumes: VolumeRequirement[] | BoundVolume[]; idle_seconds: number | null;
  ingress: { host: string; port: number } | null; server_key: SharedServerKey | null; ready_at: Date | null;
  heartbeat_at: Date | null; activity_at: Date | null; session_closed: boolean | null;
}
const SELECT = `SELECT e.*,j.state AS job_state,j.profile,a.status AS attempt_state,s.closed AS session_closed FROM execution_allocations e
  LEFT JOIN jobs j ON j.id=e.job_id LEFT JOIN attempts a ON a.id=e.attempt_id LEFT JOIN shared_sessions s ON s.id=e.session_id`;
const VOLUME_TARGET = /^\/[a-z0-9][a-z0-9/_-]{0,99}$/;

/** Admission counts physical allocations until confirmed removal, including ambiguous starts and failed teardown. */
export class AllocationStore {
  constructor(private readonly pool: pg.Pool, private readonly shared: SharedStore) {}

  async acquire(namespace: string, owner: string): Promise<ControllerLease> {
    const result = await this.pool.query(
      `INSERT INTO execution_controller(id,namespace,owner,lease_until) VALUES(1,$1,$2,clock_timestamp()+interval '30 seconds')
       ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until
       WHERE execution_controller.namespace=EXCLUDED.namespace AND
         (execution_controller.owner=EXCLUDED.owner OR execution_controller.lease_until<clock_timestamp())
       RETURNING id`, [namespace, owner]);
    if (!result.rowCount) throw new StoreError("invalid_state", "The allocation ledger is bound to another namespace or live controller.");
    return { namespace, owner };
  }

  async heartbeat(lease: ControllerLease): Promise<void> {
    const result = await this.pool.query(
      `UPDATE execution_controller SET lease_until=clock_timestamp()+interval '30 seconds'
       WHERE id=1 AND namespace=$1 AND owner=$2 AND lease_until>clock_timestamp()`, [lease.namespace, lease.owner]);
    if (!result.rowCount) throw new StoreError("invalid_state", "The execution controller lease was lost.");
  }

  async assertLease(lease: ControllerLease, db: pg.Pool | pg.PoolClient = this.pool): Promise<void> {
    const result = await db.query(
      "SELECT 1 FROM execution_controller WHERE id=1 AND namespace=$1 AND owner=$2 AND lease_until>clock_timestamp() FOR SHARE",
      [lease.namespace, lease.owner]);
    if (!result.rowCount) throw new StoreError("invalid_state", "The execution controller lease was lost.");
  }

  async release(lease: ControllerLease): Promise<void> {
    await this.pool.query("UPDATE execution_controller SET lease_until=clock_timestamp() WHERE id=1 AND namespace=$1 AND owner=$2", [lease.namespace, lease.owner]);
  }

  async reserve(lease: ControllerLease, settings: ExecutionContainerSettings, limits: SharedWorkerLimits, tokenFor: (id: string) => string): Promise<JobAllocation | undefined> {
    ExecutionContainerSettings.parse(settings);
    SharedWorkerLimits.parse(limits);
    if (settings.namespace !== lease.namespace || !/^sha256:[a-f0-9]{64}$/.test(settings.image)) {
      throw new StoreError("invalid_request", "Allocations require a resolved immutable image and the bound namespace.");
    }
    return this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const total = (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM execution_allocations WHERE state<>'retired'")).rows[0]!.count;
      if (total >= limits.executionContainers) return undefined;
      const job = (await db.query<{ id: string; principal: string; max_duration_seconds: number }>(
        `SELECT j.id,j.principal,j.max_duration_seconds FROM jobs j LEFT JOIN shared_delegations d ON d.job_id=j.id
         LEFT JOIN shared_sessions s ON s.id=d.session_id
         WHERE j.execution_mode='dedicated' AND j.state IN ('queued','retry_wait') AND j.not_before<=clock_timestamp()
           AND NOT j.cancel_requested AND (d.id IS NULL OR NOT (s.closed AND s.cancel_children))
           AND NOT EXISTS (SELECT 1 FROM execution_allocations e WHERE e.job_id=j.id AND e.state<>'retired')
           AND (SELECT count(*) FROM execution_allocations e WHERE e.principal=j.principal AND e.state<>'retired')<$1
           AND (d.id IS NULL OR (SELECT count(*) FROM execution_allocations e JOIN shared_delegations k ON k.job_id=e.job_id
             WHERE k.session_id=s.id AND e.state<>'retired')<(s.definition->'limits'->>'maxParallelJobs')::integer)
         ORDER BY j.not_before,j.created_at,j.id LIMIT 1`, [limits.containersPerPrincipal])).rows[0];
      if (!job) return undefined;
      const id = randomUUID();
      const token = tokenFor(id);
      if (token.length < 32 || token.length > 200) throw new StoreError("invalid_request", "Invalid allocation credential.");
      await db.query(
        `INSERT INTO execution_allocations(id,job_id,principal,namespace,image,settings,token_digest,state,startup_until,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'starting',clock_timestamp()+$8*interval '1 second',clock_timestamp()+$9*interval '1 second')`,
        [id, job.id, job.principal, lease.namespace, settings.image, JSON.stringify(settings), digest(token),
          settings.startupSeconds, settings.startupSeconds + job.max_duration_seconds + settings.shutdownSeconds + 30]);
      const row = (await db.query<AllocationRow>(`${SELECT} WHERE e.id=$1`, [id])).rows[0]!;
      return allocation(row) as JobAllocation;
    });
  }

  /**
   * Requests a resumable allocation for one session, counting it against the deployment and per-principal container
   * limits in the same admission transaction as job reservations. Returns the session's existing active allocation
   * instead of creating a second one. Pass `db` to admit atomically with the caller's own records.
   */
  async request(request: AllocationRequest, limits: SharedWorkerLimits, db?: pg.PoolClient): Promise<SessionAllocation> {
    SharedWorkerLimits.parse(limits);
    ContainerSize.parse(request.resources);
    if (request.purpose !== "session" || !request.size || request.volumes.length > 4
      || request.volumes.some((volume) => !VOLUME_TARGET.test(volume.target) || !["session", "shared"].includes(volume.purpose))
      || new Set(request.volumes.map((volume) => volume.target)).size !== request.volumes.length
      || ![request.idleSeconds, request.startupSeconds, request.maxLifetimeSeconds].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new StoreError("invalid_request", "Invalid session allocation request.");
    }
    const admit = async (client: pg.PoolClient): Promise<SessionAllocation> => {
      const session = (await client.query<{ principal: string; closed: boolean }>(
        "SELECT principal,closed FROM shared_sessions WHERE id=$1 FOR UPDATE", [request.sessionId])).rows[0];
      if (!session || session.principal !== request.principal || session.closed) throw new StoreError("not_found", "The session is unavailable.");
      const existing = (await client.query<AllocationRow>(`${SELECT} WHERE e.session_id=$1 AND e.state<>'retired'`, [request.sessionId])).rows[0];
      if (existing) return allocation(existing) as SessionAllocation;
      const counts = (await client.query<{ total: number; own: number }>(
        `SELECT count(*)::int AS total,count(*) FILTER (WHERE principal=$1)::int AS own
         FROM execution_allocations WHERE state<>'retired'`, [request.principal])).rows[0]!;
      if (counts.total >= limits.executionContainers) throw new StoreError("quota_exceeded", "No execution container capacity is available.");
      if (counts.own >= limits.containersPerPrincipal) throw new StoreError("quota_exceeded", "The principal's execution container limit is reached.");
      const released = await client.query(
        "SELECT 1 FROM execution_volumes WHERE session_id=ANY($1::uuid[]) AND released_at IS NOT NULL",
        [request.volumes.map((volume) => volume.sessionId)]);
      if (released.rowCount) throw new StoreError("invalid_state", "A requested volume has been released.");
      const id = randomUUID();
      await client.query(
        `INSERT INTO execution_allocations(id,kind,session_id,principal,purpose,size,resources,volumes,idle_seconds,state,startup_until,expires_at)
         VALUES($1,'session',$2,$3,$4,$5,$6,$7,$8,'starting',clock_timestamp()+$9*interval '1 second',clock_timestamp()+$10*interval '1 second')`,
        [id, request.sessionId, request.principal, request.purpose, request.size, JSON.stringify(request.resources),
          JSON.stringify(request.volumes), request.idleSeconds, request.startupSeconds, request.maxLifetimeSeconds]);
      return allocation((await client.query<AllocationRow>(`${SELECT} WHERE e.id=$1`, [id])).rows[0]!) as SessionAllocation;
    };
    return db ? admit(db) : this.shared.transaction(admit);
  }

  /** Binds an unbound session allocation: immutable image, container settings, credential digest and volume names. */
  async bind(lease: ControllerLease, id: string, settings: ExecutionContainerSettings, token: string, ingressCredential: string): Promise<SessionAllocation> {
    ExecutionContainerSettings.parse(settings);
    if (settings.namespace !== lease.namespace || !/^sha256:[a-f0-9]{64}$/.test(settings.image)
      || token.length < 32 || token.length > 200 || ingressCredential.length < 32 || ingressCredential.length > 200) {
      throw new StoreError("invalid_request", "Session allocations bind to a resolved immutable image, the bound namespace and credentials.");
    }
    return this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const row = (await db.query<AllocationRow>(
        `${SELECT} WHERE e.id=$1 AND e.kind='session' AND e.state='starting' AND e.image IS NULL FOR UPDATE OF e`, [id])).rows[0];
      if (!row) throw new StoreError("invalid_state", "The session allocation is not awaiting binding.");
      const bound: BoundVolume[] = [];
      for (const volume of row.volumes as VolumeRequirement[]) {
        const name = `hybrid-${lease.namespace}-${volume.purpose}-${volume.sessionId}`;
        const owner = (await db.query<{ principal: string }>("SELECT principal FROM shared_sessions WHERE id=$1", [volume.sessionId])).rows[0];
        if (!owner || owner.principal !== row.principal) throw new StoreError("invalid_state", "A volume's session belongs to another principal.");
        const record = (await db.query<{ name: string; released_at: Date | null }>(
          `INSERT INTO execution_volumes(name,namespace,session_id,purpose,principal) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(namespace,session_id,purpose) DO UPDATE SET name=execution_volumes.name RETURNING name,released_at`,
          [name, lease.namespace, volume.sessionId, volume.purpose, row.principal])).rows[0]!;
        if (record.released_at) throw new StoreError("invalid_state", "A requested volume has been released.");
        bound.push({ ...volume, name: record.name });
      }
      const resources = ContainerSize.parse(row.resources);
      const resolved = ExecutionContainerSettings.parse({ ...settings, cpus: resources.cpus, memoryMiB: resources.memoryMiB });
      await db.query(
        `UPDATE execution_allocations SET namespace=$2,image=$3,settings=$4,token_digest=$5,ingress_credential=$6,volumes=$7 WHERE id=$1`,
        [id, lease.namespace, resolved.image, JSON.stringify(resolved), digest(token), ingressCredential, JSON.stringify(bound)]);
      return allocation((await db.query<AllocationRow>(`${SELECT} WHERE e.id=$1`, [id])).rows[0]!) as SessionAllocation;
    });
  }

  async volumeObserved(lease: ControllerLease, name: string): Promise<void> {
    await this.assertLease(lease);
    await this.pool.query("UPDATE execution_volumes SET observed_at=COALESCE(observed_at,clock_timestamp()) WHERE name=$1 AND namespace=$2", [name, lease.namespace]);
  }

  /** Volume names recorded for the namespace, including released ones; the controller never deletes them. */
  async volumes(lease: ControllerLease): Promise<Set<string>> {
    await this.assertLease(lease);
    return new Set((await this.pool.query<{ name: string }>("SELECT name FROM execution_volumes WHERE namespace=$1", [lease.namespace])).rows.map((row) => row.name));
  }

  async active(lease: ControllerLease): Promise<ExecutionAllocation[]> {
    await this.assertLease(lease);
    return (await this.pool.query<AllocationRow>(
      `${SELECT} WHERE (e.namespace=$1 OR (e.kind='session' AND e.namespace IS NULL)) AND e.state<>'retired' ORDER BY e.created_at`,
      [lease.namespace])).rows.map(allocation);
  }

  async get(lease: ControllerLease, id: string): Promise<ExecutionAllocation | undefined> {
    await this.assertLease(lease);
    const row = (await this.pool.query<AllocationRow>(
      `${SELECT} WHERE e.id=$1 AND (e.namespace=$2 OR (e.kind='session' AND e.namespace IS NULL)) AND e.state<>'retired'`,
      [id, lease.namespace])).rows[0];
    return row ? allocation(row) : undefined;
  }

  async beforeStart(lease: ControllerLease, id: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const updated = await db.query(
        `UPDATE execution_allocations SET start_attempts=start_attempts+1
         WHERE id=$1 AND namespace=$2 AND state='starting' AND attempt_id IS NULL AND image IS NOT NULL
           AND startup_until>clock_timestamp() AND start_attempts<3 RETURNING id`, [id, lease.namespace]);
      if (!updated.rowCount) throw new StoreError("invalid_state", "The allocation may no longer start.");
    });
  }

  async observed(lease: ControllerLease, id: string, containerId: string, ingress?: { host: string; port: number }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new StoreError("invalid_request", "Invalid observed container identity.");
    if (ingress && (!["127.0.0.1", "::1"].includes(ingress.host) || !Number.isSafeInteger(ingress.port) || ingress.port < 1 || ingress.port > 65_535)) {
      throw new StoreError("invalid_request", "Session ingress must be a published loopback port.");
    }
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const result = await db.query(
        `UPDATE execution_allocations SET container_id=$3,state='running',ingress=COALESCE($4::jsonb,ingress)
         WHERE id=$1 AND namespace=$2 AND state IN ('starting','running') AND (container_id IS NULL OR container_id=$3)`,
        [id, lease.namespace, containerId, ingress ? JSON.stringify(ingress) : null]);
      if (!result.rowCount) throw new StoreError("invalid_state", "The allocation identity changed.");
    });
  }

  async retiring(lease: ControllerLease, id: string, reason: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      await db.query(
        `UPDATE execution_allocations SET state='retiring',last_error=$3
         WHERE id=$1 AND (namespace=$2 OR (kind='session' AND namespace IS NULL)) AND state<>'retired'`,
        [id, lease.namespace, reason.slice(0, 500)]);
    });
  }

  async retired(lease: ControllerLease, id: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      await db.query(
        `UPDATE execution_allocations SET state='retired',finished_at=clock_timestamp()
         WHERE id=$1 AND (namespace=$2 OR (kind='session' AND namespace IS NULL)) AND state='retiring'`, [id, lease.namespace]);
    });
  }

  async failStartup(lease: ControllerLease, id: string, jobs: JobStore, message: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const row = (await db.query<{ job_id: string }>(
        "SELECT job_id FROM execution_allocations WHERE id=$1 AND namespace=$2 AND kind='job' AND attempt_id IS NULL AND state='retiring'", [id, lease.namespace])).rows[0];
      if (row) await jobs.failUnclaimedInTransaction(db, row.job_id, message.slice(0, 500));
    });
  }

  async authenticate(token: string): Promise<AuthenticatedAllocation | undefined> {
    const row = (await this.pool.query<{ id: string; kind: "job" | "session"; job_id: string | null; attempt_id: string | null; session_id: string | null; principal: string }>(
      `SELECT id,kind,job_id,attempt_id,session_id,principal FROM execution_allocations WHERE token_digest=$1
       AND state IN ('starting','running') AND expires_at>clock_timestamp()`, [digest(token)])).rows[0];
    if (!row) return undefined;
    return row.kind === "job"
      ? { kind: "job", id: row.id, jobId: row.job_id!, ...(row.attempt_id ? { attemptId: row.attempt_id } : {}) }
      : { kind: "session", id: row.id, sessionId: row.session_id!, principal: row.principal };
  }

  async ownsAttempt(allocationId: string, attemptId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM execution_allocations e JOIN attempts a ON a.id=e.attempt_id
       WHERE e.id=$1 AND e.kind='job' AND a.id=$2 AND a.job_id=e.job_id AND a.executor_id=e.id::text
         AND e.state IN ('starting','running') AND e.expires_at>clock_timestamp()`, [allocationId, attemptId]);
    return result.rowCount === 1;
  }

  /** The container's AHP listener is ready; the first readiness of an allocation counts one session activation. */
  async ready(allocationId: string, serverKey: SharedServerKey): Promise<void> {
    const key = SharedServerKey.parse(serverKey);
    await this.shared.transaction(async (db) => {
      const row = (await db.query<{ session_id: string; server_key: SharedServerKey | null }>(
        `SELECT e.session_id,e.server_key FROM execution_allocations e JOIN shared_sessions s ON s.id=e.session_id
         WHERE e.id=$1 AND e.kind='session' AND e.state IN ('starting','running') AND e.expires_at>clock_timestamp()
           AND NOT s.closed FOR UPDATE OF e`, [allocationId])).rows[0];
      if (!row) throw new StoreError("not_found", "The session allocation is not active.");
      if (row.server_key) {
        if (JSON.stringify(SharedServerKey.parse(row.server_key)) !== JSON.stringify(key)) {
          throw new StoreError("invalid_state", "The allocation already published a different server key.");
        }
        return;
      }
      await db.query(
        `UPDATE execution_allocations SET server_key=$2,ready_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
         activity_at=clock_timestamp() WHERE id=$1`, [allocationId, JSON.stringify(key)]);
      await db.query("UPDATE session_containers SET activations=activations+1 WHERE session_id=$1", [row.session_id]);
      await db.query("UPDATE shared_sessions SET last_activity_at=clock_timestamp() WHERE id=$1", [row.session_id]);
    });
  }

  /** Records liveness and activity. Tells the container to stop when it is retiring, expired, or its session closed. */
  async containerHeartbeat(allocationId: string, report: SessionContainerHeartbeat): Promise<{ stop: boolean }> {
    const row = (await this.pool.query<{ stop: boolean }>(
      `WITH current AS (
         SELECT e.id,e.session_id,(e.state='retiring' OR e.expires_at<=clock_timestamp() OR s.closed) AS stop
         FROM execution_allocations e JOIN shared_sessions s ON s.id=e.session_id
         WHERE e.id=$1 AND e.kind='session' AND e.state<>'retired' AND e.ready_at IS NOT NULL
       ), touched AS (
         UPDATE execution_allocations e SET heartbeat_at=clock_timestamp(),
           activity_at=CASE WHEN $2 OR $3 THEN clock_timestamp() ELSE e.activity_at END
         FROM current c WHERE e.id=c.id RETURNING e.session_id
       ), session AS (
         UPDATE shared_sessions s SET last_activity_at=clock_timestamp() FROM touched t WHERE s.id=t.session_id AND ($2 OR $3)
       )
       SELECT stop FROM current`, [allocationId, report.activeTurn, report.activity])).rows[0];
    return { stop: row?.stop ?? true };
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function allocation(row: AllocationRow): ExecutionAllocation {
  const common = {
    id: row.id, principal: row.principal, state: row.state, startAttempts: row.start_attempts,
    startupUntil: row.startup_until.toISOString(), expiresAt: row.expires_at.toISOString(),
    ...(row.container_id ? { containerId: row.container_id } : {}),
  };
  if (row.kind === "job") {
    return { ...common, kind: "job", jobId: row.job_id!, namespace: row.namespace!, image: row.image!,
      settings: ExecutionContainerSettings.parse(row.settings), jobState: row.job_state!, profile: row.profile!,
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), ...(row.attempt_state ? { attemptState: row.attempt_state } : {}) };
  }
  return {
    ...common, kind: "session", sessionId: row.session_id!, purpose: row.purpose!, size: row.size!,
    resources: ContainerSize.parse(row.resources), idleSeconds: row.idle_seconds!, volumes: row.volumes, sessionClosed: row.session_closed ?? true,
    ...(row.namespace ? { namespace: row.namespace } : {}), ...(row.image ? { image: row.image } : {}),
    ...(row.settings ? { settings: ExecutionContainerSettings.parse(row.settings) } : {}),
    ...(row.ingress ? { ingress: row.ingress } : {}), ...(row.server_key ? { serverKey: SharedServerKey.parse(row.server_key) } : {}),
    ...(row.ready_at ? { readyAt: row.ready_at.toISOString() } : {}), ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at.toISOString() } : {}),
    ...(row.activity_at ? { activityAt: row.activity_at.toISOString() } : {}),
  };
}
