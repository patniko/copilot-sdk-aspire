import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { HostStore, migrate } from "@copilot-agent/job-store";
import { loadHarnesses } from "@copilot-agent/service-defaults";
import type { HarnessSnapshot } from "@copilot-agent/contracts";

let pool: pg.Pool;
let store: HostStore;
let harness: HarnessSnapshot;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  store = new HostStore(pool);
  harness = (await loadHarnesses(join(import.meta.dirname, "..", "..", "examples", "customer-config"))).get("interactive-demo")![0]!;
});
beforeEach(async () => { await pool.query("TRUNCATE demo_host, hosted_sessions, hosted_connection_tickets CASCADE"); });
afterAll(async () => { await pool.end(); });

describe("durable demo host control", () => {
  it("allows one owner and fences previous processes", async () => {
    const first = await store.acquire("alice", 30, 1);
    await expect(store.acquire("alice", 30, 1)).rejects.toThrow(/Another host/);
    await store.release(first.epoch);
    await expect(store.acquire("bob", 30, 2)).rejects.toThrow(/configured owner/);
    await expect(store.acquire("alice", 30, 2)).rejects.toThrow(/configured owner/);
    const second = await store.acquire("alice", 30, 1);
    expect(second.computeId).toBe(first.computeId);
    expect(second.epoch).not.toBe(first.epoch);
    await expect(store.heartbeat(first.epoch, 30)).rejects.toThrow(/lease was lost/);
  });

  it("retains snapshot and usage across renewal and host restart", async () => {
    const first = await store.acquire("alice", 30, 1);
    const id = randomUUID();
    const original = await store.session(first.epoch, "alice", id, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    const grant = await store.grant(first.epoch, "alice", id);
    const requestId = randomUUID();
    await store.recordUsage(grant.jti, requestId, 100, 50);
    await store.recordUsage(grant.jti, requestId, 100, 50);
    expect((await store.introspect(grant.jti)).remainingTokens).toBe(850);
    expect((await store.grant(first.epoch, "alice", id)).jti).toBe(grant.jti);
    await store.release(first.epoch);
    expect((await store.introspect(grant.jti)).active).toBe(false);
    const next = await store.acquire("alice", 30, 1);
    const resumed = await store.session(next.epoch, "alice", id, true, { harness, model: "ignored", tokenBudget: 2000 });
    expect(resumed.harness).toEqual(original.harness);
    expect(resumed.tokenBudget).toBe(1000);
    expect(resumed.inputTokens + resumed.outputTokens).toBe(150);
    expect((await store.grant(next.epoch, "alice", id)).jti).not.toBe(grant.jti);
    await expect(store.session(next.epoch, "bob", id, true, { harness, model: "grok-4.6", tokenBudget: 1000 })).rejects.toThrow();
  });

  it("does not allow renewal to reset exhaustion or reopen closed sessions", async () => {
    const lease = await store.acquire("alice", 30, 1);
    const id = randomUUID();
    await store.session(lease.epoch, "alice", id, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    const grant = await store.grant(lease.epoch, "alice", id);
    await store.recordUsage(grant.jti, randomUUID(), 1000, 1);
    expect(await store.introspect(grant.jti)).toMatchObject({ active: false, reason: "budget_exhausted" });
    await expect(store.grant(lease.epoch, "alice", id)).rejects.toThrow(/exhausted/);
    expect(await store.close("bob", id)).toBe(false);
    expect(await store.close("alice", id)).toBe(true);
    expect(await store.introspect(grant.jti)).toMatchObject({ active: false, reason: "revoked" });
  });

  it("issues short-lived single-use tickets bound to the current host", async () => {
    const lease = await store.acquire("alice", 30, 1);
    await expect(store.issueConnection("alice")).rejects.toThrow(/not ready/);
    await store.heartbeat(lease.epoch, 30, undefined, { keyId: "test-key", algorithm: "x25519-sealedbox", publicKey: "test-public-key" });
    await expect(store.issueConnection("bob")).rejects.toThrow(/not ready/);
    const ticket = await store.issueConnection("alice");
    expect(await store.consumeConnection(lease.epoch, "bob", ticket.token)).toBe(false);
    expect(await store.consumeConnection(lease.epoch, "alice", ticket.token)).toBe(true);
    expect(await store.consumeConnection(lease.epoch, "alice", ticket.token)).toBe(false);
    const stale = await store.issueConnection("alice");
    await store.release(lease.epoch);
    const next = await store.acquire("alice", 30, 1);
    expect(await store.consumeConnection(next.epoch, "alice", stale.token)).toBe(false);
  });
});
