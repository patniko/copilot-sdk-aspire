import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { ExecutorCapabilities, InputRequestBody } from "@copilot-agent/contracts";
import { JobStore, migrate, StoreError, type NewJob } from "@copilot-agent/job-store";
import { inputHarness } from "./fixtures/input-harness.js";

let pool: pg.Pool;
let store: JobStore;

const executor: ExecutorCapabilities = {
  executorId: "input-test-executor",
  profiles: ["node-ts-agent"],
  processIsolation: "uid",
  egress: "none",
  platform: "linux-x64",
};

const questionRequest: InputRequestBody = {
  kind: "question",
  question: "Pick one",
  choices: ["yes", "no"],
  allowFreeform: false,
};

const permissionRequest: InputRequestBody = {
  kind: "permission",
  permission: { type: "shell", command: "git status", intention: "Inspect workspace state" },
};

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    principal: "alice",
    requestHash: `hash-${randomUUID()}`,
    harness: inputHarness(30),
    profile: "node-ts-agent",
    model: "grok-4.6",
    input: { ask: questionRequest },
    maxDurationSeconds: 60,
    tokenBudget: 1000,
    maxAttempts: 1,
    safeToRetry: true,
    ...overrides,
  };
}

const claim = () =>
  store.claimNext({
    executor,
    defaults: { requiresUidIsolation: true, requiresEgressEnforcement: true, acknowledgedGaps: ["egress-not-enforced"] },
    leaseSeconds: 30,
    maxConcurrentPerPrincipal: 10,
  });

async function claimedJob(overrides: Partial<NewJob> = {}) {
  const created = await store.createJob(newJob(overrides), 10);
  const attempt = await claim();
  expect(attempt).toBeDefined();
  return { job: created.view, attempt: attempt! };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  store = new JobStore(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE jobs CASCADE");
});

describe("input requests", () => {
  it("creates, lists, answers, and polls input requests", async () => {
    const { job, attempt } = await claimedJob();
    const created = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "q1", questionRequest);
    expect(created?.id).toMatch(/[0-9a-f-]{36}/);
    expect((await store.getJob("alice", job.id))?.pendingInputs).toBe(1);

    const pending = await store.listInputRequests("alice", { state: "pending", limit: 10 });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: created!.id,
      jobId: job.id,
      attempt: 1,
      harness: { name: "input-fixture", version: "1.0.0" },
      state: "pending",
    });

    const answered = await store.respondInputRequest("alice", job.id, created!.id, { kind: "question", answer: "yes" }, "alice");
    expect(answered).toMatchObject({
      state: "answered",
      response: { kind: "question", answer: "yes", wasFreeform: false },
    });
    await expect(
      store.respondInputRequest("alice", job.id, created!.id, { kind: "question", answer: "yes" }, "alice"),
    ).rejects.toMatchObject({ code: "invalid_state" });

    expect(await store.pollInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, created!.id)).toMatchObject({
      state: "answered",
      response: { kind: "question", answer: "yes", wasFreeform: false },
    });
    expect((await store.getJob("alice", job.id))?.pendingInputs).toBe(0);
    expect((await store.listEvents("alice", job.id, 0, 20)).map((e) => e.body.type)).toContain("job.input_requested");
    expect((await store.listEvents("alice", job.id, 0, 20)).map((e) => e.body.type)).toContain("job.input_resolved");
  });

  it("rejects mismatched response kinds and invalid choices", async () => {
    const { job, attempt } = await claimedJob();
    const created = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "q1", questionRequest);
    await expect(
      store.respondInputRequest("alice", job.id, created!.id, { kind: "permission", approved: true }, "alice"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.respondInputRequest("alice", job.id, created!.id, { kind: "question", answer: "maybe" }, "alice"),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("expires pending requests during polling and listing", async () => {
    const { job, attempt } = await claimedJob();
    const created = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "q1", questionRequest);
    await pool.query("UPDATE input_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [created!.id]);

    expect(await store.pollInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, created!.id)).toEqual({
      state: "expired",
    });
    expect(await store.listInputRequests("alice", { state: "pending", limit: 10 })).toEqual([]);
    expect((await store.listInputRequests("alice", { jobId: job.id, state: "all", limit: 10 }))[0]).toMatchObject({
      state: "expired",
    });

    const stale = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "q2", questionRequest);
    await pool.query("UPDATE input_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [stale!.id]);
    await expect(
      store.respondInputRequest("alice", job.id, stale!.id, { kind: "question", answer: "yes" }, "alice"),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect((await store.listInputRequests("alice", { jobId: job.id, state: "all", limit: 10 })).map((r) => r.state)).toEqual([
      "expired",
      "expired",
    ]);
  });

  it("cancels pending requests when attempts settle or running jobs are cancelled", async () => {
    const first = await claimedJob();
    const settled = await store.createInputRequest(first.attempt.attempt.id, first.attempt.attempt.leaseToken, "q1", questionRequest);
    await store.completeAttempt(first.attempt.attempt.id, first.attempt.attempt.leaseToken, { kind: "succeeded", output: {} }, 1);
    expect((await store.listInputRequests("alice", { jobId: first.job.id, state: "all", limit: 10 }))[0]).toMatchObject({
      id: settled!.id,
      state: "cancelled",
    });

    const second = await claimedJob({ requestHash: "cancel-running" });
    const cancelled = await store.createInputRequest(second.attempt.attempt.id, second.attempt.attempt.leaseToken, "q1", permissionRequest);
    expect((await store.requestCancel("alice", second.job.id)).state).toBe("cancel_requested");
    expect((await store.listInputRequests("alice", { jobId: second.job.id, state: "all", limit: 10 }))[0]).toMatchObject({
      id: cancelled!.id,
      state: "cancelled",
    });
  });

  it("fences stale leases and reports unknown polls", async () => {
    const { attempt } = await claimedJob();
    expect(await store.createInputRequest(attempt.attempt.id, "stale-token-0000000000", "q1", questionRequest)).toBeUndefined();
    expect(await store.pollInputRequest(attempt.attempt.id, "stale-token-0000000000", randomUUID())).toBeUndefined();
    expect(await store.pollInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, randomUUID())).toBeNull();
  });

  it("enforces quota and is idempotent by runner request id", async () => {
    const { attempt } = await claimedJob();
    const first = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "same", questionRequest);
    const replay = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "same", questionRequest);
    expect(replay).toEqual(first);

    for (let i = 0; i < 4; i++) {
      await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, `q${i}`, questionRequest);
    }
    await expect(store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "overflow", questionRequest)).rejects.toBeInstanceOf(
      StoreError,
    );
    await expect(
      store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "overflow", questionRequest),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await store.listInputRequests("alice", { state: "pending", limit: 10 })).toHaveLength(5);
  });

  it("scopes input requests to the owning principal", async () => {
    const { job, attempt } = await claimedJob();
    const created = await store.createInputRequest(attempt.attempt.id, attempt.attempt.leaseToken, "q1", questionRequest);
    expect(await store.listInputRequests("bob", { state: "all", limit: 10 })).toEqual([]);
    await expect(
      store.respondInputRequest("bob", job.id, created!.id, { kind: "question", answer: "yes" }, "bob"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
