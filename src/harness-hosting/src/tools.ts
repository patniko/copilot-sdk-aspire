import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ToolRequest } from "@copilot-agent/contracts";
import { defineTool, type Tool } from "@github/copilot-sdk";

export interface ToolEnvironment {
  toolsRoot: string;
  pythonBin: string;
  workspace: string;
}

type BindingFactory = (request: ToolRequest, env: ToolEnvironment) => Tool<any>;

/**
 * Tool implementations this runner can bind. A harness requests tools by binding id; only bindings
 * listed here (and in the execution profile) can be satisfied. Tool code is packaged in the image,
 * never installed from job input.
 */
const BINDINGS: Record<string, BindingFactory> = {
  "python:stats": (request, env) =>
    defineTool(request.name, {
      description: request.description,
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Name of the series, such as a column name." },
          values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 100000 },
        },
        required: ["values"],
        additionalProperties: false,
      },
      skipPermission: true,
      handler: async (args: { label?: string; values: number[] }) =>
        runPythonTool(env, join(env.toolsRoot, "python", "stats.py"), args),
    }),
};

export function supportedBindings(): string[] {
  return Object.keys(BINDINGS);
}

export function bindTools(requests: ToolRequest[], env: ToolEnvironment): Tool<any>[] {
  return requests.map((request) => {
    const factory = BINDINGS[request.binding];
    if (!factory) {
      throw new UnsupportedBindingError(request.binding);
    }
    return factory(request, env);
  });
}

export class UnsupportedBindingError extends Error {
  constructor(readonly binding: string) {
    super(`Tool binding '${binding}' is not available in this runner.`);
  }
}

const MAX_TOOL_OUTPUT = 1024 * 1024;

/** Executes a pinned Python tool with JSON on stdin/stdout, a timeout, and bounded output. */
export function runPythonTool(env: ToolEnvironment, script: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.pythonBin, ["-I", script], {
      cwd: env.workspace,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? env.workspace, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Python tool timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_TOOL_OUTPUT) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Python tool failed: ${stderr.trim().split("\n").at(-1) ?? `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Python tool returned invalid JSON."));
      }
    });
    child.stdin.end(JSON.stringify(args));
  });
}
