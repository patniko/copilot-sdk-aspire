import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, PromotionResponse, PromotionSnapshotPage, SessionContainerReadyResult, SessionContainerSettings,
  SessionContainerSpec, SharedConnection, SharedSessionDefinition, SharedSessionLimits, SharedSessionView, SharedWorkerLimits,
  type HarnessSnapshot, type PlacementRoute, type PromotionState,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobEventListener, JobStore, migrate, PlacementStore, PromotionStore, SessionContainerStore,
  SessionDirectory, SessionFileStore, SharedStore, type ControllerLease, type PromotionRecord,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, restorePromotionSnapshot } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { ContainerSessionService } from "../../src/agent-api/src/container-sessions.js";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { sessionRoutes } from "../../src/connection-broker/src/sessions.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { sharedWorkerDeployment, type SharedActivationPlan } from "../../src/session-host/src/admission.js";
import { postgresSessionFilesystem } from "../../src/session-host/src/postgres-filesystem.js";
import { PromotionRefused, SharedPromotions, type SharedPromotionsOptions } from "../../src/session-host/src/promotion/coordinator.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";

/**
 * The promotion protocol (docs/HOSTING-MODES-PLAN.md, section 7.3) against PostgreSQL, the real dispatcher, broker
 * route checks, agent API and shared-worker control routes, with the session container simulated through its
 * allocation credential and no native runtime: request and refusals, the move, the snapshot fetch, restore, the
 * cutover on readiness, every failure before cutover leaving the session shared, and no route back.
 */
const keys = { executor: "synthetic-executor-key-".repeat(3), gateway: "synthetic-gateway-key-".repeat(3), signing: "synthetic-capability-key-".repeat(3) };
const brokerKey = "synthetic-connection-broker-key-".repeat(2);
const workerKey = "synthetic-shared-worker-key-".repeat(2);
const apiKey = "synthetic-promotion-api-key-".repeat(2);
const serverKey = { keyId: "promoted-container", algorithm: "x25519-sealedbox" as const, publicKey: "promoted-container-public-key" };
const namespace = `promotion-${randomUUID().slice(0, 12)}`;
const principal = `promotion-${randomUUID()}`;
const settings = SessionContainerSettings.parse({ image: "copilot-session-container:unused", startupSeconds: 10 });
const capacity = SharedWorkerLimits.parse({ executionContainers: 32, containersPerPrincipal: 16 });
const resources = { cpus: 0.5, memoryMiB: 1024 };

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let promotions: PromotionStore;
let allocations: AllocationStore;
let placements: PlacementStore;
let dispatcher: FastifyInstance;
let lease: ControllerLease;
let promotable: HarnessSnapshot;
let registry: Awaited<ReturnType<typeof sharedRegistry>>;
const notices: Array<{ id: string; prompt: string }> = [];
const deactivated: string[] = [];

function coordinator(overrides: Partial<SharedPromotionsOptions> = {}): SharedPromotions {
  return new SharedPromotions({
    store: promotions, files, settings, limits: capacity, pollMs: 50,
    deactivate: async (id) => { deactivated.push(id); },
    storageAreas: async (id) => ({ state: "/data/worker/session-state", workspace: `/data/worker/anchors/${id}`, workspacePath: `/data/worker/anchors/${id}` }),
    notify: async (_principal, id, _notification, prompt) => { notices.push({ id, prompt }); },
    report: () => {},
    ...overrides,
  });
}

/** A shared conversation of `snapshot`, with runtime history, spilled output, consent and workspace files in its storage. */
async function conversation(snapshot: HarnessSnapshot = promotable) {
  const definition = SharedSessionDefinition.parse({
    model: "fixture", limits: SharedSessionLimits.parse({}),
    harness: {
      name: snapshot.definition.name, version: snapshot.definition.version, digest: snapshot.digest,
      mode: snapshot.definition.hosting?.mode ?? "isolated", definition: snapshot.definition,
    },
  });
  const row = await shared.create(principal, 1, "promotion protocol", definition, 1000);
  const writer = await files.acquire(row.id, principal, "shared-worker");
  const provider = postgresSessionFilesystem(files, writer, "posix");
  await provider.writeFile("/data/worker/session-state/events.jsonl", "{\"type\":\"session.start\"}\n");
  await provider.writeFile("/data/worker/session-state/temp/spill.txt", "spilled tool output");
  await provider.writeFile("/data/worker/session-state/permissions.json", "{}");
  await provider.writeFile(`/data/worker/anchors/${row.id}/Notes/MixedCase.md`, "# Notes\n");
  await files.release(writer);
  const plan = { definition: snapshot.definition, policy: registry.policies.base } as SharedActivationPlan;
  return { id: row.id, plan };
}

async function until(id: string, done: (promotion: PromotionRecord) => boolean, label: string, timeout = 20_000): Promise<PromotionRecord> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const promotion = await promotions.byId(id);
    if (promotion && done(promotion)) return promotion;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${promotion?.state}`);
    await delay(50);
  }
}
const reached = (id: string, ...states: PromotionState[]) => until(id, (promotion) => states.includes(promotion.state), states.join("/"));
const allocated = (id: string) => until(id, (promotion) => promotion.allocationId !== undefined, "an allocation");

/** Binds and observes the allocation as the controller does, and acts as the container through its allocation-scoped credential. */
async function container(allocationId: string) {
  const token = randomBytes(32).toString("base64url");
  await allocations.bind(lease, allocationId, ExecutionContainerSettings.parse({ namespace, image: `sha256:${"a".repeat(64)}` }), token,
    randomBytes(32).toString("base64url"));
  await allocations.observed(lease, allocationId, randomBytes(32).toString("hex"), { host: "127.0.0.1", port: 9 });
  return (operation: string, body: object = {}) => dispatcher.inject({
    method: "POST", url: `/internal/session-containers/${operation}`, headers: { "x-internal-key": token }, payload: body,
  });
}

/** The broker's placement check for live routes, over the ledger's current placements. */
const brokerCheck = (routes: PlacementRoute[]) =>
  sessionRoutes({ consume: async () => undefined, lookup: (ids) => placements.current(ids) }).check!(routes, 5_000);
const sharedRoute = (sessionId: string): PlacementRoute => ({ kind: "shared", sessionId, generation: 1, epoch: randomUUID() });
const containerRoute = (sessionId: string, allocationId: string, generation: number): PlacementRoute => ({
  kind: "container", sessionId, generation, allocationId, endpoint: "http://127.0.0.1:1/", credential: "c".repeat(43),
});

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  allocations = new AllocationStore(pool, shared);
  promotions = new PromotionStore(pool, shared, allocations);
  placements = new PlacementStore(pool);
  promotable = sharedHarness("promotion-protocol", {
    hosting: { mode: "promotable", promotion: { approval: "allow" } }, builtinTools: ["files", "shell"],
  });
  registry = await sharedRegistry([promotable, sharedHarness("plain-shared")], {
    hosting: { modes: ["isolated", "shared", "promotable"], promotion: { approval: ["ask", "allow"] } },
  });
  dispatcher = buildDispatcher({
    store: new JobStore(pool), policies: registry.policies, executorKey: keys.executor, gatewayKey: keys.gateway, signingKey: keys.signing,
    allocations, sessionContainers: { allocations, store: new SessionContainerStore(pool, shared), policies: registry.policies, heartbeatSeconds: 5, promotions },
  });
  await dispatcher.ready();
  lease = await allocations.acquire(namespace, randomUUID());
});

afterAll(async () => {
  await dispatcher?.close();
  await pool?.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
  await pool?.query("DELETE FROM execution_allocations WHERE principal=$1", [principal]);
  await pool?.query("DELETE FROM shared_sessions WHERE principal=$1", [principal]);
  await pool?.query("DELETE FROM session_file_namespaces WHERE principal=$1", [principal]);
  await pool?.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
  await pool?.end();
});

describe("promotion protocol", () => {
  it("moves a shared conversation into its container: snapshot by allocation, restore, cutover on readiness, one way", async () => {
    const promoter = coordinator();
    const { id, plan } = await conversation();
    const first = await promoter.request({ principal, sessionId: id, plan, source: "tool", requestKey: "tool:call-1", reason: "Needs a shell" });
    expect(first).toMatchObject({ created: true, promotion: { state: "requested", source: "tool", size: "small", reason: "Needs a shell" } });
    // A repeated tool call, or another one while the move is open, joins the same promotion.
    expect(await promoter.request({ principal, sessionId: id, plan, source: "tool", requestKey: "tool:call-1" }))
      .toMatchObject({ created: false, promotion: { id: first.promotion.id } });
    expect(await promoter.request({ principal, sessionId: id, plan, source: "tool", requestKey: "tool:call-2" }))
      .toMatchObject({ created: false, promotion: { id: first.promotion.id } });
    const turnLease = await files.acquire(id, principal, "shared-worker");
    await expect(shared.enqueueTurn(turnLease, randomUUID(), "user", capacity)).rejects.toMatchObject({ code: "invalid_state" });
    await files.release(turnLease);
    expect(await brokerCheck([sharedRoute(id)])).toEqual(["current"]);

    promoter.turnEnded(id);
    const starting = await allocated(first.promotion.id);
    expect(starting.state).toBe("starting");
    expect(deactivated).toContain(id);
    expect((await placements.current([id]))[0]).toEqual({ sessionId: id, kind: "shared", generation: 1, moving: true });
    // Attached clients are moved off the shared worker as soon as the move begins.
    expect(await brokerCheck([sharedRoute(id)])).toEqual(["moved"]);

    const call = await container(starting.allocationId!);
    const spec = SessionContainerSpec.parse((await call("spec")).json());
    expect(spec).toMatchObject({
      sessionId: id, harness: { digest: promotable.digest },
      promotion: { id: first.promotion.id, digest: starting.snapshotDigest, previousWorkspace: `/data/worker/anchors/${id}`, runtimeSessionId: id, history: true },
    });
    const page = PromotionSnapshotPage.parse((await call("promotion-snapshot", { from: 0 })).json());
    // Runtime history and the workspace move; spilled tool output and provider-scoped consent stay behind.
    expect(page.manifest.entries.map((entry) => `${entry.area}:${entry.path}`)).toEqual(["state:events.jsonl", "workspace:Notes", "workspace:Notes/MixedCase.md"]);
    expect(page.next).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), "promotion-protocol-"));
    try {
      const contents = async function* () {
        for (const file of page.files) yield { ordinal: file.ordinal, content: Buffer.from(file.content, "base64") };
      };
      await restorePromotionSnapshot(page.manifest, contents(), { state: join(root, "state"), workspace: join(root, "workspace") },
        { sessionId: id, digest: spec.promotion!.digest });
      expect(await readFile(join(root, "workspace", "Notes", "MixedCase.md"), "utf8")).toBe("# Notes\n");
      expect(await readdir(join(root, "state"))).toEqual(["events.jsonl"]);
    } finally { await rm(root, { recursive: true, force: true }); }

    const ready = await call("ready", { serverKey });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(SessionContainerReadyResult.parse(ready.json())).toEqual({ ready: true, promoted: first.promotion.id });
    await reached(first.promotion.id, "committed");
    const view = (await shared.get(principal, id))!.view;
    expect(view).toMatchObject({ placement: "container", mode: "promotable", segment: { generation: 2, placement: "container" }, promotion: { state: "committed" } });
    expect(Date.parse(view.segment.startedAt)).toBeGreaterThanOrEqual(Date.parse(view.createdAt));
    expect((await placements.current([id]))[0]).toEqual({ sessionId: id, kind: "container", generation: 2 });
    expect(await brokerCheck([sharedRoute(id), containerRoute(id, starting.allocationId!, 2)])).toEqual(["moved", "current"]);
    expect((await pool.query("SELECT generation,placement,reason,promotion_id FROM session_segments WHERE session_id=$1", [id])).rows)
      .toEqual([{ generation: 2, placement: "container", reason: "promotion", promotion_id: first.promotion.id }]);

    // After cutover the snapshot is out of reach, a retried readiness still answers as promoted, and nothing demotes.
    expect((await call("promotion-snapshot", { from: 0 })).statusCode).toBe(404);
    expect(SessionContainerReadyResult.parse((await call("ready", { serverKey })).json())).toEqual({ ready: true, promoted: first.promotion.id });
    await expect(promotions.fail(first.promotion.id, "startup_failed", "late")).rejects.toMatchObject({ code: "invalid_state" });
    await expect(pool.query("UPDATE shared_sessions SET placement='shared' WHERE id=$1", [id])).rejects.toThrow(/cannot return to shared/);
    await expect(pool.query("UPDATE shared_sessions SET placement_generation=1 WHERE id=$1", [id])).rejects.toThrow(/cannot decrease/);
    // The shared namespace is fenced read-only: no shared worker can take a writable lease again.
    await expect(files.acquire(id, principal, "shared-worker")).rejects.toMatchObject({ code: "ESTALE" });
    expect(await promoter.request({ principal, sessionId: id, plan, source: "tool", requestKey: "tool:call-3" }))
      .toMatchObject({ created: false, promotion: { id: first.promotion.id, state: "committed" } });

    // A later container for the promoted session resumes from its volume: its spec carries no promotion.
    await pool.query("UPDATE execution_allocations SET state='retired' WHERE session_id=$1", [id]);
    const again = await allocations.request({
      sessionId: id, principal, purpose: "session", size: "small", resources, volumes: [], idleSeconds: 60, startupSeconds: 60, maxLifetimeSeconds: 600,
    }, capacity);
    const next = await container(again.id);
    expect(SessionContainerSpec.parse((await next("spec")).json()).promotion).toBeUndefined();
    expect(notices.filter((notice) => notice.id === id)).toEqual([]);
  });

  it("moves a handoff: target harness and definition, workspace only, and a fresh runtime session opened by its notice", async () => {
    const promoter = coordinator();
    const { id } = await conversation();
    const target = sharedHarness("handoff-target", { hosting: { mode: "isolated" }, builtinTools: ["files", "shell"] });
    const targetDefinition = SharedSessionDefinition.parse({
      model: "fixture", limits: SharedSessionLimits.parse({ maxTurnSeconds: 120, maxJobs: 0, maxContinuations: 0 }),
      harness: { name: target.definition.name, version: target.definition.version, digest: target.digest, mode: "isolated", definition: target.definition },
    });
    const handoffId = randomUUID();
    const notice = `[handoff:${handoffId}]\nYou continue a conversation handed off to you. Its notes are in Notes/MixedCase.md.`;
    const { promotion } = await promotions.request({
      principal, sessionId: id, source: "tool", requestKey: `handoff:${handoffId}`, kind: "handoff", history: false,
      runtimeSessionId: `handoff-${handoffId}`, notice, target: { harness: target, definition: targetDefinition }, size: "small", resources,
    });
    expect(promotion).toMatchObject({ kind: "handoff", history: false, runtimeSessionId: `handoff-${handoffId}`, notice });
    promoter.begin(promotion.id);
    const starting = await allocated(promotion.id);
    const call = await container(starting.allocationId!);
    const spec = SessionContainerSpec.parse((await call("spec")).json());
    expect(spec).toMatchObject({
      harness: { digest: target.digest }, maxTurnSeconds: 120,
      promotion: { id: promotion.id, runtimeSessionId: `handoff-${handoffId}`, history: false, notice },
    });
    const page = PromotionSnapshotPage.parse((await call("promotion-snapshot", { from: 0 })).json());
    expect(page.manifest.entries.map((entry) => `${entry.area}:${entry.path}`)).toEqual(["workspace:Notes", "workspace:Notes/MixedCase.md"]);
    expect(SessionContainerReadyResult.parse((await call("ready", { serverKey })).json())).toEqual({ ready: true, promoted: promotion.id });
    await reached(promotion.id, "committed");
    // The cutover installed the target definition: the view names the target harness and the new runtime session.
    const record = (await shared.get(principal, id))!;
    expect(record.definition).toEqual(targetDefinition);
    expect(record.view).toMatchObject({
      placement: "container", mode: "isolated", harness: { name: "handoff-target", digest: target.digest },
      segment: { generation: 2, placement: "container", ahpSessionId: `handoff-${handoffId}`, harness: { name: "handoff-target", digest: target.digest } },
    });
    expect(record.view.promotion).toBeUndefined();
    expect(await promotions.latest(principal, id)).toBeUndefined();
    expect((await pool.query("SELECT reason,ahp_session_id FROM session_segments WHERE session_id=$1", [id])).rows)
      .toEqual([{ reason: "handoff", ahp_session_id: `handoff-${handoffId}` }]);

    // A failed handoff is reported by the handoff ledger, not by a promotion notice to the source agent.
    const held = await conversation();
    const activation = await files.acquire(held.id, principal, "still-active");
    const failing = await promotions.request({ principal, sessionId: held.id, source: "tool", requestKey: `handoff:${randomUUID()}`, kind: "handoff", size: "small", resources });
    promoter.begin(failing.promotion.id);
    expect((await reached(failing.promotion.id, "failed")).view.error?.code).toBe("snapshot_failed");
    await files.release(activation);
    await delay(200);
    expect(notices.filter((entry) => entry.id === held.id || entry.id === id)).toEqual([]);
  });

  it("refuses promotion for other harnesses and without capacity, recording nothing", async () => {
    const promoter = coordinator();
    const plain = await conversation(registry.harnesses.get("plain-shared")![0]!);
    await expect(promoter.request({ principal, sessionId: plain.id, plan: plain.plan, source: "tool", requestKey: "tool:x" }))
      .rejects.toMatchObject({ code: "promotion_not_allowed" });
    expect(await promotions.latest(principal, plain.id)).toBeUndefined();

    const blocking = await conversation();
    await allocations.request({
      sessionId: blocking.id, principal, purpose: "session", size: "small", resources, volumes: [], idleSeconds: 60, startupSeconds: 60, maxLifetimeSeconds: 600,
    }, capacity);
    const own = Number((await pool.query("SELECT count(*) FROM execution_allocations WHERE principal=$1 AND state<>'retired'", [principal])).rows[0].count);
    const full = coordinator({ limits: SharedWorkerLimits.parse({ executionContainers: 32, containersPerPrincipal: own }) });
    const { id, plan } = await conversation();
    await expect(full.request({ principal, sessionId: id, plan, source: "tool", requestKey: "tool:y" }))
      .rejects.toSatisfy((error: unknown) => error instanceof PromotionRefused && error.code === "promotion_capacity");
    expect(await promotions.latest(principal, id)).toBeUndefined();
    await pool.query("UPDATE execution_allocations SET state='retired' WHERE session_id=$1", [blocking.id]);
  });

  it("fails before cutover at each step, leaving the session shared and writable, releasing the container, and telling the agent", async () => {
    const promoter = coordinator();
    // The snapshot cannot be read while an activation still holds the conversation's storage.
    const held = await conversation();
    const activation = await files.acquire(held.id, principal, "still-active");
    const a = await promoter.request({ principal, sessionId: held.id, plan: held.plan, source: "tool", requestKey: "tool:a" });
    promoter.turnEnded(held.id);
    expect((await reached(a.promotion.id, "failed")).view.error?.code).toBe("snapshot_failed");
    await files.release(activation);

    // The container cannot restore the snapshot and reports it; its allocation is released.
    const restoring = await conversation();
    const b = await promoter.request({ principal, sessionId: restoring.id, plan: restoring.plan, source: "tool", requestKey: "tool:b" });
    promoter.turnEnded(restoring.id);
    const bAllocation = (await allocated(b.promotion.id)).allocationId!;
    const call = await container(bAllocation);
    const failed = await call("promotion-failed", { code: "restore_failed", message: "A snapshot file did not match its digest." });
    expect(failed.json()).toEqual({ failed: true });
    expect((await reached(b.promotion.id, "failed")).view.error?.code).toBe("restore_failed");
    expect((await pool.query("SELECT state FROM execution_allocations WHERE id=$1", [bAllocation])).rows[0]).toEqual({ state: "retiring" });
    // The released container's credential no longer authenticates: it can neither commit nor read the snapshot.
    expect((await call("ready", { serverKey })).statusCode).toBe(401);
    expect((await call("promotion-snapshot", { from: 0 })).statusCode).toBe(401);

    // The container stops before it reports ready (an API-initiated move, which has no turn to wait for).
    const stopping = await conversation();
    const c = await promoter.request({ principal, sessionId: stopping.id, plan: stopping.plan, source: "api", requestKey: "api:c" });
    promoter.begin(c.promotion.id);
    await allocated(c.promotion.id);
    await pool.query("UPDATE execution_allocations SET state='retired',last_error='The session container exited (exit code 1).' WHERE session_id=$1", [stopping.id]);
    expect((await reached(c.promotion.id, "failed")).view.error).toEqual({ code: "startup_failed", message: "The session container exited (exit code 1)." });

    // The container never reports ready.
    const slow = await conversation();
    const timed = coordinator({ readyTimeoutMs: 500 });
    const d = await timed.request({ principal, sessionId: slow.id, plan: slow.plan, source: "tool", requestKey: "tool:d" });
    timed.turnEnded(slow.id);
    expect((await reached(d.promotion.id, "failed")).view.error?.code).toBe("promotion_timeout");
    const dAllocation = (await promotions.byId(d.promotion.id))!.allocationId!;
    expect((await pool.query("SELECT state FROM execution_allocations WHERE id=$1", [dAllocation])).rows[0]).toEqual({ state: "retiring" });

    // A container that reports ready after the shared storage moved on cannot commit a stale snapshot.
    const stale = await conversation();
    const e = await promoter.request({ principal, sessionId: stale.id, plan: stale.plan, source: "api", requestKey: "api:e" });
    promoter.begin(e.promotion.id);
    const eAllocation = (await allocated(e.promotion.id)).allocationId!;
    const writer = await files.acquire(stale.id, principal, "late-shared-writer");
    await files.write(writer, `/data/worker/anchors/${stale.id}/late.txt`, Buffer.from("written after the snapshot"));
    await files.release(writer);
    const late = await (await container(eAllocation))("ready", { serverKey });
    expect(late.statusCode).toBe(409);
    expect((await reached(e.promotion.id, "failed")).view.error?.code).toBe("snapshot_stale");

    const sessions = [held, restoring, stopping, slow, stale];
    for (const session of sessions) {
      expect((await shared.get(principal, session.id))!.view).toMatchObject({ placement: "shared", segment: { generation: 1 }, promotion: { state: "failed" } });
      expect((await placements.current([session.id]))[0]).toEqual({ sessionId: session.id, kind: "shared", generation: 1 });
      expect(await brokerCheck([sharedRoute(session.id)])).toEqual(["current"]);
      const writable = await files.acquire(session.id, principal, "shared-worker");
      await files.write(writable, `/data/worker/anchors/${session.id}/after.txt`, Buffer.from("turns are admitted again"));
      expect(await shared.enqueueTurn(writable, randomUUID(), "user", capacity)).toMatchObject({ state: "queued" });
      await pool.query("DELETE FROM shared_turns WHERE session_id=$1", [session.id]);
      await files.release(writable);
    }
    // Agents that asked through the tool hear why, once; API callers see the failed promotion instead.
    await delay(200);
    const told = notices.filter((notice) => sessions.some((session) => session.id === notice.id));
    expect(told.map((notice) => notice.id).sort()).toEqual([held.id, restoring.id, slow.id].sort());
    expect(told.find((notice) => notice.id === restoring.id)?.prompt).toContain("restore_failed");
  });

  it("serves promote and views through the agent API and shared worker, idempotently, with no route back", async () => {
    const root = await mkdtemp(join(tmpdir(), "promotion-service-"));
    const profile = process.env.COPILOT_AHP_FACTORY_PROFILE;
    process.env.COPILOT_AHP_FACTORY_PROFILE = "managed";
    const service = new SharedSessionService({
      root, store: shared, files, principals: { [principal]: 1 },
      admission: sharedAdmission(registry, { deployment: sharedWorkerDeployment({ promotion: true }) }),
      limits: capacity, gatewayUrl: "http://127.0.0.1:9", mintToken: async () => "unused", report: () => {},
      promotion: { store: promotions, settings, pollMs: 50 },
    });
    const host = buildSharedHost(service, workerKey, brokerKey);
    await host.listen({ port: 0, host: "127.0.0.1" });
    const harnesses = new Map(registry.harnesses);
    const profiles = new Map(registry.profiles);
    const catalog = {
      harnesses, profiles, policies: registry.policies,
      deployment: hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true, promotion: true }),
    };
    const jobs = new JobStore(pool);
    const api = buildApi({
      store: jobs, listener: new JobEventListener(pool), harnesses,
      admission: new Admission({ harnesses, profiles, policies: registry.policies }),
      maxOpenJobsPerPrincipal: 10, console: false, authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`), hosting: catalog,
      delegations: new DelegationStore(pool, shared, jobs),
      shared: { url: `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`, key: workerKey, brokerUrl: "http://127.0.0.1:47001" },
      containers: new ContainerSessionService({
        store: new SessionContainerStore(pool, shared), allocations, directory: new SessionDirectory(pool), catalog,
        principals: { [principal]: 1 }, settings, limits: capacity, brokerUrl: "http://127.0.0.1:47001", connectWaitSeconds: 1,
      }),
    });
    try {
      const headers = { authorization: `Bearer ${apiKey}` };
      const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "promotion-protocol" } });
      expect(created.statusCode, created.body).toBe(201);
      const session = SharedSessionView.parse(created.json());
      expect(session).toMatchObject({ mode: "promotable", placement: "shared", segment: { generation: 1 } });
      const plain = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "plain-shared" } });
      expect(plain.statusCode, plain.body).toBe(201);
      const refused = await api.inject({ method: "POST", url: `/v1/sessions/${SharedSessionView.parse(plain.json()).id}/promote`, headers, payload: {} });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "promotion_not_allowed" } });

      const promote = (key: string) => api.inject({
        method: "POST", url: `/v1/sessions/${session.id}/promote`, headers: { ...headers, "idempotency-key": key }, payload: { reason: "Run the build" },
      });
      const first = await promote("first");
      expect(first.statusCode, first.body).toBe(202);
      const accepted = PromotionResponse.parse(first.json());
      expect(accepted).toMatchObject({ sessionId: session.id, created: true, promotion: { source: "api", reason: "Run the build" } });
      expect(PromotionResponse.parse((await promote("first")).json())).toMatchObject({ created: false, promotion: { id: accepted.promotion.id } });
      expect(PromotionResponse.parse((await promote("second")).json())).toMatchObject({ created: false, promotion: { id: accepted.promotion.id } });
      const allocation = (await allocated(accepted.promotion.id)).allocationId!;
      // While the conversation moves, clients get no shared connection; the launcher retries.
      const moving = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers, payload: {} });
      expect(moving.statusCode, moving.body).toBe(409);
      expect(moving.json()).toMatchObject({ error: { code: "promotion_in_progress" } });

      expect((await (await container(allocation))("ready", { serverKey })).statusCode).toBe(200);
      await reached(accepted.promotion.id, "committed");
      const viewed = SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json());
      expect(viewed).toMatchObject({ id: session.id, placement: "container", segment: { generation: 2 }, promotion: { id: accepted.promotion.id, state: "committed" } });
      // Clients now connect to the container, under the same application session.
      const connected = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers, payload: {} });
      expect(connected.statusCode, connected.body).toBe(200);
      expect(SharedConnection.parse(connected.json())).toMatchObject({
        sessionId: session.id, ahpSessionId: session.id, destination: "container", serverKey, url: `ws://127.0.0.1:47001/sessions/${session.id}`,
      });
      // After the container idles out, a connection requests a new one for the promoted session from its volume.
      await pool.query("UPDATE execution_allocations SET state='retired' WHERE session_id=$1", [session.id]);
      const resumed = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers, payload: {} });
      expect(resumed.statusCode, resumed.body).toBe(503);
      expect(resumed.json()).toMatchObject({ error: { code: "container_starting" } });
      expect((await pool.query("SELECT state FROM execution_allocations WHERE session_id=$1 AND id<>$2", [session.id, allocation])).rows)
        .toEqual([{ state: "starting" }]);
      const after = await promote("third");
      expect(after.statusCode).toBe(200);
      expect(PromotionResponse.parse(after.json())).toMatchObject({ created: false, promotion: { id: accepted.promotion.id, state: "committed" } });
      // There is no demotion route.
      expect((await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/demote`, headers, payload: {} })).statusCode).toBe(404);
    } finally {
      await api.close();
      await host.close();
      await service.stop();
      await rm(root, { recursive: true, force: true });
      if (profile === undefined) delete process.env.COPILOT_AHP_FACTORY_PROFILE;
      else process.env.COPILOT_AHP_FACTORY_PROFILE = profile;
    }
  });
});
