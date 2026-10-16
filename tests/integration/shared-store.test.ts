import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import { migrate, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";

let pool: pg.Pool;
let store: SharedStore;
let files: SessionFileStore;
const ids: string[] = [];
const definition = SharedSessionDefinition.parse({
  model: "synthetic", instructions: "Synthetic coordinator.", allowedHarnesses: [],
  limits: SharedSessionLimits.parse({ tokenBudget: 1000, turnTokenBudget: 400, maxContinuations: 1 }),
});
const limits = SharedWorkerLimits.parse({ activeTurns: 2, activeTurnsPerPrincipal: 1, queuedTurns: 4 });
const serverKey = { keyId: "synthetic", algorithm: "x25519-sealedbox" as const, publicKey: "synthetic-public-key" };
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  store = new SharedStore(pool);
  files = new SessionFileStore(pool);
});
afterEach(async () => {
  await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [ids]);
  ids.length = 0;
});
afterAll(async () => { await pool.end(); });
async function create(principal = randomUUID()) {
  const session = await store.create(principal, 1, "fixture", definition, 100);
  ids.push(session.id);
  const lease = await files.acquire(session.id, principal, "fixture-worker");
  return { session, lease, principal };
}

describe("durable shared session admission", () => {
  it("binds retained configuration and visibility to the principal and enforces creation quotas", async () => {
    const { session, principal } = await create();
    expect((await store.get(principal, session.id))?.definition).toEqual(definition);
    expect(await store.get("someone-else", session.id)).toBeUndefined();
    expect(await store.close("someone-else", session.id, false)).toBe(false);
    await expect(store.create(principal, 1, "", definition, 1)).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await store.list(principal)).toHaveLength(1);
    expect(await store.close(principal, session.id, false)).toBe(true);
  });

  it("issues activation-bound tickets that only the placement store consumes, once", async () => {
    const placements = new PlacementStore(pool);
    const { lease, principal, session } = await create();
    await expect(store.issueTicket(principal, session.id)).rejects.toMatchObject({ code: "not_found" });
    await store.publish(lease, serverKey);
    expect((await store.get(principal, session.id))?.view.online).toBe(true);
    await expect(store.issueTicket("someone-else", session.id)).rejects.toMatchObject({ code: "not_found" });
    const first = await store.issueTicket(principal, session.id);
    expect(first.serverKey).toEqual(serverKey);
    expect((await Promise.all(Array.from({ length: 4 }, () => placements.consumeTicket(session.id, first.token)))).filter(Boolean)).toHaveLength(1);
    for (let index = 0; index < 16; index++) await store.issueTicket(principal, session.id);
    await expect(store.issueTicket(principal, session.id)).rejects.toMatchObject({ code: "quota_exceeded" });
    await pool.query("DELETE FROM shared_connection_tickets WHERE session_id=$1", [session.id]);
    const stale = await store.issueTicket(principal, session.id);
    await files.release(lease);
    const replacement = await files.acquire(session.id, principal, "replacement");
    expect(await placements.consumeTicket(session.id, stale.token)).toBeUndefined();
    await expect(store.issueTicket(principal, session.id)).rejects.toMatchObject({ code: "not_found" });
    await store.publish(replacement, serverKey);
    const last = await store.issueTicket(principal, session.id);
    await store.close(principal, session.id, false);
    expect(await placements.consumeTicket(session.id, last.token)).toBeUndefined();
    await expect(store.issueTicket(principal, session.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("bounds active turns globally and per principal without blocking other principals behind a busy one", async () => {
    const alice = randomUUID();
    const one = await create(alice);
    const two = await create(alice);
    const bob = await create();
    const first = await store.enqueueTurn(one.lease, "one", "user", limits);
    const second = await store.enqueueTurn(two.lease, "two", "user", limits);
    const third = await store.enqueueTurn(bob.lease, "three", "user", limits);
    expect((await store.startTurn(one.lease, first.id, limits))?.state).toBe("running");
    expect(await store.startTurn(two.lease, second.id, limits)).toBeUndefined();
    expect((await store.startTurn(bob.lease, third.id, limits))?.state).toBe("running");
    expect(await store.startTurn(two.lease, second.id, limits)).toBeUndefined();
    await expect(store.finishTurn({ ...one.lease, principal: "wrong" }, first.id)).rejects.toMatchObject({ code: "not_found" });
    await store.finishTurn(one.lease, first.id);
    expect((await store.startTurn(two.lease, second.id, limits))?.state).toBe("running");
    await store.finishTurn(two.lease, second.id);
    await store.finishTurn(bob.lease, third.id);
  });

  it("reserves turn budgets, serializes inference, deduplicates usage, and refunds only known unused budget", async () => {
    const { lease, principal, session } = await create();
    const queued = await store.enqueueTurn(lease, "one", "user", limits);
    expect(await store.enqueueTurn(lease, "one", "user", limits)).toEqual(queued);
    await store.startTurn(lease, queued.id, limits);
    expect(await store.introspect(queued.id, undefined, ["other-model"])).toMatchObject({ active: false, reason: "revoked" });
    await expect(store.beginInference(queued.id, randomUUID(), ["other-model"])).rejects.toMatchObject({ code: "invalid_state" });
    expect((await store.get(principal, session.id))?.view.budget.reservedTokens).toBe(400);
    const request = randomUUID();
    expect(await store.beginInference(queued.id, request)).toBe(400);
    await expect(store.beginInference(queued.id, randomUUID())).rejects.toMatchObject({ code: "quota_exceeded" });
    await store.finishTurn(lease, queued.id);
    expect((await store.get(principal, session.id))?.view.budget.reservedTokens).toBe(400);
    await store.recordUsage(queued.id, request, 100, 50, true);
    await store.recordUsage(queued.id, request, 100, 50, true);
    await expect(store.recordUsage(queued.id, request, 101, 50, true)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await store.get(principal, session.id))?.view.budget).toEqual({ usedTokens: 150, reservedTokens: 0, remainingTokens: 850 });
    expect(await store.introspect(queued.id)).toMatchObject({ active: false, reason: "revoked" });
  });

  it("charges unknown requests on lease loss and never loses late consumption above the reservation", async () => {
    const { lease, principal, session } = await create();
    const queued = await store.enqueueTurn(lease, "one", "user", limits);
    await store.startTurn(lease, queued.id, limits);
    const request = randomUUID();
    await store.beginInference(queued.id, request);
    await files.release(lease);
    expect(await store.recover()).toContainEqual(lease);
    expect((await store.get(principal, session.id))?.view.budget).toEqual({ usedTokens: 400, reservedTokens: 0, remainingTokens: 600 });
    await store.recordUsage(queued.id, request, 450, 50, true);
    await store.recordUsage(queued.id, request, 450, 50, true);
    expect((await store.get(principal, session.id))?.view.budget.usedTokens).toBe(500);
    const replacement = await files.acquire(session.id, principal, "replacement");
    await expect(store.enqueueTurn(lease, "stale", "user", limits)).rejects.toMatchObject({ code: "not_found" });
    const next = await store.enqueueTurn(replacement, "next", "completion", limits);
    await store.startTurn(replacement, next.id, limits);
    await store.finishTurn(replacement, next.id);
    await expect(store.enqueueTurn(replacement, "extra", "completion", limits)).rejects.toMatchObject({ code: "quota_exceeded" });
  });
});
