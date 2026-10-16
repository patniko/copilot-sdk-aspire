import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits,
  type ArtifactData, type ExecutorCapabilities,
} from "@copilot-agent/contracts";
import { AllocationStore, DelegationStore, JobStore, SharedStore, SessionFileStore, migrate, type NewJob } from "@copilot-agent/job-store";
import { inputHarness } from "./fixtures/input-harness.js";

let pool: pg.Pool;
let jobs: JobStore;
let shared: SharedStore;
let files: SessionFileStore;
let delegations: DelegationStore;
let allocations: AllocationStore;
const sessionIds: string[] = [];
const jobIds: string[] = [];
let namespace: string;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const harness = { ...inputHarness(), digest: `sha256:${hash("delegation-fixture")}` };
const definition = SharedSessionDefinition.parse({
  model: "fixture",
  delegation: { harnesses: [{ name: harness.definition.name, version: harness.definition.version, digest: harness.digest }] },
  limits: SharedSessionLimits.parse({ tokenBudget: 3000, turnTokenBudget: 500, maxParallelJobs: 1, maxJobs: 3 }),
});
const limits = SharedWorkerLimits.parse({ executionContainers: 2, containersPerPrincipal: 2 });
const content = "selected immutable input";
const artifact: ArtifactData = { path: "input.txt", sha256: hash(content), base64: Buffer.from(content).toString("base64") };
const settings = () => ExecutionContainerSettings.parse({ namespace, image: `sha256:${"a".repeat(64)}` });
const tokenFor = (id: string) => `${id}-synthetic-allocation-token`;
const capabilities = (executorId: string): ExecutorCapabilities => ({
  executorId, profiles: ["node-ts-agent"], processIsolation: "none", egress: "none", platform: "linux-arm64",
});
const defaults = { requiresUidIsolation: false, requiresEgressEnforcement: false, acknowledgedGaps: [] };
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  jobs = new JobStore(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  delegations = new DelegationStore(pool, shared, jobs);
  allocations = new AllocationStore(pool, shared);
});
afterEach(async () => {
  await pool.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [jobIds]);
  await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessionIds]);
  await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessionIds]);
  if (namespace) await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
  sessionIds.length = 0;
  jobIds.length = 0;
});
afterAll(async () => { await pool.end(); });

async function fixture() {
  const principal = randomUUID();
  const session = await shared.create(principal, 1, "fixture", definition, 10);
  sessionIds.push(session.id);
  const lease = await files.acquire(session.id, principal, "worker");
  const turn = await shared.enqueueTurn(lease, randomUUID(), "user", limits);
  await shared.startTurn(lease, turn.id, limits);
  const job: NewJob = {
    principal, harness, profile: "node-ts-agent", model: "fixture", input: { ask: {} },
    requestHash: hash("synthetic-job"), tokenBudget: 800, maxDurationSeconds: 60, maxAttempts: 1, safeToRetry: true,
  };
  const admit = async (operation: string, inputs = [artifact]) => {
    const view = await delegations.admit(lease, turn.id, operation, hash(operation), job, inputs, 10);
    if (!jobIds.includes(view.id)) jobIds.push(view.id);
    return view;
  };
  namespace = `fixture-${randomUUID().slice(0, 12)}`;
  const controller = await allocations.acquire(namespace, randomUUID());
  return { session, principal, lease, turn, job, admit, controller };
}

describe("durable delegated container execution", () => {
  it("atomically deduplicates accepted tool operations and reserves aggregate budget", async () => {
    const f = await fixture();
    const replies = await Promise.all(Array.from({ length: 5 }, () => f.admit("tool-call")));
    expect(new Set(replies.map((job) => job.id)).size).toBe(1);
    expect((await shared.get(f.principal, f.session.id))?.view).toMatchObject({
      jobs: 1, budget: { usedTokens: 0, reservedTokens: 1300, remainingTokens: 1700 },
    });
    expect(await delegations.inputs(replies[0]!.id)).toEqual([artifact]);
    await expect(delegations.admit(f.lease, f.turn.id, "tool-call", hash("changed"), f.job, [], 10))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await files.release(f.lease);
    await expect(delegations.admit(f.lease, f.turn.id, "stale", hash("stale"), f.job, [], 10))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects malformed snapshots without admitting a job or spending a reservation", async () => {
    const f = await fixture();
    await expect(f.admit("corrupt", [{ ...artifact, sha256: hash("other") }])).rejects.toThrow(/checksum/);
    await expect(f.admit("duplicate", [artifact, { ...artifact, path: "INPUT.TXT" }])).rejects.toThrow(/duplicate/);
    expect((await shared.get(f.principal, f.session.id))?.view.jobs).toBe(0);
    expect(await jobs.listJobs(f.principal, 10)).toEqual([]);
  });

  it("fences dedicated claims and counts starting or retiring allocations against conversation ceilings", async () => {
    const f = await fixture();
    const first = await f.admit("one");
    await f.admit("two");
    expect(await jobs.claimNext({ executor: capabilities("pool"), leaseSeconds: 30, maxConcurrentPerPrincipal: 4, defaults })).toBeUndefined();
    const allocation = await allocations.reserve(f.controller, settings(), limits, tokenFor);
    expect(allocation?.jobId).toBe(first.id);
    expect(await allocations.reserve(f.controller, settings(), limits, tokenFor)).toBeUndefined();
    expect(await allocations.authenticate("wrong-token")).toBeUndefined();
    expect(await allocations.authenticate(tokenFor(allocation!.id))).toMatchObject({ id: allocation!.id, jobId: first.id });
    expect(await jobs.claimNext({ executor: capabilities(randomUUID()), allocationId: allocation!.id,
      leaseSeconds: 30, maxConcurrentPerPrincipal: 4, defaults })).toBeUndefined();
    const claim = await jobs.claimNext({ executor: capabilities(allocation!.id), allocationId: allocation!.id,
      leaseSeconds: 30, maxConcurrentPerPrincipal: 4, defaults });
    expect(claim?.job.id).toBe(first.id);
    expect(await allocations.ownsAttempt(allocation!.id, claim!.attempt.id)).toBe(true);
    expect(await allocations.ownsAttempt(allocation!.id, randomUUID())).toBe(false);
    expect(await jobs.claimNext({ executor: capabilities(allocation!.id), allocationId: allocation!.id,
      leaseSeconds: 30, maxConcurrentPerPrincipal: 4, defaults })).toBeUndefined();
    await jobs.completeAttempt(claim!.attempt.id, claim!.attempt.leaseToken, { kind: "succeeded", output: {} }, 1);
    await allocations.retiring(f.controller, allocation!.id, "complete");
    expect(await allocations.reserve(f.controller, settings(), limits, tokenFor)).toBeUndefined();
    await allocations.retired(f.controller, allocation!.id);
    expect((await allocations.reserve(f.controller, settings(), limits, tokenFor))?.jobId).not.toBe(first.id);
  });

  it("retains immutable artifacts, settles child usage once, and records one completion notice", async () => {
    const f = await fixture();
    const job = await f.admit("one");
    const allocation = (await allocations.reserve(f.controller, settings(), limits, tokenFor))!;
    const claim = (await jobs.claimNext({ executor: capabilities(allocation.id), allocationId: allocation.id,
      leaseSeconds: 30, maxConcurrentPerPrincipal: 4, defaults }))!;
    const requestId = randomUUID();
    expect(await jobs.beginInferenceRequest(claim.capability.jti, requestId)).toBe(800);
    await expect(jobs.beginInferenceRequest(claim.capability.jti, randomUUID())).rejects.toMatchObject({ code: "quota_exceeded" });
    await jobs.recordUsage(claim.capability.jti, 10, 20, requestId, true);
    await jobs.recordUsage(claim.capability.jti, 10, 20, requestId, true);
    const output = { ...artifact, path: "report.txt" };
    const published = await delegations.publishArtifact(claim.attempt.id, claim.attempt.leaseToken, output);
    expect(await delegations.publishArtifact(claim.attempt.id, claim.attempt.leaseToken, output)).toEqual(published);
    await expect(delegations.publishArtifact(claim.attempt.id, claim.attempt.leaseToken, { ...output, path: "REPORT.TXT" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await delegations.artifacts(f.principal, job.id)).toEqual([]);
    await jobs.completeAttempt(claim.attempt.id, claim.attempt.leaseToken, { kind: "succeeded", output: { report: "ready" } }, 1);
    expect(await delegations.artifacts("other", job.id)).toEqual([]);
    expect((await delegations.artifact(f.principal, job.id, published.id))?.content.toString()).toBe(content);
    await expect(delegations.publishArtifact(claim.attempt.id, claim.attempt.leaseToken, output)).rejects.toMatchObject({ code: "invalid_state" });
    await delegations.reconcile();
    await delegations.reconcile();
    expect((await shared.get(f.principal, f.session.id))?.view.budget).toEqual({ usedTokens: 30, reservedTokens: 500, remainingTokens: 2470 });
    const notice = (await delegations.notifications()).find((notice) => notice.jobId === job.id)!;
    expect(notice).toBeDefined();
    expect(await delegations.claimNotification(f.lease, notice.id)).toBe(true);
    expect(await delegations.claimNotification(f.lease, notice.id)).toBe(false);
    await delegations.finishNotification(f.lease, notice.id, "delivered");
    expect((await delegations.notifications()).some((notice) => notice.jobId === job.id)).toBe(false);
  });

  it("retains conservative charges after lost usage and fences controller takeover", async () => {
    const f = await fixture();
    const job = await f.admit("one");
    const allocation = (await allocations.reserve(f.controller, settings(), limits, tokenFor))!;
    const claim = (await jobs.claimNext({ executor: capabilities(allocation.id), allocationId: allocation.id,
      leaseSeconds: 30, maxConcurrentPerPrincipal: 4, defaults }))!;
    const requestId = randomUUID();
    await jobs.beginInferenceRequest(claim.capability.jti, requestId);
    await jobs.completeAttempt(claim.attempt.id, claim.attempt.leaseToken, { kind: "succeeded", output: {} }, 1);
    await pool.query("UPDATE attempts SET finished_at=clock_timestamp()-interval '31 seconds' WHERE id=$1", [claim.attempt.id]);
    await delegations.reconcile();
    expect((await shared.get(f.principal, f.session.id))?.view.budget.usedTokens).toBe(800);
    await jobs.recordUsage(claim.capability.jti, 800, 100, requestId, true);
    await delegations.reconcile();
    expect((await shared.get(f.principal, f.session.id))?.view.budget.usedTokens).toBe(900);
    expect((await jobs.getJob(f.principal, job.id))?.usage.requests).toBe(1);
    await expect(allocations.acquire(namespace, randomUUID())).rejects.toMatchObject({ code: "invalid_state" });
    await allocations.release(f.controller);
    const replacement = await allocations.acquire(namespace, randomUUID());
    await expect(allocations.beforeStart(f.controller, allocation.id)).rejects.toMatchObject({ code: "invalid_state" });
    expect((await allocations.active(replacement))[0]?.id).toBe(allocation.id);
  });

  it("does not let manual retry reopen a settled child without a new parent reservation", async () => {
    const f = await fixture();
    const job = await f.admit("one");
    const allocation = (await allocations.reserve(f.controller, settings(), limits, tokenFor))!;
    await allocations.retiring(f.controller, allocation.id, "Synthetic startup failure.");
    await allocations.failStartup(f.controller, allocation.id, jobs, "Synthetic startup failure.");
    await allocations.retired(f.controller, allocation.id);
    await delegations.reconcile();
    await expect(jobs.retryJob(f.principal, job.id)).rejects.toMatchObject({ code: "invalid_state" });
    expect((await shared.get(f.principal, f.session.id))?.view.budget.reservedTokens).toBe(500);
    expect((await jobs.getJob(f.principal, job.id))?.state).toBe("failed");
  });
});
