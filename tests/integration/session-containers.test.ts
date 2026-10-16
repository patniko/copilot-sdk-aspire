import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, afterAll, describe, expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, HarnessDefinition, SessionContainerSettings, SessionContainerSpec, SharedConnection, SharedSessionView,
  SharedWorkerLimits, type HarnessSnapshot,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobEventListener, JobStore, PlacementStore, SessionContainerStore, SessionDirectory, SessionFileStore,
  SharedStore, migrate,
} from "@copilot-agent/job-store";
import {
  Admission, ApiKeyAuthenticator, canonicalJson, createLogger, loadPolicySet, loadProfiles, sha256Hex, verifyInferenceCapability,
} from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { ContainerSessionService } from "../../src/agent-api/src/container-sessions.js";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { ExecutionController } from "../../src/execution-controller/src/controller.js";
import { FakeAdapter } from "./fixtures/fake-adapter.js";

const repo = join(import.meta.dirname, "..", "..");
const signingKey = "synthetic-capability-key-".repeat(3);
const allocationKey = "synthetic-allocation-key-".repeat(3);
const gatewayKey = "synthetic-gateway-key-".repeat(3);
const executorKey = "synthetic-executor-key-".repeat(3);
const serverKey = { keyId: "synthetic", algorithm: "x25519-sealedbox" as const, publicKey: "synthetic-public-key" };
const brokerUrl = "http://127.0.0.1:47000";
const ingressCredential = (allocationId: string) => createHmac("sha256", allocationKey).update(`ingress:${allocationId}`).digest("base64url");
const images = { "executor:test": `sha256:${"a".repeat(64)}`, "session:test": `sha256:${"b".repeat(64)}` };

function snapshot(definition: Record<string, unknown>): HarnessSnapshot {
  const parsed = HarnessDefinition.parse({
    schemaVersion: "1", version: "1.0.0", description: "Synthetic session container harness.", instructions: "Work in the session workspace.",
    model: { preferred: "grok-4.6", allowed: ["grok-4.6"] }, tools: [],
    input: { schema: { type: "object" } }, output: { schema: { type: "object" } },
    limits: { maxDurationSeconds: 600, maxInferenceTokens: 50_000 }, retry: { safeToRetry: false, maxAttempts: 1 },
    runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
    ...definition,
  });
  return { definition: parsed, digest: `sha256:${sha256Hex(canonicalJson(parsed))}` };
}
const coder = snapshot({
  name: "session-coder", interaction: "conversation", builtinTools: ["files", "shell"],
  permissions: { default: "ask", kinds: { write: "allow", shell: "allow" } },
});
const batch = snapshot({ name: "batch-only" });
const sharedChat = snapshot({ name: "shared-chat", interaction: "conversation", hosting: { mode: "shared" } });
const harnesses = new Map([[coder.definition.name, [coder]], [batch.definition.name, [batch]], [sharedChat.definition.name, [sharedChat]]]);

let pool: pg.Pool;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => { await pool?.end(); });

const wait = async (predicate: () => Promise<boolean> | boolean, label: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function environment(options: { limits?: Partial<SharedWorkerLimits>; containers?: boolean } = {}) {
  const namespace = `session-test-${randomUUID().slice(0, 12)}`;
  const principals = { a: randomUUID(), b: randomUUID(), unbound: randomUUID() };
  const keys = { a: `key-a-${randomUUID()}`, b: `key-b-${randomUUID()}`, unbound: `key-u-${randomUUID()}` };
  const bindings = { [principals.a]: 1001, [principals.b]: 1002 };
  const jobs = new JobStore(pool);
  const shared = new SharedStore(pool);
  const allocations = new AllocationStore(pool, shared);
  const store = new SessionContainerStore(pool, shared);
  const delegations = new DelegationStore(pool, shared, jobs);
  const base = await loadPolicySet(join(repo, "examples", "customer-config"));
  const policies = { base: base.base, overrides: new Map() };
  const profiles = await loadProfiles(repo);
  const limits = SharedWorkerLimits.parse({ executionContainers: 4, containersPerPrincipal: 2, ...options.limits });
  const settings = SessionContainerSettings.parse({ image: "session:test", idleSeconds: 30, heartbeatSeconds: 2, startupSeconds: 30, shutdownSeconds: 1 });
  const fake = new FakeAdapter(namespace, images);
  const apps: FastifyInstance[] = [];
  const dispatcher = buildDispatcher({
    store: jobs, policies, executorKey, gatewayKey, signingKey, allocations, delegations,
    sessionContainers: { allocations, store, policies, heartbeatSeconds: settings.heartbeatSeconds },
  });
  apps.push(dispatcher);
  const containers = options.containers !== false;
  const catalog = { harnesses, profiles, policies, deployment: hostingDeployment({ executor: "on-demand", sharedWorker: !containers, sessionContainers: containers }) };
  const service = containers ? new ContainerSessionService({
    store, allocations, directory: new SessionDirectory(pool), catalog, principals: bindings, settings, limits, brokerUrl, connectWaitSeconds: 20,
  }) : undefined;
  const api = buildApi({
    store: jobs, listener: new JobEventListener(pool), admission: new Admission({ harnesses, profiles, policies }), harnesses,
    authenticator: new ApiKeyAuthenticator(`${principals.a}:${keys.a};${principals.b}:${keys.b};${principals.unbound}:${keys.unbound}`),
    maxOpenJobsPerPrincipal: 10, console: false, delegations, execution: "dedicated", hosting: catalog,
    ...(service ? { containers: service } : { shared: { url: "http://127.0.0.1:9", key: "unused-worker-key-".repeat(3), brokerUrl } }),
  });
  apps.push(api);
  const controllers: ExecutionController[] = [];
  const controller = () => {
    const created = new ExecutionController({
      allocations, jobs, delegations, settings: ExecutionContainerSettings.parse({ namespace, image: "executor:test" }), limits, sessions: settings,
      signingKey: allocationKey, dispatcherUrl: "http://127.0.0.1:1", gatewayUrl: "http://127.0.0.1:2",
      logger: createLogger("session-container-test"), adapter: () => fake,
    });
    controllers.push(created);
    return created;
  };
  const heartbeats = new Map<string, NodeJS.Timeout>();
  cleanups.push(async () => {
    for (const timer of heartbeats.values()) clearInterval(timer);
    for (const created of controllers) await created.stop().catch(() => undefined);
    for (const app of apps) await app.close();
    await pool.query("DELETE FROM shared_sessions WHERE principal=ANY($1::text[])", [Object.values(principals)]);
    await pool.query("DELETE FROM jobs WHERE principal=ANY($1::text[])", [Object.values(principals)]);
    await pool.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
    await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
  });
  const headers = (who: keyof typeof keys) => ({ authorization: `Bearer ${keys[who]}` });
  const asContainer = (token: string, path: string, payload: object = {}) =>
    dispatcher.inject({ method: "POST", url: `/internal/session-containers/${path}`, headers: { "x-internal-key": token }, payload });
  /** Acts as the container: fetches its spec, publishes readiness, and heartbeats without activity. */
  const ready = async (sessionId: string) => {
    await wait(() => fake.session(sessionId)?.status === "running", "a running session container");
    const container = fake.session(sessionId)!;
    const spec = await asContainer(container.token, "spec");
    expect(spec.statusCode).toBe(200);
    expect((await asContainer(container.token, "ready", { serverKey })).statusCode).toBe(200);
    heartbeats.set(container.id, setInterval(() => { void asContainer(container.token, "heartbeat", { activeTurn: false, activity: false }); }, 1_000));
    return { container, spec: SessionContainerSpec.parse(spec.json()) };
  };
  const create = async (who: keyof typeof keys = "a", harness = coder.definition.name) => {
    const response = await api.inject({ method: "POST", url: "/v1/sessions", headers: headers(who), payload: { harness, label: "synthetic" } });
    expect(response.statusCode, response.body).toBe(201);
    return SharedSessionView.parse(response.json());
  };
  const connect = async (who: keyof typeof keys, id: string) => {
    const pending = api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers: headers(who) });
    const started = await ready(id);
    const response = await pending;
    expect(response.statusCode, response.body).toBe(200);
    return { connection: SharedConnection.parse(response.json()), ...started, cache: response.headers["cache-control"] };
  };
  const view = async (who: keyof typeof keys, id: string) => SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers: headers(who) })).json());
  const active = async () => (await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM execution_allocations WHERE (namespace=$1 OR namespace IS NULL) AND kind='session' AND state<>'retired'", [namespace])).rows[0]!.count;
  return { namespace, principals, keys, bindings, jobs, shared, allocations, store, dispatcher, api, fake, controller, headers, asContainer, ready, create, connect, view, active, limits, settings };
}

describe("resumable session containers", () => {
  it("starts a container on connection, stops it when idle, resumes from the retained volume, and retires on close", async () => {
    const env = await environment();
    await env.controller().start();
    const session = await env.create();
    expect(session).toMatchObject({ placement: "container", mode: "isolated", online: false,
      harness: { name: "session-coder", version: "1.0.0", digest: coder.digest }, container: { state: "dormant", size: "small", cpus: 0.5, memoryMiB: 1024, activations: 0 } });
    expect(session.segment).toEqual({ generation: 1, placement: "container", harness: session.harness, ahpSessionId: session.id, startedAt: session.createdAt });
    const stored = (await pool.query<{ definition: Record<string, unknown> }>("SELECT definition FROM shared_sessions WHERE id=$1", [session.id])).rows[0]!.definition;
    expect(stored).toEqual({ model: "grok-4.6", limits: session.limits, harness: {
      name: "session-coder", version: "1.0.0", digest: coder.digest, mode: "isolated", policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } });
    expect(session.limits).toMatchObject({ idleSeconds: 30, maxJobs: 0, maxContinuations: 0 });
    const relay = await env.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers: env.headers("a"), payload: { transport: "github" } });
    expect([relay.statusCode, relay.json().error.code]).toEqual([409, "hosting_unavailable"]);
    expect((await env.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers: env.headers("a"), payload: { transport: "carrier-pigeon" } })).statusCode).toBe(400);
    expect(await env.active()).toBe(0);

    const first = await env.connect("a", session.id);
    expect(first.cache).toBe("no-store");
    expect(first.connection).toMatchObject({ sessionId: session.id, destination: "container", transport: "direct", ahpSessionId: session.id, serverKey });
    expect(first.connection.url).toBe(`ws://127.0.0.1:47000/sessions/${session.id}`);
    expect(first.spec).toMatchObject({ sessionId: session.id, githubUserId: 1001, model: "grok-4.6", harness: { digest: coder.digest }, heartbeatSeconds: 2 });
    expect(await env.view("a", session.id)).toMatchObject({ online: true, container: { state: "running", activations: 1 } });
    const firstAllocation = first.spec.allocationId;
    const volume = (await pool.query<{ name: string; released_at: Date | null }>("SELECT name,released_at FROM execution_volumes WHERE session_id=$1", [session.id])).rows;
    expect(volume).toEqual([{ name: `hybrid-${env.namespace}-session-${session.id}`, released_at: null }]);

    const placements = new PlacementStore(pool);
    expect(await placements.consumeTicket(session.id, first.connection.token)).toEqual({ kind: "container", sessionId: session.id, generation: 1,
      allocationId: firstAllocation, endpoint: `http://127.0.0.1:${first.container.ingress!.port}/`, credential: ingressCredential(firstAllocation) });
    expect(await placements.consumeTicket(session.id, first.connection.token)).toBeUndefined();
    expect((await env.asContainer(first.container.token, "connection", { ticket: first.connection.token })).statusCode).toBe(404);

    await pool.query("UPDATE execution_allocations SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [firstAllocation]);
    await wait(async () => (await env.view("a", session.id)).container?.state === "dormant", "idle stop");
    expect(env.fake.session(session.id)).toBeUndefined();
    expect(env.fake.operations).toContain(`stop:${firstAllocation}`);
    expect(env.fake.volumeLabels.has(volume[0]!.name)).toBe(true);
    expect((await pool.query("SELECT last_error FROM execution_allocations WHERE id=$1", [firstAllocation])).rows[0]).toEqual({ last_error: "The session was idle." });
    expect((await env.asContainer(first.container.token, "spec")).statusCode).toBe(401);

    const second = await env.connect("a", session.id);
    expect(second.spec.allocationId).not.toBe(firstAllocation);
    expect(env.fake.operations.filter((operation) => operation.startsWith("volume:"))).toEqual([`volume:${volume[0]!.name}`]);
    expect(await env.view("a", session.id)).toMatchObject({ container: { state: "running", activations: 2 } });

    expect((await env.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/close`, headers: env.headers("a"), payload: {} })).json()).toEqual({ closed: true });
    await wait(async () => await env.active() === 0, "retirement on close");
    expect(env.fake.session(session.id)).toBeUndefined();
    expect(env.fake.volumeLabels.has(volume[0]!.name)).toBe(true);
    expect((await pool.query("SELECT released_at IS NOT NULL AS released FROM execution_volumes WHERE session_id=$1", [session.id])).rows).toEqual([{ released: true }]);
    expect(await env.view("a", session.id)).toMatchObject({ closed: true, online: false, container: { state: "closed" } });
    expect((await env.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers: env.headers("a") })).statusCode).toBe(404);
    await expect(env.allocations.request({
      sessionId: session.id, principal: env.principals.a, purpose: "session", size: "small", resources: { cpus: 0.5, memoryMiB: 1024 },
      volumes: [{ purpose: "session", sessionId: session.id, target: "/data", readOnly: false }], idleSeconds: 30, startupSeconds: 30, maxLifetimeSeconds: 600,
    }, env.limits)).rejects.toMatchObject({ code: "not_found" });
  }, 60_000);

  it("adopts running containers after a controller restart, removes orphans, and retires vanished containers", async () => {
    const env = await environment();
    const first = env.controller();
    await first.start();
    const kept = await env.create();
    const vanished = await env.create();
    const keptStart = await env.connect("a", kept.id);
    const vanishedStart = await env.connect("a", vanished.id);
    await pool.query("UPDATE execution_controller SET lease_until=clock_timestamp() WHERE namespace=$1", [env.namespace]);
    await wait(() => !first.healthy, "the replaced controller to lose ownership");
    const orphan = env.fake.orphan(images["session:test"]);
    env.fake.containers.delete(vanishedStart.container.id);
    const creations = env.fake.operations.filter((operation) => operation.startsWith("create-session:")).length;

    const second = env.controller();
    await second.start();
    expect(env.fake.containers.has(orphan)).toBe(false);
    expect(env.fake.containers.has(keptStart.container.id)).toBe(true);
    await wait(async () => (await env.view("a", vanished.id)).container?.state === "dormant", "retiring the vanished container");
    expect((await pool.query("SELECT last_error FROM execution_allocations WHERE id=$1", [vanishedStart.spec.allocationId])).rows[0])
      .toEqual({ last_error: "The session container exited." });
    expect(env.fake.operations.filter((operation) => operation.startsWith("create-session:"))).toHaveLength(creations);
    const reconnect = await env.api.inject({ method: "POST", url: `/v1/sessions/${kept.id}/connection`, headers: env.headers("a") });
    expect(reconnect.statusCode).toBe(200);
    expect(SharedConnection.parse(reconnect.json()).url).toBe(keptStart.connection.url);
    await second.stop();
    expect(await env.active()).toBe(0);
    expect(env.fake.containers.size).toBe(0);
    expect(await env.view("a", kept.id)).toMatchObject({ closed: false, container: { state: "dormant", activations: 1 } });
  }, 60_000);

  it("counts session allocations against deployment and principal limits under concurrent requests", async () => {
    const env = await environment({ limits: { executionContainers: 2, containersPerPrincipal: 1 } });
    const sessions = [await env.create("a"), await env.create("a"), await env.create("b"), await env.create("b")];
    const request = (id: string, principal: string) => env.allocations.request({
      sessionId: id, principal, purpose: "session", size: "small", resources: { cpus: 0.5, memoryMiB: 1024 },
      volumes: [{ purpose: "session", sessionId: id, target: "/data", readOnly: false }], idleSeconds: 30, startupSeconds: 30, maxLifetimeSeconds: 600,
    }, env.limits);
    const owners = [env.principals.a, env.principals.a, env.principals.b, env.principals.b];
    const results = await Promise.allSettled(sessions.flatMap((session, index) => [request(session.id, owners[index]!), request(session.id, owners[index]!)]));
    const granted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(new Set(granted.map((allocation) => allocation.id)).size).toBe(2);
    expect(new Set(granted.map((allocation) => allocation.principal))).toEqual(new Set([env.principals.a, env.principals.b]));
    expect(results.filter((result) => result.status === "rejected").every((result) => (result as PromiseRejectedResult).reason.code === "quota_exceeded")).toBe(true);
    expect(await env.active()).toBe(2);
    const lease = await env.allocations.acquire(env.namespace, randomUUID());
    await env.jobs.createJob({
      principal: env.principals.b, harness: batch, profile: "node-ts-agent", model: "grok-4.6", input: {}, requestHash: randomUUID(),
      tokenBudget: 1000, maxDurationSeconds: 60, maxAttempts: 1, safeToRetry: true, execution: "dedicated",
    }, 10);
    expect(await env.allocations.reserve(lease, ExecutionContainerSettings.parse({ namespace: env.namespace, image: images["executor:test"] }),
      env.limits, (id) => `${id}-synthetic-token`)).toBeUndefined();
    const waiting = sessions.findIndex((session) => !granted.some((allocation) => allocation.sessionId === session.id));
    const busy = await env.api.inject({ method: "POST", url: `/v1/sessions/${sessions[waiting]!.id}/connection`,
      headers: env.headers(owners[waiting] === env.principals.a ? "a" : "b") });
    expect([busy.statusCode, busy.json().error.code]).toEqual([429, "quota_exceeded"]);
  }, 60_000);

  it("scopes container credentials to one session and inference grants to its budget", async () => {
    const env = await environment();
    await env.controller().start();
    const mine = await env.create("a");
    const theirs = await env.create("b");
    const own = await env.connect("a", mine.id);
    const other = await env.connect("b", theirs.id);
    expect(other.spec.githubUserId).toBe(1002);

    const placements = new PlacementStore(pool);
    expect(await placements.consumeTicket(mine.id, other.connection.token)).toBeUndefined();
    expect(await placements.consumeTicket(theirs.id, other.connection.token)).toMatchObject({ kind: "container", sessionId: theirs.id,
      allocationId: other.spec.allocationId, credential: ingressCredential(other.spec.allocationId) });
    expect((await env.dispatcher.inject({ method: "POST", url: "/internal/executor/claim", headers: { "x-internal-key": own.container.token },
      payload: { executorId: own.spec.allocationId, profiles: ["node-ts-agent"], processIsolation: "uid", egress: "none", platform: "linux" } })).statusCode).toBe(401);
    expect((await env.asContainer("not-an-allocation-credential-at-all-000", "spec")).statusCode).toBe(401);
    expect((await env.asContainer(executorKey, "spec")).statusCode).toBe(401);

    await env.jobs.createJob({
      principal: env.principals.a, harness: batch, profile: "node-ts-agent", model: "grok-4.6", input: {}, requestHash: randomUUID(),
      tokenBudget: 1000, maxDurationSeconds: 60, maxAttempts: 1, safeToRetry: true, execution: "dedicated",
    }, 10);
    await wait(() => [...env.fake.containers.values()].some((container) => container.kind === "job"), "a one-shot job container");
    const job = [...env.fake.containers.values()].find((container) => container.kind === "job")!;
    expect((await env.asContainer(job.token, "spec")).statusCode).toBe(401);
    expect((await env.asContainer(job.token, "token")).statusCode).toBe(401);

    const grant = await env.asContainer(own.container.token, "token");
    expect(grant.statusCode).toBe(200);
    expect(grant.headers["cache-control"]).toBe("no-store");
    const claims = await verifyInferenceCapability(signingKey, (grant.json() as { token: string }).token);
    expect(claims).toMatchObject({ kind: "hosted-session", session: mine.id, sub: mine.id, epoch: own.spec.allocationId, prn: env.principals.a, mdl: ["grok-4.6"] });
    const introspect = async () => (await env.dispatcher.inject({ method: "POST", url: "/internal/capabilities/introspect",
      headers: { "x-internal-key": gatewayKey }, payload: { jti: claims.jti } })).json();
    expect(await introspect()).toEqual({ active: true, remainingTokens: 50_000 });
    const requestId = randomUUID();
    for (let i = 0; i < 2; i++) {
      const usage = await env.dispatcher.inject({ method: "POST", url: "/internal/capabilities/usage", headers: { "x-internal-key": gatewayKey },
        payload: { requestId, jti: claims.jti, model: "grok-4.6", inputTokens: 100, outputTokens: 20 } });
      expect(usage.json()).toEqual({ recorded: true });
    }
    expect((await env.view("a", mine.id)).budget).toEqual({ usedTokens: 120, reservedTokens: 0, remainingTokens: 49_880 });
    expect(await introspect()).toEqual({ active: true, remainingTokens: 49_880 });

    const route = await placements.consumeTicket(mine.id, (await env.api.inject({ method: "POST", url: `/v1/sessions/${mine.id}/connection`, headers: env.headers("a") })).json().token);
    expect(route).toEqual({ kind: "container", sessionId: mine.id, generation: 1, allocationId: own.spec.allocationId,
      endpoint: `http://127.0.0.1:${own.container.ingress!.port}/`, credential: ingressCredential(own.spec.allocationId) });

    const files = new SessionFileStore(pool);
    const lease = await files.acquire(mine.id, env.principals.a, "shared-worker");
    await expect(env.shared.publish(lease, serverKey)).rejects.toMatchObject({ code: "not_found" });
    await expect(env.shared.issueTicket(env.principals.a, mine.id)).rejects.toMatchObject({ code: "not_found" });
    await files.release(lease);
    await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [mine.id]);

    expect((await env.api.inject({ method: "POST", url: `/v1/sessions/${mine.id}/close`, headers: env.headers("a"), payload: {} })).statusCode).toBe(200);
    expect(await introspect()).toMatchObject({ active: false, reason: "revoked" });
    expect((await env.asContainer(own.container.token, "token")).statusCode).toBe(404);
    expect((await env.asContainer(own.container.token, "heartbeat", { activeTurn: false, activity: false })).json()).toEqual({ stop: true });
    await wait(async () => (await env.view("a", mine.id)).container?.state === "closed" && !env.fake.session(mine.id), "retiring the closed session");
    expect((await env.asContainer(own.container.token, "spec")).statusCode).toBe(401);
  }, 60_000);

  it("keeps sessions principal-scoped and rejects harnesses session containers cannot host", async () => {
    const env = await environment();
    const mine = await env.create("a");
    for (const [method, url] of [["GET", `/v1/sessions/${mine.id}`], ["POST", `/v1/sessions/${mine.id}/connection`], ["POST", `/v1/sessions/${mine.id}/close`], ["GET", `/v1/sessions/${mine.id}/jobs`]] as const) {
      const response = await env.api.inject({ method, url, headers: env.headers("b"), ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await env.api.inject({ method: "GET", url: "/v1/sessions", headers: env.headers("b") })).json()).toEqual({ sessions: [] });
    expect((await env.api.inject({ method: "GET", url: "/v1/sessions", headers: env.headers("unbound") })).statusCode).toBe(404);
    expect((await env.api.inject({ method: "POST", url: "/v1/sessions", headers: env.headers("unbound"), payload: { harness: "session-coder" } })).statusCode).toBe(404);
    const listed = SharedSessionView.array().parse((await env.api.inject({ method: "GET", url: "/v1/sessions", headers: env.headers("a") })).json().sessions);
    expect(listed.map((session) => session.id)).toEqual([mine.id]);
    expect((await env.api.inject({ method: "GET", url: `/v1/sessions/${mine.id}/jobs`, headers: env.headers("a") })).json()).toEqual({ jobs: [] });

    const create = (payload: object) => env.api.inject({ method: "POST", url: "/v1/sessions", headers: env.headers("a"), payload });
    const missing = await create({ harness: "not-published" });
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, "harness_not_found"]);
    const version = await create({ harness: "session-coder", version: "9.9.9" });
    expect(version.statusCode).toBe(404);
    const batchSession = await create({ harness: "batch-only" });
    expect([batchSession.statusCode, batchSession.json().error.code]).toEqual([422, "policy_rejected"]);
    const sharedSession = await create({ harness: "shared-chat" });
    expect([sharedSession.statusCode, sharedSession.json().error.code]).toEqual([422, "hosting_mode_not_allowed"]);
    expect((await create({ harness: "session-coder", unexpected: true })).statusCode).toBe(400);
    expect((await create({ harness: { name: "session-coder" } })).statusCode).toBe(400);

    const withoutContainers = await environment({ containers: false });
    const unavailable = await withoutContainers.api.inject({ method: "POST", url: "/v1/sessions", headers: withoutContainers.headers("a"),
      payload: { harness: "session-coder" } });
    expect([unavailable.statusCode, unavailable.json().error.code]).toEqual([409, "hosting_unavailable"]);
  }, 60_000);
});
