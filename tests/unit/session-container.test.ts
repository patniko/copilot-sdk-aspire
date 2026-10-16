import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContainerSize, DEFAULT_CONTAINER_SIZES, ExecutionContainerSettings, SessionContainerSettings, SessionContainerSpec, SharedConnection,
  SharedSessionView,
} from "@copilot-agent/contracts";
import type { SessionAllocation } from "@copilot-agent/job-store";
import { sessionContainerArguments, volumeLabels } from "../../src/execution-controller/src/docker.js";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { containerUpstream } from "../../src/connection-broker/src/sessions.js";
import { OwnerConfiguration, OwnerMessage, SupervisorMessage } from "../../src/session-container/src/protocol.js";

const sessionId = randomUUID();
const allocation = (overrides: Partial<SessionAllocation> = {}): SessionAllocation => ({
  id: randomUUID(), kind: "session", principal: "dev", namespace: "local-0123456789", state: "starting", startAttempts: 0,
  startupUntil: new Date().toISOString(), expiresAt: new Date().toISOString(), sessionId, purpose: "session", size: "small",
  resources: { cpus: 0.5, memoryMiB: 1024 }, idleSeconds: 900, sessionClosed: false,
  image: `sha256:${"b".repeat(64)}`,
  settings: ExecutionContainerSettings.parse({ namespace: "local-0123456789", image: `sha256:${"b".repeat(64)}`, cpus: 0.5, memoryMiB: 1024 }),
  volumes: [{ purpose: "session", sessionId, target: "/data", readOnly: false, name: `hybrid-local-0123456789-session-${sessionId}` }],
  ...overrides,
});
const credentials = { token: "allocation-credential-".repeat(3), ingress: "ingress-credential-".repeat(3) };

describe("session container Docker arguments", () => {
  it("passes credentials only through the Docker CLI environment and mounts only the session volume", () => {
    const { args, env } = sessionContainerArguments("local-0123456789", allocation(), credentials, "http://localhost:5000", "http://127.0.0.1:5001", "win32");
    expect(args.join(" ")).not.toContain(credentials.token);
    expect(args.join(" ")).not.toContain(credentials.ingress);
    expect(env).toMatchObject({
      SESSION_CONTAINER_KEY: credentials.token, SESSION_CONTAINER_INGRESS_CREDENTIAL: credentials.ingress, SESSION_CONTAINER_SESSION_ID: sessionId,
      "services__job-dispatcher__http__0": "http://host.docker.internal:5000", "services__inference-gateway__http__0": "http://host.docker.internal:5001",
    });
    expect(Object.keys(env).filter((name) => /DATABASE|POSTGRES|DOCKER|SIGNING|FOUNDRY|GITHUB|ConnectionStrings/i.test(name))).toEqual([]);
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "0.5", "--memory", "1024m",
      "--publish", "127.0.0.1::8080", "--label", "copilot.hybrid.kind=session", "--label", `copilot.hybrid.session=${sessionId}`]));
    expect(args.filter((arg) => arg === "--mount")).toHaveLength(1);
    expect(args).toContain(`type=volume,src=hybrid-local-0123456789-session-${sessionId},dst=/data`);
    expect(args.some((arg) => /^(-v|--volume|--privileged|--network=host)$/.test(arg) || arg.includes("docker.sock"))).toBe(false);
    expect(args.filter((arg, index) => args[index - 1] === "--cap-add").sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "KILL", "SETGID", "SETUID"]);
    expect(args.at(-1)).toBe(`sha256:${"b".repeat(64)}`);
    expect(sessionContainerArguments("local-0123456789", allocation(), credentials, "http://localhost:5000", "http://localhost:5001", "linux").args)
      .toEqual(expect.arrayContaining(["--add-host", "host.docker.internal:host-gateway"]));
  });

  it("refuses unbound allocations and labels volumes with their namespace and session", () => {
    expect(() => sessionContainerArguments("ns-12345678", allocation({ image: undefined }), credentials, "http://a:1", "http://b:2", "linux")).toThrow(/Bind/);
    expect(() => sessionContainerArguments("ns-12345678", allocation({ volumes: [{ purpose: "session", sessionId, target: "/data", readOnly: false }] }),
      credentials, "http://a:1", "http://b:2", "linux")).toThrow(/volumes/);
    expect(() => sessionContainerArguments("ns-12345678", allocation(), credentials, "http://user:pass@a:1", "http://b:2", "linux")).toThrow();
    const readOnly = sessionContainerArguments("ns-12345678", allocation({ volumes: [{ purpose: "shared", sessionId, target: "/shared", readOnly: true, name: "shared-volume" }] }),
      credentials, "http://a:1", "http://b:2", "linux");
    expect(readOnly.args).toContain("type=volume,src=shared-volume,dst=/shared,readonly");
    expect(volumeLabels("ns-12345678", { purpose: "session", sessionId, target: "/data", readOnly: false, name: "v" })).toEqual({
      "copilot.hybrid.namespace": "ns-12345678", "copilot.hybrid.managed": "volume", "copilot.hybrid.session": sessionId, "copilot.hybrid.purpose": "session",
    });
  });

  it("runs an orchestrator worker as the worker, labeled with its coordinator, with its private and the shared volume", () => {
    const workerId = randomUUID();
    const worker = allocation({
      purpose: "worker", workerId,
      volumes: [
        { purpose: "worker", sessionId: workerId, target: "/data", readOnly: false, name: `hybrid-local-0123456789-worker-${workerId}` },
        { purpose: "shared", sessionId, target: "/shared", readOnly: false, name: `hybrid-local-0123456789-shared-${sessionId}` },
      ],
    });
    const { args, env } = sessionContainerArguments("local-0123456789", worker, credentials, "http://a:1", "http://b:2", "linux");
    expect(env).toMatchObject({ SESSION_CONTAINER_SESSION_ID: workerId, SESSION_CONTAINER_PURPOSE: "worker" });
    expect(args).toEqual(expect.arrayContaining([
      "--label", `copilot.hybrid.session=${sessionId}`, "--label", `copilot.hybrid.worker=${workerId}`,
      `type=volume,src=hybrid-local-0123456789-worker-${workerId},dst=/data`, `type=volume,src=hybrid-local-0123456789-shared-${sessionId},dst=/shared`,
    ]));
    const session = sessionContainerArguments("local-0123456789", allocation(), credentials, "http://a:1", "http://b:2", "linux");
    expect(session.env.SESSION_CONTAINER_PURPOSE).toBeUndefined();
    expect(session.args.some((arg) => arg.startsWith("copilot.hybrid.worker="))).toBe(false);
  });
});

describe("session container contracts", () => {
  it("bounds operator settings and keeps catalog sizes inside the Docker settings limits", () => {
    expect(SessionContainerSettings.parse({})).toEqual({
      image: "copilot-session-container:local", idleSeconds: 900, maxLifetimeSeconds: 28_800, startupSeconds: 180, shutdownSeconds: 25, heartbeatSeconds: 5,
    });
    for (const invalid of [{ idleSeconds: 5 }, { startupSeconds: 601 }, { shutdownSeconds: 0 }, { heartbeatSeconds: 1 }, { sizes: {} }]) {
      expect(SessionContainerSettings.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
    for (const size of Object.values(DEFAULT_CONTAINER_SIZES)) {
      expect(ExecutionContainerSettings.safeParse({ namespace: "local-0123456789", image: "x", ...size }).success).toBe(true);
    }
    expect(ContainerSize.safeParse({ cpus: 16, memoryMiB: 1024 }).success).toBe(false);
  });

  it("keeps connection material placement-generic and advertises container hosting", () => {
    const connection = { sessionId, destination: "container", transport: "direct", ahpSessionId: sessionId,
      url: `ws://127.0.0.1:49152/sessions/${sessionId}`, token: "t".repeat(43), expiresAt: new Date().toISOString(),
      serverKey: { keyId: "k", algorithm: "x25519-sealedbox", publicKey: "p" } };
    expect(SharedConnection.parse(connection).destination).toBe("container");
    expect(SharedConnection.safeParse({ ...connection, destination: "host" }).success).toBe(false);
    expect(SharedConnection.safeParse({ ...connection, transport: "github" }).success).toBe(false);
    expect(hostingDeployment({ executor: "on-demand", sharedWorker: false, sessionContainers: true }).sessionContainers).toEqual({ transports: ["direct"], features: [] });
    expect(hostingDeployment({ executor: "pool", sharedWorker: true }).sessionContainers).toBeUndefined();
  });

  it("describes container placement, mode, segment and container state in the shared session view", () => {
    const at = new Date().toISOString();
    const view = {
      id: sessionId, label: "", model: "m", closed: false, online: false, createdAt: at, lastActivityAt: at,
      harness: { name: "coding-agent", version: "1.0.0", digest: `sha256:${"c".repeat(64)}` }, mode: "isolated", placement: "container",
      segment: { generation: 1, placement: "container", ahpSessionId: sessionId, startedAt: at },
      limits: { tokenBudget: 1000, turnTokenBudget: 1000, maxTurnSeconds: 60, idleSeconds: 60, maxJobs: 0, maxParallelJobs: 1, maxContinuations: 0 },
      budget: { usedTokens: 0, reservedTokens: 0, remainingTokens: 1000 }, jobs: 0, continuations: 0,
      container: { state: "dormant", size: "small", cpus: 0.5, memoryMiB: 1024, idleSeconds: 60, activations: 0 },
    };
    expect(SharedSessionView.parse(view).container?.state).toBe("dormant");
    expect(SharedSessionView.safeParse({ ...view, container: { ...view.container, state: "paused" } }).success).toBe(false);
    expect(SharedSessionView.safeParse({ ...view, container: { ...view.container, gpus: 1 } }).success).toBe(false);
    expect(SharedSessionView.safeParse({ ...view, placement: "host" }).success).toBe(false);
    expect(SharedSessionView.parse({ ...view, placement: "shared", mode: "shared", container: undefined }).container).toBeUndefined();
  });
});

describe("brokered session container ingress", () => {
  it("forwards to the allocation's internal ingress origin with its credential and never a client ticket", () => {
    const route = { kind: "container" as const, sessionId, generation: 1, allocationId: randomUUID(), endpoint: "http://127.0.0.1:49152/", credential: "c".repeat(43) };
    const upstream = containerUpstream()(route);
    expect(upstream.origin.href).toBe("http://127.0.0.1:49152/");
    expect(upstream).toMatchObject({ path: `/sessions/${sessionId}`, headers: { "x-internal-key": "c".repeat(43) } });
    expect(Object.keys(upstream.headers ?? {})).toEqual(["x-internal-key"]);
    for (const endpoint of ["https://127.0.0.1:49152/", "http://user:pass@127.0.0.1:49152/", "http://127.0.0.1:49152/sessions"]) {
      expect(() => containerUpstream()({ ...route, endpoint }), endpoint).toThrow(/internal HTTP origin/);
    }
  });
});
describe("session container process protocol", () => {
  const spec = SessionContainerSpec.parse({
    sessionId, allocationId: randomUUID(), githubUserId: 1, model: "m", maxTurnSeconds: 60, heartbeatSeconds: 5,
    harness: { digest: `sha256:${"d".repeat(64)}`, definition: {
      schemaVersion: "1", name: "coding-agent", version: "1.0.0", description: "d", instructions: "i", interaction: "conversation",
      model: { preferred: "m", allowed: ["m"] }, tools: [], input: { schema: {} }, output: { schema: {} },
      limits: { maxDurationSeconds: 60, maxInferenceTokens: 1000 }, retry: { safeToRetry: false, maxAttempts: 1 },
      runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
    } },
  });

  it("gives the unprivileged owner no allocation, signing, or provider credential", () => {
    const config = { spec, dataDirectory: "/data/execution", gatewayUrl: "http://host.docker.internal:1/openai/v1", listenerToken: "l".repeat(43),
      port: 8765, toolsRoot: "/app/tools", pythonBin: "/usr/bin/python3" };
    expect(OwnerConfiguration.parse(config)).toEqual(config);
    for (const extra of ["allocationKey", "signingKey", "githubToken", "databaseUrl"]) {
      expect(OwnerConfiguration.safeParse({ ...config, [extra]: "secret-value-".repeat(4) }).success, extra).toBe(false);
    }
    expect(SupervisorMessage.safeParse({ kind: "start", config }).success).toBe(true);
    expect(OwnerMessage.safeParse({ kind: "token", id: randomUUID(), token: "x" }).success).toBe(false);
    expect(OwnerMessage.safeParse({ kind: "activity", activeTurn: true }).success).toBe(true);
  });
});
