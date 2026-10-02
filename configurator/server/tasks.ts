import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { invocation, killTree, stripAnsi } from "./process.js";
import type { TaskInfo, TaskKind, TaskLine } from "./types.js";

export interface TaskStep {
  tool: string;
  args: string[];
  /** Extra environment for this step. Values are never echoed. */
  env?: Record<string, string>;
  label: string;
}

interface TaskState {
  info: TaskInfo;
  lines: TaskLine[];
  seq: number;
  child?: ChildProcess;
  cancelled: boolean;
  redact: string[];
}

/** Long-running operations that conflict with each other share a lane; only one runs per lane. */
const LANES: Record<TaskKind, string> = {
  validate: "check",
  "test-unit": "check",
  "test-all": "check",
  build: "build",
  "local-start": "local",
  "local-stop": "local",
  "local-restart-api": "local",
  publish: "azure",
  deploy: "azure",
  "az-login": "login",
};

const MAX_LINES = 6000;
const MAX_TASKS = 30;

/** Runs a fixed set of commands, keeps their output, and lets the UI poll and cancel them. */
export class TaskRunner {
  readonly #tasks = new Map<string, TaskState>();

  constructor(
    private readonly root: string,
    private readonly baseEnv: () => NodeJS.ProcessEnv,
  ) {}

  list(): TaskInfo[] {
    return [...this.#tasks.values()].map((t) => t.info).reverse();
  }

  get(id: string): TaskState | undefined {
    return this.#tasks.get(id);
  }

  lines(id: string, after: number): { info: TaskInfo; lines: TaskLine[] } | undefined {
    const task = this.#tasks.get(id);
    return task ? { info: task.info, lines: task.lines.filter((l) => l.seq > after) } : undefined;
  }

  running(kind: TaskKind): TaskInfo | undefined {
    return [...this.#tasks.values()].find((t) => t.info.status === "running" && LANES[t.info.kind] === LANES[kind])?.info;
  }

  start(kind: TaskKind, title: string, steps: TaskStep[], redact: string[] = []): TaskInfo {
    const busy = this.running(kind);
    if (busy) {
      throw new TaskConflictError(`'${busy.title}' is still running.`);
    }
    const info: TaskInfo = {
      id: randomUUID(),
      kind,
      title,
      status: "running",
      startedAt: new Date().toISOString(),
      command: steps.map((s) => s.label).join(" && "),
    };
    const state: TaskState = { info, lines: [], seq: 0, cancelled: false, redact: redact.filter((r) => r.length >= 8) };
    this.#tasks.set(info.id, state);
    while (this.#tasks.size > MAX_TASKS) {
      const oldest = [...this.#tasks.values()].find((t) => t.info.status !== "running");
      if (!oldest) break;
      this.#tasks.delete(oldest.info.id);
    }
    void this.#run(state, steps);
    return info;
  }

  cancel(id: string): boolean {
    const task = this.#tasks.get(id);
    if (!task || task.info.status !== "running") {
      return false;
    }
    task.cancelled = true;
    this.#append(task, "system", "Cancelling…");
    if (task.child) {
      killTree(task.child);
    }
    return true;
  }

  async #run(state: TaskState, steps: TaskStep[]): Promise<void> {
    let exitCode: number | null = 0;
    for (const step of steps) {
      if (state.cancelled) break;
      this.#append(state, "system", `$ ${step.label}`);
      exitCode = await this.#runStep(state, step);
      if (exitCode !== 0) break;
    }
    state.info.exitCode = exitCode;
    state.info.endedAt = new Date().toISOString();
    state.info.status = state.cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
    this.#append(state, "system", `${state.info.status} (exit ${exitCode ?? "signal"})`);
  }

  #runStep(state: TaskState, step: TaskStep): Promise<number | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        const call = invocation(step.tool, step.args);
        child = spawn(call.file, call.args, {
          ...call.options,
          cwd: this.root,
          env: { ...this.baseEnv(), ...step.env, FORCE_COLOR: "0", NO_COLOR: "1" },
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        this.#append(state, "stderr", (error as Error).message);
        resolve(-1);
        return;
      }
      state.child = child;
      const pump = (stream: "stdout" | "stderr") => {
        let pending = "";
        return (chunk: string) => {
          pending += chunk;
          const parts = pending.split(/\r?\n|\r(?!\n)/);
          pending = parts.pop() ?? "";
          for (const part of parts) this.#append(state, stream, part);
        };
      };
      child.stdout?.setEncoding("utf8").on("data", pump("stdout"));
      child.stderr?.setEncoding("utf8").on("data", pump("stderr"));
      child.on("error", (error) => {
        this.#append(state, "stderr", error.message);
        resolve(-1);
      });
      child.on("close", (code) => {
        state.child = undefined;
        resolve(code);
      });
    });
  }

  #append(state: TaskState, stream: TaskLine["stream"], raw: string): void {
    let text = stripAnsi(raw).replace(/\s+$/, "");
    if (!text && stream !== "system") return;
    for (const secret of state.redact) {
      text = text.split(secret).join("[redacted]");
    }
    state.lines.push({ seq: ++state.seq, text: text.slice(0, 4000), stream });
    if (state.lines.length > MAX_LINES) {
      state.lines.splice(0, state.lines.length - MAX_LINES);
    }
  }
}

export class TaskConflictError extends Error {}
