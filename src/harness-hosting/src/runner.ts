import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_INPUT_TIMEOUT_SECONDS,
  renderSkillMarkdown,
  type InputRequestBody,
  type InputResponseBody,
  type RunnerEventBody,
  type RunnerEventDetail,
  type RunnerFailureCode,
  type RunnerStart,
} from "@copilot-agent/contracts";
import { CopilotClient, defineTool, type SessionEvent } from "@github/copilot-sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildPermissionHandler } from "./permissions.js";
import { buildSessionOptions } from "./session-config.js";
import { bindTools, UnsupportedBindingError, type ToolEnvironment } from "./tools.js";

export interface RunnerSink {
  event(event: RunnerEventBody): void;
  result(output: unknown): void;
  failure(code: RunnerFailureCode, message: string, retryable: boolean, uncertainEffects?: boolean): void;
}

export interface RunOptions {
  start: RunnerStart;
  sink: RunnerSink;
  cancel: AbortSignal;
  ask: (request: InputRequestBody, timeoutMs?: number) => Promise<InputResponseBody>;
  toolsRoot: string;
  pythonBin: string;
}

/**
 * Runs one harness attempt with the Copilot SDK. The session uses empty mode, an explicit tool
 * allowlist, no ambient configuration discovery, and a BYOK provider that points at the inference
 * gateway with the job-scoped capability. No upstream provider credential is available here.
 */
export async function runHarness(options: RunOptions): Promise<void> {
  const { start, sink, cancel } = options;
  const definition = start.harness.definition;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);

  const validateInput = ajv.compile(definition.input.schema);
  if (!validateInput(start.input)) {
    sink.failure("invalid_input", "The job input does not match the harness input schema.", false);
    return;
  }
  const validateOutput = ajv.compile(definition.output.schema);

  const workspace = start.workspace;
  const files = join(workspace, "files");
  await mkdir(files, { recursive: true });
  const skillsDirectory = join(workspace, "skills");
  for (const skill of definition.skills ?? []) {
    await mkdir(join(skillsDirectory, skill.name), { recursive: true });
    await writeFile(join(skillsDirectory, skill.name, "SKILL.md"), renderSkillMarkdown(skill), "utf8");
  }
  const toolEnv: ToolEnvironment = { toolsRoot: options.toolsRoot, pythonBin: options.pythonBin, workspace: files };

  let tools;
  try {
    tools = bindTools(definition.tools, toolEnv);
  } catch (error) {
    if (error instanceof UnsupportedBindingError) {
      sink.failure("unsupported", error.message, false);
      return;
    }
    throw error;
  }

  let submitted: { output: unknown } | undefined;
  const submitResult = defineTool("submit_result", {
    description: "Submit the final structured result of this job. Call exactly once when finished.",
    parameters: definition.output.schema,
    skipPermission: true,
    isTerminal: true,
    handler: async (args: unknown) => {
      if (!validateOutput(args)) {
        const problems = (validateOutput.errors ?? [])
          .slice(0, 10)
          .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
          .join("; ");
        throw new Error(`The result does not match the required schema: ${problems}`);
      }
      submitted = { output: args };
      return { accepted: true };
    },
  });
  const allTools = [...tools, submitResult];
  const sessionOptions = buildSessionOptions(
    definition,
    allTools.map((t) => t.name),
    skillsDirectory,
  );

  const runtimeEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "windir", "PATHEXT", "LOCALAPPDATA", "APPDATA"]) {
    const value = process.env[key];
    if (value) {
      runtimeEnv[key] = value;
    }
  }

  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: join(workspace, "copilot-home"),
    workingDirectory: files,
    useLoggedInUser: false,
    logLevel: "error",
    env: runtimeEnv,
  });

  const toolNames = new Map<string, string>();
  let lastError: { message: string; statusCode?: number } | undefined;
  const detailedEvents = start.eventDetail === "full";
  const emit = (event: RunnerEventBody, detail?: RunnerEventDetail) =>
    sink.event(detail && event.kind !== "sdk.event" ? { ...event, detail } : event);
  const onEvent = (event: SessionEvent) => {
    const detail = detailedEvents ? captureSessionEvent(event) : undefined;
    switch (event.type) {
      case "assistant.turn_start":
        emit({ kind: "agent.turn_started" }, detail);
        break;
      case "assistant.turn_end":
        emit({ kind: "agent.turn_completed" }, detail);
        break;
      case "tool.execution_start":
        toolNames.set(event.data.toolCallId, event.data.toolName);
        emit({ kind: "tool.started", tool: event.data.toolName.slice(0, 100) }, detail);
        break;
      case "tool.execution_complete":
        emit(
          {
            kind: "tool.completed",
            tool: (toolNames.get(event.data.toolCallId) ?? "unknown").slice(0, 100),
            ok: event.data.success,
          },
          detail,
        );
        break;
      case "subagent.started":
        emit({ kind: "subagent.started", agent: event.data.agentName.slice(0, 100) }, detail);
        break;
      case "subagent.completed":
        emit({ kind: "subagent.completed", agent: event.data.agentName.slice(0, 100), ok: true }, detail);
        break;
      case "subagent.failed":
        emit({ kind: "subagent.completed", agent: event.data.agentName.slice(0, 100), ok: false }, detail);
        break;
      case "skill.invoked":
        emit({ kind: "skill.used", skill: event.data.name.slice(0, 100) }, detail);
        break;
      case "session.error":
        lastError = { message: event.data.message, statusCode: event.data.statusCode };
        if (detail) sink.event({ kind: "sdk.event", detail });
        break;
      default:
        if (detail) sink.event({ kind: "sdk.event", detail });
        break;
    }
  };

  const attemptDeadlineMs = new Date(start.deadline).getTime();
  const inputTimeoutMs = () =>
    Math.max(
      0,
      Math.min((definition.permissions?.timeoutSeconds ?? DEFAULT_INPUT_TIMEOUT_SECONDS) * 1000, attemptDeadlineMs - Date.now() - 1_000),
    );
  const askInput = (request: InputRequestBody): Promise<InputResponseBody> => {
    const timeoutMs = inputTimeoutMs();
    if (cancel.aborted || timeoutMs <= 0) return Promise.resolve({ kind: "expired" });
    return options.ask(request, timeoutMs);
  };
  const truncate = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
  const questionChoices = (choices: string[] | undefined) => {
    const kept = choices?.map((choice) => truncate(choice, 500)).filter((choice) => choice.length > 0).slice(0, 20);
    return kept?.length ? kept : undefined;
  };
  const onUserInputRequest =
    definition.permissions?.questions === true
      ? async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
          const response = await askInput({
            kind: "question",
            question: truncate(request.question || "The agent asks for input.", 4000),
            choices: questionChoices(request.choices),
            allowFreeform: request.allowFreeform ?? true,
          });
          if (response.kind === "question") return { answer: response.answer, wasFreeform: response.wasFreeform };
          return {
            answer: "No answer was given in time. Continue with your best judgement and state your assumptions.",
            wasFreeform: true,
          };
        }
      : undefined;

  await client.start();
  try {
    const session = await client.createSession({
      model: start.inference.model,
      provider: {
        type: "openai",
        baseUrl: start.inference.baseUrl,
        apiKey: start.inference.token,
        wireApi: "completions",
      },
      tools: allTools,
      ...sessionOptions,
      onPermissionRequest: buildPermissionHandler(definition.permissions, askInput),
      ...(onUserInputRequest ? { onUserInputRequest } : {}),
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
    });
    session.on(onEvent);
    const abortSession = () => void session.abort().catch(() => undefined);
    cancel.addEventListener("abort", abortSession, { once: true });

    const remainingMs = () => attemptDeadlineMs - Date.now() - 3_000;
    const prompt =
      `Job input (JSON):\n\`\`\`json\n${JSON.stringify(start.input, null, 2)}\n\`\`\`\n\n` +
      "Complete the task using the available tools, then call submit_result.";

    try {
      for (const message of [prompt, "You have not submitted a valid result yet. Call submit_result now."]) {
        if (submitted || cancel.aborted) {
          break;
        }
        if (remainingMs() <= 0) {
          sink.failure("deadline_exceeded", "The attempt deadline was reached.", false);
          return;
        }
        await session.sendAndWait({ prompt: message }, remainingMs());
      }
    } catch (error) {
      if (cancel.aborted) {
        sink.failure("cancelled", "The attempt was cancelled.", false);
        return;
      }
      const message = (error as Error).message ?? "";
      if (/timeout/i.test(message) || remainingMs() <= 0) {
        sink.failure("deadline_exceeded", "The attempt deadline was reached.", false);
        return;
      }
      const forbidden = lastError?.statusCode === 401 || lastError?.statusCode === 403;
      sink.failure(
        "inference_error",
        `Inference failed${lastError?.statusCode ? ` (${lastError.statusCode})` : ""}.`,
        !forbidden,
      );
      return;
    } finally {
      cancel.removeEventListener("abort", abortSession);
    }

    if (cancel.aborted) {
      sink.failure("cancelled", "The attempt was cancelled.", false);
    } else if (submitted) {
      sink.result(submitted.output);
    } else {
      sink.failure("invalid_output", "The agent finished without submitting a valid result.", false);
    }
    await session.disconnect().catch(() => undefined);
  } finally {
    await client.stop().catch(() => undefined);
  }
}

const MAX_DETAIL_JSON_BYTES = 200_000;
const MAX_DETAIL_STRING_CHARS = 50_000;
const MAX_DETAIL_COLLECTION_ITEMS = 100;
const REDACTED_DETAIL_KEYS = /^(authorization|cookie|set-cookie|token|access[_-]?token|api[_-]?key|password|secret|encryptedContent)$/i;

function captureSessionEvent(event: SessionEvent): RunnerEventDetail {
  const detail = {
    eventType: event.type,
    id: event.id,
    parentId: event.parentId,
    timestamp: event.timestamp,
    agentId: event.agentId,
    ephemeral: event.ephemeral,
    data: sanitizeDetailValue(event.data),
  };
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json, "utf8") <= MAX_DETAIL_JSON_BYTES) {
    return detail;
  }
  return {
    eventType: event.type,
    id: event.id,
    parentId: event.parentId,
    timestamp: event.timestamp,
    agentId: event.agentId,
    ephemeral: event.ephemeral,
    data: {
      truncated: true,
      originalBytes: Buffer.byteLength(json, "utf8"),
      preview: json.slice(0, MAX_DETAIL_JSON_BYTES - 1_000),
    },
  };
}

function sanitizeDetailValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_STRING_CHARS ? `${value.slice(0, MAX_DETAIL_STRING_CHARS)}\n[truncated]` : value;
  }
  if (depth >= 12) return "[maximum depth reached]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_DETAIL_COLLECTION_ITEMS).map((item) => sanitizeDetailValue(item, depth + 1));
    if (value.length > kept.length) kept.push(`[${value.length - kept.length} more items]`);
    return kept;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_DETAIL_COLLECTION_ITEMS);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[key] = REDACTED_DETAIL_KEYS.test(key) ? "[redacted]" : sanitizeDetailValue(item, depth + 1);
    }
    const total = Object.keys(value as Record<string, unknown>).length;
    if (total > entries.length) result.__truncatedKeys = total - entries.length;
    return result;
  }
  return String(value);
}
