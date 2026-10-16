import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BROKER_MOVED_CLOSE, SharedConnection, SharedSessionDefinition, SharedSessionLimits, SharedSessionView, type SharedSessionCreation } from "@copilot-agent/contracts";
import {
  JobEventListener, JobStore, migrate, PlacementStore, SessionFileStore, SharedStore, StoreError, type SessionFileLease,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, loadHarnesses, loadPolicySet, loadProfiles } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import type { SharedSessionService } from "../../src/session-host/src/service.js";
import { buildBroker } from "../../src/connection-broker/src/broker.js";
import { DispatcherDirectory, sessionRoutes, sharedUpstream } from "../../src/connection-broker/src/sessions.js";

const principal = `broker-${randomUUID()}`;
const apiKey = "synthetic-broker-api-key-".repeat(2);
const workerKey = "synthetic-shared-worker-key-".repeat(2);
const brokerKey = "synthetic-connection-broker-key-".repeat(2);
const nativeToken = "synthetic-native-listener-token-".repeat(2);
const serverKey = { keyId: "synthetic", algorithm: "x25519-sealedbox" as const, publicKey: "synthetic-public-key" };
const definition = SharedSessionDefinition.parse({
  model: "synthetic", instructions: "Synthetic broker qualification.", allowedHarnesses: [], limits: SharedSessionLimits.parse({}),
});
const url = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/**
 * Stands in for the native runtime owner: real ledger tickets and leases, with an echoing private listener in place of
 * the in-process AHP host. The shared worker's server, ingress, and control routes are the real ones.
 */
class LedgerBackedOwner {
  readonly healthy = true;
  readonly leases = new Map<string, SessionFileLease>();
  constructor(private readonly store: SharedStore, private readonly files: SessionFileStore, private readonly nativePort: () => number) {}
  async create(owner: string, request: SharedSessionCreation) { return (await this.store.create(owner, 1, request.label, definition, 100)).view; }
  async list(owner: string) { return this.store.list(owner); }
  async get(owner: string, id: string) {
    const row = await this.store.get(owner, id);
    if (!row) throw new StoreError("not_found", "The shared conversation was not found.");
    return row;
  }
  async connection(owner: string, id: string) {
    if (!this.leases.has(id)) {
      const lease = await this.files.acquire(id, owner, "broker-test-worker", 300);
      await this.store.publish(lease, serverKey);
      this.leases.set(id, lease);
    }
    return { sessionId: id, ahpSessionId: id, ...(await this.store.issueTicket(owner, id)) };
  }
  async resolveForwarded(path: string, epoch: string | undefined) {
    const lease = this.leases.get(/^\/sessions\/([0-9a-f-]{36})$/.exec(path)?.[1] ?? "");
    return lease && lease.epoch === epoch ? { token: nativeToken, targetPort: this.nativePort() } : undefined;
  }
  async close(owner: string, id: string, cancelChildren: boolean) { await this.store.close(owner, id, cancelChildren); }
  async stop() {}
}

let pool: pg.Pool;
let native: WebSocketServer;
let dispatcher: FastifyInstance;
let shared: FastifyInstance;
let broker: FastifyInstance;
let api: FastifyInstance | undefined;
let buildCallerApi: () => FastifyInstance;
const sessions: string[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  native = new WebSocketServer({
    host: "127.0.0.1", port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) => req.url === `/?tkn=${encodeURIComponent(nativeToken)}`,
  });
  native.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
  await once(native, "listening");
  const repo = join(import.meta.dirname, "..", "..");
  const [harnesses, profiles, policies] = await Promise.all([
    loadHarnesses(join(repo, "examples", "customer-config")), loadProfiles(repo), loadPolicySet(join(repo, "examples", "customer-config")),
  ]);
  const jobs = new JobStore(pool);
  dispatcher = buildDispatcher({
    store: jobs, policies, executorKey: "unused-executor-key-".repeat(3), gatewayKey: "unused-gateway-key-".repeat(3),
    signingKey: "unused-signing-key-".repeat(4), broker: { store: new PlacementStore(pool), key: brokerKey },
  });
  await dispatcher.listen({ port: 0, host: "127.0.0.1" });
  const owner = new LedgerBackedOwner(new SharedStore(pool), new SessionFileStore(pool), () => (native.address() as AddressInfo).port);
  shared = buildSharedHost(owner as unknown as SharedSessionService, workerKey, brokerKey);
  await shared.listen({ port: 0, host: "127.0.0.1" });
  ({ app: broker } = buildBroker({
    families: [sessionRoutes(new DispatcherDirectory(url(dispatcher), brokerKey))],
    upstreams: { shared: sharedUpstream(new URL(url(shared)), brokerKey) },
    checkMilliseconds: 100,
  }));
  await broker.listen({ port: 0, host: "127.0.0.1" });
  const listener = new JobEventListener(pool);
  buildCallerApi = () => buildApi({
    store: jobs, listener, harnesses, admission: new Admission({ harnesses, profiles, policies }), maxOpenJobsPerPrincipal: 10,
    console: false, authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`),
    shared: { url: url(shared), key: workerKey, brokerUrl: url(broker) },
  });
});

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await api?.close();
  await broker?.close();
  await shared?.close();
  await dispatcher?.close();
  await new Promise((resolve) => native?.close(resolve));
  await pool?.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
  await pool?.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
  await pool?.end();
});

async function startApi(port = 0): Promise<string> {
  api = buildCallerApi();
  await api.listen({ port, host: "127.0.0.1" });
  return url(api);
}

async function call<T>(base: string, path: string, parse: { parse(value: unknown): T }, body: object = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`API request failed (${response.status}).`);
  return parse.parse(await response.json());
}

interface Client { socket: WebSocket; next(): Promise<string>; closed: Promise<{ code: number; reason: string }> }
function attach(target: string, ticket?: string): Promise<Client | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ticket ? `${target}?tkn=${encodeURIComponent(ticket)}` : target);
    const messages: string[] = [];
    const waiting: Array<(message: string) => void> = [];
    let closed: (value: { code: number; reason: string }) => void = () => undefined;
    const close = new Promise<{ code: number; reason: string }>((done) => { closed = done; });
    socket.on("message", (data: Buffer) => {
      const waiter = waiting.shift();
      if (waiter) waiter(data.toString());
      else messages.push(data.toString());
    });
    socket.on("close", (code, reason) => closed({ code, reason: reason.toString() }));
    socket.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.on("error", reject);
    socket.on("open", () => {
      sockets.push(socket);
      resolve({
        socket, closed: close,
        next: () => messages.length ? Promise.resolve(messages.shift()!) : new Promise((done) => waiting.push(done)),
      });
    });
  });
}
async function attached(target: string, ticket: string): Promise<Client> {
  const client = await attach(target, ticket);
  if (typeof client === "number") throw new Error(`The broker refused the connection (${client}).`);
  return client;
}
async function echo(client: Client, text: string): Promise<void> {
  client.socket.send(text);
  expect(await client.next()).toBe(text);
}

describe("connection broker deployment path", () => {
  it("keeps live connections across agent-api restarts and issues new tickets from the replacement", async () => {
    const first = await startApi();
    const session = await call(first, "/v1/sessions", SharedSessionView, { harness: "broker-fixture", label: "broker" });
    sessions.push(session.id);
    const connection = await call(first, `/v1/sessions/${session.id}/connection`, SharedConnection);
    expect(connection.url).toBe(`${url(broker).replace("http:", "ws:")}/sessions/${session.id}`);
    expect(connection).toMatchObject({ destination: "shared", transport: "direct", ahpSessionId: session.id });
    expect(Date.parse(connection.expiresAt) - Date.now()).toBeGreaterThan(50_000);
    expect(Date.parse(connection.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
    const client = await attached(connection.url, connection.token);
    await echo(client, "before restart");

    const port = (api!.server.address() as AddressInfo).port;
    await api!.close();
    api = undefined;
    await expect(fetch(`${first}/health`)).rejects.toThrow();
    await echo(client, "while the API is down");
    const replacement = await startApi(port);
    await echo(client, "after restart");
    const second = await call(replacement, `/v1/sessions/${session.id}/connection`, SharedConnection);
    const another = await attached(second.url, second.token);
    await echo(another, "second client");
    await echo(client, "first client still attached");
    expect(await attach(connection.url, connection.token)).toBe(401);
  });

  it("accepts placement ingress only from the broker and closes with moved on a placement change", async () => {
    const base = api ? url(api) : await startApi();
    const session = await call(base, "/v1/sessions", SharedSessionView, { harness: "broker-fixture", label: "moved" });
    sessions.push(session.id);
    const direct = await call(base, `/v1/sessions/${session.id}/connection`, SharedConnection);
    expect(await attach(`${url(shared).replace("http:", "ws:")}/sessions/${session.id}`, direct.token)).toBe(401);
    const client = await attached(direct.url, direct.token);
    await echo(client, "placed");
    const stale = await call(base, `/v1/sessions/${session.id}/connection`, SharedConnection);
    await pool.query("UPDATE shared_sessions SET placement_generation=placement_generation+1 WHERE id=$1", [session.id]);
    expect(await client.closed).toEqual({ code: BROKER_MOVED_CLOSE.code, reason: BROKER_MOVED_CLOSE.reason });
    expect(await attach(stale.url, stale.token)).toBe(401);
    const moved = await call(base, `/v1/sessions/${session.id}/connection`, SharedConnection);
    await echo(await attached(moved.url, moved.token), "reconnected after the move");
  });

  it("refuses expired tickets and tickets for closed sessions", async () => {
    const base = api ? url(api) : await startApi();
    const session = await call(base, "/v1/sessions", SharedSessionView, { harness: "broker-fixture" });
    sessions.push(session.id);
    const expired = await call(base, `/v1/sessions/${session.id}/connection`, SharedConnection);
    await pool.query("UPDATE shared_connection_tickets SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [session.id]);
    expect(await attach(expired.url, expired.token)).toBe(401);
    const outstanding = await call(base, `/v1/sessions/${session.id}/connection`, SharedConnection);
    await call(base, `/v1/sessions/${session.id}/close`, { parse: (value: unknown) => value }, {});
    expect(await attach(outstanding.url, outstanding.token)).toBe(401);
    const refused = await fetch(`${base}/v1/sessions/${session.id}/connection`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
    expect(refused.status).toBe(404);
  });
});
