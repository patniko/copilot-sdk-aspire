import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderSkillMarkdown, type RunnerEventBody, type RunnerFailureCode, type RunnerStart } from "@copilot-agent/contracts";
import { CopilotClient, defineTool, type SessionEvent } from "@github/copilot-sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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
  const onEvent = (event: SessionEvent) => {
    switch (event.type) {
      case "assistant.turn_start":
        sink.event({ kind: "agent.turn_started" });
        break;
      case "assistant.turn_end":
        sink.event({ kind: "agent.turn_completed" });
        break;
      case "tool.execution_start":
        toolNames.set(event.data.toolCallId, event.data.toolName);
        sink.event({ kind: "tool.started", tool: event.data.toolName.slice(0, 100) });
        break;
      case "tool.execution_complete":
        sink.event({
          kind: "tool.completed",
          tool: (toolNames.get(event.data.toolCallId) ?? "unknown").slice(0, 100),
          ok: event.data.success,
        });
        break;
      case "subagent.started":
        sink.event({ kind: "subagent.started", agent: event.data.agentName.slice(0, 100) });
        break;
      case "subagent.completed":
        sink.event({ kind: "subagent.completed", agent: event.data.agentName.slice(0, 100), ok: true });
        break;
      case "subagent.failed":
        sink.event({ kind: "subagent.completed", agent: event.data.agentName.slice(0, 100), ok: false });
        break;
      case "skill.invoked":
        sink.event({ kind: "skill.used", skill: event.data.name.slice(0, 100) });
        break;
      case "session.error":
        lastError = { message: event.data.message, statusCode: event.data.statusCode };
        break;
      default:
        break;
    }
  };

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
      onPermissionRequest: () => ({ kind: "reject", feedback: "Not permitted by the job policy." }),
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
    });
    session.on(onEvent);
    const abortSession = () => void session.abort().catch(() => undefined);
    cancel.addEventListener("abort", abortSession, { once: true });

    const remainingMs = () => new Date(start.deadline).getTime() - Date.now() - 3_000;
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
