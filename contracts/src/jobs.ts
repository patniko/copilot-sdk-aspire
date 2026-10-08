import { z } from "zod";
import { SEMVER, SLUG } from "./harness.js";
import { InputRequestBody, InputResponseBody, RunnerEventBody, RunnerFailureCode } from "./runner-protocol.js";

export const JobState = z.enum([
  "queued",
  "running",
  "retry_wait",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "needs_review",
]);
export type JobState = z.infer<typeof JobState>;

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "needs_review",
]);

export const JobSubmission = z
  .object({
    harness: z
      .object({
        name: z.string().regex(SLUG),
        version: z.string().regex(SEMVER).optional(),
      })
      .strict(),
    profile: z.string().regex(SLUG).optional(),
    input: z.unknown(),
    /** Narrows the harness and policy deadline; cannot extend it. */
    deadlineSeconds: z.number().int().min(10).max(3600).optional(),
  })
  .strict();
export type JobSubmission = z.infer<typeof JobSubmission>;

export const JobErrorCode = z.union([
  RunnerFailureCode,
  z.enum(["lease_expired", "executor_lost", "protocol_error", "runner_exited", "policy_rejected", "policy_revoked"]),
]);
export type JobErrorCode = z.infer<typeof JobErrorCode>;

export interface JobError {
  code: JobErrorCode;
  message: string;
}

export interface JobUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface JobView {
  id: string;
  state: JobState;
  harness: { name: string; version: string; digest: string };
  profile: string;
  createdAt: string;
  updatedAt: string;
  /** Per-attempt duration limit after intersecting harness, policy, and caller limits. */
  maxDurationSeconds: number;
  attempts: number;
  maxAttempts: number;
  /** Requirements the execution target could not enforce, acknowledged by the operator. */
  acknowledgedGaps: string[];
  /** Digest of the effective policy (base plus any harness override) that admitted the job. */
  policyDigest?: string;
  result?: unknown;
  error?: JobError;
  usage: JobUsage;
  /** Input requests (approvals or questions) waiting for an answer. */
  pendingInputs: number;
}

// ---------------------------------------------------------------------------
// Input requests: approvals and questions from a running agent, answered by the job's caller.
// ---------------------------------------------------------------------------

export const InputRequestState = z.enum(["pending", "answered", "expired", "cancelled"]);
export type InputRequestState = z.infer<typeof InputRequestState>;

export interface InputRequestView {
  /** Server-assigned id used in the API. */
  id: string;
  jobId: string;
  attempt: number;
  harness: { name: string; version: string };
  state: InputRequestState;
  request: InputRequestBody;
  /** Present once answered. */
  response?: InputResponseBody;
  createdAt: string;
  /** The request is denied (or answered empty) if nobody answers by then. */
  expiresAt: string;
  resolvedAt?: string;
}

/** Body of POST /v1/jobs/{id}/input-requests/{requestId}/respond. */
export const InputResponseSubmission = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("permission"),
      approved: z.boolean(),
      scope: z.enum(["once", "kind"]).optional(),
      feedback: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("question"), answer: z.string().min(1).max(8000) }).strict(),
]);
export type InputResponseSubmission = z.infer<typeof InputResponseSubmission>;

/** Short, display-safe summary of a request for event streams and lists. */
export function summarizeInputRequest(request: InputRequestBody): string {
  if (request.kind === "question") return `Question: ${request.question}`.slice(0, 300);
  const p = request.permission;
  const target = p.command ?? p.path ?? p.url ?? p.tool ?? p.intention ?? "";
  return `Permission (${p.type}): ${target}`.slice(0, 300);
}

/** Application events: an allowlisted, versioned contract. Raw SDK events are not exposed. */
export const JobEventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job.queued"), policyDigest: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal("job.attempt_started"),
      attempt: z.number().int(),
      profile: z.string(),
      acknowledgedGaps: z.array(z.string()),
    })
    .strict(),
  /** No executor that recently polled enforces the controls this job's policy requires. Recorded once. */
  z.object({ type: z.literal("job.waiting_for_eligible_executor"), missing: z.array(z.string()) }).strict(),
  z.object({ type: z.literal("job.runner_event"), attempt: z.number().int(), event: RunnerEventBody }).strict(),
  z.object({ type: z.literal("job.cancel_requested") }).strict(),
  z
    .object({
      type: z.literal("job.retry_scheduled"),
      attempt: z.number().int(),
      reason: JobErrorCode,
      notBefore: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("job.succeeded"), attempt: z.number().int() }).strict(),
  z.object({ type: z.literal("job.failed"), attempt: z.number().int(), code: JobErrorCode, message: z.string() }).strict(),
  z.object({ type: z.literal("job.cancelled") }).strict(),
  z.object({ type: z.literal("job.needs_review"), reason: z.string() }).strict(),
  z
    .object({
      type: z.literal("job.input_requested"),
      attempt: z.number().int(),
      requestId: z.string().uuid(),
      kind: z.enum(["permission", "question"]),
      summary: z.string().max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal("job.input_resolved"),
      requestId: z.string().uuid(),
      state: z.enum(["answered", "expired", "cancelled"]),
      approved: z.boolean().optional(),
    })
    .strict(),
]);
export type JobEventBody = z.infer<typeof JobEventBody>;

export interface JobEventView {
  seq: number;
  at: string;
  body: JobEventBody;
}
