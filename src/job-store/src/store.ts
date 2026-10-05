import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_INPUT_TIMEOUT_SECONDS,
  summarizeInputRequest,
  type InputRequestBody,
  type InputRequestState,
  type InputRequestView,
  type InputResponseBody,
  type InputResponseSubmission,
  type ExecutorCapabilities,
  type HarnessSnapshot,
  type JobErrorCode,
  type JobEventBody,
  type JobEventView,
  type JobState,
  type JobView,
  type RunnerEventBody,
  type RunnerFailureCode,
  type CapabilityIntrospection,
} from "@copilot-agent/contracts";
import type pg from "pg";

export type StoreErrorCode =
  | "idempotency_conflict"
  | "quota_exceeded"
  | "not_found"
  | "invalid_state"
  | "invalid_request";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NewJob {
  principal: string;
  idempotencyKey?: string;
  requestHash: string;
  harness: HarnessSnapshot;
  profile: string;
  model: string;
  input: unknown;
  maxDurationSeconds: number;
  tokenBudget: number;
  maxAttempts: number;
  safeToRetry: boolean;
}

export interface Claim {
  job: {
    id: string;
    principal: string;
    harness: HarnessSnapshot;
    profile: string;
    model: string;
    input: unknown;
  };
  attempt: {
    id: string;
    number: number;
    leaseToken: string;
    deadline: string;
    acknowledgedGaps: string[];
  };
  capability: { jti: string; expiresAt: Date; tokenBudget: number };
}

export type AttemptOutcome =
  | { kind: "succeeded"; output: unknown }
  | { kind: "cancelled" }
  | {
      kind: "failed";
      code: JobErrorCode;
      message: string;
      retryable: boolean;
      uncertainEffects: boolean;
    };

export interface CompletionResult {
  accepted: boolean;
  state?: JobState;
}

export interface CreatedInputRequest {
  id: string;
  expiresAt: string;
}

export interface PolledInputRequest {
  state: InputRequestState;
  response?: InputResponseBody;
}

export interface ListInputRequestsOptions {
  jobId?: string;
  state?: "pending" | "all";
  limit: number;
  order?: "oldest" | "newest";
}

interface JobRow {
  id: string;
  principal: string;
  idempotency_key: string | null;
  request_hash: string;
  state: JobState;
  harness_name: string;
  harness_version: string;
  harness_digest: string;
  harness_snapshot: HarnessSnapshot;
  profile: string;
  model: string;
  input: unknown;
  max_duration_seconds: number;
  token_budget: number;
  max_attempts: number;
  safe_to_retry: boolean;
  attempts: number;
  not_before: Date;
  cancel_requested: boolean;
  result: unknown;
  error_code: JobErrorCode | null;
  error_message: string | null;
  input_tokens: string;
  output_tokens: string;
  inference_requests: number;
  created_at: Date;
  updated_at: Date;
  acknowledged_gaps?: string[] | null;
  pending_inputs?: string | number | null;
}

interface InputRequestRow {
  id: string;
  job_id: string;
  attempt_id: string;
  attempt_number: number;
  runner_request_id: string;
  kind: "permission" | "question";
  request: InputRequestBody;
  state: InputRequestState;
  response: InputResponseBody | null;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
  answered_by: string | null;
  harness_name: string;
  harness_version: string;
}

const JOB_VIEW_SELECT = `
  SELECT j.*, (
    SELECT a.acknowledged_gaps FROM attempts a WHERE a.job_id = j.id ORDER BY a.number DESC LIMIT 1
  ) AS acknowledged_gaps, (
    SELECT count(*)::int FROM input_requests ir
    WHERE ir.job_id = j.id AND ir.state = 'pending' AND ir.expires_at > now()
  ) AS pending_inputs
  FROM jobs j`;

export class JobStore {
  constructor(private readonly pool: pg.Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  // -------------------------------------------------------------------------
  // Caller-facing operations. Every read and write is scoped to the principal.
  // -------------------------------------------------------------------------

  async createJob(job: NewJob, maxOpenJobsPerPrincipal: number): Promise<{ view: JobView; created: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#tx(async (client) => {
          if (job.idempotencyKey) {
            const existing = await client.query<JobRow>(
              `${JOB_VIEW_SELECT} WHERE j.principal = $1 AND j.idempotency_key = $2`,
              [job.principal, job.idempotencyKey],
            );
            const row = existing.rows[0];
            if (row) {
              if (row.request_hash !== job.requestHash) {
                throw new StoreError(
                  "idempotency_conflict",
                  "The idempotency key was already used with a different request.",
                );
              }
              return { view: toView(row), created: false };
            }
          }
          const open = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM jobs
             WHERE principal = $1 AND state IN ('queued','retry_wait','running','cancel_requested')`,
            [job.principal],
          );
          if (Number(open.rows[0]?.count ?? 0) >= maxOpenJobsPerPrincipal) {
            throw new StoreError("quota_exceeded", "Too many open jobs for this principal.");
          }
          const id = randomUUID();
          const inserted = await client.query<JobRow>(
            `INSERT INTO jobs (id, principal, idempotency_key, request_hash, state, harness_name, harness_version,
               harness_digest, harness_snapshot, profile, model, input, max_duration_seconds, token_budget,
               max_attempts, safe_to_retry)
             VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING *`,
            [
              id,
              job.principal,
              job.idempotencyKey ?? null,
              job.requestHash,
              job.harness.definition.name,
              job.harness.definition.version,
              job.harness.digest,
              JSON.stringify(job.harness),
              job.profile,
              job.model,
              JSON.stringify(job.input ?? null),
              job.maxDurationSeconds,
              job.tokenBudget,
              job.maxAttempts,
              job.safeToRetry,
            ],
          );
          await this.#event(client, id, { type: "job.queued" });
          return { view: toView(inserted.rows[0]!), created: true };
        });
      } catch (error) {
        // A concurrent request with the same idempotency key won the insert; re-read it.
        if (isUniqueViolation(error) && attempt === 0) {
          continue;
        }
        throw error;
      }
    }
    throw new StoreError("idempotency_conflict", "Concurrent submission with the same idempotency key.");
  }

  async getJob(principal: string, id: string): Promise<JobView | undefined> {
    const result = await this.pool.query<JobRow>(`${JOB_VIEW_SELECT} WHERE j.id = $1 AND j.principal = $2`, [
      id,
      principal,
    ]);
    const row = result.rows[0];
    return row ? toView(row) : undefined;
  }

  /** Lists the principal's most recent jobs, newest first. Results are omitted to keep pages small. */
  async listJobs(principal: string, limit: number, before?: Date): Promise<JobView[]> {
    const result = await this.pool.query<JobRow>(
      `${JOB_VIEW_SELECT} WHERE j.principal = $1 AND ($2::timestamptz IS NULL OR j.created_at < $2)
       ORDER BY j.created_at DESC LIMIT $3`,
      [principal, before ?? null, limit],
    );
    return result.rows.map((row) => {
      const view = toView(row);
      delete view.result;
      return view;
    });
  }

  async listEvents(principal: string, jobId: string, afterSeq: number, limit: number): Promise<JobEventView[]> {
    const result = await this.pool.query<{ seq: string; at: Date; body: JobEventBody }>(
      `SELECT e.seq::text AS seq, e.at, e.body FROM job_events e
       JOIN jobs j ON j.id = e.job_id
       WHERE e.job_id = $1 AND j.principal = $2 AND e.seq > $3
       ORDER BY e.seq LIMIT $4`,
      [jobId, principal, afterSeq, limit],
    );
    return result.rows.map((r) => ({ seq: Number(r.seq), at: r.at.toISOString(), body: r.body }));
  }

  async listInputRequests(principal: string, options: ListInputRequestsOptions): Promise<InputRequestView[]> {
    return this.#tx(async (client) => {
      await this.#expirePendingInputsForPrincipal(client, principal, options.jobId);
      const state = options.state ?? "pending";
      const order =
        options.order ?? (state === "pending" ? "oldest" : "newest");
      const params: unknown[] = [principal, options.jobId ?? null, options.limit];
      const result = await client.query<InputRequestRow>(
        `SELECT r.*, j.harness_name, j.harness_version
         FROM input_requests r
         JOIN jobs j ON j.id = r.job_id
         WHERE j.principal = $1
           AND ($2::uuid IS NULL OR r.job_id = $2)
           AND ($4::text = 'all' OR (r.state = 'pending' AND r.expires_at > now()))
         ORDER BY r.created_at ${order === "oldest" ? "ASC" : "DESC"}, r.id ${order === "oldest" ? "ASC" : "DESC"}
         LIMIT $3`,
        [...params, state],
      );
      return result.rows.map(toInputRequestView);
    });
  }

  async respondInputRequest(
    principal: string,
    jobId: string,
    requestId: string,
    submission: InputResponseSubmission,
    answeredBy: string,
  ): Promise<InputRequestView> {
    const result = await this.#tx(async (client) => {
      const locked = await client.query<InputRequestRow>(
        `SELECT r.*, j.harness_name, j.harness_version
         FROM input_requests r
         JOIN jobs j ON j.id = r.job_id
         WHERE j.principal = $1 AND r.job_id = $2 AND r.id = $3
         FOR UPDATE OF r`,
        [principal, jobId, requestId],
      );
      const row = locked.rows[0];
      if (!row) {
        throw new StoreError("not_found", "Input request not found.");
      }
      if (row.state === "pending" && row.expires_at <= new Date()) {
        await this.#expireInputRequest(client, row);
        return { expired: true as const };
      }
      if (row.state !== "pending") {
        throw new StoreError("invalid_state", `Input request is ${row.state} and cannot be answered.`);
      }
      if (row.kind !== submission.kind || row.request.kind !== submission.kind) {
        throw new StoreError("invalid_request", `Cannot answer a ${row.kind} request with a ${submission.kind} response.`);
      }

      let response: InputResponseBody;
      if (submission.kind === "permission") {
        response = {
          kind: "permission",
          approved: submission.approved,
          ...(submission.scope !== undefined ? { scope: submission.scope } : {}),
          ...(submission.feedback !== undefined ? { feedback: submission.feedback } : {}),
        };
      } else {
        const request = row.request;
        if (request.kind !== "question") {
          throw new StoreError("invalid_request", "The input request is not a question.");
        }
        const choices = request.choices ?? [];
        if (request.allowFreeform === false && choices.length > 0 && !choices.includes(submission.answer)) {
          throw new StoreError("invalid_request", "The answer must be one of the request choices.");
        }
        response = { kind: "question", answer: submission.answer, wasFreeform: !choices.includes(submission.answer) };
      }

      const updated = await client.query<InputRequestRow>(
        `UPDATE input_requests r
         SET state = 'answered', response = $4, resolved_at = now(), answered_by = $5
         FROM jobs j
         WHERE r.id = $1 AND r.job_id = $2 AND j.id = r.job_id AND j.principal = $3
         RETURNING r.*, j.harness_name, j.harness_version`,
        [requestId, jobId, principal, JSON.stringify(response), answeredBy],
      );
      const view = toInputRequestView(updated.rows[0]!);
      await this.#event(client, jobId, {
        type: "job.input_resolved",
        requestId,
        state: "answered",
        ...(response.kind === "permission" ? { approved: response.approved } : {}),
      });
      return { view };
    });
    if ("expired" in result) {
      throw new StoreError("invalid_state", "Input request has expired and cannot be answered.");
    }
    return result.view;
  }

  async requestCancel(principal: string, id: string): Promise<JobView> {
    return this.#tx(async (client) => {
      const row = await this.#lockJob(client, id, principal);
      switch (row.state) {
        case "queued":
        case "retry_wait":
          await client.query("UPDATE jobs SET state = 'cancelled', cancel_requested = true, updated_at = now() WHERE id = $1", [id]);
          await this.#event(client, id, { type: "job.cancelled" });
          break;
        case "running":
          await client.query(
            "UPDATE jobs SET state = 'cancel_requested', cancel_requested = true, updated_at = now() WHERE id = $1",
            [id],
          );
          await this.#revokeForJob(client, id);
          await this.#cancelPendingInputsForJob(client, id);
          await this.#event(client, id, { type: "job.cancel_requested" });
          break;
        default:
          break;
      }
      return this.#view(client, id);
    });
  }

  /** Manual retry of a failed or needs-review job grants exactly one more attempt. */
  async retryJob(principal: string, id: string): Promise<JobView> {
    return this.#tx(async (client) => {
      const row = await this.#lockJob(client, id, principal);
      if (row.state !== "failed" && row.state !== "needs_review") {
        throw new StoreError("invalid_state", `A job in state '${row.state}' cannot be retried.`);
      }
      await client.query(
        `UPDATE jobs SET state = 'queued', max_attempts = attempts + 1, not_before = now(), error_code = NULL,
           error_message = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      await this.#event(client, id, { type: "job.queued" });
      return this.#view(client, id);
    });
  }

  // -------------------------------------------------------------------------
  // Dispatcher-facing operations. Attempts are fenced by (attempt id, lease token).
  // -------------------------------------------------------------------------

  async claimNext(options: {
    executor: ExecutorCapabilities;
    acknowledgedGaps: string[];
    leaseSeconds: number;
    maxConcurrentPerPrincipal: number;
  }): Promise<Claim | undefined> {
    return this.#tx(async (client) => {
      const candidate = await client.query<JobRow>(
        `SELECT j.* FROM jobs j
         WHERE j.state IN ('queued','retry_wait') AND j.not_before <= now() AND j.profile = ANY($1::text[])
           AND (SELECT count(*) FROM jobs r WHERE r.principal = j.principal AND r.state IN ('running','cancel_requested')) < $2
         ORDER BY j.not_before, j.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [options.executor.profiles, options.maxConcurrentPerPrincipal],
      );
      const job = candidate.rows[0];
      if (!job) {
        return undefined;
      }
      const attemptId = randomUUID();
      const number = job.attempts + 1;
      const leaseToken = randomBytes(32).toString("base64url");
      const attempt = await client.query<{ deadline: Date }>(
        `INSERT INTO attempts (id, job_id, number, executor_id, lease_token, lease_expires_at, deadline, status,
           acknowledged_gaps, executor_capabilities)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), now() + make_interval(secs => $7), 'running', $8, $9)
         RETURNING deadline`,
        [
          attemptId,
          job.id,
          number,
          options.executor.executorId,
          leaseToken,
          options.leaseSeconds,
          job.max_duration_seconds,
          options.acknowledgedGaps,
          JSON.stringify(options.executor),
        ],
      );
      const deadline = attempt.rows[0]!.deadline;
      await client.query("UPDATE jobs SET state = 'running', attempts = $2, updated_at = now() WHERE id = $1", [
        job.id,
        number,
      ]);
      const used = Number(job.input_tokens) + Number(job.output_tokens);
      const tokenBudget = Math.max(0, job.token_budget - used);
      const jti = randomUUID();
      const expiresAt = new Date(deadline.getTime() + 60_000);
      await client.query(
        "INSERT INTO capabilities (jti, attempt_id, expires_at, token_budget) VALUES ($1, $2, $3, $4)",
        [jti, attemptId, expiresAt, tokenBudget],
      );
      await this.#event(client, job.id, {
        type: "job.attempt_started",
        attempt: number,
        profile: job.profile,
        acknowledgedGaps: options.acknowledgedGaps,
      });
      return {
        job: {
          id: job.id,
          principal: job.principal,
          harness: job.harness_snapshot,
          profile: job.profile,
          model: job.model,
          input: job.input,
        },
        attempt: {
          id: attemptId,
          number,
          leaseToken,
          deadline: deadline.toISOString(),
          acknowledgedGaps: options.acknowledgedGaps,
        },
        capability: { jti, expiresAt, tokenBudget },
      };
    });
  }

  /** Extends a lease. Returns undefined when the caller no longer owns the attempt. */
  async heartbeat(
    attemptId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<{ cancelRequested: boolean; deadline: string } | undefined> {
    const result = await this.pool.query<{ cancel_requested: boolean; deadline: Date }>(
      `UPDATE attempts a SET lease_expires_at = now() + make_interval(secs => $3)
       FROM jobs j
       WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'running' AND j.id = a.job_id
       RETURNING j.cancel_requested, a.deadline`,
      [attemptId, leaseToken, leaseSeconds],
    );
    const row = result.rows[0];
    return row ? { cancelRequested: row.cancel_requested, deadline: row.deadline.toISOString() } : undefined;
  }

  async recordProvenance(attemptId: string, leaseToken: string, provenance: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE attempts SET provenance = provenance || $3::jsonb
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [attemptId, leaseToken, JSON.stringify(provenance)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendRunnerEvent(attemptId: string, leaseToken: string, event: RunnerEventBody): Promise<boolean> {
    return this.#tx(async (client) => {
      const owner = await client.query<{ job_id: string; number: number }>(
        "SELECT job_id, number FROM attempts WHERE id = $1 AND lease_token = $2 AND status = 'running'",
        [attemptId, leaseToken],
      );
      const row = owner.rows[0];
      if (!row) {
        return false;
      }
      await this.#event(client, row.job_id, { type: "job.runner_event", attempt: row.number, event });
      return true;
    });
  }

  async createInputRequest(
    attemptId: string,
    leaseToken: string,
    runnerRequestId: string,
    request: InputRequestBody,
    _executorTimeoutSeconds?: number,
  ): Promise<CreatedInputRequest | undefined> {
    return this.#tx(async (client) => {
      const owner = await client.query<{
        job_id: string;
        number: number;
        deadline: Date;
        harness_snapshot: HarnessSnapshot;
      }>(
        `SELECT a.job_id, a.number, a.deadline, j.harness_snapshot
         FROM attempts a
         JOIN jobs j ON j.id = a.job_id
         WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'running'
         FOR UPDATE OF a`,
        [attemptId, leaseToken],
      );
      const attempt = owner.rows[0];
      if (!attempt) {
        return undefined;
      }

      const existing = await client.query<{ id: string; expires_at: Date }>(
        "SELECT id, expires_at FROM input_requests WHERE attempt_id = $1 AND runner_request_id = $2",
        [attemptId, runnerRequestId],
      );
      const duplicate = existing.rows[0];
      if (duplicate) {
        return { id: duplicate.id, expiresAt: duplicate.expires_at.toISOString() };
      }

      await this.#expirePendingInputsForAttempt(client, attemptId);
      const pending = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM input_requests
         WHERE attempt_id = $1 AND state = 'pending' AND expires_at > now()`,
        [attemptId],
      );
      if ((pending.rows[0]?.count ?? 0) >= 5) {
        throw new StoreError("quota_exceeded", "Too many pending input requests for this attempt.");
      }

      const timeoutSeconds =
        attempt.harness_snapshot.definition.permissions?.timeoutSeconds ?? DEFAULT_INPUT_TIMEOUT_SECONDS;
      const id = randomUUID();
      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO input_requests
           (id, job_id, attempt_id, attempt_number, runner_request_id, kind, request, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', LEAST(now() + ($8::int * interval '1 second'), $9))
         RETURNING id, expires_at`,
        [
          id,
          attempt.job_id,
          attemptId,
          attempt.number,
          runnerRequestId,
          request.kind,
          JSON.stringify(request),
          timeoutSeconds,
          attempt.deadline,
        ],
      );
      await this.#event(client, attempt.job_id, {
        type: "job.input_requested",
        attempt: attempt.number,
        requestId: id,
        kind: request.kind,
        summary: summarizeInputRequest(request),
      });
      return { id, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
    });
  }

  async pollInputRequest(
    attemptId: string,
    leaseToken: string,
    id: string,
  ): Promise<PolledInputRequest | null | undefined> {
    return this.#tx(async (client) => {
      const owner = await client.query<{ job_id: string }>(
        `SELECT job_id FROM attempts
         WHERE id = $1 AND lease_token = $2 AND status = 'running'
         FOR UPDATE`,
        [attemptId, leaseToken],
      );
      if (!owner.rows[0]) {
        return undefined;
      }
      const request = await client.query<InputRequestRow>(
        `SELECT r.*, j.harness_name, j.harness_version
         FROM input_requests r
         JOIN jobs j ON j.id = r.job_id
         WHERE r.id = $1 AND r.attempt_id = $2
         FOR UPDATE OF r`,
        [id, attemptId],
      );
      const row = request.rows[0];
      if (!row) {
        return null;
      }
      if (row.state === "pending" && row.expires_at <= new Date()) {
        await this.#expireInputRequest(client, row);
        return { state: "expired" };
      }
      return row.response ? { state: row.state, response: row.response } : { state: row.state };
    });
  }

  async completeAttempt(
    attemptId: string,
    leaseToken: string,
    outcome: AttemptOutcome,
    backoffSeconds: number,
  ): Promise<CompletionResult> {
    return this.#tx(async (client) => {
      const owner = await client.query<{ job_id: string; number: number }>(
        `SELECT a.job_id, a.number FROM attempts a
         WHERE a.id = $1 AND a.lease_token = $2 AND a.status = 'running' FOR UPDATE`,
        [attemptId, leaseToken],
      );
      const attempt = owner.rows[0];
      if (!attempt) {
        return { accepted: false };
      }
      const job = await this.#lockJob(client, attempt.job_id);
      const state = await this.#settle(client, job, attempt.number, attemptId, outcome, backoffSeconds);
      return { accepted: true, state };
    });
  }

  /**
   * Recovers attempts whose lease expired (executor loss or forced termination). Read-only work is
   * retried; work with possible external effects is marked for review instead of being repeated.
   */
  async reapExpiredLeases(backoffSeconds: number, limit = 50): Promise<number> {
    return this.#tx(async (client) => {
      const expired = await client.query<{ id: string; job_id: string; number: number }>(
        `SELECT id, job_id, number FROM attempts
         WHERE status = 'running' AND lease_expires_at < now()
         ORDER BY lease_expires_at
         FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      for (const attempt of expired.rows) {
        const job = await this.#lockJob(client, attempt.job_id);
        await this.#settle(
          client,
          job,
          attempt.number,
          attempt.id,
          {
            kind: "failed",
            code: "lease_expired",
            message: "The executor stopped renewing its lease.",
            retryable: true,
            uncertainEffects: true,
          },
          backoffSeconds,
        );
      }
      return expired.rowCount ?? 0;
    });
  }

  // -------------------------------------------------------------------------
  // Capability introspection and usage, used by the inference gateway.
  // -------------------------------------------------------------------------

  async introspectCapability(jti: string): Promise<CapabilityIntrospection> {
    const result = await this.pool.query<{
      revoked: boolean;
      expired: boolean;
      token_budget: number;
      tokens_used: string;
      status: string;
      cancel_requested: boolean;
    }>(
      `SELECT c.revoked, c.expires_at < now() AS expired, c.token_budget, c.tokens_used::text AS tokens_used,
              a.status, j.cancel_requested
       FROM capabilities c JOIN attempts a ON a.id = c.attempt_id JOIN jobs j ON j.id = a.job_id
       WHERE c.jti = $1`,
      [jti],
    );
    const row = result.rows[0];
    if (!row) {
      return { active: false, reason: "unknown", remainingTokens: 0 };
    }
    const remainingTokens = Math.max(0, row.token_budget - Number(row.tokens_used));
    if (row.revoked || row.expired || row.cancel_requested) {
      return { active: false, reason: "revoked", remainingTokens };
    }
    if (row.status !== "running") {
      return { active: false, reason: "attempt_inactive", remainingTokens };
    }
    if (remainingTokens <= 0) {
      return { active: false, reason: "budget_exhausted", remainingTokens };
    }
    return { active: true, remainingTokens };
  }

  async recordUsage(jti: string, inputTokens: number, outputTokens: number): Promise<boolean> {
    const input = Math.max(0, Math.floor(inputTokens));
    const output = Math.max(0, Math.floor(outputTokens));
    const result = await this.pool.query(
      `WITH cap AS (
         UPDATE capabilities SET tokens_used = tokens_used + $2 + $3 WHERE jti = $1 RETURNING attempt_id
       )
       UPDATE jobs j SET input_tokens = j.input_tokens + $2, output_tokens = j.output_tokens + $3,
              inference_requests = j.inference_requests + 1, updated_at = now()
       FROM attempts a, cap
       WHERE a.id = cap.attempt_id AND j.id = a.job_id`,
      [jti, input, output],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------

  async #settle(
    client: pg.PoolClient,
    job: JobRow,
    attemptNumber: number,
    attemptId: string,
    outcome: AttemptOutcome,
    backoffSeconds: number,
  ): Promise<JobState> {
    const attemptStatus =
      outcome.kind === "succeeded"
        ? "succeeded"
        : outcome.kind === "cancelled"
          ? "cancelled"
          : outcome.code === "lease_expired"
            ? "lost"
            : "failed";
    await client.query(
      "UPDATE attempts SET status = $2, error_code = $3, finished_at = now() WHERE id = $1",
      [attemptId, attemptStatus, outcome.kind === "failed" ? outcome.code : null],
    );
    await client.query("UPDATE capabilities SET revoked = true WHERE attempt_id = $1", [attemptId]);
    await this.#cancelPendingInputsForAttempt(client, attemptId);

    if (outcome.kind === "succeeded") {
      await client.query(
        "UPDATE jobs SET state = 'succeeded', result = $2, error_code = NULL, error_message = NULL, updated_at = now() WHERE id = $1",
        [job.id, JSON.stringify(outcome.output ?? null)],
      );
      await this.#event(client, job.id, { type: "job.succeeded", attempt: attemptNumber });
      return "succeeded";
    }

    if (job.cancel_requested || outcome.kind === "cancelled") {
      await client.query("UPDATE jobs SET state = 'cancelled', updated_at = now() WHERE id = $1", [job.id]);
      await this.#event(client, job.id, { type: "job.cancelled" });
      return "cancelled";
    }

    const failure = outcome;
    const canRetry =
      failure.retryable && attemptNumber < job.max_attempts && (job.safe_to_retry || !failure.uncertainEffects);
    if (canRetry) {
      const delay = backoffSeconds * 2 ** (attemptNumber - 1);
      const notBefore = new Date(Date.now() + delay * 1000);
      await client.query(
        "UPDATE jobs SET state = 'retry_wait', not_before = $2, error_code = $3, error_message = $4, updated_at = now() WHERE id = $1",
        [job.id, notBefore, failure.code, failure.message],
      );
      await this.#event(client, job.id, {
        type: "job.retry_scheduled",
        attempt: attemptNumber,
        reason: failure.code,
        notBefore: notBefore.toISOString(),
      });
      return "retry_wait";
    }

    if (failure.uncertainEffects && !job.safe_to_retry) {
      await client.query(
        "UPDATE jobs SET state = 'needs_review', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1",
        [job.id, failure.code, failure.message],
      );
      await this.#event(client, job.id, {
        type: "job.needs_review",
        reason: `Attempt ${attemptNumber} ended with an uncertain external outcome (${failure.code}).`,
      });
      return "needs_review";
    }

    await client.query(
      "UPDATE jobs SET state = 'failed', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1",
      [job.id, failure.code, failure.message],
    );
    await this.#event(client, job.id, {
      type: "job.failed",
      attempt: attemptNumber,
      code: failure.code,
      message: failure.message,
    });
    return "failed";
  }

  async #expirePendingInputsForAttempt(client: pg.PoolClient, attemptId: string): Promise<void> {
    const expired = await client.query<{ id: string; job_id: string }>(
      `UPDATE input_requests
       SET state = 'expired', resolved_at = now()
       WHERE attempt_id = $1 AND state = 'pending' AND expires_at <= now()
       RETURNING id, job_id`,
      [attemptId],
    );
    for (const row of expired.rows) {
      await this.#event(client, row.job_id, { type: "job.input_resolved", requestId: row.id, state: "expired" });
    }
  }

  async #expirePendingInputsForPrincipal(
    client: pg.PoolClient,
    principal: string,
    jobId?: string,
  ): Promise<void> {
    const expired = await client.query<{ id: string; job_id: string }>(
      `UPDATE input_requests r
       SET state = 'expired', resolved_at = now()
       FROM jobs j
       WHERE r.job_id = j.id AND j.principal = $1
         AND ($2::uuid IS NULL OR r.job_id = $2)
         AND r.state = 'pending' AND r.expires_at <= now()
       RETURNING r.id, r.job_id`,
      [principal, jobId ?? null],
    );
    for (const row of expired.rows) {
      await this.#event(client, row.job_id, { type: "job.input_resolved", requestId: row.id, state: "expired" });
    }
  }

  async #expireInputRequest(client: pg.PoolClient, row: Pick<InputRequestRow, "id" | "job_id">): Promise<void> {
    const updated = await client.query<{ id: string; job_id: string }>(
      `UPDATE input_requests
       SET state = 'expired', resolved_at = now()
       WHERE id = $1 AND state = 'pending'
       RETURNING id, job_id`,
      [row.id],
    );
    for (const expired of updated.rows) {
      await this.#event(client, expired.job_id, {
        type: "job.input_resolved",
        requestId: expired.id,
        state: "expired",
      });
    }
  }

  async #cancelPendingInputsForAttempt(client: pg.PoolClient, attemptId: string): Promise<void> {
    const cancelled = await client.query<{ id: string; job_id: string }>(
      `UPDATE input_requests
       SET state = 'cancelled', resolved_at = now()
       WHERE attempt_id = $1 AND state = 'pending'
       RETURNING id, job_id`,
      [attemptId],
    );
    for (const row of cancelled.rows) {
      await this.#event(client, row.job_id, { type: "job.input_resolved", requestId: row.id, state: "cancelled" });
    }
  }

  async #cancelPendingInputsForJob(client: pg.PoolClient, jobId: string): Promise<void> {
    const cancelled = await client.query<{ id: string; job_id: string }>(
      `UPDATE input_requests
       SET state = 'cancelled', resolved_at = now()
       WHERE job_id = $1 AND state = 'pending'
       RETURNING id, job_id`,
      [jobId],
    );
    for (const row of cancelled.rows) {
      await this.#event(client, row.job_id, { type: "job.input_resolved", requestId: row.id, state: "cancelled" });
    }
  }

  async #lockJob(client: pg.PoolClient, id: string, principal?: string): Promise<JobRow> {
    const result = await client.query<JobRow>(
      principal
        ? "SELECT * FROM jobs WHERE id = $1 AND principal = $2 FOR UPDATE"
        : "SELECT * FROM jobs WHERE id = $1 FOR UPDATE",
      principal ? [id, principal] : [id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new StoreError("not_found", "Job not found.");
    }
    return row;
  }

  async #view(client: pg.PoolClient, id: string): Promise<JobView> {
    const result = await client.query<JobRow>(`${JOB_VIEW_SELECT} WHERE j.id = $1`, [id]);
    return toView(result.rows[0]!);
  }

  async #revokeForJob(client: pg.PoolClient, jobId: string): Promise<void> {
    await client.query(
      `UPDATE capabilities c SET revoked = true FROM attempts a
       WHERE c.attempt_id = a.id AND a.job_id = $1 AND a.status = 'running'`,
      [jobId],
    );
  }

  async #event(client: pg.PoolClient, jobId: string, body: JobEventBody): Promise<void> {
    await client.query("INSERT INTO job_events (job_id, body) VALUES ($1, $2)", [jobId, JSON.stringify(body)]);
    await client.query("SELECT pg_notify('job_events', $1)", [jobId]);
  }

  async #tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function toView(row: JobRow): JobView {
  const view: JobView = {
    id: row.id,
    state: row.state,
    harness: { name: row.harness_name, version: row.harness_version, digest: row.harness_digest },
    profile: row.profile,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    maxDurationSeconds: row.max_duration_seconds,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    acknowledgedGaps: row.acknowledged_gaps ?? [],
    usage: {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      requests: row.inference_requests,
    },
    pendingInputs: Number(row.pending_inputs ?? 0),
  };
  if (row.state === "succeeded") {
    view.result = row.result;
  }
  if (row.error_code && (row.state === "failed" || row.state === "needs_review" || row.state === "retry_wait")) {
    view.error = { code: row.error_code, message: row.error_message ?? "" };
  }
  return view;
}

function toInputRequestView(row: InputRequestRow): InputRequestView {
  return {
    id: row.id,
    jobId: row.job_id,
    attempt: row.attempt_number,
    harness: { name: row.harness_name, version: row.harness_version },
    state: row.state,
    request: row.request,
    ...(row.response ? { response: row.response } : {}),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export type { RunnerFailureCode };
