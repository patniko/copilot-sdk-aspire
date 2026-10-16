import { fork, type ChildProcess } from "node:child_process";
import { chown, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SessionContainerHeartbeatResult, WORKER_SHARED_MOUNT, WorkerContainerSpec } from "@copilot-agent/contracts";
import { createLogger, optionalEnv, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { EXECUTION_UID, WORKER_OPERATIONS, WorkerOwnerMessage, type WorkerOwnerConfiguration } from "./protocol.js";

/**
 * Orchestrator worker supervisor (docs/HOSTING-MODES-PLAN.md, section 7.4). It holds the allocation-scoped credential,
 * which is bound to one worker, publishes readiness and liveness, brokers inference grants, and performs the owner's
 * worker calls on the dispatcher's worker routes. The worker's agent loop runs in a separate process as the execution
 * user. A worker has no client listener: clients reach workers only through their coordinator.
 */
if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("The worker supervisor must run as root in its Linux container to start the unprivileged owner.");
}
const key = requireEnv("SESSION_CONTAINER_KEY");
const allocationId = requireEnv("SESSION_CONTAINER_ALLOCATION_ID");
const workerId = requireEnv("SESSION_CONTAINER_SESSION_ID");
const dispatcher = serviceUrl("job-dispatcher");
const gateway = serviceUrl("inference-gateway");
const data = optionalEnv("SESSION_CONTAINER_DATA", "/data");
for (const name of ["SESSION_CONTAINER_KEY", "SESSION_CONTAINER_INGRESS_CREDENTIAL"]) delete process.env[name];
const OPERATIONS = new Set<string>(WORKER_OPERATIONS);

class DispatcherError extends Error {
  constructor(readonly status: number) { super(`Worker container control failed (${status}).`); }
}
async function call(operation: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${dispatcher}/internal/workers/${operation}`, {
    method: "POST", headers: { "content-type": "application/json", "x-internal-key": key },
    body: JSON.stringify(body ?? {}), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, body: parsed };
}
async function post<T>(operation: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const result = await call(operation, body);
  if (result.status < 200 || result.status >= 300) throw new DispatcherError(result.status);
  return schema.parse(result.body);
}

const logger = createLogger("worker-container").child({ allocation: allocationId, worker: workerId });
const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) => { logger[level](fields, message); };

const spec = await post("spec", {}, WorkerContainerSpec);
if (spec.workerId !== workerId || spec.allocationId !== allocationId) throw new Error("The dispatcher returned another allocation's worker.");
const execution = join(data, "execution");
await mkdir(execution, { recursive: true, mode: 0o700 });
if ((await stat(execution)).uid !== EXECUTION_UID) await chown(execution, EXECUTION_UID, EXECUTION_UID);
const temporary = join(execution, "tmp");
await mkdir(temporary, { recursive: true, mode: 0o700 });
if ((await stat(temporary)).uid !== EXECUTION_UID) await chown(temporary, EXECUTION_UID, EXECUTION_UID);
// Every worker of a session runs as the execution user, so the shared volume's root belongs to it.
if (spec.sharedVolume && !spec.sharedVolume.readOnly && (await stat(WORKER_SHARED_MOUNT)).uid !== EXECUTION_UID) {
  await chown(WORKER_SHARED_MOUNT, EXECUTION_UID, EXECUTION_UID);
}
let stopping = false;
let activity = true;
let activeTurn = false;
let heartbeat: NodeJS.Timeout | undefined;
let heartbeating = false;
let failures = 0;
let child: ChildProcess | undefined;

async function beat(): Promise<void> {
  if (heartbeating || stopping) return;
  heartbeating = true;
  try {
    const result = await post("heartbeat", { activeTurn, activity: activity || activeTurn }, SessionContainerHeartbeatResult);
    activity = false;
    failures = 0;
    if (result.stop) {
      log("info", "The worker stopped or its allocation is retiring; stopping.");
      await shutdown(0);
    }
  } catch (error) {
    failures++;
    if ((error instanceof DispatcherError && error.status === 401) || failures >= 3) {
      log("error", "The allocation is no longer active; stopping.");
      await shutdown(1);
    }
  } finally { heartbeating = false; }
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  process.exitCode = code;
  const owner = child;
  if (owner?.connected) owner.send({ kind: "stop" });
  if (owner && owner.exitCode === null && owner.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { if (owner.pid) process.kill(-owner.pid, "SIGKILL"); } catch { owner.kill("SIGKILL"); }
      }, 20_000);
      owner.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (owner?.pid) {
    try { process.kill(-owner.pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) log("error", "The owner process group could not be terminated."); }
  }
}

/** Reports the owner's failure to the ledger, which stops the worker and tells its coordinator. */
async function failed(message: string): Promise<void> {
  await post("failed", { message: message.slice(0, 1000) || "The worker failed." }, z.object({ recorded: z.literal(true) }).strict())
    .catch(() => log("error", "The worker's failure could not be reported."));
  await shutdown(1);
}

const config: WorkerOwnerConfiguration = {
  spec, dataDirectory: execution, gatewayUrl: `${gateway}/openai/v1`,
  toolsRoot: optionalEnv("SESSION_CONTAINER_TOOLS", "/app/tools"), pythonBin: optionalEnv("SESSION_CONTAINER_PYTHON", "/usr/bin/python3"),
};
child = fork(fileURLToPath(new URL("./worker-owner.js", import.meta.url)), [], {
  uid: EXECUTION_UID, gid: EXECUTION_UID, cwd: execution, detached: true,
  env: {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: execution, LANG: "C.UTF-8", TMPDIR: temporary,
    COPILOT_HOME: join(execution, "copilot-home"), COPILOT_AHP_FACTORY_PROFILE: "managed",
    ...(process.env.COPILOT_CLI_PATH ? { COPILOT_CLI_PATH: process.env.COPILOT_CLI_PATH } : {}),
    NODE_ENV: "production",
  },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
const debug = process.env.LOG_LEVEL === "debug";
child.stderr?.on("data", (chunk: Buffer) => {
  // Runtime diagnostics can contain conversation content; include them only when explicitly debugging.
  if (debug) log("warn", "owner diagnostic", { detail: chunk.toString("utf8").slice(0, 2000) });
  else log("warn", "The worker owner reported a runtime diagnostic.");
});
const reply = (message: object) => { if (!stopping && child?.connected) child.send(message); };
child.on("message", (value: unknown) => {
  const parsed = WorkerOwnerMessage.safeParse(value);
  if (!parsed.success) {
    log("error", "Invalid owner protocol message.");
    void failed("The worker owner sent an invalid protocol message.");
    return;
  }
  const message = parsed.data;
  if (message.kind === "ready") {
    void (async () => {
      await post("ready", {}, z.object({ ready: z.literal(true) }).strict());
      if (stopping) return;
      heartbeat = setInterval(() => { void beat(); }, spec.heartbeatSeconds * 1000);
      log("info", "Worker container ready.");
    })().catch(() => {
      log("error", "The worker container could not publish its readiness.");
      void shutdown(1);
    });
  } else if (message.kind === "token") {
    post("token", {}, z.object({ token: z.string().min(1).max(8192) }).strict())
      .then((result) => reply({ kind: "token", id: message.id, token: result.token }))
      .catch((error: unknown) => {
        const status = error instanceof DispatcherError ? error.status : 503;
        reply({ kind: "token", id: message.id, error: `The inference grant was refused (${status}).` });
      });
  } else if (message.kind === "call") {
    if (!OPERATIONS.has(message.operation)) {
      reply({ kind: "result", id: message.id, status: 400 });
      return;
    }
    call(message.operation, message.body)
      .then((result) => reply({ kind: "result", id: message.id, status: result.status, ...(result.body === undefined ? {} : { body: result.body }) }))
      .catch(() => reply({ kind: "result", id: message.id, status: 0 }));
  } else if (message.kind === "activity") {
    activity = true;
    activeTurn = message.activeTurn;
  } else if (message.kind === "failed") {
    log("error", "The worker owner failed.", { detail: message.message });
    void failed(message.message);
  } else {
    log("warn", "Worker operation failed.", { detail: message.message });
  }
});
child.on("error", () => { if (!stopping) { log("error", "The worker owner process failed."); void failed("The worker process failed."); } });
child.on("exit", () => { if (!stopping) { log("error", "The worker owner exited."); void failed("The worker process exited unexpectedly."); } });
child.send({ kind: "start", config });
process.once("SIGTERM", () => { void shutdown(0); });
process.once("SIGINT", () => { void shutdown(0); });
