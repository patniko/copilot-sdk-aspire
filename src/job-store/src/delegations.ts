import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ArtifactData, ARTIFACT_MAX_BYTES, ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES,
  type ArtifactManifest, type JobView,
} from "@copilot-agent/contracts";
import { JobStore, StoreError, type NewJob } from "./store.js";
import { SharedStore } from "./shared-store.js";
import type { SessionFileLease } from "./session-files.js";

export interface CompletionNotice {
  id: string;
  principal: string;
  sessionId: string;
  jobId: string;
  state: "pending" | "delivering" | "delivered" | "needs_review" | "closed";
  activationEpoch?: string;
}
export class DelegationStore {
  constructor(private readonly pool: pg.Pool, private readonly shared: SharedStore, private readonly jobs: JobStore) {}

  async find(lease: SessionFileLease, operation: string, argumentsHash: string): Promise<JobView | undefined> {
    const jobId = await this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const row = (await db.query<{ job_id: string; arguments_hash: string }>(
        "SELECT job_id,arguments_hash FROM shared_delegations WHERE session_id=$1 AND operation_key=$2", [lease.id, operation])).rows[0];
      if (!row) return undefined;
      if (row.arguments_hash !== argumentsHash) throw new StoreError("idempotency_conflict", "The delegation operation was reused with different arguments.");
      return row.job_id;
    });
    return jobId ? this.jobs.getJob(lease.principal, jobId) : undefined;
  }

  async admit(lease: SessionFileLease, turnId: string, operation: string, argumentsHash: string, job: NewJob,
    inputs: ArtifactData[], maximumOpenJobs: number): Promise<JobView> {
    if (!operation || operation.length > 200 || !/^[a-f0-9]{64}$/.test(argumentsHash) || job.principal !== lease.principal) {
      throw new StoreError("invalid_request", "Invalid delegation identity.");
    }
    const files = validateArtifactSet(inputs);
    const accepted = await this.shared.transaction(async (db) => {
      const session = await this.shared.authorize(db, lease);
      const existing = (await db.query<{ job_id: string; arguments_hash: string }>(
        "SELECT job_id,arguments_hash FROM shared_delegations WHERE session_id=$1 AND operation_key=$2", [lease.id, operation])).rows[0];
      if (existing) {
        if (existing.arguments_hash !== argumentsHash) throw new StoreError("idempotency_conflict", "The delegation arguments changed.");
        return existing.job_id;
      }
      const active = await db.query(
        `SELECT 1 FROM shared_turns WHERE id=$1 AND session_id=$2 AND epoch=$3 AND principal=$4
         AND source='user' AND state='running' AND deadline>clock_timestamp() AND tokens_used<token_budget`,
        [turnId, lease.id, lease.epoch, lease.principal]);
      if (!active.rowCount) throw new StoreError("invalid_state", "Only an active user turn may delegate; completion messages cannot create nested jobs.");
      const allowed = (session.definition.delegation?.harnesses ?? []).some((harness) => harness.name === job.harness.definition.name
        && harness.version === job.harness.definition.version && harness.digest === job.harness.digest);
      if (!allowed) throw new StoreError("invalid_request", "This harness snapshot is not approved for the conversation.");
      if (session.jobs >= session.definition.limits.maxJobs) throw new StoreError("quota_exceeded", "The conversation fan-out limit is exhausted.");
      const remaining = session.definition.limits.tokenBudget - Number(session.tokens_used) - Number(session.tokens_reserved);
      const reservation = Math.min(remaining, job.tokenBudget);
      if (reservation < 1) throw new StoreError("quota_exceeded", "No aggregate budget remains for a child job.");
      const id = randomUUID();
      const admitted = await this.jobs.createJobInTransaction(db, {
        ...job, execution: "dedicated", tokenBudget: reservation,
        idempotencyKey: `shared:${hash(`${lease.id}\0${operation}`)}`,
        requestHash: hash(JSON.stringify({ request: job.requestHash, argumentsHash, files: files.map(({ path, sha256 }) => ({ path, sha256 })) })),
      }, maximumOpenJobs);
      await db.query(
        `INSERT INTO shared_delegations(id,session_id,turn_id,job_id,operation_key,arguments_hash,reserved_tokens)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, lease.id, turnId, admitted.view.id, operation, argumentsHash, reservation]);
      for (const file of files) {
        await db.query("INSERT INTO delegation_inputs(delegation_id,path,sha256,content) VALUES($1,$2,$3,$4)",
          [id, file.path, file.sha256, file.content]);
      }
      await db.query("UPDATE shared_sessions SET jobs=jobs+1,tokens_reserved=tokens_reserved+$2 WHERE id=$1", [lease.id, reservation]);
      return admitted.view.id;
    });
    const view = await this.jobs.getJob(lease.principal, accepted);
    if (!view) throw new StoreError("not_found", "The admitted job is unavailable.");
    return view;
  }

  async inputs(jobId: string): Promise<ArtifactData[]> {
    const rows = await this.pool.query<{ path: string; sha256: string; content: Buffer }>(
      `SELECT f.path,f.sha256,f.content FROM delegation_inputs f JOIN shared_delegations d ON d.id=f.delegation_id
       WHERE d.job_id=$1 ORDER BY f.path`, [jobId]);
    return rows.rows.map((row) => ({ path: row.path, sha256: row.sha256, base64: row.content.toString("base64") }));
  }

  async publishArtifact(attemptId: string, leaseToken: string, artifact: ArtifactData): Promise<ArtifactManifest> {
    const file = validateArtifactSet([artifact])[0]!;
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      try {
        await db.query("SELECT j.id FROM jobs j JOIN attempts a ON a.job_id=j.id WHERE a.id=$1 FOR UPDATE OF j", [attemptId]);
        const owner = (await db.query<{ job_id: string }>(
          `SELECT a.job_id FROM attempts a JOIN jobs j ON j.id=a.job_id
           WHERE a.id=$1 AND a.lease_token=$2 AND a.status='running' AND a.lease_expires_at>clock_timestamp()
             AND a.deadline>clock_timestamp() AND NOT j.cancel_requested AND j.execution_mode='dedicated'
           FOR UPDATE OF a`, [attemptId, leaseToken])).rows[0];
        if (!owner) throw new StoreError("invalid_state", "The artifact attempt is no longer owned.");
        const existing = (await db.query<{ id: string; path: string; sha256: string; size: number }>(
          "SELECT id,path,sha256,octet_length(content)::int AS size FROM job_artifacts WHERE attempt_id=$1 AND lower(path)=lower($2)",
          [attemptId, file.path])).rows[0];
        if (existing) {
          if (existing.path !== file.path || existing.sha256 !== file.sha256) throw new StoreError("idempotency_conflict", "Published artifacts are immutable.");
          await db.query("COMMIT");
          return existing;
        }
        const totals = (await db.query<{ count: number; bytes: string }>(
          "SELECT count(*)::int AS count,COALESCE(sum(octet_length(content)),0)::text AS bytes FROM job_artifacts WHERE attempt_id=$1", [attemptId])).rows[0]!;
        if (totals.count >= ARTIFACT_MAX_FILES || Number(totals.bytes) + file.content.length > ARTIFACT_MAX_TOTAL_BYTES) {
          throw new StoreError("quota_exceeded", "The artifact set exceeds its file/byte quota.");
        }
        const id = randomUUID();
        await db.query("INSERT INTO job_artifacts(id,job_id,attempt_id,path,sha256,content) VALUES($1,$2,$3,$4,$5,$6)",
          [id, owner.job_id, attemptId, file.path, file.sha256, file.content]);
        await db.query("COMMIT");
        return { id, path: file.path, sha256: file.sha256, size: file.content.length };
      } catch (error) { await db.query("ROLLBACK"); throw error; }
    } finally { db.release(); }
  }

  async artifacts(principal: string, jobId: string): Promise<ArtifactManifest[]> {
    return (await this.pool.query<ArtifactManifest>(
      `SELECT f.id,f.path,f.sha256,octet_length(f.content)::int AS size FROM job_artifacts f
       JOIN jobs j ON j.id=f.job_id JOIN attempts a ON a.id=f.attempt_id
       WHERE j.id=$1 AND j.principal=$2 AND j.state='succeeded' AND a.status='succeeded' AND a.number=j.attempts ORDER BY f.path`,
      [jobId, principal])).rows;
  }

  async artifact(principal: string, jobId: string, id: string): Promise<(ArtifactManifest & { content: Buffer }) | undefined> {
    return (await this.pool.query<ArtifactManifest & { content: Buffer }>(
      `SELECT f.id,f.path,f.sha256,octet_length(f.content)::int AS size,f.content FROM job_artifacts f
       JOIN jobs j ON j.id=f.job_id JOIN attempts a ON a.id=f.attempt_id
       WHERE f.id=$1 AND j.id=$2 AND j.principal=$3 AND j.state='succeeded' AND a.status='succeeded' AND a.number=j.attempts`,
      [id, jobId, principal])).rows[0];
  }

  async list(principal: string, sessionId: string): Promise<Array<{ jobId: string; state: string; notificationState: string | null; notificationError: string | null }>> {
    return (await this.pool.query<{ jobId: string; state: string; notificationState: string | null; notificationError: string | null }>(
      `SELECT j.id AS "jobId",j.state,i.state AS "notificationState",i.last_error AS "notificationError"
       FROM shared_delegations d JOIN shared_sessions s ON s.id=d.session_id
       JOIN jobs j ON j.id=d.job_id LEFT JOIN shared_completion_inbox i ON i.delegation_id=d.id
       WHERE s.id=$1 AND s.principal=$2 AND j.principal=s.principal ORDER BY d.created_at LIMIT 100`,
      [sessionId, principal])).rows;
  }

  async reconcile(): Promise<void> {
    await this.jobs.recoverInferenceRequests();
    const cancelled = await this.pool.query<{ id: string; principal: string }>(
      `SELECT j.id,j.principal FROM shared_delegations d JOIN shared_sessions s ON s.id=d.session_id JOIN jobs j ON j.id=d.job_id
       WHERE s.closed AND s.cancel_children AND j.state IN ('queued','retry_wait','running') LIMIT 100`);
    for (const row of cancelled.rows) await this.jobs.requestCancel(row.principal, row.id);
    await this.shared.transaction(async (db) => {
      const terminal = await db.query<{ id: string; session_id: string; settled: boolean; reserved_tokens: number; charged_tokens: string; budget_tokens_used: string }>(
        `SELECT d.*,j.budget_tokens_used FROM shared_delegations d JOIN jobs j ON j.id=d.job_id
         WHERE j.state IN ('succeeded','failed','cancelled','needs_review')
           AND NOT EXISTS (SELECT 1 FROM attempts a JOIN capabilities c ON c.attempt_id=a.id
             JOIN job_inference_requests r ON r.jti=c.jti WHERE a.job_id=j.id AND r.state='pending')
           AND (NOT d.settled OR j.budget_tokens_used>d.charged_tokens) ORDER BY d.created_at LIMIT 100`);
      for (const row of terminal.rows) {
        const charged = Math.max(Number(row.charged_tokens), Number(row.budget_tokens_used));
        await db.query("UPDATE shared_sessions SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$3 WHERE id=$1",
          [row.session_id, row.settled ? 0 : row.reserved_tokens, charged - Number(row.charged_tokens)]);
        await db.query("UPDATE shared_delegations SET settled=true,charged_tokens=$2 WHERE id=$1", [row.id, charged]);
      }
      await db.query(
        `INSERT INTO shared_completion_inbox(id,delegation_id)
         SELECT gen_random_uuid(),d.id FROM shared_delegations d JOIN jobs j ON j.id=d.job_id
         WHERE j.state IN ('succeeded','failed','cancelled','needs_review')
         ON CONFLICT(delegation_id) DO NOTHING`);
      await db.query(
        `UPDATE shared_completion_inbox i SET state='closed' FROM shared_delegations d,shared_sessions s
         WHERE i.delegation_id=d.id AND d.session_id=s.id AND s.closed AND i.state IN ('pending','delivering')`);
      await db.query(
        `UPDATE shared_completion_inbox i SET state='needs_review',last_error='Continuation or aggregate budget exhausted; retrieve the job result explicitly.'
         FROM shared_delegations d,shared_sessions s
         WHERE i.delegation_id=d.id AND d.session_id=s.id AND i.state='pending' AND NOT s.closed AND
           (s.continuations >= (s.definition->'limits'->>'maxContinuations')::integer OR
             s.tokens_used >= (s.definition->'limits'->>'tokenBudget')::bigint)`);
      await db.query(
        "UPDATE shared_completion_inbox SET state=CASE WHEN attempts>=5 THEN 'needs_review' ELSE 'pending' END,activation_epoch=NULL WHERE state='delivering' AND delivery_until<clock_timestamp()");
    });
  }

  async notifications(): Promise<CompletionNotice[]> {
    const rows = await this.pool.query<{ id: string; principal: string; session_id: string; job_id: string; state: CompletionNotice["state"]; activation_epoch: string | null }>(
      `SELECT i.id,s.principal,s.id AS session_id,d.job_id,i.state,i.activation_epoch FROM shared_completion_inbox i
       JOIN shared_delegations d ON d.id=i.delegation_id JOIN shared_sessions s ON s.id=d.session_id
       WHERE i.state='pending' AND NOT s.closed ORDER BY i.created_at LIMIT 100`);
    return rows.rows.map((row) => ({ id: row.id, principal: row.principal, sessionId: row.session_id, jobId: row.job_id, state: row.state,
      ...(row.activation_epoch ? { activationEpoch: row.activation_epoch } : {}) }));
  }

  async claimNotification(lease: SessionFileLease, id: string): Promise<boolean> {
    return this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      const result = await db.query(
        `UPDATE shared_completion_inbox i SET state='delivering',activation_epoch=$3,delivery_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1
         FROM shared_delegations d WHERE i.id=$1 AND i.delegation_id=d.id AND d.session_id=$2 AND i.state='pending' AND attempts<5`,
        [id, lease.id, lease.epoch]);
      return result.rowCount === 1;
    });
  }

  async finishNotification(lease: SessionFileLease, id: string, state: "delivered" | "pending" | "needs_review", error?: string): Promise<void> {
    await this.shared.transaction(async (db) => {
      await this.shared.authorize(db, lease);
      await db.query(
        `UPDATE shared_completion_inbox i SET state=CASE WHEN $4='pending' AND attempts>=5 THEN 'needs_review' ELSE $4 END,
         delivered_at=CASE WHEN $4='delivered' THEN clock_timestamp() ELSE delivered_at END,last_error=$5
         FROM shared_delegations d WHERE i.id=$1 AND i.delegation_id=d.id AND d.session_id=$2 AND i.activation_epoch=$3 AND i.state='delivering'`,
        [id, lease.id, lease.epoch, state, error?.slice(0, 500) ?? null]);
    });
  }
}

export function validateArtifactSet(values: ArtifactData[]): Array<{ path: string; sha256: string; content: Buffer }> {
  if (values.length > ARTIFACT_MAX_FILES) throw new StoreError("quota_exceeded", "Too many artifact files.");
  const names = new Set<string>();
  let total = 0;
  return values.map((value) => {
    const file = ArtifactData.parse(value);
    const content = Buffer.from(file.base64, "base64");
    total += content.length;
    if (names.has(file.path.toLowerCase()) || content.toString("base64") !== file.base64
      || content.length > ARTIFACT_MAX_BYTES || total > ARTIFACT_MAX_TOTAL_BYTES || hash(content) !== file.sha256) {
      throw new StoreError("invalid_request", "Invalid, duplicate, oversized, or checksum-mismatched artifact.");
    }
    names.add(file.path.toLowerCase());
    return { path: file.path, sha256: file.sha256, content };
  });
}
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
