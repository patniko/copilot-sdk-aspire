#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  ExecutorToRunner,
  JsonLineDecoder,
  RUNNER_MAX_LINE_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type InputRequestBody,
  type InputResponseBody,
  type RunnerEventBody,
  type RunnerFailureCode,
  type RunnerToExecutor,
} from "@copilot-agent/contracts";
import { runHarness, type RunnerSink } from "./runner.js";

/**
 * Runner protocol v1 over stdio: JSON Lines on stdin/stdout, diagnostics on stderr.
 * The runner never receives upstream provider or control-plane credentials.
 */
const require = createRequire(import.meta.url);
const sdkVersion = readPackageVersion("@github/copilot-sdk");

/** Finds a dependency's package.json by walking up from its resolved entry point. */
function readPackageVersion(name: string): string {
  let directory = dirname(require.resolve(name));
  for (let i = 0; i < 6; i++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === name && manifest.version) {
        return manifest.version;
      }
    } catch {
      // keep walking up
    }
    directory = dirname(directory);
  }
  return "unknown";
}

const write = (message: RunnerToExecutor) => process.stdout.write(`${JSON.stringify(message)}\n`);
let terminal = false;
let requestCounter = 0;
const pendingInputs = new Map<
  string,
  { resolve: (response: InputResponseBody) => void; timer?: NodeJS.Timeout }
>();

function ask(request: InputRequestBody, timeoutMs?: number): Promise<InputResponseBody> {
  if (terminal || cancel.signal.aborted || (timeoutMs !== undefined && timeoutMs <= 0)) {
    return Promise.resolve({ kind: "expired" });
  }
  const id = `r${Date.now().toString(36)}_${(requestCounter++).toString(36)}`;
  return new Promise((resolve) => {
    const finish = (response: InputResponseBody) => {
      const pending = pendingInputs.get(id);
      if (!pending) return;
      pendingInputs.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(response);
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish({ kind: "expired" }), timeoutMs);
    pendingInputs.set(id, { resolve, timer });
    write({ type: "input_request", id, request });
  });
}

function expirePendingInputs(): void {
  for (const [id, pending] of pendingInputs) {
    pendingInputs.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({ kind: "expired" });
  }
}

function resolvePendingInput(id: string, response: InputResponseBody): void {
  const pending = pendingInputs.get(id);
  if (!pending) return;
  pendingInputs.delete(id);
  if (pending.timer) clearTimeout(pending.timer);
  pending.resolve(response);
}

const sink: RunnerSink = {
  event: (event: RunnerEventBody) => {
    if (!terminal) {
      write({ type: "event", event });
    }
  },
  result: (output: unknown) => {
    if (!terminal) {
      terminal = true;
      expirePendingInputs();
      write({ type: "result", output });
    }
  },
  failure: (code: RunnerFailureCode, message: string, retryable: boolean, uncertainEffects = false) => {
    if (!terminal) {
      terminal = true;
      expirePendingInputs();
      write({ type: "failure", code, message, retryable, uncertainEffects });
    }
  },
};

write({
  type: "hello",
  protocol: RUNNER_PROTOCOL_VERSION,
  runner: { name: "copilot-ts-reference-runner", version: "0.1.0", language: "typescript", sdkVersion },
  capabilities: [
    "cancel",
    "structured-result",
    "prompt-sections",
    "model-options",
    "custom-agents",
    "skills",
    "builtin-tools",
    "interactive",
  ],
});

const cancel = new AbortController();
let started = false;
const decoder = new JsonLineDecoder(RUNNER_MAX_LINE_BYTES);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of decoder.push(chunk)) {
    if (line === null) {
      continue;
    }
    let parsed;
    try {
      parsed = ExecutorToRunner.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed.success) {
      process.stderr.write("runner: ignoring invalid protocol message\n");
      continue;
    }
    const message = parsed.data;
    if (message.type === "input_response") {
      resolvePendingInput(message.id, message.response);
    } else if (message.type === "cancel") {
      cancel.abort();
      expirePendingInputs();
      if (!started) {
        sink.failure("cancelled", "Cancelled before start.", false);
        process.exit(0);
      }
    } else if (message.type === "start" && !started) {
      started = true;
      runHarness({
        start: message,
        sink,
        cancel: cancel.signal,
        ask,
        toolsRoot: process.env.TOOLS_ROOT ?? "tools",
        pythonBin: process.env.PYTHON_BIN ?? "python3",
      })
        .catch((error: unknown) => {
          process.stderr.write(`runner: unexpected error: ${(error as Error).message}\n`);
          sink.failure("internal", "The runner failed unexpectedly.", true);
        })
        .finally(() => {
          expirePendingInputs();
          if (!terminal) {
            sink.failure("internal", "The runner ended without an outcome.", true);
          }
          process.stdout.write("", () => process.exit(0));
        });
    }
  }
});
process.stdin.on("end", () => {
  if (!started) {
    process.exit(0);
  }
  cancel.abort();
  expirePendingInputs();
});
