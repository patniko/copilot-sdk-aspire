import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { HostStore, migrate, type HostKey } from "@copilot-agent/job-store";
import { loadHarnesses } from "@copilot-agent/service-defaults";
import type { HarnessSnapshot } from "@copilot-agent/contracts";

let pool: pg.Pool;
let store: HostStore;
let harness: HarnessSnapshot;
const alice: HostKey = { harness: "interactive-demo", owner: "alice" };
const review: HostKey = { harness: "review-agent", owner: "alice" };
const serverKey = { keyId: "test-key", algorithm: "x25519-sealedbox", publicKey: "test-public-key" };

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  store = new HostStore(pool);
  harness = (await loadHarnesses(join(import.meta.dirname, "..", "..", "examples", "customer-config"))).get("interactive-demo")![0]!;
});
beforeEach(async () => { await pool.query("TRUNCATE demo_host, owner_hosts, hosted_sessions, hosted_connection_tickets CASCADE"); });
afterAll(async () => { await pool.end(); });

describe("durable owner host control", () => {
  it("allows one owner per harness host and fences previous processes", async () => {
    const first = await store.acquire(alice, 30, 1);
    await expect(store.acquire(alice, 30, 1)).rejects.toThrow(/Another host/);
    await store.release(alice, first.epoch);
    await expect(store.acquire({ harness: alice.harness, owner: "bob" }, 30, 2)).rejects.toThrow(/configured owner/);
    await expect(store.acquire(alice, 30, 2)).rejects.toThrow(/configured owner/);
    const second = await store.acquire(alice, 30, 1);
    expect(second.computeId).toBe(first.computeId);
    expect(second.epoch).not.toBe(first.epoch);
    await expect(store.heartbeat(alice, first.epoch, 30)).rejects.toThrow(/lease was lost/);
  });

  it("keeps each harness host's lease, sessions, grants, and tickets separate", async () => {
    const one = await store.acquire(alice, 30, 1);
    const two = await store.acquire(review, 30, 1);
    expect(two.computeId).not.toBe(one.computeId);
    // A lease, session, or grant is valid only for the host that holds it.
    await expect(store.heartbeat(review, one.epoch, 30)).rejects.toThrow(/lease was lost/);
    const id = randomUUID();
    await store.session(alice, one.epoch, id, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    await expect(store.session(review, two.epoch, id, true, { harness, model: "grok-4.6", tokenBudget: 1000 })).rejects.toThrow(/missing or closed/);
    await expect(store.grant(review, two.epoch, id)).rejects.toThrow(/missing or closed/);
    await expect(store.grant(review, one.epoch, id)).rejects.toThrow(/lease was lost/);
    const grant = await store.grant(alice, one.epoch, id);
    expect(await store.list(review)).toEqual([]);
    expect((await store.list(alice)).map((session) => session.id)).toEqual([id]);
    expect(await store.find(review, id)).toBeUndefined();
    expect(await store.close(review, id)).toBe(false);
    // Releasing another harness's host does not revoke this host's grants.
    await store.release(review, two.epoch);
    expect((await store.introspect(grant.jti)).active).toBe(true);
    await store.release(alice, one.epoch);
    expect(await store.introspect(grant.jti)).toMatchObject({ active: false, reason: "revoked" });

    const a = await store.acquire(alice, 30, 1);
    const b = await store.acquire(review, 30, 1);
    await store.heartbeat(alice, a.epoch, 30, undefined, serverKey);
    await store.heartbeat(review, b.epoch, 30, undefined, serverKey);
    const ticket = await store.issueConnection(alice);
    expect(await store.consumeConnection(review, b.epoch, ticket.token)).toBe(false);
    expect(await store.consumeConnection(alice, b.epoch, ticket.token)).toBe(false);
    expect(await store.consumeConnection(alice, a.epoch, ticket.token)).toBe(true);
  });

  it("limits open sessions per host, not per owner", async () => {
    const one = await store.acquire(alice, 30, 1);
    const two = await store.acquire(review, 30, 1);
    for (let index = 0; index < 10; index++) {
      await store.session(alice, one.epoch, randomUUID(), false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    }
    await expect(store.session(alice, one.epoch, randomUUID(), false, { harness, model: "grok-4.6", tokenBudget: 1000 })).rejects.toThrow(/maximum 10/);
    await store.session(review, two.epoch, randomUUID(), false, { harness, model: "grok-4.6", tokenBudget: 1000 });
  });

  it("binds a host to the compute identity recorded on its volume", async () => {
    const computeId = randomUUID();
    const first = await store.acquire(alice, 30, 1, "managed", computeId);
    expect(first.computeId).toBe(computeId);
    await store.release(alice, first.epoch);
    await expect(store.acquire(alice, 30, 1, "managed", randomUUID())).rejects.toThrow(/different durable host identity/);
    expect((await store.acquire(alice, 30, 1, "managed", computeId)).computeId).toBe(computeId);
  });

  it("retains snapshot and usage across renewal and host restart", async () => {
    const first = await store.acquire(alice, 30, 1);
    const id = randomUUID();
    const original = await store.session(alice, first.epoch, id, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    const grant = await store.grant(alice, first.epoch, id);
    const requestId = randomUUID();
    await store.recordUsage(grant.jti, requestId, 100, 50);
    await store.recordUsage(grant.jti, requestId, 100, 50);
    expect((await store.introspect(grant.jti)).remainingTokens).toBe(850);
    expect((await store.grant(alice, first.epoch, id)).jti).toBe(grant.jti);
    await store.release(alice, first.epoch);
    expect((await store.introspect(grant.jti)).active).toBe(false);
    const next = await store.acquire(alice, 30, 1);
    const resumed = await store.session(alice, next.epoch, id, true, { harness, model: "ignored", tokenBudget: 2000 });
    expect(resumed.harness).toEqual(original.harness);
    expect(resumed.tokenBudget).toBe(1000);
    expect(resumed.inputTokens + resumed.outputTokens).toBe(150);
    expect((await store.grant(alice, next.epoch, id)).jti).not.toBe(grant.jti);
    await expect(store.session({ harness: alice.harness, owner: "bob" }, next.epoch, id, true, { harness, model: "grok-4.6", tokenBudget: 1000 })).rejects.toThrow();
  });

  it("does not allow renewal to reset exhaustion or reopen closed sessions", async () => {
    const lease = await store.acquire(alice, 30, 1);
    const id = randomUUID();
    await store.session(alice, lease.epoch, id, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    const grant = await store.grant(alice, lease.epoch, id);
    await store.recordUsage(grant.jti, randomUUID(), 1000, 1);
    expect(await store.introspect(grant.jti)).toMatchObject({ active: false, reason: "budget_exhausted" });
    await expect(store.grant(alice, lease.epoch, id)).rejects.toThrow(/exhausted/);
    expect(await store.close({ harness: alice.harness, owner: "bob" }, id)).toBe(false);
    expect(await store.close(alice, id)).toBe(true);
    expect(await store.introspect(grant.jti)).toMatchObject({ active: false, reason: "revoked" });
  });

  it("issues short-lived single-use tickets bound to the current host", async () => {
    const lease = await store.acquire(alice, 30, 1);
    await expect(store.issueConnection(alice)).rejects.toThrow(/not ready/);
    await store.heartbeat(alice, lease.epoch, 30, undefined, serverKey);
    await expect(store.issueConnection({ harness: alice.harness, owner: "bob" })).rejects.toThrow(/not ready/);
    const ticket = await store.issueConnection(alice);
    expect(await store.consumeConnection({ harness: alice.harness, owner: "bob" }, lease.epoch, ticket.token)).toBe(false);
    expect(await store.consumeConnection(alice, lease.epoch, ticket.token)).toBe(true);
    expect(await store.consumeConnection(alice, lease.epoch, ticket.token)).toBe(false);
    const stale = await store.issueConnection(alice);
    await store.release(alice, lease.epoch);
    const next = await store.acquire(alice, 30, 1);
    expect(await store.consumeConnection(alice, next.epoch, stale.token)).toBe(false);
  });

  it("records native hosting without granting direct connection tickets", async () => {
    const lease = await store.acquire(alice, 30, 1, "github-native");
    await store.heartbeat(alice, lease.epoch, 30, "native-environment");
    expect(await store.status(alice)).toMatchObject({
      online: true, execution: "github-native", environmentId: "native-environment",
    });
    await expect(store.issueConnection(alice)).rejects.toThrow(/not ready/);
    expect(await store.list(alice)).toEqual([]);
  });
});

describe("legacy singleton adoption", () => {
  async function legacyHost(ownerUserId = 1) {
    const legacy = { computeId: randomUUID(), epoch: randomUUID() };
    await pool.query(
      `INSERT INTO demo_host (id, compute_id, owner, epoch, lease_until, environment_id, server_key, owner_user_id, execution)
       VALUES (1, $1, 'Alice', $2, now() + interval '30 seconds', 'legacy-environment', $3, $4, 'managed')`,
      [legacy.computeId, legacy.epoch, JSON.stringify(serverKey), ownerUserId],
    );
    return legacy;
  }

  it("makes the singleton row the configured harness's host, with its identity, lease, and sessions", async () => {
    const legacy = await legacyHost();
    const id = randomUUID();
    const other = randomUUID();
    await pool.query("INSERT INTO hosted_sessions (id, owner, harness, model, token_budget) VALUES ($1, 'alice', $2, 'grok-4.6', 1000), ($3, 'mallory', $2, 'grok-4.6', 1000)",
      [id, JSON.stringify(harness), other]);
    expect(await store.adoptLegacyHost("interactive-demo")).toBe(true);
    expect(await store.adoptLegacyHost("interactive-demo")).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS count FROM demo_host")).rows[0].count).toBe(0);
    expect(await store.status(alice)).toEqual({ online: true, execution: "managed", environmentId: "legacy-environment", serverKey });
    // The adopted epoch keeps a running legacy host's lease valid without a restart.
    await store.heartbeat(alice, legacy.epoch, 30);
    expect((await store.list(alice)).map((session) => session.id)).toEqual([id]);
    expect((await pool.query("SELECT host_harness FROM hosted_sessions WHERE id = $1", [other])).rows[0].host_harness).toBeNull();
    await store.release(alice, legacy.epoch);
    expect((await store.acquire(alice, 30, 1)).computeId).toBe(legacy.computeId);
  });

  it("leaves the singleton row for review when the harness already has a host", async () => {
    await store.acquire(alice, 30, 2);
    await legacyHost();
    expect(await store.adoptLegacyHost("interactive-demo")).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS count FROM demo_host")).rows[0].count).toBe(1);
  });

  it("never lets anyone acquire an adopted prototype host without a pinned account", async () => {
    await legacyHost(0);
    expect(await store.adoptLegacyHost("interactive-demo")).toBe(true);
    await pool.query("UPDATE owner_hosts SET lease_until = now() - interval '1 second'");
    await expect(store.acquire(alice, 30, 1)).rejects.toThrow(/configured owner/);
  });
});
