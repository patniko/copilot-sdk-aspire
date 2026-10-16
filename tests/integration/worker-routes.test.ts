import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type HarnessSnapshot, SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, WorkerDefinitionExport, WorkerInputRequestView, WorkerView,
} from "@copilot-agent/contracts";
import {
  JobStore, migrate, SessionFileStore, SharedStore, StoreError, WorkerStore,
  type JobEventListener, type NewWorker, type SessionFileLease, type SharedSessionRecord,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, type Logger } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { WorkerInboxPump, type WorkerInboxHost } from "../../src/session-host/src/worker-inbox.js";
import { conversation, snapshot, workerRegistry } from "../fixtures/workers.js";

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let workers: WorkerStore;
let app: ReturnType<typeof buildApi>;
const sessions: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const limits = SharedWorkerLimits.parse({ activeTurns: 16, activeTurnsPerPrincipal: 16, activeTurnsPerHarness: 16, queuedTurns: 64 });
const capacity = { maxPerSession: 6, maxConcurrent: 4, maxPerPrincipal: 4, deployment: 10_000 };
const keys = { owner: "owner-key-0123456789abcdefghijkl", stranger: "stranger-key-0123456789abcdefghi" };
const runner = conversation("test-runner");
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

function worker(name: string, changes: Partial<NewWorker> = {}): NewWorker {
  return {
    operationKey: `call-${name}`, argumentsHash: hash(name), name, source: "listed",
    harness: { name: runner.name, version: runner.version, digest: snapshot(runner).digest }, definition: runner,
    size: "small", resources: { cpus: 0.5, memoryMiB: 1024 }, sharedVolume: "none", approvalMode: "manual", inheritHumanAuthority: false,
    coordinatorAnswers: false, model: "fixture", tokenBudget: 10_000, maxTurnSeconds: 600, idleSeconds: 60, lifetimeSeconds: 3600,
    task: `Task for ${name}.`, ...changes,
  };
}

async function coordinator(principal = "owner") {
  const session = await shared.create(principal, 1, "lead", SharedSessionDefinition.parse({
    model: "fixture", limits: SharedSessionLimits.parse({ tokenBudget: 100_000, turnTokenBudget: 5_000, maxContinuations: 4 }),
    harness: { name: "lead", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, mode: "orchestrator" },
  }), 100);
  sessions.push(session.id);
  const lease = await files.acquire(session.id, principal, "worker");
  const queued = await shared.enqueueTurn(lease, randomUUID(), "user", limits);
  await shared.startTurn(lease, queued.id, limits);
  return { session, principal, lease, admit: (name: string, changes: Partial<NewWorker> = {}) => workers.admit(lease, queued.id, worker(name, changes), capacity) };
}

const call = async (method: "GET" | "POST", url: string, key = keys.owner, payload?: unknown) => {
  const response = await app.inject({ method, url, headers: { "x-api-key": key }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: response.statusCode, body: response.json() as Record<string, unknown>, headers: response.headers };
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  workers = new WorkerStore(pool, shared);
  const registry = await workerRegistry([]);
  app = buildApi({
    store: new JobStore(pool), listener: {} as JobEventListener,
    admission: new Admission({ harnesses: new Map<string, HarnessSnapshot[]>(), profiles: new Map(registry.profiles), policies: registry.policies }),
    authenticator: new ApiKeyAuthenticator(`owner:${keys.owner};stranger:${keys.stranger}`),
    harnesses: new Map(), maxOpenJobsPerPrincipal: 10, console: false, workers,
  });
  await app.ready();
});
afterEach(async () => {
  await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
  await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
  sessions.length = 0;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("worker API", () => {
  it("lists and reads the caller's workers and exports a recorded definition", async () => {
    const c = await coordinator();
    expect(await call("GET", `/v1/sessions/${c.session.id}/workers`)).toMatchObject({ status: 200, body: { workers: [] } });
    const { view } = await c.admit("tests");
    const listed = await call("GET", `/v1/sessions/${c.session.id}/workers`);
    expect(listed.status).toBe(200);
    expect((listed.body.workers as unknown[]).map((entry) => WorkerView.parse(entry).id)).toEqual([view.id]);
    for (const reference of ["tests", view.id]) {
      const read = await call("GET", `/v1/sessions/${c.session.id}/workers/${reference}`);
      expect(read.status).toBe(200);
      expect(WorkerView.parse(read.body)).toMatchObject({ id: view.id, name: "tests", state: "starting" });
    }
    const exported = await call("GET", `/v1/sessions/${c.session.id}/workers/tests/definition`);
    expect(exported.headers["cache-control"]).toBe("no-store");
    expect(WorkerDefinitionExport.parse(exported.body)).toMatchObject({ workerId: view.id, source: "listed", toolCallId: "call-tests", definition: runner });
    expect((await call("GET", `/v1/sessions/${c.session.id}/workers/ghost`)).status).toBe(404);
  });

  it("hides other principals' sessions, workers, and requests", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    const request = await workers.createInputRequest(view.id, "perm-1", { kind: "permission", permission: { type: "write", path: "README.md" } }, 600);
    for (const url of [
      `/v1/sessions/${c.session.id}/workers`, `/v1/sessions/${c.session.id}/workers/tests`, `/v1/sessions/${c.session.id}/workers/tests/definition`,
      `/v1/sessions/${c.session.id}/input-requests`, `/v1/sessions/not-a-uuid/workers`,
    ]) {
      expect((await call("GET", url, keys.stranger)).status).toBe(404);
    }
    expect(await call("GET", "/v1/worker-input-requests", keys.stranger)).toMatchObject({ status: 200, body: { requests: [] } });
    const respond = await call("POST", `/v1/sessions/${c.session.id}/input-requests/${request.id}/respond`, keys.stranger, { kind: "permission", approved: true });
    expect(respond).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect((await call("GET", `/v1/sessions/${c.session.id}/workers`, "wrong-key-0123456789abcdefghijkl")).status).toBe(401);
  });

  it("queues worker requests for a person and records the answer", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    const request = await workers.createInputRequest(view.id, "perm-1", { kind: "permission", permission: { type: "shell", command: "npm test" } }, 600);
    const pending = await call("GET", "/v1/worker-input-requests?state=pending&limit=500");
    expect((pending.body.requests as unknown[]).map((entry) => WorkerInputRequestView.parse(entry)))
      .toContainEqual(expect.objectContaining({ id: request.id, sessionId: c.session.id, worker: "tests", state: "pending" }));
    expect((await call("GET", `/v1/sessions/${c.session.id}/input-requests`)).body.requests).toHaveLength(1);
    expect((await call("GET", `/v1/sessions/${c.session.id}/input-requests?state=bogus`)).status).toBe(400);
    const invalid = await call("POST", `/v1/sessions/${c.session.id}/input-requests/${request.id}/respond`, keys.owner, { kind: "permission" });
    expect(invalid).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    const answered = await call("POST", `/v1/sessions/${c.session.id}/input-requests/${request.id}/respond`, keys.owner,
      { kind: "permission", approved: false, feedback: "Not now." });
    expect(answered.status).toBe(200);
    expect(WorkerInputRequestView.parse(answered.body)).toMatchObject({ state: "answered", answeredBy: "principal", response: { approved: false, feedback: "Not now." } });
    const again = await call("POST", `/v1/sessions/${c.session.id}/input-requests/${request.id}/respond`, keys.owner, { kind: "permission", approved: true });
    expect(again).toMatchObject({ status: 409, body: { error: { code: "invalid_state" } } });
    expect((await call("GET", `/v1/sessions/${c.session.id}/input-requests?state=all`)).body.requests).toEqual([expect.objectContaining({ state: "answered" })]);
  });
});

describe("worker inbox pump", () => {
  function host(principal: string, lease: () => SessionFileLease) {
    const prompts: Array<{ id: string; notificationId: string; prompt: string }> = [];
    let busy = false;
    let failure: Error | undefined;
    const value: WorkerInboxHost = {
      busy: () => busy,
      get: async (owner, id) => (await shared.get(owner, id)) as SharedSessionRecord,
      ensure: async () => undefined,
      activation: (owner) => {
        if (owner !== principal) throw new Error("Unexpected principal.");
        return lease();
      },
      continueConversation: async (_owner, id, notificationId, prompt) => {
        if (failure) throw failure;
        prompts.push({ id, notificationId, prompt });
        return "delivered";
      },
    };
    return { value, prompts, setBusy: (state: boolean) => { busy = state; }, fail: (error?: Error) => { failure = error; } };
  }

  it("delivers worker events as one bounded continuation and waits while the coordinator is busy", async () => {
    const c = await coordinator();
    for (const name of ["one", "two"]) {
      const { view } = await c.admit(name);
      await workers.turnStarted(view.id);
      await workers.turnFinished(view.id, { result: `Result of ${name}.` });
    }
    const fake = host(c.principal, () => c.lease);
    const pump = new WorkerInboxPump(fake.value, workers, logger);
    fake.setBusy(true);
    await pump.tick();
    expect(fake.prompts).toEqual([]);
    fake.setBusy(false);
    fake.fail(new StoreError("quota_exceeded", "The conversation is busy."));
    await pump.tick();
    expect((await pool.query("SELECT state FROM worker_inbox WHERE session_id=$1", [c.session.id])).rows.map((row) => row.state)).toEqual(["pending", "pending"]);
    fake.fail();
    await pump.tick();
    const delivered = fake.prompts.filter((entry) => entry.id === c.session.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.notificationId).toMatch(/^workers-[0-9a-f-]{36}$/);
    expect(delivered[0]!.prompt).toMatch(/untrusted worker data/);
    expect(delivered[0]!.prompt).toContain("Result of one.");
    expect(delivered[0]!.prompt).toContain("Result of two.");
    expect((await pool.query("SELECT state FROM worker_inbox WHERE session_id=$1", [c.session.id])).rows.map((row) => row.state)).toEqual(["delivered", "delivered"]);
    await pump.tick();
    expect(fake.prompts.filter((entry) => entry.id === c.session.id)).toHaveLength(1);
  });

  it("sends a batch whose delivery outcome is unknown to review", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await workers.turnStarted(view.id);
    await workers.turnFinished(view.id, { result: "Done." });
    const fake = host(c.principal, () => c.lease);
    fake.fail(new Error("The runtime connection dropped."));
    await new WorkerInboxPump(fake.value, workers, logger).tick();
    expect((await pool.query("SELECT state,last_error FROM worker_inbox WHERE session_id=$1", [c.session.id])).rows)
      .toEqual([{ state: "needs_review", last_error: "Delivery outcome may be unknown; read the workers explicitly." }]);
  });
});
