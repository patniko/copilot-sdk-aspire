import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { ExecutionContainerSettings, SharedWorkerLimits, type JobState } from "@copilot-agent/contracts";
import { SharedStore } from "./shared-store.js";
import { JobStore, StoreError } from "./store.js";

export interface ControllerLease { namespace: string; owner: string }
export interface ExecutionAllocation {
  id: string;
  jobId: string;
  principal: string;
  namespace: string;
  image: string;
  settings: ExecutionContainerSettings;
  state: "starting" | "running" | "retiring" | "retired";
  attemptId?: string;
  attemptState?: string;
  jobState: JobState;
  profile: string;
  containerId?: string;
  startAttempts: number;
  startupUntil: string;
  expiresAt: string;
}
interface AllocationRow {
  id: string; job_id: string; principal: string; namespace: string; image: string; settings: ExecutionContainerSettings;
  state: ExecutionAllocation["state"]; attempt_id: string | null; attempt_state: string | null; job_state: JobState; profile: string;
  container_id: string | null; start_attempts: number; startup_until: Date; expires_at: Date;
}
const SELECT = `SELECT e.*,j.state AS job_state,j.profile,a.status AS attempt_state FROM execution_allocations e
  JOIN jobs j ON j.id=e.job_id LEFT JOIN attempts a ON a.id=e.attempt_id`;

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

  async reserve(lease: ControllerLease, settings: ExecutionContainerSettings, limits: SharedWorkerLimits, tokenFor: (id: string) => string): Promise<ExecutionAllocation | undefined> {
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
      return allocation(row);
    });
  }

  async active(lease: ControllerLease): Promise<ExecutionAllocation[]> {
    await this.assertLease(lease);
    return (await this.pool.query<AllocationRow>(`${SELECT} WHERE e.namespace=$1 AND e.state<>'retired' ORDER BY e.created_at`, [lease.namespace])).rows.map(allocation);
  }

  async get(lease: ControllerLease, id: string): Promise<ExecutionAllocation | undefined> {
    await this.assertLease(lease);
    const row = (await this.pool.query<AllocationRow>(`${SELECT} WHERE e.id=$1 AND e.namespace=$2 AND e.state<>'retired'`, [id, lease.namespace])).rows[0];
    return row ? allocation(row) : undefined;
  }

  async beforeStart(lease: ControllerLease, id: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const updated = await db.query(
        `UPDATE execution_allocations SET start_attempts=start_attempts+1
         WHERE id=$1 AND namespace=$2 AND state='starting' AND attempt_id IS NULL
           AND startup_until>clock_timestamp() AND start_attempts<3 RETURNING id`, [id, lease.namespace]);
      if (!updated.rowCount) throw new StoreError("invalid_state", "The allocation may no longer start.");
    });
  }

  async observed(lease: ControllerLease, id: string, containerId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new StoreError("invalid_request", "Invalid observed container identity.");
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const result = await db.query(
        `UPDATE execution_allocations SET container_id=$3,state='running'
         WHERE id=$1 AND namespace=$2 AND state IN ('starting','running') AND (container_id IS NULL OR container_id=$3)`,
        [id, lease.namespace, containerId]);
      if (!result.rowCount) throw new StoreError("invalid_state", "The allocation identity changed.");
    });
  }

  async retiring(lease: ControllerLease, id: string, reason: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      await db.query("UPDATE execution_allocations SET state='retiring',last_error=$3 WHERE id=$1 AND namespace=$2 AND state<>'retired'",
        [id, lease.namespace, reason.slice(0, 500)]);
    });
  }

  async retired(lease: ControllerLease, id: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      await db.query("UPDATE execution_allocations SET state='retired',finished_at=clock_timestamp() WHERE id=$1 AND namespace=$2 AND state='retiring'", [id, lease.namespace]);
    });
  }

  async failStartup(lease: ControllerLease, id: string, jobs: JobStore, message: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.assertLease(lease, db);
      const row = (await db.query<{ job_id: string }>(
        "SELECT job_id FROM execution_allocations WHERE id=$1 AND namespace=$2 AND attempt_id IS NULL AND state='retiring'", [id, lease.namespace])).rows[0];
      if (row) await jobs.failUnclaimedInTransaction(db, row.job_id, message.slice(0, 500));
    });
  }

  async authenticate(token: string): Promise<{ id: string; jobId: string; attemptId?: string } | undefined> {
    const row = (await this.pool.query<{ id: string; job_id: string; attempt_id: string | null }>(
      `SELECT id,job_id,attempt_id FROM execution_allocations WHERE token_digest=$1
       AND state IN ('starting','running') AND expires_at>clock_timestamp()`, [digest(token)])).rows[0];
    return row ? { id: row.id, jobId: row.job_id, ...(row.attempt_id ? { attemptId: row.attempt_id } : {}) } : undefined;
  }

  async ownsAttempt(allocationId: string, attemptId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM execution_allocations e JOIN attempts a ON a.id=e.attempt_id
       WHERE e.id=$1 AND a.id=$2 AND a.job_id=e.job_id AND a.executor_id=e.id::text
         AND e.state IN ('starting','running') AND e.expires_at>clock_timestamp()`, [allocationId, attemptId]);
    return result.rowCount === 1;
  }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function allocation(row: AllocationRow): ExecutionAllocation {
  return { id: row.id, jobId: row.job_id, principal: row.principal, namespace: row.namespace, image: row.image,
    settings: ExecutionContainerSettings.parse(row.settings), state: row.state, jobState: row.job_state, profile: row.profile,
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), ...(row.attempt_state ? { attemptState: row.attempt_state } : {}),
    ...(row.container_id ? { containerId: row.container_id } : {}), startAttempts: row.start_attempts,
    startupUntil: row.startup_until.toISOString(), expiresAt: row.expires_at.toISOString() };
}
