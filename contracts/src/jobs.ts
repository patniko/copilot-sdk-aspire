import { z } from "zod";
import { SEMVER, SLUG } from "./harness.js";
import { RunnerEventBody, RunnerFailureCode } from "./runner-protocol.js";

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
  z.enum(["lease_expired", "executor_lost", "protocol_error", "runner_exited", "policy_rejected"]),
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
  result?: unknown;
  error?: JobError;
  usage: JobUsage;
}

/** Application events: an allowlisted, versioned contract. Raw SDK events are not exposed. */
export const JobEventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job.queued") }).strict(),
  z
    .object({
      type: z.literal("job.attempt_started"),
      attempt: z.number().int(),
      profile: z.string(),
      acknowledgedGaps: z.array(z.string()),
    })
    .strict(),
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
]);
export type JobEventBody = z.infer<typeof JobEventBody>;

export interface JobEventView {
  seq: number;
  at: string;
  body: JobEventBody;
}
