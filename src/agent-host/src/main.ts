import { fork, type ChildProcess } from "node:child_process";
import { chmod, chown, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoHostSettings, HostExecution, HostLease, policyFor } from "@copilot-agent/contracts";
import { createService, loadHarnesses, loadPolicySet, loadProfiles, admitHostedHarness, optionalEnv, requireEnv, serviceUrl, listenPort } from "@copilot-agent/service-defaults";
import { readHostIdentity, writeHostIdentity } from "./identity.js";
import { OwnerMessage, type OwnerConfiguration } from "./protocol.js";
import { resolveGitHubOwner, verifyGitHubOwner } from "./proxy.js";
import { readServerKey, registerAhpProxy, type ServerKey } from "@copilot-agent/service-defaults";

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
// The legacy single host maps transport `github` to GitHub-native execution; per-harness hosts set this explicitly.
const executionKind = HostExecution.parse(optionalEnv("DEMO_HOST_EXECUTION", transport === "github" ? "github-native" : "managed"));
if (executionKind === "github-native" && transport !== "github") throw new Error("GitHub-native hosting is reachable only through the GitHub relay.");
const direct = transport === "direct" || transport === "both";
const relay = transport === "github" || transport === "both";
const token = optionalEnv("DEMO_HOST_CONNECTION_TOKEN", "");
if (direct && token.length < 32) throw new Error("The demo host connection token must contain at least 32 characters.");
const serviceKey = requireEnv("DEMO_HOST_KEY");
const githubToken = process.env.DEMO_HOST_GITHUB_TOKEN;
const ownerUserId = relay
  ? (githubToken ? await verifyGitHubOwner(githubToken, settings.owner) : undefined)
  : await resolveGitHubOwner(settings.owner);
if (!ownerUserId) {
  throw new Error("Mission Control requires a valid GitHub credential for the configured demo owner.");
}
const policy = policyFor(await loadPolicySet(), settings.harness);
const managed = executionKind === "github-native" ? undefined : await (async () => {
  const [harnesses, profiles] = await Promise.all([loadHarnesses(), loadProfiles()]);
  const harness = harnesses.get(settings.harness)?.[0];
  if (!harness) throw new Error("The demo host harness is not published.");
  return { ...admitHostedHarness(harness, profiles, policy), maxTurnSeconds: Math.min(policy.maxDurationSeconds, harness.definition.limits.maxDurationSeconds) };
})();
if (policy.requirements.egress === "gateway-only" && !policy.acknowledgedGaps.includes("egress-not-enforced")) {
  throw new Error("Demo host egress is not enforced; the operator policy has not acknowledged this gap.");
}
/** The source revision recorded with a locally built runtime bundle, for qualification evidence. */
const runtimeRevision = await (async () => {
  const launcher = process.env.DEMO_HOST_RUNTIME_PATH;
  if (!launcher) return undefined;
  try {
    const provenance: unknown = JSON.parse(await readFile(join(dirname(launcher), "provenance.json"), "utf8"));
    const revision = provenance && typeof provenance === "object" && "revisions" in provenance && provenance.revisions
      && typeof provenance.revisions === "object" && "runtime" in provenance.revisions ? provenance.revisions.runtime : undefined;
    return typeof revision === "string" && /^[0-9a-f]{7,40}$/.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
})();
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
const execution = join(data, executionKind === "github-native" ? "github-native" : "execution");
await mkdir(data, { recursive: true, mode: 0o711 });
await mkdir(execution, { recursive: true, mode: 0o700 });
await chown(execution, 10001, 10001);
await chmod(execution, 0o700);
const identity = await readHostIdentity(data, { harness: settings.harness, ownerUserId });
const lease = HostLease.parse(await post("acquire", {
  ownerUserId, harness: settings.harness, ...(identity ? { computeId: identity.computeId } : {}),
}));
if (identity && identity.computeId !== lease.computeId) throw new Error("The durable host identity differs from this volume's identity.");
if (!identity) await writeHostIdentity(data, { harness: settings.harness, ownerUserId, computeId: lease.computeId });
let ready = false;
let stopping = false;
let child: ChildProcess | undefined;
let environmentId: string | undefined;
let serverKey: ServerKey | undefined;
const app = createService({ name: "agent-host", ready: async () => {
  if (!ready) throw new Error("The demo host is not ready.");
} });
if (direct) {
  registerAhpProxy(app, {
    token, targetPort: 8765, ready: () => ready,
    authorize: async (ticket) => {
      const response = await post("connection", { epoch: lease.epoch, token: ticket });
      return !!response && typeof response === "object" && "authorized" in response && response.authorized === true;
    },
  });
}
app.get("/", async () => ({
  service: "agent-host", harness: settings.harness, transport, execution: executionKind, ready, environmentId,
  ...(runtimeRevision ? { runtimeRevision } : {}),
}));

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  ready = false;
  clearInterval(heartbeat);
  if (child?.connected) child.send({ kind: "stop" });
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
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  await post("release", { epoch: lease.epoch });
}

app.addHook("onClose", shutdown);
const common = { owner: settings.owner, ownerUserId, computeId: lease.computeId, dataDirectory: execution, harness: settings.harness };
let childConfig: OwnerConfiguration;
if (executionKind === "github-native") {
  if (!githubToken) throw new Error("GitHub-native hosting requires the owner's credential.");
  childConfig = { ...common, execution: "github-native", transport: "github", githubToken };
} else {
  if (!managed) throw new Error("Managed hosting configuration is unavailable.");
  childConfig = {
    ...common, execution: "managed", transport,
    ...(direct ? { connectionToken: token, port: 8765 } : {}), ...(relay ? { githubToken } : {}),
    runtimePath: process.env.DEMO_HOST_RUNTIME_PATH,
    runtimeProvider: process.env.DEMO_HOST_RUNTIME_PROVIDER,
    gatewayUrl: `${serviceUrl("inference-gateway")}/openai/v1/`,
    model: managed.model, maxTurnSeconds: managed.maxTurnSeconds,
  };
}
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
    // Paths and codes only: message values can carry credentials.
    app.log.error({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.code}`) }, "Invalid host-owner protocol message.");
    ready = false;
    void app.close();
    return;
  }
  const message = parsed.data;
  if (message.kind === "ready") {
    environmentId = message.environmentId;
    const provision = async () => {
      if (direct) serverKey = await readServerKey(8765, token);
      await post("heartbeat", { epoch: lease.epoch, environmentId, serverKey });
      if (stopping) return;
      ready = true;
      app.log.info({ harness: settings.harness, transport, environmentId, runtimeRevision }, "Demo agent host ready.");
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
    void post(request.operation, {
      epoch: lease.epoch, sessionId: request.sessionId,
      ...(request.operation === "session" ? { resume: request.resume, ...(request.ahpSessionId ? { ahpSessionId: request.ahpSessionId } : {}) } : {}),
    })
      .then((result) => { if (!stopping && child?.connected) child.send({ kind: "response", id: message.id, result }); })
      .catch((error: unknown) => {
        app.log.error({ operation: request.operation }, "Host session control failed.");
        if (!stopping && child?.connected) child.send({ kind: "response", id: message.id, error: error instanceof Error ? error.message : "Host control failed." });
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
    if (stopping) return;
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
