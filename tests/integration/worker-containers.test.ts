import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, SessionContainerSettings, SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, WorkerContainerSpec,
  WorkerControl, WorkerInputPoll, type WorkerCapacity,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobStore, migrate, SessionContainerStore, SessionFileStore, SharedStore, WorkerStore,
  type NewWorker, type WorkerContainerOptions,
} from "@copilot-agent/job-store";
import { createLogger, createService, verifyInferenceCapability } from "@copilot-agent/service-defaults";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { ExecutionController } from "../../src/execution-controller/src/controller.js";
import { registerSharedFileRoutes } from "../../src/execution-controller/src/shared-files.js";
import { ControllerSharedFiles } from "../../src/session-host/src/shared-files.js";
import { conversation, snapshot, workerRegistry } from "../fixtures/workers.js";
import { FakeAdapter } from "./fixtures/fake-adapter.js";

const signingKey = "synthetic-capability-key-".repeat(3);
const gatewayKey = "synthetic-gateway-key-".repeat(3);
const filesKey = "synthetic-shared-files-key-".repeat(2);
const images = { "executor:test": `sha256:${"a".repeat(64)}`, "session:test": `sha256:${"b".repeat(64)}` };
const limits = SharedWorkerLimits.parse({
  activeTurns: 16, activeTurnsPerPrincipal: 16, activeTurnsPerHarness: 16, queuedTurns: 64, executionContainers: 32, containersPerPrincipal: 16,
});
const containers: WorkerContainerOptions = { limits, startupSeconds: 60 };
const capacity: WorkerCapacity = { maxPerSession: 6, maxConcurrent: 4, maxPerPrincipal: 4, deployment: 1000 };
const runner = conversation("test-runner");
const serverKey = { keyId: "synthetic", algorithm: "x25519-sealedbox" as const, publicKey: "synthetic-public-key" };

let pool: pg.Pool;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => { await pool.end(); });

const wait = async (predicate: () => Promise<boolean> | boolean, label: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function environment() {
  const namespace = `workers-${randomUUID().slice(0, 12)}`;
  const principal = `worker-test-${randomUUID().slice(0, 8)}`;
  const shared = new SharedStore(pool);
  const files = new SessionFileStore(pool);
  const allocations = new AllocationStore(pool, shared);
  const workers = new WorkerStore(pool, shared, allocations);
  const jobs = new JobStore(pool);
  const registry = await workerRegistry([runner]);
  const settings = SessionContainerSettings.parse({ image: "session:test", idleSeconds: 60, heartbeatSeconds: 2, startupSeconds: 30, shutdownSeconds: 1 });
  const fake = new FakeAdapter(namespace, images);
  const apps: FastifyInstance[] = [];
  const dispatcher = buildDispatcher({
    store: jobs, policies: registry.policies, executorKey: "synthetic-executor-key-".repeat(3), gatewayKey, signingKey, allocations,
    sessionContainers: { allocations, store: new SessionContainerStore(pool, shared), policies: registry.policies, heartbeatSeconds: 2 },
    workers: { allocations, workers, policies: registry.policies, heartbeatSeconds: 2 },
  });
  apps.push(dispatcher);
  const controllers: ExecutionController[] = [];
  const controller = () => {
    const created = new ExecutionController({
      allocations, jobs, delegations: new DelegationStore(pool, shared, jobs), limits, sessions: settings,
      settings: ExecutionContainerSettings.parse({ namespace, image: "executor:test" }), signingKey: "synthetic-allocation-key-".repeat(3),
      dispatcherUrl: "http://127.0.0.1:1", gatewayUrl: "http://127.0.0.1:2", logger: createLogger("worker-container-test"), adapter: () => fake,
    });
    controllers.push(created);
    return created;
  };
  const sessions: string[] = [];
  cleanups.push(async () => {
    for (const created of controllers) await created.stop().catch(() => undefined);
    for (const app of apps) await app.close();
    await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
    await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
    await pool.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
    await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
  });
  const coordinator = async (mode: "orchestrator" | "shared" = "orchestrator") => {
    const session = await shared.create(principal, 1, "lead", SharedSessionDefinition.parse({
      model: "fixture", limits: SharedSessionLimits.parse({ tokenBudget: 200_000, turnTokenBudget: 5_000, maxContinuations: 4 }),
      harness: { name: "lead", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, mode },
    }), 50);
    sessions.push(session.id);
    const lease = await files.acquire(session.id, principal, "worker");
    const queued = await shared.enqueueTurn(lease, randomUUID(), "user", limits);
    await shared.startTurn(lease, queued.id, limits);
    const admit = async (name: string, changes: Partial<NewWorker> = {}) => (await workers.admit(lease, queued.id, {
      operationKey: `call-${name}`, argumentsHash: "a".repeat(64), name, source: "listed",
      harness: { name: runner.name, version: runner.version, digest: snapshot(runner).digest }, definition: runner,
      size: "small", resources: { cpus: 0.5, memoryMiB: 1024 }, sharedVolume: "read-write", approvalMode: "manual", inheritHumanAuthority: false,
      coordinatorAnswers: false, model: "fixture", tokenBudget: 20_000, maxTurnSeconds: 600, inputTimeoutSeconds: 300, idleSeconds: 600,
      lifetimeSeconds: 3600, task: `Task for ${name}.`, ...changes,
    }, capacity, containers)).view;
    return { session, lease, admit };
  };
  const asWorker = (token: string, path: string, payload: object = {}) =>
    dispatcher.inject({ method: "POST", url: `/internal/workers/${path}`, headers: { "x-internal-key": token }, payload });
  const container = (workerId: string) => [...fake.containers.values()].find((entry) => entry.labels?.["copilot.hybrid.worker"] === workerId);
  const active = async () => (await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM execution_allocations WHERE (namespace=$1 OR namespace IS NULL) AND kind='session' AND state<>'retired'", [namespace])).rows[0]!.count;
  return { namespace, principal, shared, workers, allocations, dispatcher, fake, controller, coordinator, asWorker, container, active, apps };
}

describe("worker containers", () => {
  it("run each worker as itself with its private and the shared volume, report through worker-bound routes, and return capacity", async () => {
    const env = await environment();
    const controller = env.controller();
    await controller.start();
    const c = await env.coordinator();
    const alpha = await c.admit("alpha");
    const beta = await c.admit("beta", { size: "medium", resources: { cpus: 1, memoryMiB: 2048 }, sharedVolume: "read-only" });
    await wait(() => env.container(alpha.id)?.status === "running" && env.container(beta.id)?.status === "running", "two running worker containers");
    const a = env.container(alpha.id)!;
    const b = env.container(beta.id)!;
    expect(a.labels).toMatchObject({ "copilot.hybrid.kind": "session", "copilot.hybrid.session": c.session.id, "copilot.hybrid.worker": alpha.id });
    const bound = (await pool.query<{ worker_id: string; volumes: Array<{ name: string; target: string; readOnly: boolean }>; resources: { cpus: number } }>(
      "SELECT worker_id,volumes,resources FROM execution_allocations WHERE worker_id=ANY($1::uuid[])", [[alpha.id, beta.id]])).rows;
    expect(Object.fromEntries(bound.map((row) => [row.worker_id, row.volumes.map((volume) => [volume.name, volume.target, volume.readOnly])]))).toEqual({
      [alpha.id]: [[`hybrid-${env.namespace}-worker-${alpha.id}`, "/data", false], [`hybrid-${env.namespace}-shared-${c.session.id}`, "/shared", false]],
      [beta.id]: [[`hybrid-${env.namespace}-worker-${beta.id}`, "/data", false], [`hybrid-${env.namespace}-shared-${c.session.id}`, "/shared", true]],
    });
    expect(bound.find((row) => row.worker_id === beta.id)!.resources).toEqual({ cpus: 1, memoryMiB: 2048 });

    // A worker container reads only its own worker, publishes readiness without a listener key, and heartbeats.
    const spec = WorkerContainerSpec.parse((await env.asWorker(a.token, "spec")).json());
    expect(spec).toMatchObject({ workerId: alpha.id, sessionId: c.session.id, messageSource: `agent-${c.session.id}`, sharedVolume: { path: "/shared", readOnly: false } });
    expect((await env.asWorker(a.token, "ready", { serverKey })).statusCode).toBe(400);
    expect((await env.asWorker(a.token, "ready")).json()).toEqual({ ready: true });
    expect((await env.asWorker(b.token, "ready")).statusCode).toBe(200);
    expect((await env.asWorker(a.token, "heartbeat", { activeTurn: true, activity: true })).json()).toEqual({ stop: false });
    // Worker and session-container credentials are not interchangeable.
    expect((await env.dispatcher.inject({ method: "POST", url: "/internal/session-containers/spec", headers: { "x-internal-key": a.token } })).statusCode).toBe(401);
    expect((await env.asWorker("not-a-worker-allocation-credential-0000", "spec")).statusCode).toBe(401);

    // Inference grants are charged to the worker's reservation through the gateway's introspection and usage chain.
    const grant = await env.asWorker(a.token, "token");
    expect(grant.headers["cache-control"]).toBe("no-store");
    const claims = await verifyInferenceCapability(signingKey, (grant.json() as { token: string }).token);
    expect(claims).toMatchObject({ sub: alpha.id, session: alpha.id, epoch: spec.allocationId, prn: env.principal, mdl: ["fixture"] });
    const introspect = async () => (await env.dispatcher.inject({ method: "POST", url: "/internal/capabilities/introspect",
      headers: { "x-internal-key": gatewayKey }, payload: { jti: claims.jti } })).json();
    expect(await introspect()).toEqual({ active: true, remainingTokens: 20_000 });
    const usage = await env.dispatcher.inject({ method: "POST", url: "/internal/capabilities/usage", headers: { "x-internal-key": gatewayKey },
      payload: { requestId: randomUUID(), jti: claims.jti, model: "fixture", inputTokens: 300, outputTokens: 50 } });
    expect(usage.json()).toEqual({ recorded: true });
    expect(await introspect()).toEqual({ active: true, remainingTokens: 19_650 });

    // The container delivers its worker's messages, reports a turn, and its request waits for a person.
    const control = WorkerControl.parse((await env.asWorker(a.token, "control")).json());
    expect(control.messages.map((message) => message.content)).toEqual(["Task for alpha."]);
    expect((await env.asWorker(a.token, "messages/delivered", { ids: [control.messages[0]!.id] })).json()).toEqual({ recorded: true });
    expect((await env.asWorker(a.token, "turns/started", { turnId: "turn-1" })).json()).toEqual({ recorded: true });
    const created = (await env.asWorker(a.token, "input-requests", {
      turnId: "turn-1", runtimeRequestId: "perm-1", request: { kind: "permission", permission: { type: "shell", command: "npm publish" } },
    })).json() as { id: string };
    expect(WorkerInputPoll.parse((await env.asWorker(a.token, "input-requests/poll", { id: created.id })).json())).toEqual({ state: "pending" });
    expect((await env.asWorker(b.token, "input-requests/poll", { id: created.id })).statusCode).toBe(404);
    await env.workers.respondInputRequest(env.principal, c.session.id, created.id, { kind: "permission", approved: true });
    expect(WorkerInputPoll.parse((await env.asWorker(a.token, "input-requests/poll", { id: created.id })).json()))
      .toEqual({ state: "answered", response: { kind: "permission", approved: true }, answeredBy: "principal" });
    expect((await env.asWorker(a.token, "turns/finished", { turnId: "turn-1", result: "ALPHA_DONE" })).json()).toEqual({ recorded: true });
    expect((await env.workers.get(env.principal, c.session.id, "alpha"))).toMatchObject({ state: "idle", result: { text: "ALPHA_DONE" }, usage: { tokensUsed: 350 } });

    // Archiving stops the worker's container through its heartbeat; the controller retires the allocation.
    await env.workers.archive(c.lease, "alpha");
    expect((await env.asWorker(a.token, "heartbeat", { activeTurn: false, activity: false })).json()).toEqual({ stop: true });
    expect(await introspect()).toMatchObject({ active: false, reason: "revoked" });
    await wait(() => !env.container(alpha.id), "the archived worker's container to be removed");
    // A worker container that exits while its worker runs has failed.
    b.status = "exited";
    await wait(() => !env.container(beta.id), "the exited worker's container to be removed");
    await wait(async () => (await env.active()) === 0, "capacity to return to zero");
    expect(await env.workers.reconcileAllocations()).toEqual([{ id: beta.id, sessionId: c.session.id, principal: env.principal, reason: "failed" }]);
    const views = new Map((await env.workers.list(env.principal, c.session.id)).map((view) => [view.name, view]));
    expect(views.get("alpha")).toMatchObject({ state: "stopped", stopReason: "archived", capacityReleased: true });
    expect(views.get("beta")).toMatchObject({ state: "stopped", stopReason: "failed", capacityReleased: true, error: expect.stringMatching(/container stopped/) });
    expect((await pool.query("SELECT count(*)::int AS count FROM session_workers WHERE session_id=$1 AND released_at IS NULL", [c.session.id])).rows[0].count).toBe(0);
    // Volumes are retained, and a stopped worker's private volume can no longer be mounted.
    expect((await env.fake.volumes()).sort()).toEqual([
      `hybrid-${env.namespace}-shared-${c.session.id}`, `hybrid-${env.namespace}-worker-${alpha.id}`, `hybrid-${env.namespace}-worker-${beta.id}`,
    ].sort());
    expect((await pool.query("SELECT purpose,released_at IS NOT NULL AS released FROM execution_volumes WHERE namespace=$1 ORDER BY purpose,name", [env.namespace])).rows)
      .toEqual([{ purpose: "shared", released: false }, { purpose: "worker", released: true }, { purpose: "worker", released: true }]);
  });

  it("serve a coordinator's shared volume only through the controller's bounded file service", async () => {
    const env = await environment();
    const controller = env.controller();
    await controller.start();
    const app = createService({ name: "execution-controller-test" });
    registerSharedFileRoutes(app, controller, filesKey);
    env.apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const client = new ControllerSharedFiles(url, filesKey);
    const signal = new AbortController().signal;
    const c = await env.coordinator();

    expect(await client.list(c.session.id, undefined, signal)).toEqual([]);
    await expect(client.read(c.session.id, "plan/notes.md", signal)).rejects.toThrow("The file was not found.");
    const written = await client.write(c.session.id, "plan/notes.md", Buffer.from("# Plan"), undefined, signal);
    expect(written).toMatchObject({ size: 6, etag: expect.any(String) });
    expect(await client.list(c.session.id, undefined, signal)).toEqual([{ name: "plan", type: "directory" }]);
    expect(await client.list(c.session.id, "plan", signal)).toEqual([{ name: "notes.md", type: "file", size: 6 }]);
    expect((await client.read(c.session.id, "plan/notes.md", signal)).toString()).toBe("# Plan");
    await expect(client.write(c.session.id, "plan/notes.md", Buffer.from("again"), undefined, signal)).rejects.toThrow(/read it first/);
    expect(await client.write(c.session.id, "plan/notes.md", Buffer.from("again"), written.etag, signal)).toMatchObject({ size: 5 });
    // The volume a coordinator writes first is the one its workers mount.
    expect((await pool.query("SELECT name,purpose,principal FROM execution_volumes WHERE namespace=$1", [env.namespace])).rows)
      .toEqual([{ name: `hybrid-${env.namespace}-shared-${c.session.id}`, purpose: "shared", principal: env.principal }]);
    const worker = await c.admit("reader", { sharedVolume: "read-only" });
    await wait(() => env.container(worker.id)?.status === "running", "the worker's container");
    const mounted = (await pool.query<{ volumes: Array<{ name: string }> }>("SELECT volumes FROM execution_allocations WHERE worker_id=$1", [worker.id])).rows[0]!.volumes;
    expect(mounted.map((volume) => volume.name)).toContain(`hybrid-${env.namespace}-shared-${c.session.id}`);

    const raw = (path: string, payload: object, key = filesKey) => fetch(`${url}/internal/shared-files/${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-key": key }, body: JSON.stringify(payload),
    });
    expect((await raw("list", { sessionId: c.session.id }, "wrong-shared-files-key-0123456789")).status).toBe(401);
    expect((await raw("read", { sessionId: c.session.id, path: "../etc/passwd" })).status).toBe(400);
    expect((await raw("write", { sessionId: c.session.id, path: "big.txt", content: Buffer.alloc(40 * 1024).toString("base64") })).status).toBe(400);
    const plain = await env.coordinator("shared");
    await expect(client.list(plain.session.id, undefined, signal)).rejects.toThrow("The coordinator conversation is unavailable.");
    await env.shared.close(env.principal, c.session.id, false);
    await expect(client.list(c.session.id, undefined, signal)).rejects.toThrow("The coordinator conversation is unavailable.");
    await env.workers.sweep();
    expect((await pool.query("SELECT released_at IS NOT NULL AS released FROM execution_volumes WHERE namespace=$1 AND purpose='shared'", [env.namespace])).rows)
      .toEqual([{ released: true }]);
  });
});
