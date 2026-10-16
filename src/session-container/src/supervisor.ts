import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SessionContainerHeartbeatResult, SessionContainerSpec } from "@copilot-agent/contracts";
import { createLogger, createService, optionalEnv, readServerKey, registerAhpProxy, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { EXECUTION_UID, INGRESS_PORT, OWNER_PORT, OwnerMessage, type OwnerConfiguration } from "./protocol.js";

/**
 * Session container supervisor. It holds the allocation-scoped credential, publishes readiness and liveness to the
 * dispatcher, brokers inference grants for the owner, and accepts only ingress connections the connection broker
 * forwards with the per-allocation ingress credential after consuming the client's one-use ticket. The agent loop
 * runs in a separate process as the execution user.
 */
if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("The session container supervisor must run as root in its Linux container to start the unprivileged owner.");
}
const key = requireEnv("SESSION_CONTAINER_KEY");
const ingressCredential = requireEnv("SESSION_CONTAINER_INGRESS_CREDENTIAL");
const allocationId = requireEnv("SESSION_CONTAINER_ALLOCATION_ID");
const sessionId = requireEnv("SESSION_CONTAINER_SESSION_ID");
const dispatcher = serviceUrl("job-dispatcher");
const gateway = serviceUrl("inference-gateway");
const data = optionalEnv("SESSION_CONTAINER_DATA", "/data");
for (const name of ["SESSION_CONTAINER_KEY", "SESSION_CONTAINER_INGRESS_CREDENTIAL"]) delete process.env[name];

class DispatcherError extends Error {
  constructor(readonly status: number) { super(`Session container control failed (${status}).`); }
}
async function post<T>(operation: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${dispatcher}/internal/session-containers/${operation}`, {
    method: "POST", headers: { "content-type": "application/json", "x-internal-key": key },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DispatcherError(response.status);
  }
  return schema.parse(await response.json());
}

const logger = createLogger("session-container").child({ allocation: allocationId, session: sessionId });
const log = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) => { logger[level](fields, message); };

const spec = await post("spec", {}, SessionContainerSpec);
if (spec.sessionId !== sessionId || spec.allocationId !== allocationId) throw new Error("The dispatcher returned another allocation's session.");
const execution = join(data, "execution");
await mkdir(execution, { recursive: true, mode: 0o700 });
if ((await stat(execution)).uid !== EXECUTION_UID) await chown(execution, EXECUTION_UID, EXECUTION_UID);
const temporary = join(execution, "tmp");
await mkdir(temporary, { recursive: true, mode: 0o700 });
if ((await stat(temporary)).uid !== EXECUTION_UID) await chown(temporary, EXECUTION_UID, EXECUTION_UID);
const listenerToken = randomBytes(32).toString("base64url");
let ready = false;
let stopping = false;
let activity = true;
let activeTurn = false;
let heartbeat: NodeJS.Timeout | undefined;
let heartbeating = false;
let failures = 0;
let child: ChildProcess | undefined;

const app = createService({ name: "session-container", ready: async () => {
  if (!ready || stopping) throw new Error("The session container is not ready.");
} });
registerAhpProxy(app, {
  ready: () => ready && !stopping,
  forwardedBy: ingressCredential,
  resolve: async (path) => {
    if (path !== `/sessions/${sessionId}`) return undefined;
    activity = true;
    return { token: listenerToken, targetPort: OWNER_PORT };
  },
});

async function beat(): Promise<void> {
  if (heartbeating || stopping) return;
  heartbeating = true;
  try {
    const result = await post("heartbeat", { activeTurn, activity: activity || activeTurn }, SessionContainerHeartbeatResult);
    activity = false;
    failures = 0;
    if (result.stop) {
      log("info", "The allocation is retiring or its session closed; stopping.");
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
  ready = false;
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
  await app.close();
}

const config: OwnerConfiguration = {
  spec, dataDirectory: execution, gatewayUrl: `${gateway}/openai/v1`, listenerToken, port: OWNER_PORT,
  toolsRoot: optionalEnv("SESSION_CONTAINER_TOOLS", "/app/tools"), pythonBin: optionalEnv("SESSION_CONTAINER_PYTHON", "/usr/bin/python3"),
};
child = fork(fileURLToPath(new URL("./owner.js", import.meta.url)), [], {
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
  if (debug) log("warn", "owner diagnostic", { detail: chunk.toString("utf8").split(listenerToken).join("[redacted]").slice(0, 2000) });
  else log("warn", "The session owner reported a runtime diagnostic.");
});
child.on("message", (value: unknown) => {
  const parsed = OwnerMessage.safeParse(value);
  if (!parsed.success) {
    log("error", "Invalid owner protocol message.");
    void shutdown(1);
    return;
  }
  const message = parsed.data;
  if (message.kind === "ready") {
    void (async () => {
      const serverKey = await readServerKey(OWNER_PORT, listenerToken);
      await post("ready", { serverKey }, z.object({ ready: z.literal(true) }).strict());
      if (stopping) return;
      ready = true;
      heartbeat = setInterval(() => { void beat(); }, spec.heartbeatSeconds * 1000);
      log("info", "Session container ready.");
    })().catch(() => {
      log("error", "The session container could not publish its readiness.");
      void shutdown(1);
    });
  } else if (message.kind === "token") {
    post("token", {}, z.object({ token: z.string().min(1).max(8192) }).strict())
      .then((result) => { if (!stopping && child?.connected) child.send({ kind: "token", id: message.id, token: result.token }); })
      .catch((error: unknown) => {
        const status = error instanceof DispatcherError ? error.status : 503;
        if (!stopping && child?.connected) child.send({ kind: "token", id: message.id, error: `The inference grant was refused (${status}).` });
      });
  } else if (message.kind === "activity") {
    activity = true;
    activeTurn = message.activeTurn;
  } else if (message.kind === "failed") {
    log("error", "The session owner failed.", { detail: message.message });
    void shutdown(1);
  } else {
    log("warn", "Session operation failed.", { detail: message.message });
  }
});
child.on("error", () => { if (!stopping) { log("error", "The session owner process failed."); void shutdown(1); } });
child.on("exit", () => { if (!stopping) { log("error", "The session owner exited."); void shutdown(1); } });
child.send({ kind: "start", config });
await app.listen({ port: INGRESS_PORT, host: "0.0.0.0" });
process.once("SIGTERM", () => { void shutdown(0); });
process.once("SIGINT", () => { void shutdown(0); });
