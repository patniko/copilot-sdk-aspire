import { fork, type ChildProcess } from "node:child_process";
import { chmod, chown, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoHostSettings, HostLease } from "@copilot-agent/contracts";
import { createService, loadHarnesses, loadPolicy, loadProfiles, admitHostedHarness, optionalEnv, requireEnv, serviceUrl, listenPort } from "@copilot-agent/service-defaults";
import { OwnerMessage, type OwnerConfiguration } from "./protocol.js";
import { registerAhpProxy, resolveGitHubOwner, verifyGitHubOwner } from "./proxy.js";
import { readServerKey, type ServerKey } from "./server-key.js";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("The demo host must run in its Linux container with uid-isolated execution.");
}
const settings = DemoHostSettings.parse({
  transport: requireEnv("DEMO_HOST_TRANSPORT"),
  owner: requireEnv("DEMO_HOST_OWNER"),
  harness: optionalEnv("DEMO_HOST_HARNESS", "interactive-demo"),
});
if (settings.transport === "disabled") throw new Error("Do not start the demo host when disabled.");
const transport = settings.transport;
const ownerUserId = await resolveGitHubOwner(settings.owner);
const token = requireEnv("DEMO_HOST_CONNECTION_TOKEN");
if (token.length < 32) throw new Error("The demo host connection token must contain at least 32 characters.");
const serviceKey = requireEnv("DEMO_HOST_KEY");
const githubToken = process.env.DEMO_HOST_GITHUB_TOKEN;
const needsGitHub = transport === "github" || transport === "both";
if (needsGitHub && (!githubToken || !(await verifyGitHubOwner(githubToken, settings.owner)))) {
  throw new Error("Mission Control requires a valid GitHub credential for the configured demo owner.");
}
const [harnesses, profiles, policy] = await Promise.all([loadHarnesses(), loadProfiles(), loadPolicy()]);
const harness = harnesses.get(settings.harness)?.[0];
if (!harness) throw new Error("The demo host harness is not published.");
const admitted = admitHostedHarness(harness, profiles, policy);
if (policy.requirements.egress === "gateway-only" && !policy.acknowledgedGaps.includes("egress-not-enforced")) {
  throw new Error("Demo host egress is not enforced; the operator policy has not acknowledged this gap.");
}
const dispatcher = serviceUrl("job-dispatcher");
async function post(operation: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${dispatcher}/internal/host/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-key": serviceKey },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Host control ${operation} failed (${response.status}).`);
  return response.json();
}

const data = optionalEnv("DEMO_HOST_DATA", "/data");
const execution = join(data, "execution");
await mkdir(data, { recursive: true, mode: 0o711 });
await mkdir(execution, { recursive: true, mode: 0o700 });
await chown(execution, 10001, 10001);
await chmod(execution, 0o700);
const lease = HostLease.parse(await post("acquire", { ownerUserId }));
let ready = false;
let stopping = false;
let child: ChildProcess | undefined;
let environmentId: string | undefined;
let serverKey: ServerKey | undefined;
const app = createService({ name: "agent-host", ready: async () => {
  if (!ready) throw new Error("The demo host is not ready.");
} });
if (transport === "direct" || transport === "both") {
  registerAhpProxy(app, {
    token, targetPort: 8765, ready: () => ready,
    authorize: async (ticket) => {
      const response = await post("connection", { epoch: lease.epoch, token: ticket });
      return !!response && typeof response === "object" && "authorized" in response && response.authorized === true;
    },
  });
}
app.get("/", async () => ({ service: "agent-host", transport, ready, environmentId }));

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  ready = false;
  clearInterval(heartbeat);
  child?.send({ kind: "stop" });
  if (child && child.exitCode === null) {
    const processToStop = child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (processToStop.pid) {
          try { process.kill(-processToStop.pid, "SIGKILL"); }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
              app.log.error("The host process group could not be terminated.");
              processToStop.kill("SIGKILL");
            }
          }
        }
      }, 15_000);
      processToStop.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await post("release", { epoch: lease.epoch });
}

app.addHook("onClose", shutdown);
const childConfig: OwnerConfiguration = {
  transport, owner: settings.owner, ownerUserId, computeId: lease.computeId,
  connectionToken: token, ...(needsGitHub ? { githubToken } : {}),
  dataDirectory: execution, gatewayUrl: `${serviceUrl("inference-gateway")}/openai/v1/`,
  model: admitted.model, maxTurnSeconds: Math.min(policy.maxDurationSeconds, harness.definition.limits.maxDurationSeconds),
  port: 8765,
};
child = fork(fileURLToPath(new URL("./owner.js", import.meta.url)), [], {
  uid: 10001, gid: 10001, cwd: execution,
  detached: true,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: execution, LANG: "C.UTF-8" },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
child.stderr?.on("data", () => app.log.error("The host owner reported a runtime diagnostic; check the host's protected runtime logs."));
child.on("message", (value: unknown) => {
  const parsed = OwnerMessage.safeParse(value);
  if (!parsed.success) {
    app.log.error("Invalid host-owner protocol message.");
    ready = false;
    void app.close();
    return;
  }
  const message = parsed.data;
  if (message.kind === "ready") {
    environmentId = message.environmentId;
    const provision = async () => {
      if (transport === "direct" || transport === "both") serverKey = await readServerKey(8765, token);
      await post("heartbeat", { epoch: lease.epoch, environmentId, serverKey });
      ready = true;
      app.log.info({ transport, environmentId }, "Demo agent host ready.");
    };
    void provision().catch(() => {
      app.log.error("The host connection metadata could not be provisioned.");
      process.exitCode = 1;
      void app.close();
    });
  } else if (message.kind === "failed") {
    ready = false;
    app.log.error({ message: message.message }, "Demo host failed.");
    process.exitCode = 1;
    void app.close();
  } else if (message.kind === "diagnostic") {
    app.log.error({ message: message.message }, "Hosted session operation failed.");
  } else {
    const request = message.request;
    if (request.operation === "close") {
      child?.send({ kind: "response", id: message.id, error: "Close sessions through the authenticated application API." });
      return;
    }
    void post(request.operation, { epoch: lease.epoch, sessionId: request.sessionId, ...(request.operation === "session" ? { resume: request.resume } : {}) })
      .then((result) => { child?.send({ kind: "response", id: message.id, result }); })
      .catch((error: unknown) => {
        app.log.error({ operation: request.operation }, "Host session control failed.");
        child?.send({ kind: "response", id: message.id, error: error instanceof Error ? error.message : "Host control failed." });
      });
  }
});
child.on("error", () => { ready = false; app.log.error("The isolated host owner could not start."); process.exitCode = 1; void app.close(); });
child.on("exit", () => { ready = false; if (!stopping) { process.exitCode = 1; void app.close(); } });
child.send({ kind: "start", config: childConfig });
let heartbeating = false;
const heartbeat = setInterval(() => {
  if (heartbeating || stopping) return;
  heartbeating = true;
  void post("heartbeat", { epoch: lease.epoch, environmentId, serverKey }).then((result) => {
    if (result && typeof result === "object" && "closedSessions" in result) {
      child?.send({ kind: "close", sessionIds: result.closedSessions });
    }
  }).catch(() => {
    ready = false;
    app.log.error("Demo host ownership heartbeat failed; stopping execution.");
    process.exitCode = 1;
    void app.close();
  }).finally(() => { heartbeating = false; });
}, 8_000);
await app.listen({ port: listenPort(8080), host: "0.0.0.0" });
process.once("SIGTERM", () => { void app.close().catch(() => { process.exitCode = 1; }); });
process.once("SIGINT", () => { void app.close().catch(() => { process.exitCode = 1; }); });
