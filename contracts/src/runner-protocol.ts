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
    /** Controls whether the runner forwards bounded SDK event payloads with its normal progress events. */
    eventDetail: z.enum(["sanitized", "full"]).optional(),
    workspace: z.string().min(1),
    traceparent: z.string().optional(),
  })
  .strict();
export type RunnerStart = z.infer<typeof RunnerStart>;

export const RunnerCancel = z
  .object({ type: z.literal("cancel"), reason: z.string().max(500) })
  .strict();
export type RunnerCancel = z.infer<typeof RunnerCancel>;

// ---------------------------------------------------------------------------
// Input requests: the agent asks a person for a permission decision or an answer.
// The runner sends input_request; the executor relays it to the dispatcher, where callers answer it
// through the API, and sends input_response back. Content is agent-generated: display it as text.
// ---------------------------------------------------------------------------

/** What a permission request asks for, reduced to fields a person needs to decide. */
export const PermissionPrompt = z
  .object({
    /** SDK permission kind; kinds without a dedicated rule are reported as "other". */
    type: z.enum(["read", "write", "shell", "url", "mcp", "other"]),
    intention: z.string().max(1000).optional(),
    /** Shell: full command text. */
    command: z.string().max(8000).optional(),
    /** Shell: command names that are not read-only, which an approval for the attempt would cover. */
    commandNames: z.array(z.string().min(1).max(100)).max(20).optional(),
    /** Read or write: file path. */
    path: z.string().max(1000).optional(),
    url: z.string().max(2000).optional(),
    /** Write: unified diff of the change (truncated). */
    diff: z.string().max(20_000).optional(),
    /** MCP or other tool name. */
    tool: z.string().max(200).optional(),
    warning: z.string().max(1000).optional(),
  })
  .strict();
export type PermissionPrompt = z.infer<typeof PermissionPrompt>;

export const InputRequestBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), permission: PermissionPrompt }).strict(),
  z
    .object({
      kind: z.literal("question"),
      question: z.string().min(1).max(4000),
      choices: z.array(z.string().min(1).max(500)).max(20).optional(),
      allowFreeform: z.boolean(),
    })
    .strict(),
]);
export type InputRequestBody = z.infer<typeof InputRequestBody>;

export const InputResponseBody = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("permission"),
      approved: z.boolean(),
      /**
       * "kind" also approves similar later requests for the rest of the attempt: the same non-read-only
       * command names, all file writes, reads in the same folder, the same website host, or the same tool.
       */
      scope: z.enum(["once", "kind"]).optional(),
      feedback: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("question"), answer: z.string().max(8000), wasFreeform: z.boolean() }).strict(),
  /** No answer arrived in time, or the request was cancelled; the runner denies or answers empty. */
  z.object({ kind: z.literal("expired") }).strict(),
]);
export type InputResponseBody = z.infer<typeof InputResponseBody>;

/** Correlation id chosen by the runner, unique within an attempt. */
export const RUNNER_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const RunnerInputResponse = z
  .object({ type: z.literal("input_response"), id: z.string().regex(RUNNER_REQUEST_ID), response: InputResponseBody })
  .strict();
export type RunnerInputResponse = z.infer<typeof RunnerInputResponse>;

export const ExecutorToRunner = z.discriminatedUnion("type", [RunnerStart, RunnerCancel, RunnerInputResponse]);
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

/**
 * Bounded SDK event detail. This can contain prompts, responses, tool arguments and tool output, so executors
 * enable it only through explicit environment configuration. Credential-like fields are redacted by runners.
 */
export const RunnerEventDetail = z
  .object({
    eventType: z.string().min(1).max(200),
    id: z.string().max(200).optional(),
    parentId: z.string().max(200).nullable().optional(),
    timestamp: z.string().max(100).optional(),
    agentId: z.string().max(200).optional(),
    ephemeral: z.boolean().optional(),
    data: z.unknown(),
  })
  .strict();
export type RunnerEventDetail = z.infer<typeof RunnerEventDetail>;

const detail = { detail: RunnerEventDetail.optional() };

/** Sanitized, allowlisted runner events, optionally carrying bounded SDK detail when explicitly enabled. */
export const RunnerEventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent.turn_started"), ...detail }).strict(),
  z.object({ kind: z.literal("agent.turn_completed"), ...detail }).strict(),
  z.object({ kind: z.literal("tool.started"), tool: z.string().max(100), ...detail }).strict(),
  z.object({ kind: z.literal("tool.completed"), tool: z.string().max(100), ok: z.boolean(), ...detail }).strict(),
  z.object({ kind: z.literal("subagent.started"), agent: z.string().max(100), ...detail }).strict(),
  z.object({ kind: z.literal("subagent.completed"), agent: z.string().max(100), ok: z.boolean(), ...detail }).strict(),
  z.object({ kind: z.literal("skill.used"), skill: z.string().max(100), ...detail }).strict(),
  z.object({ kind: z.literal("progress"), message: z.string().max(500), ...detail }).strict(),
  z.object({ kind: z.literal("sdk.event"), detail: RunnerEventDetail }).strict(),
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

export const RunnerInputRequest = z
  .object({ type: z.literal("input_request"), id: z.string().regex(RUNNER_REQUEST_ID), request: InputRequestBody })
  .strict();
export type RunnerInputRequest = z.infer<typeof RunnerInputRequest>;

export const RunnerToExecutor = z.discriminatedUnion("type", [
  RunnerHello,
  RunnerEvent,
  RunnerResult,
  RunnerFailure,
  RunnerInputRequest,
]);
export type RunnerToExecutor = z.infer<typeof RunnerToExecutor>;
