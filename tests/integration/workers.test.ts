import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, type WorkerCapacity,
} from "@copilot-agent/contracts";
import {
  AllocationStore, migrate, SessionFileStore, SharedStore, WorkerStore, type NewWorker, type WorkerContainerOptions,
} from "@copilot-agent/job-store";
import { conversation, snapshot } from "../fixtures/workers.js";

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let allocations: AllocationStore;
let workers: WorkerStore;
const sessions: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const limits = SharedWorkerLimits.parse({
  activeTurns: 16, activeTurnsPerPrincipal: 16, activeTurnsPerHarness: 16, queuedTurns: 64, executionContainers: 32, containersPerPrincipal: 16,
});
const containers: WorkerContainerOptions = { limits, startupSeconds: 60 };
const runner = conversation("test-runner");
const capacity: WorkerCapacity = { maxPerSession: 6, maxConcurrent: 2, maxPerPrincipal: 3, deployment: 10_000 };

function definition(mode: "orchestrator" | "shared" = "orchestrator") {
  return SharedSessionDefinition.parse({
    model: "fixture",
    limits: SharedSessionLimits.parse({ tokenBudget: 100_000, turnTokenBudget: 5_000, maxContinuations: 4 }),
    harness: { name: "lead", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, mode },
  });
}

function worker(name: string, changes: Partial<NewWorker> = {}): NewWorker {
  return {
    operationKey: `call-${name}`, argumentsHash: hash(name), name, source: "listed",
    harness: { name: runner.name, version: runner.version, digest: snapshot(runner).digest }, definition: runner,
    policyDigest: `sha256:${"b".repeat(64)}`, size: "small", resources: { cpus: 0.5, memoryMiB: 1024 }, sharedVolume: "read-write",
    approvalMode: "manual", inheritHumanAuthority: false, coordinatorAnswers: false, model: "fixture", tokenBudget: 20_000,
    maxTurnSeconds: 600, inputTimeoutSeconds: 300, idleSeconds: 60, lifetimeSeconds: 3600, task: `Task for ${name}.`, ...changes,
  };
}

async function coordinator(principal = randomUUID(), mode: "orchestrator" | "shared" = "orchestrator") {
  const session = await shared.create(principal, 1, "lead", definition(mode), 10);
  sessions.push(session.id);
  const lease = await files.acquire(session.id, principal, "worker");
  const queued = await shared.enqueueTurn(lease, randomUUID(), "user", limits);
  const turn = await shared.startTurn(lease, queued.id, limits);
  expect(turn?.state).toBe("running");
  const admit = (name: string, changes: Partial<NewWorker> = {}, ceilings: WorkerCapacity = capacity) =>
    workers.admit(lease, queued.id, worker(name, changes), ceilings, containers);
  return { session, principal, lease, turnId: queued.id, admit };
}

const budget = async (principal: string, id: string) => (await shared.get(principal, id))!.view.budget;
const inbox = async (sessionId: string) => (await pool.query<{ kind: string; detail: Record<string, unknown>; state: string; batch_id: string | null }>(
  "SELECT kind,detail,state,batch_id FROM worker_inbox WHERE session_id=$1 ORDER BY created_at,id", [sessionId])).rows;
const holding = async (sessionId: string) => (await pool.query<{ count: number }>(
  "SELECT count(*)::int AS count FROM session_workers WHERE session_id=$1 AND released_at IS NULL", [sessionId])).rows[0]!.count;
const allocationOf = async (workerId: string) => (await pool.query<{ id: string }>(
  "SELECT id FROM execution_allocations WHERE worker_id=$1", [workerId])).rows[0]!.id;
/** Stands in for the controller and container: the worker's container is running and ready. */
const markReady = (workerId: string) => pool.query(
  "UPDATE execution_allocations SET state='running',ready_at=clock_timestamp() WHERE worker_id=$1 AND state<>'retired'", [workerId]);
/** Stands in for the controller: the worker's container is confirmed gone. */
const retire = (workerId: string, error?: string) => pool.query(
  `UPDATE execution_allocations SET state='retired',finished_at=clock_timestamp(),last_error=COALESCE($2::text,last_error)
   WHERE worker_id=$1 AND state<>'retired'`, [workerId, error ?? null]);
const release = async (workerId: string) => { await retire(workerId); await workers.reconcileAllocations(); };
const turn = async (workerId: string, turnId: string, result?: string) => {
  await workers.turnStarted(workerId, turnId);
  await workers.turnFinished(workerId, turnId, result === undefined ? {} : { result });
};
const spend = async (workerId: string, tokens: number) => {
  await markReady(workerId);
  const grant = await workers.grant(await allocationOf(workerId));
  return workers.recordUsage(grant.jti, randomUUID(), tokens, 0);
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  allocations = new AllocationStore(pool, shared);
  workers = new WorkerStore(pool, shared, allocations);
});
afterEach(async () => {
  await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
  await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
  sessions.length = 0;
});
afterAll(async () => { await pool.end(); });

describe("worker admission", () => {
  it("is idempotent per tool call, records the first task, reserves the aggregate budget, and requests one allocation", async () => {
    const c = await coordinator();
    const replies = await Promise.all(Array.from({ length: 4 }, () => c.admit("tests")));
    expect(new Set(replies.map((reply) => reply.view.id)).size).toBe(1);
    expect(replies.filter((reply) => reply.created)).toHaveLength(1);
    const view = replies[0]!.view;
    expect(view).toMatchObject({
      sessionId: c.session.id, name: "tests", source: "listed", harness: { name: "test-runner", version: "1.0.0" }, size: "small",
      resources: { cpus: 0.5, memoryMiB: 1024 }, sharedVolume: "read-write", approvalMode: "manual", state: "starting",
      usage: { tokenBudget: 20_000, tokensUsed: 0, turns: 0 }, pendingMessages: 1, pendingInputs: 0, capacityReleased: false,
    });
    expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBeGreaterThanOrEqual(3_599_000);
    expect(await budget(c.principal, c.session.id)).toEqual({ usedTokens: 0, reservedTokens: 25_000, remainingTokens: 75_000 });
    expect((await workers.control(view.id)).messages).toEqual([expect.objectContaining({ seq: 1, delivery: "enqueue", content: "Task for tests." })]);
    const rows = (await pool.query("SELECT kind,purpose,session_id,worker_id,principal,size,idle_seconds,state,volumes FROM execution_allocations WHERE worker_id=$1",
      [view.id])).rows;
    expect(rows).toEqual([{
      kind: "session", purpose: "worker", session_id: null, worker_id: view.id, principal: c.principal, size: "small", idle_seconds: 180, state: "starting",
      volumes: [
        { purpose: "worker", sessionId: view.id, target: "/data", readOnly: false },
        { purpose: "shared", sessionId: c.session.id, target: "/shared", readOnly: false },
      ],
    }]);
    await expect(workers.admit(c.lease, c.turnId, { ...worker("tests"), argumentsHash: hash("other") }, capacity, containers))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(c.admit("tests", { operationKey: "another-call" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await shared.get(c.principal, view.id)).toBeUndefined();
  });

  it("stays at depth one: only an orchestrator's running turn can start workers", async () => {
    const plain = await coordinator(randomUUID(), "shared");
    await expect(plain.admit("tests")).rejects.toMatchObject({ code: "invalid_state", message: expect.stringMatching(/orchestrator/) });
    const c = await coordinator();
    await shared.finishTurn(c.lease, c.turnId);
    await expect(c.admit("tests")).rejects.toMatchObject({ code: "invalid_state", message: expect.stringMatching(/running coordinator turn/) });
    await files.release(c.lease);
    await expect(c.admit("tests")).rejects.toMatchObject({ code: "not_found" });
    await expect(workers.admit(c.lease, c.turnId, worker(randomUUID()), capacity, containers)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("enforces the session, principal, and deployment ceilings under concurrent creation until allocations retire", async () => {
    const c = await coordinator();
    const outcomes = await Promise.allSettled(["one", "two", "three", "four", "five"].map((name) => c.admit(name)));
    const admitted = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value.view] : []));
    expect(admitted).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => (outcome as PromiseRejectedResult).reason.code))
      .toEqual(["quota_exceeded", "quota_exceeded", "quota_exceeded"]);
    const second = await coordinator(c.principal);
    await second.admit("six");
    await expect(second.admit("seven")).rejects.toMatchObject({ code: "quota_exceeded", message: expect.stringMatching(/principal/) });
    await workers.archive(c.lease, admitted[0]!.name);
    expect(await holding(c.session.id)).toBe(2);
    await expect(second.admit("seven")).rejects.toMatchObject({ code: "quota_exceeded" });
    await release(admitted[0]!.id);
    expect(await holding(c.session.id)).toBe(1);
    await second.admit("seven");
    const total = { ...capacity, maxPerSession: 3 };
    await workers.archive(c.lease, admitted[1]!.id);
    await release(admitted[1]!.id);
    await c.admit("eight", {}, total);
    await expect(c.admit("nine", {}, total)).rejects.toMatchObject({ code: "quota_exceeded", message: expect.stringMatching(/maximum of 3/) });
    const active = (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM session_workers WHERE released_at IS NULL")).rows[0]!.count;
    const third = await coordinator();
    await expect(third.admit("ten", {}, { ...capacity, deployment: active })).rejects.toMatchObject({ message: expect.stringMatching(/deployment/) });
  });

  it("admits a worker and its container allocation atomically", async () => {
    const c = await coordinator();
    const tight: WorkerContainerOptions = { ...containers, limits: { ...limits, containersPerPrincipal: 1 } };
    await workers.admit(c.lease, c.turnId, worker("one"), capacity, tight);
    await expect(workers.admit(c.lease, c.turnId, worker("two"), capacity, tight))
      .rejects.toMatchObject({ code: "quota_exceeded", message: expect.stringMatching(/container limit/) });
    expect((await workers.list(c.principal, c.session.id)).map((entry) => entry.name)).toEqual(["one"]);
    expect(await budget(c.principal, c.session.id)).toMatchObject({ reservedTokens: 25_000 });
  });

  it("leaves the coordinator one turn's budget", async () => {
    const c = await coordinator();
    const first = await c.admit("big", { tokenBudget: 95_000 });
    expect(first.view.usage.tokenBudget).toBe(90_000);
    await expect(c.admit("next")).rejects.toMatchObject({ code: "quota_exceeded", message: expect.stringMatching(/budget/) });
  });
});

describe("coordinator commands", () => {
  it("queue durable messages in order, idempotently, within a bound, and refuse them after archive", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    const steer = await workers.send(c.lease, "call-steer", hash("steer"), "tests", "Stop and summarize.", "immediate");
    const later = await workers.send(c.lease, "call-later", hash("later"), view.id, "Then lint.", "enqueue");
    expect([steer.message.seq, later.message.seq]).toEqual([2, 3]);
    expect(await workers.send(c.lease, "call-steer", hash("steer"), "tests", "Stop and summarize.", "immediate")).toMatchObject({ message: { id: steer.message.id } });
    await expect(workers.send(c.lease, "call-steer", hash("changed"), "tests", "x", "immediate")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(workers.send(c.lease, "call-ghost", hash("ghost"), "ghost", "x", "enqueue")).rejects.toMatchObject({ code: "not_found" });
    const control = await workers.control(view.id);
    expect(control.messages.map((message) => [message.seq, message.delivery])).toEqual([[1, "enqueue"], [2, "immediate"], [3, "enqueue"]]);
    await workers.messagesDelivered(view.id, [control.messages[0]!.id]);
    expect((await workers.control(view.id)).messages.map((message) => message.seq)).toEqual([2, 3]);
    for (let index = 0; index < 14; index++) await workers.send(c.lease, `fill-${index}`, hash(`fill-${index}`), "tests", "More.", "enqueue");
    await expect(workers.send(c.lease, "overflow", hash("overflow"), "tests", "More.", "enqueue")).rejects.toMatchObject({ code: "quota_exceeded" });
    const archived = await workers.archive(c.lease, "tests");
    expect(archived).toMatchObject({ state: "stopped", stopReason: "archived", pendingMessages: 0, capacityReleased: false });
    expect(await workers.archive(c.lease, "tests")).toMatchObject({ state: "stopped", stopReason: "archived" });
    await expect(workers.send(c.lease, "after", hash("after"), "tests", "x", "enqueue")).rejects.toMatchObject({ code: "invalid_state" });
    expect(await workers.control(view.id)).toEqual({ state: "stopped", interrupt: false, messages: [] });
    expect(await inbox(c.session.id)).toEqual([]);
  });

  it("interrupt only a running turn, and report each turn once to the inbox", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    expect((await workers.interrupt(c.lease, "tests")).interrupted).toBe(false);
    await workers.turnStarted(view.id, "turn-1");
    await workers.turnStarted(view.id, "turn-1");
    expect(await workers.interrupt(c.lease, "tests")).toMatchObject({ interrupted: true, worker: { state: "working", usage: { turns: 1 } } });
    expect((await workers.control(view.id)).interrupt).toBe(true);
    await workers.turnFinished(view.id, "turn-1", { result: "Partial output.", interrupted: true });
    await workers.turnFinished(view.id, "turn-1", { result: "Partial output.", interrupted: true });
    expect(await workers.get(c.principal, c.session.id, "tests")).toMatchObject({ state: "idle" });
    expect((await workers.get(c.principal, c.session.id, "tests"))!.result).toBeUndefined();
    expect((await workers.control(view.id)).interrupt).toBe(false);
    await turn(view.id, "turn-2", "All 12 tests pass.");
    await turn(view.id, "turn-3", "r".repeat(20_000));
    await workers.turnFinished(view.id, "turn-9", { result: "A turn that never started." });
    await expect(workers.turnStarted(view.id, "not a turn id")).rejects.toMatchObject({ code: "invalid_request" });
    const latest = (await workers.get(c.principal, c.session.id, view.id))!;
    expect(latest).toMatchObject({ state: "idle", usage: { turns: 3 }, result: { truncated: true } });
    expect(latest.result!.text).toHaveLength(16_000);
    const events = await inbox(c.session.id);
    expect(events.map((entry) => [entry.kind, entry.detail])).toEqual([
      ["idle", { reason: "interrupted" }],
      ["completed", { result: "All 12 tests pass.", truncated: false }],
      ["completed", { result: "r".repeat(4000), truncated: true }],
    ]);
  });

  it("charge usage once per request and return capacity only when the allocation is retired", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    const allocationId = await allocationOf(view.id);
    await expect(workers.grant(allocationId)).rejects.toMatchObject({ code: "not_found" });
    await markReady(view.id);
    const grant = await workers.grant(allocationId);
    expect(grant).toMatchObject({ workerId: view.id, sessionId: c.session.id, allocationId, principal: c.principal, models: ["fixture"], remainingTokens: 20_000 });
    expect((await workers.grant(allocationId)).jti).toBe(grant.jti);
    expect(await workers.introspect(grant.jti)).toEqual({ active: true, remainingTokens: 20_000 });
    const request = randomUUID();
    expect(await workers.recordUsage(grant.jti, request, 1000, 500)).toBe(true);
    expect(await workers.recordUsage(grant.jti, request, 1000, 500)).toBe(true);
    expect(await workers.recordUsage(randomUUID(), randomUUID(), 1, 1)).toBe(false);
    await pool.query("UPDATE execution_allocations SET created_at=created_at-interval '2 seconds' WHERE id=$1", [allocationId]);
    const archived = await workers.archive(c.lease, "tests");
    expect(archived).toMatchObject({ state: "stopped", capacityReleased: false, usage: { tokensUsed: 1500 } });
    expect(await workers.introspect(grant.jti)).toMatchObject({ active: false, reason: "revoked" });
    expect(await budget(c.principal, c.session.id)).toMatchObject({ usedTokens: 0, reservedTokens: 25_000 });
    expect(await holding(c.session.id)).toBe(1);
    await retire(view.id);
    expect(await workers.reconcileAllocations()).toEqual([]);
    expect(await workers.reconcileAllocations()).toEqual([]);
    const released = (await workers.get(c.principal, c.session.id, "tests"))!;
    expect(released.capacityReleased).toBe(true);
    expect(released.usage.containerSeconds).toBeGreaterThanOrEqual(2);
    expect(await holding(c.session.id)).toBe(0);
    expect(await budget(c.principal, c.session.id)).toEqual({ usedTokens: 1500, reservedTokens: 5_000, remainingTokens: 93_500 });
    expect(await workers.recordUsage(grant.jti, randomUUID(), 100, 0)).toBe(true);
    expect((await budget(c.principal, c.session.id)).usedTokens).toBe(1600);
  });

  it("fail a running worker whose container is gone, and tell the coordinator", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await workers.turnStarted(view.id, "turn-1");
    await retire(view.id, "The container exited with status 137.");
    expect(await workers.reconcileAllocations()).toEqual([{ id: view.id, sessionId: c.session.id, principal: c.principal, reason: "failed" }]);
    expect(await workers.get(c.principal, c.session.id, "tests")).toMatchObject({
      state: "stopped", stopReason: "failed", error: "The worker's container stopped: The container exited with status 137.", capacityReleased: true,
    });
    expect((await inbox(c.session.id)).map((entry) => [entry.kind, entry.detail.error])).toEqual([
      ["failed", "The worker's container stopped: The container exited with status 137."],
    ]);
  });
});

describe("worker containers", () => {
  it("bind the worker's private and the coordinator's shared volume, and authenticate the container as the worker", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests", { sharedVolume: "read-only" });
    const namespace = `workers-${randomUUID().slice(0, 12)}`;
    const lease = await allocations.acquire(namespace, randomUUID());
    try {
      const allocationId = await allocationOf(view.id);
      const token = `worker-token-${randomUUID()}`;
      const bound = await allocations.bind(lease, allocationId, ExecutionContainerSettings.parse({ namespace, image: `sha256:${"c".repeat(64)}` }),
        token, `ingress-credential-${randomUUID()}`);
      expect(bound).toMatchObject({ kind: "session", purpose: "worker", workerId: view.id, sessionId: c.session.id, sessionClosed: false });
      expect(bound.volumes).toEqual([
        { purpose: "worker", sessionId: view.id, target: "/data", readOnly: false, name: `hybrid-${namespace}-worker-${view.id}` },
        { purpose: "shared", sessionId: c.session.id, target: "/shared", readOnly: true, name: `hybrid-${namespace}-shared-${c.session.id}` },
      ]);
      expect(await allocations.authenticate(token)).toEqual({ kind: "worker", id: allocationId, workerId: view.id, sessionId: c.session.id, principal: c.principal });
      await expect(allocations.ready(allocationId, { keyId: "worker-key", algorithm: "x25519-sealedbox", publicKey: "public-key" }))
        .rejects.toMatchObject({ code: "invalid_request" });
      await allocations.ready(allocationId);
      await allocations.ready(allocationId);
      expect((await pool.query("SELECT 1 FROM session_containers WHERE session_id=$1", [c.session.id])).rowCount).toBe(0);
      expect(await allocations.containerHeartbeat(allocationId, { activeTurn: true, activity: true })).toEqual({ stop: false });
      expect(await workers.spec(allocationId, 5)).toMatchObject({
        workerId: view.id, sessionId: c.session.id, allocationId, name: "tests", githubUserId: 1, model: "fixture", heartbeatSeconds: 5,
        approvalMode: "manual", inheritAuthority: false, messageSource: `agent-${c.session.id}`, sharedVolume: { path: "/shared", readOnly: true },
        harness: { digest: snapshot(runner).digest },
      });
      await workers.archive(c.lease, "tests");
      expect(await allocations.containerHeartbeat(allocationId, { activeTurn: false, activity: false })).toEqual({ stop: true });
      expect(await allocations.get(lease, allocationId)).toMatchObject({ sessionClosed: true });
      await expect(workers.spec(allocationId, 5)).rejects.toMatchObject({ code: "not_found" });
      await expect(allocations.ready(allocationId)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await pool.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
      await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
    }
  });
});

describe("worker backstops", () => {
  it("stop workers for lifetime, idle time, budget, and failure, and tell the coordinator", async () => {
    const c = await coordinator();
    const ceilings = { ...capacity, maxConcurrent: 6, maxPerPrincipal: 6 };
    const old = (await c.admit("old", {}, ceilings)).view;
    const idle = (await c.admit("idle", {}, ceilings)).view;
    const spender = (await c.admit("spender", { tokenBudget: 1000 }, ceilings)).view;
    const waiting = (await c.admit("waiting", {}, ceilings)).view;
    const broken = (await c.admit("broken", {}, ceilings)).view;
    await pool.query("UPDATE session_workers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    await turn(idle.id, "turn-1");
    await pool.query("UPDATE session_workers SET idle_since=clock_timestamp()-interval '61 seconds' WHERE id=$1", [idle.id]);
    await workers.turnStarted(waiting.id, "turn-1");
    await workers.createInputRequest(waiting.id, "turn-1", "perm-1", { kind: "permission", permission: { type: "shell", command: "npm test" } });
    await pool.query("UPDATE session_workers SET last_activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [waiting.id]);
    await spend(spender.id, 1000);
    await workers.failed(broken.id, "The container exited with status 137.");
    const stopped = await workers.sweep();
    expect(stopped.filter((entry) => entry.sessionId === c.session.id).map((entry) => [entry.id, entry.reason]).sort())
      .toEqual([[idle.id, "idle_timeout"], [old.id, "max_lifetime"]].sort());
    const views = new Map((await workers.list(c.principal, c.session.id)).map((entry) => [entry.name, entry]));
    expect(views.get("spender")).toMatchObject({ state: "stopped", stopReason: "budget_exhausted" });
    expect(views.get("broken")).toMatchObject({ state: "stopped", stopReason: "failed", error: "The container exited with status 137." });
    expect(views.get("waiting")).toMatchObject({ state: "needs_input" });
    const events = (await inbox(c.session.id)).map((entry) => [entry.kind, entry.detail.reason ?? entry.detail.error ?? entry.detail.kind]);
    expect(events).toEqual(expect.arrayContaining([
      ["stopped", "budget_exhausted"], ["failed", "The container exited with status 137."], ["stopped", "max_lifetime"],
      ["stopped", "idle_timeout"], ["needs_input", "permission"], ["idle", "no_result"],
    ]));
    expect(await holding(c.session.id)).toBe(5);
  });

  it("select only eligible workers, so healthy ones cannot starve a backstop", async () => {
    const c = await coordinator();
    const ceilings = { ...capacity, maxConcurrent: 6, maxPerPrincipal: 6 };
    for (const name of ["one", "two", "three"]) await c.admit(name, {}, ceilings);
    const old = (await c.admit("old", {}, ceilings)).view;
    await pool.query("UPDATE session_workers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    expect(await workers.sweep(1)).toEqual([{ id: old.id, sessionId: c.session.id, principal: c.principal, reason: "max_lifetime" }]);
  });

  it("stop every worker when the coordinator closes, without inbox events, and release them once retired", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await turn(view.id, "turn-1", "Done.");
    await expect(workers.stopSession(c.session.id)).rejects.toMatchObject({ code: "invalid_state" });
    await shared.close(c.principal, c.session.id, false);
    const stopped = await workers.stopSession(c.session.id);
    expect(stopped).toEqual([{ id: view.id, sessionId: c.session.id, principal: c.principal, reason: "coordinator_closed" }]);
    expect(await workers.get(c.principal, c.session.id, "tests")).toMatchObject({ state: "stopped", stopReason: "coordinator_closed", capacityReleased: false });
    await release(view.id);
    expect(await workers.get(c.principal, c.session.id, "tests")).toMatchObject({ capacityReleased: true });
    await workers.reconcileInbox();
    expect((await inbox(c.session.id)).map((entry) => [entry.kind, entry.state])).toEqual([["completed", "closed"]]);
    const later = await coordinator();
    const second = (await later.admit("tests")).view;
    await shared.close(later.principal, later.session.id, false);
    expect((await workers.sweep()).find((entry) => entry.id === second.id)?.reason).toBe("coordinator_closed");
  });
});

describe("coordinator inbox", () => {
  it("claims bounded batches fenced by the activation and redelivers a timed-out batch intact", async () => {
    const c = await coordinator();
    const ceilings = { ...capacity, maxConcurrent: 3 };
    for (const name of ["one", "two", "three"]) {
      const { view } = await c.admit(name, {}, ceilings);
      await turn(view.id, "turn-1", `Result of ${name}.`);
    }
    expect(await workers.inboxSessions()).toContainEqual({ sessionId: c.session.id, principal: c.principal });
    const first = (await workers.claimInbox(c.lease, 2))!;
    expect(first.events.map((entry) => [entry.worker, entry.kind, entry.detail.result])).toEqual([
      ["one", "completed", "Result of one."], ["two", "completed", "Result of two."],
    ]);
    const second = (await workers.claimInbox(c.lease, 2))!;
    expect(second.events.map((entry) => entry.worker)).toEqual(["three"]);
    expect(await workers.claimInbox(c.lease, 2)).toBeUndefined();
    await workers.finishInbox(c.lease, first.batchId, "delivered");
    await pool.query("UPDATE worker_inbox SET delivery_until=clock_timestamp()-interval '1 second' WHERE batch_id=$1", [second.batchId]);
    await workers.reconcileInbox();
    const again = (await workers.claimInbox(c.lease, 8))!;
    expect(again.batchId).toBe(second.batchId);
    expect(again.events.map((entry) => entry.id)).toEqual(second.events.map((entry) => entry.id));
    await files.release(c.lease);
    await expect(workers.finishInbox(c.lease, again.batchId, "delivered")).rejects.toMatchObject({ code: "not_found" });
    const states = (await inbox(c.session.id)).map((entry) => entry.state);
    expect(states).toEqual(["delivered", "delivered", "delivering"]);
  });

  it("retries a failed delivery with the same batch after a delay, and sends it to review after the attempt limit", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await turn(view.id, "turn-1", "Done.");
    const first = (await workers.claimInbox(c.lease))!;
    await workers.finishInbox(c.lease, first.batchId, "deferred");
    expect((await workers.claimInbox(c.lease))!.batchId).toBe(first.batchId);
    for (let attempt = 1; attempt < 5; attempt++) {
      await workers.finishInbox(c.lease, first.batchId, "failed", "The runtime was unavailable.");
      expect(await workers.claimInbox(c.lease)).toBeUndefined();
      await pool.query("UPDATE worker_inbox SET delivery_until=clock_timestamp() WHERE batch_id=$1", [first.batchId]);
      expect((await workers.claimInbox(c.lease))!.batchId).toBe(first.batchId);
    }
    await workers.finishInbox(c.lease, first.batchId, "failed", "The runtime was unavailable.");
    expect(await workers.claimInbox(c.lease)).toBeUndefined();
    expect((await pool.query("SELECT state,attempts,last_error FROM worker_inbox WHERE session_id=$1", [c.session.id])).rows)
      .toEqual([{ state: "needs_review", attempts: 5, last_error: "The runtime was unavailable." }]);
  });

  it("sends undeliverable events to review when continuations run out", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await turn(view.id, "turn-1", "Done.");
    await pool.query("UPDATE shared_sessions SET continuations=4 WHERE id=$1", [c.session.id]);
    await workers.reconcileInbox();
    expect((await inbox(c.session.id)).map((entry) => entry.state)).toEqual(["needs_review"]);
    expect(await workers.inboxSessions()).not.toContainEqual(expect.objectContaining({ sessionId: c.session.id }));
  });
});

describe("worker requests for a person", () => {
  const permission = { kind: "permission" as const, permission: { type: "shell" as const, command: "npm publish" } };
  const question = { kind: "question" as const, question: "Which branch?", choices: ["main", "dev"], allowFreeform: false };

  it("queue for the principal from the worker's current turn, and only a person decides a permission request", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests", { coordinatorAnswers: true });
    await expect(workers.createInputRequest(view.id, "turn-1", "perm-1", permission)).rejects.toMatchObject({ code: "invalid_state" });
    await workers.turnStarted(view.id, "turn-1");
    await expect(workers.createInputRequest(view.id, "turn-0", "perm-1", permission)).rejects.toMatchObject({ code: "invalid_state" });
    const created = await workers.createInputRequest(view.id, "turn-1", "perm-1", permission);
    expect(Date.parse(created.expiresAt) - Date.now()).toBeLessThanOrEqual(305_000);
    expect(await workers.createInputRequest(view.id, "turn-1", "perm-1", permission)).toEqual({ ...created, created: false });
    expect((await workers.get(c.principal, c.session.id, "tests"))).toMatchObject({ state: "needs_input", pendingInputs: 1 });
    expect((await inbox(c.session.id))[0]).toMatchObject({ kind: "needs_input", detail: { requestId: created.id, kind: "permission", summary: "Permission (shell): npm publish" } });
    const pending = await workers.listInputRequests(c.principal, {});
    expect(pending.filter((entry) => entry.sessionId === c.session.id)).toEqual([expect.objectContaining({
      id: created.id, workerId: view.id, worker: "tests", harness: { name: "test-runner", version: "1.0.0" }, state: "pending", request: permission,
    })]);
    expect(await workers.listInputRequests(randomUUID(), {})).toEqual([]);
    await expect(workers.listInputRequests(randomUUID(), { sessionId: c.session.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(workers.answerAsCoordinator(c.lease, created.id, "yes")).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/Only a person/) });
    await expect(pool.query("UPDATE worker_input_requests SET answered_as='coordinator' WHERE id=$1", [created.id])).rejects.toThrow(/worker_input_coordinator_questions/);
    await expect(workers.respondInputRequest(randomUUID(), c.session.id, created.id, { kind: "permission", approved: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(workers.respondInputRequest(c.principal, c.session.id, created.id, { kind: "question", answer: "main" })).rejects.toMatchObject({ code: "invalid_request" });
    const answered = await workers.respondInputRequest(c.principal, c.session.id, created.id, { kind: "permission", approved: true, scope: "once" });
    expect(answered).toMatchObject({ state: "answered", answeredBy: "principal", response: { kind: "permission", approved: true, scope: "once" } });
    expect(await workers.pollInputRequest(view.id, created.id)).toEqual({ state: "answered", response: { kind: "permission", approved: true, scope: "once" }, answeredBy: "principal" });
    expect((await workers.get(c.principal, c.session.id, "tests"))!.state).toBe("working");
    await expect(workers.respondInputRequest(c.principal, c.session.id, created.id, { kind: "permission", approved: false })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("let the coordinator answer questions only when policy allows it", async () => {
    const c = await coordinator();
    const allowed = (await c.admit("allowed", { coordinatorAnswers: true })).view;
    const refused = (await c.admit("refused")).view;
    await workers.turnStarted(allowed.id, "turn-1");
    await workers.turnStarted(refused.id, "turn-1");
    const one = await workers.createInputRequest(allowed.id, "turn-1", "q-1", question);
    const two = await workers.createInputRequest(refused.id, "turn-1", "q-2", question);
    await expect(workers.answerAsCoordinator(c.lease, one.id, "staging")).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/choices/) });
    expect(await workers.answerAsCoordinator(c.lease, one.id, "main")).toMatchObject({
      state: "answered", answeredBy: "coordinator", response: { kind: "question", answer: "main", wasFreeform: false },
    });
    await expect(workers.answerAsCoordinator(c.lease, two.id, "main")).rejects.toMatchObject({ code: "invalid_state", message: expect.stringMatching(/a person must answer/) });
    const other = await coordinator();
    await expect(workers.answerAsCoordinator(other.lease, two.id, "main")).rejects.toMatchObject({ code: "not_found" });
  });

  it("expire unanswered requests and resume the worker", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await workers.turnStarted(view.id, "turn-1");
    const created = await workers.createInputRequest(view.id, "turn-1", "perm-1", permission);
    await pool.query("UPDATE worker_input_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [created.id]);
    await expect(workers.respondInputRequest(c.principal, c.session.id, created.id, { kind: "permission", approved: true }))
      .rejects.toMatchObject({ code: "invalid_state", message: expect.stringMatching(/expired/) });
    expect(await workers.listInputRequests(c.principal, { sessionId: c.session.id, state: "all" })).toEqual([expect.objectContaining({ state: "expired" })]);
    expect(await workers.pollInputRequest(view.id, created.id)).toEqual({ state: "expired" });
    expect((await workers.get(c.principal, c.session.id, "tests"))!.state).toBe("working");
    await workers.archive(c.lease, "tests");
    await expect(workers.createInputRequest(view.id, "turn-1", "perm-2", permission)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("cancel a request once its turn ends or another turn starts, and refuse late requests and answers", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    await workers.turnStarted(view.id, "turn-1");
    const created = await workers.createInputRequest(view.id, "turn-1", "perm-1", permission);
    await workers.turnFinished(view.id, "turn-1", {});
    expect(await workers.pollInputRequest(view.id, created.id)).toEqual({ state: "cancelled" });
    await expect(workers.respondInputRequest(c.principal, c.session.id, created.id, { kind: "permission", approved: true }))
      .rejects.toMatchObject({ code: "invalid_state" });
    await expect(workers.createInputRequest(view.id, "turn-1", "perm-2", permission)).rejects.toMatchObject({ code: "invalid_state" });
    expect((await workers.get(c.principal, c.session.id, "tests"))!.state).toBe("idle");
    await workers.turnStarted(view.id, "turn-2");
    const second = await workers.createInputRequest(view.id, "turn-2", "perm-3", permission);
    await workers.turnStarted(view.id, "turn-3");
    expect(await workers.pollInputRequest(view.id, second.id)).toEqual({ state: "cancelled" });
    expect((await workers.get(c.principal, c.session.id, "tests"))).toMatchObject({ state: "working", pendingInputs: 0 });
  });
});

describe("worker records", () => {
  it("record inherited authority only from the coordinator's host, and audit what the runtime applied", async () => {
    const c = await coordinator();
    const plain = (await c.admit("plain")).view;
    const inheriting = (await c.admit("judged", { approvalMode: "assisted", inheritHumanAuthority: true })).view;
    expect(inheriting.inheritsHumanAuthority).toBe(true);
    const messages = ["Fix the parser.", "yes, run the tests"];
    expect(await workers.grantAuthority(c.lease, "plain", messages)).toBeUndefined();
    const grant = (await workers.grantAuthority(c.lease, "judged", messages))!;
    expect(grant.created).toBe(true);
    expect(await workers.grantAuthority(c.lease, inheriting.id, messages)).toEqual({ id: grant.id, created: false });
    await expect(workers.grantAuthority(c.lease, "judged", Array.from({ length: 257 }, () => "more"))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(workers.grantAuthority(c.lease, "judged", ["x".repeat(600_000), "y".repeat(600_000)])).rejects.toMatchObject({ code: "invalid_request" });
    const other = await coordinator(c.principal);
    await expect(workers.grantAuthority(other.lease, inheriting.id, messages)).rejects.toMatchObject({ code: "not_found" });
    expect((await workers.control(inheriting.id)).authority).toEqual({ id: grant.id });
    expect((await workers.control(plain.id)).authority).toBeUndefined();
    expect(await workers.authorityGrant(inheriting.id, grant.id)).toEqual({ id: grant.id, sourceSessionId: c.session.id, messages });
    expect(await workers.authorityGrant(plain.id, grant.id)).toBeUndefined();
    await workers.authorityApplied(inheriting.id, grant.id, { messageCount: 2, overLimitMessageCount: 0 });
    await workers.authorityApplied(inheriting.id, grant.id, { messageCount: 9, overLimitMessageCount: 9 });
    await expect(workers.authorityApplied(plain.id, grant.id, { messageCount: 1, overLimitMessageCount: 0 })).rejects.toMatchObject({ code: "not_found" });
    expect((await workers.control(inheriting.id)).authority).toBeUndefined();
    const newer = (await workers.grantAuthority(c.lease, "judged", [...messages, "and lint it"]))!;
    expect((await workers.control(inheriting.id)).authority).toEqual({ id: newer.id });
    expect(await workers.authority(c.principal, c.session.id, inheriting.id)).toEqual([
      expect.objectContaining({ id: newer.id, sourceSessionId: c.session.id }),
      expect.objectContaining({
        id: grant.id, sourceSessionId: c.session.id, messageCount: 2, overLimitCount: 0, appliedAt: expect.any(String),
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    ]);
    expect(await workers.authority(randomUUID(), c.session.id, inheriting.id)).toEqual([]);
    expect(await workers.refreshAuthority(c.lease, [...messages, "and lint it"])).toBe(0);
    expect(await workers.refreshAuthority(c.lease, [...messages, "and lint it", "then push"])).toBe(1);
    expect((await workers.control(inheriting.id)).authority).not.toEqual({ id: newer.id });
    expect((await workers.control(plain.id)).authority).toBeUndefined();
    await expect(workers.refreshAuthority(other.lease, [])).resolves.toBe(0);
  });

  it("scope every read to the principal and export the recorded definition", async () => {
    const c = await coordinator();
    const { view } = await c.admit("tests");
    const stranger = randomUUID();
    await expect(workers.list(stranger, c.session.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await workers.get(stranger, c.session.id, view.id)).toBeUndefined();
    expect(await workers.definition(stranger, c.session.id, "tests")).toBeUndefined();
    expect((await workers.list(c.principal, c.session.id)).map((entry) => entry.id)).toEqual([view.id]);
    expect(await workers.definition(c.principal, c.session.id, "tests")).toMatchObject({
      workerId: view.id, sessionId: c.session.id, name: "tests", source: "listed", digest: snapshot(runner).digest,
      toolCallId: "call-tests", definition: runner,
    });
  });
});
