import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** CLIs that are batch shims on Windows and therefore need cmd.exe. */
const SHIMMED = new Set(["pnpm", "az", "npm"]);
const SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]*$/;

export class UnsafeArgumentError extends Error {}

/**
 * Builds a spawn invocation. Arguments are fixed by the server or validated against strict patterns
 * before they get here; anything with shell metacharacters is rejected rather than escaped.
 */
export function invocation(tool: string, args: string[]): { file: string; args: string[]; options: SpawnOptions } {
  if (process.platform === "win32" && SHIMMED.has(tool)) {
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) {
        throw new UnsafeArgumentError(`Refusing to pass an unsafe argument to ${tool}.`);
      }
    }
    return { file: "cmd.exe", args: ["/d", "/s", "/c", [tool, ...args].join(" ")], options: { windowsVerbatimArguments: true } };
  }
  return { file: tool, args, options: {} };
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command to completion and captures output, with a timeout. */
export function capture(
  tool: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } ,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const call = invocation(tool, args);
      child = spawn(call.file, call.args, {
        ...call.options,
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: (error as Error).message, timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs ?? 60_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Terminates a process and its descendants. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/** Extracts the first JSON value from CLI output that may contain banners or warnings. */
export function parseJsonOutput<T>(text: string): T | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return undefined;
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
