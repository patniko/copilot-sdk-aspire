import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, HandoffView, PromotionSnapshotPage, SessionContainerReadyResult, SessionContainerSettings, SessionContainerSpec,
  SharedConnection, SharedSessionLimits, SharedSessionView, SharedWorkerLimits, type HandoffPayload, type HarnessSnapshot,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, HandoffStore, JobEventListener, JobStore, migrate, PromotionStore, SessionContainerStore, SessionDirectory,
  SessionFileStore, SharedStore, type ControllerLease, type HandoffRecord,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { ContainerSessionService } from "../../src/agent-api/src/container-sessions.js";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { SharedAdmission, sharedWorkerDeployment } from "../../src/session-host/src/admission.js";
import { SharedConfiguration } from "../../src/session-host/src/configuration.js";
import { PERMISSION_HANDLERS } from "../../src/session-host/src/permission-handlers.js";
import { postgresSessionFilesystem } from "../../src/session-host/src/postgres-filesystem.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";

/**
 * Handoffs into a target's own session container (docs/HOSTING-MODES-PLAN.md, section 7.5) against PostgreSQL, the real
 * dispatcher, agent API, and shared-worker service, with the container simulated through its allocation credential and
 * no native runtime. The move runs as a promotion of kind `handoff` that carries the target's snapshot, definition,
 * runtime session, and notice: `summary` moves only the workspace and starts a new runtime session, `full` moves the
 * runtime history and continues it, and a failure before the cutover leaves the source in control.
 */
const keys = { executor: "synthetic-executor-key-".repeat(3), gateway: "synthetic-gateway-key-".repeat(3), signing: "synthetic-capability-key-".repeat(3) };
const brokerKey = "synthetic-connection-broker-key-".repeat(2);
const workerKey = "synthetic-shared-worker-key-".repeat(2);
const apiKey = "synthetic-handoff-container-key-".repeat(2);
const serverKey = { keyId: "handoff-container", algorithm: "x25519-sealedbox" as const, publicKey: "handoff-container-public-key" };
const namespace = `handoff-${randomUUID().slice(0, 12)}`;
const principal = `handoff-container-${randomUUID()}`;
const settings = SessionContainerSettings.parse({ image: "copilot-session-container:unused", startupSeconds: 10, idleSeconds: 240 });
// Two containers per principal, so the capacity case can hold them all.
const capacity = SharedWorkerLimits.parse({ executionContainers: 32, containersPerPrincipal: 2 });
const payload: HandoffPayload = { reason: "The build needs a shell.", summary: "SUMMARY: fix the failing build described in Plan.md." };
const conventions = process.platform === "win32" ? "windows" : "posix";
const headers = { authorization: `Bearer ${apiKey}` };

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let allocations: AllocationStore;
let promotions: PromotionStore;
let handoffs: HandoffStore;
let dispatcher: FastifyInstance;
let lease: ControllerLease;
let triage: HarnessSnapshot;
let triageFull: HarnessSnapshot;
let coder: HarnessSnapshot;
let service: SharedSessionService;
let api: FastifyInstance;
let host: FastifyInstance;
let root: string;
let profile: string | undefined;
const reports: string[] = [];

async function until<T>(read: () => Promise<T | undefined>, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(50);
  }
}
const settled = (id: string, state: HandoffRecord["state"]) =>
  until(async () => { const current = await handoffs.byId(id); return current?.state === state ? current : undefined; }, `the handoff to be ${state}`);

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

/** A conversation of `harness` whose storage holds runtime history, consent, and a workspace file, as the shared worker writes them. */
async function conversation(harness = "triage"): Promise<string> {
  const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness } });
  expect(created.statusCode, created.body).toBe(201);
  const id = SharedSessionView.parse(created.json()).id;
  const anchor = join(root, "worker", "anchors", id);
  await mkdir(anchor, { recursive: true });
  const writer = await files.acquire(id, principal, "shared-worker");
  const provider = postgresSessionFilesystem(files, writer, conventions);
  await provider.writeFile(join(root, "worker", "session-state", "events.jsonl"), "{\"type\":\"session.start\"}\n");
  await provider.writeFile(join(root, "worker", "session-state", "permissions.json"), "{}");
  await provider.writeFile(join(await realpath(anchor), "Plan.md"), "# Plan\n");
  await files.release(writer);
  return id;
}

/** The handoff to the coder, accepted as the transfer tool records it once a person approved. */
async function accepted(id: string, history: "summary" | "full"): Promise<HandoffRecord> {
  const source = history === "full" ? triageFull : triage;
  const { handoff } = await handoffs.request({
    principal, sessionId: id, requestKey: `call-${randomUUID()}`, fromGeneration: 1, fromPlacement: "shared",
    source: { name: source.definition.name, version: source.definition.version, digest: source.digest },
    target: { name: "coder", version: coder.definition.version, digest: coder.digest, mode: "isolated" }, toPlacement: "container",
    history, approval: "ask", approvedBy: "person", payload: history === "summary" ? payload : { reason: payload.reason },
  });
  expect(handoff.state).toBe("accepted");
  return handoff;
}

/** Starts the move as the worker's maintenance does after the source's turn, and waits for its container to be reserved. */
async function moving(handoff: HandoffRecord) {
  await service.maintain();
  const promotionId = await until(async () => {
    const current = await handoffs.byId(handoff.id);
    if (current?.state !== "accepted") throw new Error(`The handoff is ${current?.state}: ${JSON.stringify(current?.view.error)}; ${reports.join(", ")}`);
    return current.promotionId;
  }, "the move to start");
  const promotion = await until(async () => {
    const current = await promotions.byId(promotionId);
    return current?.allocationId ? current : undefined;
  }, "the move's container");
  return { promotion, call: await container(promotion.allocationId!) };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  allocations = new AllocationStore(pool, shared);
  promotions = new PromotionStore(pool, shared, allocations);
  handoffs = new HandoffStore(pool, shared);
  triage = sharedHarness("triage", {
    hosting: { mode: "shared", handoffs: [{ harness: "coder", description: "Coding work that needs a shell." }] }, builtinTools: ["files"],
  });
  // Without an explicit history a move across placements carries a summary (D12); this source asks for full history.
  triageFull = sharedHarness("triage-full", {
    hosting: { mode: "shared", handoffs: [{ harness: "coder", description: "Coding work that needs a shell.", history: "full" }] }, builtinTools: ["files"],
  });
  coder = sharedHarness("coder", {
    hosting: { mode: "isolated" }, builtinTools: ["files", "shell"], limits: { maxDurationSeconds: 120, maxInferenceTokens: 50_000 },
  });
  const registry = await sharedRegistry([triage, triageFull, coder]);
  dispatcher = buildDispatcher({
    store: new JobStore(pool), policies: registry.policies, executorKey: keys.executor, gatewayKey: keys.gateway, signingKey: keys.signing,
    allocations, sessionContainers: { allocations, store: new SessionContainerStore(pool, shared), policies: registry.policies, heartbeatSeconds: 5, promotions },
  });
  await dispatcher.ready();
  lease = await allocations.acquire(namespace, randomUUID());
  root = await realpath(await mkdtemp(join(tmpdir(), "handoff-container-")));
  profile = process.env.COPILOT_AHP_FACTORY_PROFILE;
  process.env.COPILOT_AHP_FACTORY_PROFILE = "managed";
  const sessionLimits = SharedSessionLimits.parse({ tokenBudget: 200_000 });
  service = new SharedSessionService({
    root: join(root, "worker"), store: shared, files, principals: { [principal]: 1 },
    admission: new SharedAdmission({
      configuration: SharedConfiguration.fixed(registry), sessionLimits, delegationHarnesses: [], permissionHandlers: new Set(PERMISSION_HANDLERS.keys()),
      deployment: sharedWorkerDeployment({ promotion: true }), sessionContainers: { idleSeconds: settings.idleSeconds },
    }),
    limits: capacity, gatewayUrl: "http://127.0.0.1:9", mintToken: async () => "unused", report: (event) => reports.push(event),
    promotion: { store: promotions, settings, pollMs: 50 }, handoffs,
  });
  host = buildSharedHost(service, workerKey, brokerKey);
  await host.listen({ port: 0, host: "127.0.0.1" });
  const harnesses = new Map(registry.harnesses);
  const profiles = new Map(registry.profiles);
  const catalog = {
    harnesses, profiles, policies: registry.policies,
    deployment: hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true, promotion: true }),
  };
  const jobs = new JobStore(pool);
  api = buildApi({
    store: jobs, listener: new JobEventListener(pool), harnesses, admission: new Admission({ harnesses, profiles, policies: registry.policies }),
    maxOpenJobsPerPrincipal: 10, console: false, authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`), hosting: catalog,
    delegations: new DelegationStore(pool, shared, jobs), handoffs,
    shared: { url: `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`, key: workerKey, brokerUrl: "http://127.0.0.1:47001" },
    containers: new ContainerSessionService({
      store: new SessionContainerStore(pool, shared), allocations, directory: new SessionDirectory(pool), catalog, principals: { [principal]: 1 },
      settings, limits: capacity, sessionLimits, brokerUrl: "http://127.0.0.1:47001", connectWaitSeconds: 1,
    }),
  });
  await api.ready();
});

afterEach(async () => {
  // Each case's containers are done; the next starts with the principal's capacity free.
  await pool.query("UPDATE execution_allocations SET state='retired' WHERE principal=$1 AND state<>'retired'", [principal]);
});

afterAll(async () => {
  try {
    await api?.close();
    await host?.close();
    await service?.stop();
    await dispatcher?.close();
  } finally {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (profile === undefined) delete process.env.COPILOT_AHP_FACTORY_PROFILE;
    else process.env.COPILOT_AHP_FACTORY_PROFILE = profile;
    await pool?.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
    await pool?.query("DELETE FROM execution_allocations WHERE principal=$1", [principal]);
    await pool?.query("DELETE FROM shared_sessions WHERE principal=$1", [principal]);
    await pool?.query("DELETE FROM session_file_namespaces WHERE principal=$1", [principal]);
    await pool?.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
    await pool?.end();
  }
});

describe("handoffs into a target's own session container", () => {
  it("moves a summary handoff: the workspace only, a new runtime session, the target's definition, and the notice", async () => {
    const id = await conversation();
    const handoff = await accepted(id, "summary");
    const { promotion, call } = await moving(handoff);
    expect(promotion).toMatchObject({ kind: "handoff", history: false, requestKey: `handoff:${handoff.id}`, source: "tool" });
    // While the conversation moves, clients get no connection; the launcher retries.
    const busy = await api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers, payload: {} });
    expect(busy.statusCode, busy.body).toBe(409);
    const spec = SessionContainerSpec.parse((await call("spec")).json());
    expect(spec).toMatchObject({ sessionId: id, harness: { digest: coder.digest }, model: "fixture", maxTurnSeconds: 120 });
    const runtimeSessionId = spec.promotion!.runtimeSessionId;
    expect(runtimeSessionId).not.toBe(id);
    expect(spec.promotion).toMatchObject({ id: promotion.id, history: false });
    expect(spec.promotion!.notice).toMatch(new RegExp(`^\\[handoff:${handoff.id}\\]\\n`));
    expect(spec.promotion!.notice).toContain("SUMMARY: fix the failing build");
    expect(spec.promotion!.notice).toContain("You run in your own container");
    // Only the workspace moves; the triage agent's runtime history stays behind.
    const page = PromotionSnapshotPage.parse((await call("promotion-snapshot", { from: 0 })).json());
    expect(page.manifest.entries.map((entry) => `${entry.area}:${entry.path}`)).toEqual(["workspace:Plan.md"]);
    expect(SessionContainerReadyResult.parse((await call("ready", { serverKey })).json())).toMatchObject({ ready: true, promoted: promotion.id });
    const committed = await settled(handoff.id, "committed");
    expect(committed.view).toMatchObject({ to: { generation: 2, placement: "container", ahpSessionId: runtimeSessionId } });
    const view = SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers })).json());
    expect(view).toMatchObject({
      harness: { name: "coder", digest: coder.digest }, mode: "isolated", placement: "container",
      segment: { generation: 2, placement: "container", ahpSessionId: runtimeSessionId, harness: { name: "coder" } },
      limits: { tokenBudget: 50_000, maxJobs: 0, maxContinuations: 0, idleSeconds: 240 },
    });
    expect(view.promotion).toBeUndefined();
    const listed = (await api.inject({ method: "GET", url: `/v1/sessions/${id}/handoffs`, headers })).json() as { handoffs: unknown[] };
    expect(listed.handoffs.map((entry) => HandoffView.parse(entry))).toEqual([expect.objectContaining({ id: handoff.id, state: "committed" })]);
    expect((await pool.query("SELECT generation,placement,reason,ahp_session_id,handoff_id FROM session_segments WHERE session_id=$1", [id])).rows)
      .toEqual([{ generation: 2, placement: "container", reason: "handoff", ahp_session_id: runtimeSessionId, handoff_id: handoff.id }]);
    // Clients now attach to the coder's runtime session in its container, under the same application session.
    const connected = await api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers, payload: {} });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(SharedConnection.parse(connected.json())).toMatchObject({ sessionId: id, destination: "container", ahpSessionId: runtimeSessionId });
    await expect(pool.query("UPDATE shared_sessions SET placement='shared' WHERE id=$1", [id])).rejects.toThrow(/cannot return to shared/);
  });

  it("moves a full handoff with the runtime history, continuing the same runtime session without the source's consent", async () => {
    const id = await conversation("triage-full");
    const handoff = await accepted(id, "full");
    const { call } = await moving(handoff);
    const spec = SessionContainerSpec.parse((await call("spec")).json());
    expect(spec.promotion).toMatchObject({ runtimeSessionId: id, history: true });
    expect(spec.promotion!.notice).toContain("You can see the earlier conversation above.");
    expect(spec.promotion!.notice).toContain("Earlier messages name the workspace as");
    const page = PromotionSnapshotPage.parse((await call("promotion-snapshot", { from: 0 })).json());
    expect(page.manifest.entries.map((entry) => `${entry.area}:${entry.path}`)).toEqual(["state:events.jsonl", "workspace:Plan.md"]);
    expect((await call("ready", { serverKey })).statusCode).toBe(200);
    await settled(handoff.id, "committed");
    expect(SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers })).json()))
      .toMatchObject({ harness: { name: "coder" }, placement: "container", segment: { generation: 2, ahpSessionId: id } });
  });

  it("leaves the source in control when the move fails before its cutover, and keeps the failure for the source", async () => {
    const id = await conversation();
    const handoff = await accepted(id, "summary");
    const { call } = await moving(handoff);
    expect((await call("promotion-failed", { code: "restore_failed", message: "A snapshot file did not match its digest." })).json()).toEqual({ failed: true });
    const failed = await settled(handoff.id, "failed");
    expect(failed.view.error).toMatchObject({ code: "handoff_failed", message: expect.stringContaining("restore_failed") });
    expect(SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers })).json()))
      .toMatchObject({ harness: { name: "triage" }, placement: "shared", segment: { generation: 1, ahpSessionId: id } });
    // The worker tries to tell the source in the background (with no runtime here, the attempt is retried later), so
    // take the storage lease once that attempt has released it.
    const writable = await until(() => files.acquire(id, principal, "shared-worker").catch(() => undefined), "the source's storage lease");
    expect(await shared.enqueueTurn(writable, randomUUID(), "user", capacity)).toMatchObject({ state: "queued" });
    await pool.query("DELETE FROM shared_turns WHERE session_id=$1", [id]);
    await files.release(writable);
  });

  it("refuses the move when the deployment has no container capacity, leaving the source in control", async () => {
    const holders = [await conversation(), await conversation()];
    for (const holder of holders) {
      await allocations.request({
        sessionId: holder, principal, purpose: "session", size: "small", resources: { cpus: 0.5, memoryMiB: 1024 }, volumes: [],
        idleSeconds: 60, startupSeconds: 60, maxLifetimeSeconds: 600,
      }, capacity);
    }
    const id = await conversation();
    const handoff = await accepted(id, "summary");
    await service.maintain();
    const failed = await settled(handoff.id, "failed");
    expect(failed.view.error?.code).toBe("handoff_unavailable");
    expect(SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers })).json()))
      .toMatchObject({ harness: { name: "triage" }, placement: "shared", segment: { generation: 1 } });
  });
});
