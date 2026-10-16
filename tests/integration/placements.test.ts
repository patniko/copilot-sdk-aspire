import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { BrokerTicketResult, PlacementLookupResult, SharedSessionDefinition, SharedSessionLimits } from "@copilot-agent/contracts";
import { JobStore, migrate, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { loadPolicy } from "@copilot-agent/service-defaults";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let dispatcher: FastifyInstance;
const brokerKey = "synthetic-broker-key-".repeat(3);
const ids: string[] = [];
const definition = SharedSessionDefinition.parse({
  model: "synthetic", instructions: "Synthetic coordinator.", allowedHarnesses: [], limits: SharedSessionLimits.parse({}),
});
const serverKey = { keyId: "synthetic", algorithm: "x25519-sealedbox" as const, publicKey: "synthetic-public-key" };

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  const policy = await loadPolicy(join(import.meta.dirname, "..", "..", "examples", "customer-config"));
  dispatcher = buildDispatcher({
    store: new JobStore(pool), policies: { base: policy, overrides: new Map() },
    executorKey: "unused-executor-key-".repeat(3), gatewayKey: "unused-gateway-key-".repeat(3), signingKey: "unused-signing-key-".repeat(4),
    broker: { store: new PlacementStore(pool), key: brokerKey },
  });
});
afterEach(async () => {
  await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [ids]);
  ids.length = 0;
});
afterAll(async () => {
  await dispatcher?.close();
  await pool?.end();
});

async function activeSession() {
  const principal = randomUUID();
  const session = await shared.create(principal, 1, "placement", definition, 100);
  ids.push(session.id);
  const lease = await files.acquire(session.id, principal, "placement-worker");
  await shared.publish(lease, serverKey);
  return { principal, id: session.id, lease };
}
const connect = async (sessionId: string, ticket: string, key = brokerKey) => {
  const response = await dispatcher.inject({
    method: "POST", url: "/internal/broker/connection", headers: { "x-internal-key": key }, payload: { sessionId, ticket },
  });
  return { status: response.statusCode, cache: response.headers["cache-control"], body: response.statusCode === 200 ? BrokerTicketResult.parse(response.json()) : undefined };
};
const lookup = async (sessionIds: string[], key = brokerKey) => {
  const response = await dispatcher.inject({
    method: "POST", url: "/internal/broker/placements", headers: { "x-internal-key": key }, payload: { sessionIds },
  });
  return { status: response.statusCode, body: response.statusCode === 200 ? PlacementLookupResult.parse(response.json()) : undefined };
};
const movePlacement = (id: string) => pool.query("UPDATE shared_sessions SET placement_generation=placement_generation+1 WHERE id=$1", [id]);

describe("brokered connection placement", () => {
  it("consumes a one-use, 60-second ticket only through the broker key and returns the activation's route", async () => {
    const { principal, id, lease } = await activeSession();
    const other = await activeSession();
    const ticket = await shared.issueTicket(principal, id);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeGreaterThan(50_000);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
    expect((await connect(id, ticket.token, "wrong-broker-key-".repeat(3))).status).toBe(401);
    expect((await dispatcher.inject({ method: "POST", url: "/internal/broker/connection", payload: { sessionId: id, ticket: ticket.token } })).statusCode).toBe(401);
    expect((await connect(id, "too-short")).status).toBe(400);
    expect((await connect(other.id, ticket.token)).body).toEqual({ authorized: false });
    const attempts = await Promise.all(Array.from({ length: 4 }, () => connect(id.toUpperCase(), ticket.token)));
    expect(attempts.every((attempt) => attempt.status === 200 && attempt.cache === "no-store")).toBe(true);
    expect(attempts.map((attempt) => attempt.body).filter((body) => body?.authorized)).toEqual([
      { authorized: true, route: { kind: "shared", sessionId: id, generation: 1, epoch: lease.epoch } },
    ]);
  });

  it("refuses expired, replaced-activation, closed-session, and older-generation tickets", async () => {
    const { principal, id, lease } = await activeSession();
    const expired = await shared.issueTicket(principal, id);
    await pool.query("UPDATE shared_connection_tickets SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [id]);
    expect((await connect(id, expired.token)).body).toEqual({ authorized: false });

    const beforeMove = await shared.issueTicket(principal, id);
    await movePlacement(id);
    expect((await connect(id, beforeMove.token)).body).toEqual({ authorized: false });
    const afterMove = await shared.issueTicket(principal, id);
    expect((await connect(id, afterMove.token)).body).toEqual({
      authorized: true, route: { kind: "shared", sessionId: id, generation: 2, epoch: lease.epoch },
    });

    const stale = await shared.issueTicket(principal, id);
    await files.release(lease);
    const replacement = await files.acquire(id, principal, "replacement-worker");
    expect((await connect(id, stale.token)).body).toEqual({ authorized: false });
    await shared.publish(replacement, serverKey);
    const current = await shared.issueTicket(principal, id);
    const closing = await shared.issueTicket(principal, id);
    expect((await connect(id, current.token)).body).toMatchObject({ authorized: true, route: { epoch: replacement.epoch, generation: 2 } });
    await shared.close(principal, id, false);
    expect((await connect(id, closing.token)).body).toEqual({ authorized: false });
  });

  it("reports the current placement of live routes and omits unknown sessions", async () => {
    const first = await activeSession();
    const second = await activeSession();
    expect((await lookup([first.id])).status).toBe(200);
    expect((await lookup([first.id], "wrong-broker-key-".repeat(3))).status).toBe(401);
    expect((await lookup([])).status).toBe(400);
    await movePlacement(second.id);
    const result = await lookup([first.id, second.id.toUpperCase(), second.id, randomUUID()]);
    expect(result.body?.placements.sort((a, b) => a.generation - b.generation)).toEqual([
      { sessionId: first.id, kind: "shared", generation: 1 },
      { sessionId: second.id, kind: "shared", generation: 2 },
    ]);
  });
});
