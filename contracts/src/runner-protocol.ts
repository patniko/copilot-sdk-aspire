import { z } from "zod";
import { HarnessDefinition } from "./harness.js";

export const RUNNER_PROTOCOL_VERSION = "1" as const;

/** Maximum size of one protocol line in either direction. */
export const RUNNER_MAX_LINE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Executor -> runner (stdin, JSON Lines)
// ---------------------------------------------------------------------------

export const RunnerStart = z
  .object({
    type: z.literal("start"),
    protocol: z.literal(RUNNER_PROTOCOL_VERSION),
    job: z
      .object({
        id: z.string().uuid(),
        attempt: z.number().int().min(1),
        principal: z.string().min(1),
      })
      .strict(),
    harness: z.object({ definition: HarnessDefinition, digest: z.string() }).strict(),
    profile: z.string(),
    input: z.unknown(),
    deadline: z.string().datetime(),
    inference: z
      .object({
        /** OpenAI-compatible base URL of the inference gateway, ending in /openai/v1/. */
        baseUrl: z.string().url(),
        /** Job-scoped capability. Not an upstream provider credential. */
        token: z.string().min(1),
        model: z.string().min(1),
      })
      .strict(),
    workspace: z.string().min(1),
    traceparent: z.string().optional(),
  })
  .strict();
export type RunnerStart = z.infer<typeof RunnerStart>;

export const RunnerCancel = z
  .object({ type: z.literal("cancel"), reason: z.string().max(500) })
  .strict();
export type RunnerCancel = z.infer<typeof RunnerCancel>;

export const ExecutorToRunner = z.discriminatedUnion("type", [RunnerStart, RunnerCancel]);
export type ExecutorToRunner = z.infer<typeof ExecutorToRunner>;

// ---------------------------------------------------------------------------
// Runner -> executor (stdout, JSON Lines). Diagnostics go to stderr.
// ---------------------------------------------------------------------------

export const RunnerHello = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(RUNNER_PROTOCOL_VERSION),
    runner: z
      .object({
        name: z.string().max(200),
        version: z.string().max(100),
        language: z.string().max(50),
        sdkVersion: z.string().max(100),
      })
      .strict(),
    capabilities: z.array(z.string().max(100)).max(50),
  })
  .strict();
export type RunnerHello = z.infer<typeof RunnerHello>;

/** Sanitized, allowlisted runner events. Raw SDK events are never forwarded. */
export const RunnerEventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent.turn_started") }).strict(),
  z.object({ kind: z.literal("agent.turn_completed") }).strict(),
  z.object({ kind: z.literal("tool.started"), tool: z.string().max(100) }).strict(),
  z.object({ kind: z.literal("tool.completed"), tool: z.string().max(100), ok: z.boolean() }).strict(),
  z.object({ kind: z.literal("progress"), message: z.string().max(500) }).strict(),
]);
export type RunnerEventBody = z.infer<typeof RunnerEventBody>;

export const RunnerEvent = z.object({ type: z.literal("event"), event: RunnerEventBody }).strict();
export type RunnerEvent = z.infer<typeof RunnerEvent>;

export const RunnerResult = z.object({ type: z.literal("result"), output: z.unknown() }).strict();
export type RunnerResult = z.infer<typeof RunnerResult>;

export const RunnerFailureCode = z.enum([
  "invalid_input",
  "invalid_output",
  "cancelled",
  "deadline_exceeded",
  "inference_error",
  "tool_error",
  "unsupported",
  "internal",
]);
export type RunnerFailureCode = z.infer<typeof RunnerFailureCode>;

export const RunnerFailure = z
  .object({
    type: z.literal("failure"),
    code: RunnerFailureCode,
    message: z.string().max(2000),
    retryable: z.boolean(),
    /** True when an external side effect may have happened and its outcome is unknown. */
    uncertainEffects: z.boolean(),
  })
  .strict();
export type RunnerFailure = z.infer<typeof RunnerFailure>;

export const RunnerToExecutor = z.discriminatedUnion("type", [
  RunnerHello,
  RunnerEvent,
  RunnerResult,
  RunnerFailure,
]);
export type RunnerToExecutor = z.infer<typeof RunnerToExecutor>;
