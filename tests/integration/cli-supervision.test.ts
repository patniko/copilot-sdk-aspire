import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { WebSocketServer } from "ws";
import { SharedConnection, SharedSessionDefinition, SharedSessionLimits, SharedSessionView, type SharedSessionCreation } from "@copilot-agent/contracts";
import { JobEventListener, JobStore, migrate, PlacementStore, SessionFileStore, SharedStore, StoreError, type SessionFileLease } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, loadHarnesses, loadPolicySet, loadProfiles } from "@copilot-agent/service-defaults";
import { superviseSessionCli } from "../../src/agent-client/src/cli-supervisor.js";
import { buildApi } from "../../src/agent-api/src/server.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import type { SharedSessionService } from "../../src/session-host/src/service.js";
import { buildBroker } from "../../src/connection-broker/src/broker.js";
import { DispatcherDirectory, sessionRoutes, sharedUpstream } from "../../src/connection-broker/src/sessions.js";

const principal = `supervision-${randomUUID()}`;
const apiKey = "synthetic-supervision-api-key-".repeat(2);
const workerKey = "synthetic-supervision-worker-key-".repeat(2);
const brokerKey = "synthetic-supervision-broker-key-".repeat(2);
const nativeToken = "synthetic-supervision-native-token-".repeat(2);
const fakeCli = join(import.meta.dirname, "..", "fakes", "fake-ahp-cli.mjs");
const url = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/** The real shared worker routes and ledger tickets, with an echoing listener in place of the in-process AHP host. */
class LedgerBackedOwner {
  readonly healthy = true;
  readonly leases = new Map<string, SessionFileLease>();
  keys = 0;
  constructor(private readonly store: SharedStore, private readonly files: SessionFileStore, private readonly nativePort: () => number) {}
  async create(owner: string, request: SharedSessionCreation) {
    const definition = SharedSessionDefinition.parse({ model: "synthetic", instructions: "Synthetic supervision.", allowedHarnesses: [], limits: SharedSessionLimits.parse({}) });
    return (await this.store.create(owner, 1, request.label, definition, 100)).view;
  }
  async list(owner: string) { return this.store.list(owner); }
  async get(owner: string, id: string) {
    const row = await this.store.get(owner, id);
    if (!row) throw new StoreError("not_found", "The shared conversation was not found.");
    return row;
  }
  async connection(owner: string, id: string) {
    const row = await this.get(owner, id);
    // A new key per placement generation, as a replacement host would publish.
    const lease = this.leases.get(id) ?? await this.files.acquire(id, owner, "supervision-worker", 300);
    this.leases.set(id, lease);
    await this.store.publish(lease, { keyId: `generation-${row.view.segment.generation}`, algorithm: "x25519-sealedbox", publicKey: `public-${row.view.segment.generation}` });
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
let api: FastifyInstance;
const sessions: string[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  native = new WebSocketServer({
    host: "127.0.0.1", port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) => req.url === `/?tkn=${encodeURIComponent(nativeToken)}`,
  });
  native.on("connection", (socket) => socket.on("message", (data) => {
    const text = data.toString();
    // The echo listener ends a supervised CLI when asked, as a person quitting it would.
    socket.send(text.startsWith("hello") ? `welcome ${text}` : text);
  }));
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
    upstreams: { shared: sharedUpstream(new URL(url(shared)), brokerKey), container: () => { throw new Error("No containers in this test."); } },
    checkMilliseconds: 200,
  }));
  await broker.listen({ port: 0, host: "127.0.0.1" });
  api = buildApi({
    store: jobs, listener: new JobEventListener(pool), harnesses, admission: new Admission({ harnesses, profiles, policies }), maxOpenJobsPerPrincipal: 10,
    console: false, authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`),
    shared: { url: url(shared), key: workerKey, brokerUrl: url(broker) },
  });
  await api.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await api?.close();
  await broker?.close();
  await shared?.close();
  await dispatcher?.close();
  await new Promise((resolve) => native?.close(resolve));
  await pool?.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
  await pool?.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
  await pool?.end();
});

async function post(path: string, body: object = {}): Promise<unknown> {
  const response = await fetch(`${url(api)}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`API request failed (${response.status}).`);
  return response.json();
}

it("reconnects a supervised CLI through the real broker after a placement change, in the same supervision", async () => {
  const session = SharedSessionView.parse(await post("/v1/sessions", { harness: "broker-fixture", label: "supervision" }));
  sessions.push(session.id);
  const provision = async () => SharedConnection.parse(await post(`/v1/sessions/${session.id}/connection`));
  const directory = await mkdtemp(join(tmpdir(), "cli-supervision-"));
  const logPath = join(directory, "cli.jsonl");
  const log = async () => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const waitFor = async (predicate: (entries: Array<Record<string, unknown>>) => boolean, label: string) => {
    const deadline = Date.now() + 30_000;
    while (!predicate(await log())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await log())}`);
      await delay(100);
    }
  };
  const notices: string[] = [];
  try {
    const connection = await provision();
    const exit = superviseSessionCli({
      command: process.execPath, args: [fakeCli, "--experimental"], env: { ...process.env, FAKE_CLI_LOG: logPath },
      connection, provision, notify: (message) => notices.push(message), retryMs: 100,
    });
    await waitFor((entries) => entries.some((entry) => entry.event === "message" && String(entry.data).startsWith("welcome")), "the first CLI's echo");
    await pool.query("UPDATE shared_sessions SET placement_generation=placement_generation+1 WHERE id=$1", [session.id]);
    await waitFor((entries) => entries.filter((entry) => entry.event === "message" && String(entry.data).startsWith("welcome")).length >= 2, "the restarted CLI's echo");
    const starts = (await log()).filter((entry) => entry.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts.map((entry) => (entry.pin as { keyId: string }).keyId)).toEqual(["generation-1", "generation-2"]);
    expect(starts.every((entry) => entry.resume === session.id)).toBe(true);
    expect(starts[0]!.pid).not.toBe(starts[1]!.pid);
    expect(notices.some((line) => line.includes("moved"))).toBe(true);
    const latest = SharedSessionView.parse(await (await fetch(`${url(api)}/v1/sessions/${session.id}`, { headers: { authorization: `Bearer ${apiKey}` } })).json());
    expect(latest.segment.generation).toBe(2);
    const second = starts[1]!.pid as number;
    process.kill(second);
    expect(await exit).not.toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);
