import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { ExecutorCapabilities, HarnessSnapshot } from "@copilot-agent/contracts";
import { JobStore, migrate, StoreError, type NewJob } from "@copilot-agent/job-store";
import { loadHarnesses } from "@copilot-agent/service-defaults";

let pool: pg.Pool;
let store: JobStore;
let harness: HarnessSnapshot;

const executor: ExecutorCapabilities = {
  executorId: "test-executor",
  profiles: ["node-ts-agent"],
  processIsolation: "uid",
  egress: "none",
  platform: "linux-x64",
};

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    principal: "alice",
    requestHash: "hash-1",
    harness,
    profile: "node-ts-agent",
    model: "grok-4.6",
    input: { question: "q" },
    maxDurationSeconds: 60,
    tokenBudget: 1000,
    maxAttempts: 2,
    safeToRetry: true,
    ...overrides,
  };
}

const claim = (leaseSeconds = 30) =>
  store.claimNext({ executor, acknowledgedGaps: ["egress-not-enforced"], leaseSeconds, maxConcurrentPerPrincipal: 10 });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  await migrate(pool); // idempotent
  store = new JobStore(pool);
  harness = (await loadHarnesses(join(import.meta.dirname, "..", "..", "examples", "customer-config"))).get("dataset-analyst")![0]!;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE jobs CASCADE");
});

describe("admission and idempotency", () => {
  it("returns the original job for a replayed idempotency key", async () => {
    const first = await store.createJob(newJob({ idempotencyKey: "k1" }), 10);
    const replay = await store.createJob(newJob({ idempotencyKey: "k1" }), 10);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.view.id).toBe(first.view.id);
  });

  it("rejects reuse of an idempotency key with a different request", async () => {
    await store.createJob(newJob({ idempotencyKey: "k2" }), 10);
    await expect(store.createJob(newJob({ idempotencyKey: "k2", requestHash: "other" }), 10)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("scopes idempotency keys and reads to the principal", async () => {
    const alice = await store.createJob(newJob({ idempotencyKey: "shared" }), 10);
    const bob = await store.createJob(newJob({ principal: "bob", idempotencyKey: "shared", requestHash: "x" }), 10);
    expect(bob.view.id).not.toBe(alice.view.id);
    expect(await store.getJob("bob", alice.view.id)).toBeUndefined();
    expect(await store.listEvents("bob", alice.view.id, 0, 10)).toEqual([]);
  });

  it("applies the per-principal open job quota", async () => {
    await store.createJob(newJob(), 1);
    await expect(store.createJob(newJob({ requestHash: "2" }), 1)).rejects.toBeInstanceOf(StoreError);
  });
});

describe("leases and fencing", () => {
  it("claims a job once and fences stale owners", async () => {
    const { view } = await store.createJob(newJob(), 10);
    const first = await claim();
    expect(first?.job.id).toBe(view.id);
    expect(await claim()).toBeUndefined();

    expect(await store.heartbeat(first!.attempt.id, first!.attempt.leaseToken, 30)).toMatchObject({
      cancelRequested: false,
    });
    expect(await store.heartbeat(first!.attempt.id, "stale-token-0000000000", 30)).toBeUndefined();
    expect(
      await store.completeAttempt(first!.attempt.id, "stale-token-0000000000", { kind: "succeeded", output: {} }, 1),
    ).toEqual({ accepted: false });

    const done = await store.completeAttempt(first!.attempt.id, first!.attempt.leaseToken, { kind: "succeeded", output: { a: 1 } }, 1);
    expect(done).toEqual({ accepted: true, state: "succeeded" });
    const finished = await store.getJob("alice", view.id);
    expect(finished?.result).toEqual({ a: 1 });
    expect(finished?.acknowledgedGaps).toEqual(["egress-not-enforced"]);
    // A completed attempt cannot be completed again.
    expect(
      await store.completeAttempt(first!.attempt.id, first!.attempt.leaseToken, { kind: "succeeded", output: {} }, 1),
    ).toEqual({ accepted: false });
  });

  it("retries read-only work after a lost lease and reports events in order", async () => {
    const { view } = await store.createJob(newJob(), 10);
    const first = await claim(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await store.reapExpiredLeases(0)).toBe(1);
    expect((await store.getJob("alice", view.id))?.state).toBe("retry_wait");
    expect(await store.heartbeat(first!.attempt.id, first!.attempt.leaseToken, 30)).toBeUndefined();
    const second = await claim();
    expect(second?.attempt.number).toBe(2);
    const events = await store.listEvents("alice", view.id, 0, 100);
    expect(events.map((e) => e.body.type)).toEqual([
      "job.queued",
      "job.attempt_started",
      "job.retry_scheduled",
      "job.attempt_started",
    ]);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("marks work with uncertain external effects for review instead of retrying", async () => {
    const { view } = await store.createJob(newJob({ safeToRetry: false }), 10);
    const attempt = await claim();
    const result = await store.completeAttempt(
      attempt!.attempt.id,
      attempt!.attempt.leaseToken,
      { kind: "failed", code: "runner_exited", message: "x", retryable: true, uncertainEffects: true },
      1,
    );
    expect(result.state).toBe("needs_review");
    expect((await store.getJob("alice", view.id))?.error?.code).toBe("runner_exited");
  });

  it("fails without retry when the failure is not retryable", async () => {
    await store.createJob(newJob(), 10);
    const attempt = await claim();
    const result = await store.completeAttempt(
      attempt!.attempt.id,
      attempt!.attempt.leaseToken,
      { kind: "failed", code: "invalid_output", message: "bad", retryable: false, uncertainEffects: false },
      1,
    );
    expect(result.state).toBe("failed");
  });
});

describe("cancellation and capabilities", () => {
  it("cancels queued jobs immediately", async () => {
    const { view } = await store.createJob(newJob(), 10);
    expect((await store.requestCancel("alice", view.id)).state).toBe("cancelled");
    expect(await claim()).toBeUndefined();
  });

  it("revokes the running attempt's capability and signals the executor", async () => {
    const { view } = await store.createJob(newJob(), 10);
    const attempt = await claim();
    expect(await store.introspectCapability(attempt!.capability.jti)).toMatchObject({ active: true });
    expect((await store.requestCancel("alice", view.id)).state).toBe("cancel_requested");
    expect(await store.introspectCapability(attempt!.capability.jti)).toMatchObject({ active: false, reason: "revoked" });
    expect(await store.heartbeat(attempt!.attempt.id, attempt!.attempt.leaseToken, 30)).toMatchObject({
      cancelRequested: true,
    });
    const result = await store.completeAttempt(attempt!.attempt.id, attempt!.attempt.leaseToken, { kind: "cancelled" }, 1);
    expect(result.state).toBe("cancelled");
  });

  it("enforces the job token budget across usage reports", async () => {
    await store.createJob(newJob({ tokenBudget: 100 }), 10);
    const attempt = await claim();
    expect(await store.recordUsage(attempt!.capability.jti, 60, 50)).toBe(true);
    expect(await store.introspectCapability(attempt!.capability.jti)).toMatchObject({
      active: false,
      reason: "budget_exhausted",
    });
    expect(await store.introspectCapability(randomUUID())).toMatchObject({ active: false, reason: "unknown" });
  });
});
