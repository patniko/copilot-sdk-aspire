import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { ExecutionPolicy, ExecutionProfile, HarnessSnapshot, PolicySet } from "@copilot-agent/contracts";
import { HostStore, JobEventListener, JobStore, migrate } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, loadHarnesses, loadPolicy, loadProfiles, verifyInferenceCapability } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import type { ApiOwnerHost } from "../../src/agent-api/src/host-routes.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";

const root = join(import.meta.dirname, "..", "..");
const devKey = "dev-key-".repeat(4);
const otherKey = "other-key-".repeat(4);
const hostKeys = { review: "review-host-key-".repeat(3), legacy: "legacy-host-key-".repeat(3) };
const signingKey = "owner-host-signing-key-".repeat(3);
const serverKey = { keyId: "test-key", algorithm: "x25519-sealedbox" as const, publicKey: "test-public-key" };

let pool: pg.Pool;
let store: HostStore;
let listener: JobEventListener;
let harnesses: Map<string, HarnessSnapshot[]>;
let profiles: Map<string, ExecutionProfile>;
let policy: ExecutionPolicy;

const clone = (snapshot: HarnessSnapshot, name: string): HarnessSnapshot =>
  ({ definition: { ...snapshot.definition, name }, digest: `sha256:${name.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a")}` });

const reviewHost: ApiOwnerHost = {
  harness: "review-agent", owner: "alice", principal: "dev", transport: "both", execution: "managed",
  resource: "host-review-agent", size: { name: "medium", cpus: 1, memoryMiB: 2048 }, legacy: false, url: "http://localhost:4123",
};
const legacyHost: ApiOwnerHost = {
  harness: "interactive-demo", owner: "alice", principal: "dev", transport: "both", execution: "managed", resource: "agent-host", legacy: true,
};

function api(policies: PolicySet = { base: policy, overrides: new Map() }) {
  return buildApi({
    store: new JobStore(pool), listener, admission: new Admission({ harnesses, profiles, policies }),
    authenticator: new ApiKeyAuthenticator(`dev:${devKey};other:${otherKey}`), harnesses, maxOpenJobsPerPrincipal: 10, console: false,
    hosts: { store, hosts: [reviewHost, legacyHost], harnesses, policies, profiles },
  });
}
const as = (key: string) => ({ authorization: `Bearer ${key}` });

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  store = new HostStore(pool);
  listener = new JobEventListener(pool);
  await listener.start();
  const customerConfigRoot = join(root, "examples", "customer-config");
  [harnesses, profiles, policy] = await Promise.all([loadHarnesses(customerConfigRoot), loadProfiles(root), loadPolicy(customerConfigRoot)]);
  const demo = harnesses.get("interactive-demo")![0]!;
  harnesses.set("review-agent", [clone(demo, "review-agent")]);
  harnesses.set("lone-agent", [clone(demo, "lone-agent")]);
});
beforeEach(async () => { await pool.query("TRUNCATE demo_host, owner_hosts, hosted_sessions, hosted_connection_tickets CASCADE"); });
afterAll(async () => {
  await listener?.stop();
  await pool?.end();
});

describe("owner host API", () => {
  it("lists hosts with cost inputs and shows connection metadata only to the owner", async () => {
    const app = api();
    const lease = await store.acquire(reviewHost, 30, 1);
    await store.heartbeat(reviewHost, lease.epoch, 30, "review-environment", serverKey);
    const owner = (await app.inject({ method: "GET", url: "/v1/hosts", headers: as(devKey) })).json();
    expect(owner.hosts).toEqual([
      { harness: "review-agent", transport: "both", execution: "managed", owned: true, online: true, resource: "host-review-agent",
        size: { name: "medium", cpus: 1, memoryMiB: 2048 }, environmentId: "review-environment", serverKey },
      { harness: "interactive-demo", transport: "both", execution: "managed", owned: true, online: false, resource: "agent-host" },
    ]);
    const other = (await app.inject({ method: "GET", url: "/v1/hosts/review-agent", headers: as(otherKey) })).json();
    expect(other).toEqual({ harness: "review-agent", transport: "both", execution: "managed", owned: false, online: true,
      resource: "host-review-agent", size: { name: "medium", cpus: 1, memoryMiB: 2048 } });
    expect((await app.inject({ method: "GET", url: "/v1/hosts" })).statusCode).toBe(401);
    await app.close();
  });

  it("returns relay_owner_only to other principals and names session containers for direct", async () => {
    const app = api();
    const lease = await store.acquire(reviewHost, 30, 1);
    await store.heartbeat(reviewHost, lease.epoch, 30, "review-environment", serverKey);
    const relay = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(otherKey), payload: { transport: "github" } });
    expect(relay.statusCode).toBe(403);
    expect(relay.json().error.code).toBe("relay_owner_only");
    const direct = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(otherKey), payload: { transport: "direct" } });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error).toMatchObject({ code: "hosting_unavailable", details: { prerequisite: { kind: "host", name: "session-containers" } } });
    expect((await app.inject({ method: "GET", url: "/v1/hosts/review-agent/sessions", headers: as(otherKey) })).statusCode).toBe(404);
    await app.close();
  });

  it("provisions direct and relay material for the owner of an online host", async () => {
    const app = api();
    const offline = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: {} });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error).toMatchObject({ code: "hosting_unavailable", message: expect.stringMatching(/offline/) });
    const lease = await store.acquire(reviewHost, 30, 1);
    const unpublished = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "github" } });
    expect(unpublished.json().error).toMatchObject({ code: "hosting_unavailable", message: expect.stringMatching(/GitHub environment/) });
    await store.heartbeat(reviewHost, lease.epoch, 30, "review-environment", serverKey);
    const direct = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: {} });
    expect(direct.statusCode).toBe(200);
    expect(direct.headers["cache-control"]).toBe("no-store");
    const material = direct.json();
    expect(material).toMatchObject({ harness: "review-agent", transport: "direct", execution: "managed", url: "ws://localhost:4123/", serverKey });
    expect(await store.consumeConnection(reviewHost, lease.epoch, material.token)).toBe(true);
    expect(await store.consumeConnection(legacyHost, lease.epoch, material.token)).toBe(false);
    const relay = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "github" } });
    expect(relay.json()).toEqual({ harness: "review-agent", transport: "github", execution: "managed", environmentId: "review-environment" });

    const harness = harnesses.get("review-agent")![0]!;
    const id = randomUUID();
    const runtimeId = id.replaceAll("-", "");
    const ahpSessionId = randomUUID();
    await store.session(reviewHost, lease.epoch, id, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    // Before the host attributes its catalog entry, the session exists but has no resumable client identity.
    const unattributed = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "github", sessionId: runtimeId } });
    expect(unattributed.statusCode).toBe(200);
    expect(unattributed.json().ahpSessionId).toBeUndefined();
    expect(await store.recordCatalogIdentity(reviewHost, lease.epoch, id, ahpSessionId)).toBe(true);
    // The ledger ID in either spelling, or the AHP session ID, finds it; resume always uses the AHP session ID.
    for (const sessionId of [runtimeId, id, ahpSessionId]) {
      const resume = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "github", sessionId } });
      expect(resume.json()).toMatchObject({ ahpSessionId, environmentId: "review-environment" });
    }
    const other = randomUUID();
    await store.session(reviewHost, lease.epoch, other, false, { harness, model: "grok-4.6", tokenBudget: 1000 });
    expect(await store.recordCatalogIdentity(reviewHost, lease.epoch, other, ahpSessionId)).toBe(false);
    await expect(store.recordCatalogIdentity(reviewHost, randomUUID(), other, randomUUID())).rejects.toThrow(/lease was lost/);
    const unknown = await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "github", sessionId: randomUUID() } });
    expect(unknown.statusCode).toBe(404);
    const listed = (await app.inject({ method: "GET", url: "/v1/hosts/review-agent/sessions", headers: as(devKey) })).json().sessions as Array<{ id: string; ahpSessionId?: string }>;
    expect(listed.map((s) => [s.id, s.ahpSessionId]).sort()).toEqual([[id, ahpSessionId], [other, undefined]].sort());
    expect((await app.inject({ method: "POST", url: `/v1/hosts/review-agent/sessions/${runtimeId}/close`, headers: as(devKey) })).json()).toEqual({ closed: true });
    expect((await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { sessionId: id } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "relay" } })).statusCode).toBe(400);
    await app.close();
  });

  it("distinguishes unknown harnesses, undeployed hosts, and transports the policy does not allow", async () => {
    const app = api();
    expect((await app.inject({ method: "POST", url: "/v1/hosts/no-such-agent/connection", headers: as(devKey), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/hosts/dataset-analyst/connection", headers: as(devKey), payload: {} })).statusCode).toBe(404);
    const lone = await app.inject({ method: "POST", url: "/v1/hosts/lone-agent/connection", headers: as(devKey), payload: {} });
    expect(lone.statusCode).toBe(409);
    expect(lone.json().error).toMatchObject({ code: "hosting_unavailable", details: { prerequisite: { kind: "host", name: "isolated-host" } } });
    await app.close();
    const narrowed = api({ base: policy, overrides: new Map([["review-agent", { schemaVersion: "1" as const, harness: "review-agent", overrides: { hosting: { transports: ["direct" as const] } } }]]) });
    const lease = await store.acquire(reviewHost, 30, 1);
    await store.heartbeat(reviewHost, lease.epoch, 30, "review-environment", serverKey);
    const relay = await narrowed.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "github" } });
    expect(relay.statusCode).toBe(422);
    expect(relay.json().error.code).toBe("transport_not_allowed");
    expect((await narrowed.inject({ method: "POST", url: "/v1/hosts/review-agent/connection", headers: as(devKey), payload: { transport: "direct" } })).statusCode).toBe(200);
    await narrowed.close();
  });

  it("keeps the legacy single-host routes for the demo principal", async () => {
    const app = api();
    expect((await app.inject({ method: "GET", url: "/v1/host", headers: as(otherKey) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/host", headers: as(devKey) })).json()).toEqual({ transport: "both", harness: "interactive-demo", online: false });
    const lease = await store.acquire(legacyHost, 30, 1);
    await store.heartbeat(legacyHost, lease.epoch, 30, "legacy-environment", serverKey);
    const connection = (await app.inject({ method: "POST", url: "/v1/host/connection", headers: as(devKey) })).json();
    expect(connection).toMatchObject({ transport: "both", harness: "interactive-demo", online: true, environmentId: "legacy-environment", serverKey });
    expect(await store.consumeConnection(legacyHost, lease.epoch, connection.token)).toBe(true);
    await app.close();
  });
});

describe("owner host control in the dispatcher", () => {
  const dispatcher = (policies?: Partial<Record<"review", ExecutionPolicy>>) => buildDispatcher({
    store: new JobStore(pool), hostStore: store, policies: { base: policy, overrides: new Map() },
    executorKey: "unused-executor-key".repeat(3), gatewayKey: "unused-gateway-key".repeat(3), signingKey,
    host: {
      store, profiles, signingKey,
      hosts: [
        { harness: "review-agent", owner: "alice", key: hostKeys.review, transport: "both", execution: "managed",
          snapshot: harnesses.get("review-agent")![0], policy: policies?.review ?? policy },
        { harness: "interactive-demo", owner: "alice", key: hostKeys.legacy, transport: "github", execution: "github-native", policy },
      ],
    },
  });
  const post = (app: ReturnType<typeof dispatcher>, key: string, operation: string, payload: object) =>
    app.inject({ method: "POST", url: `/internal/host/${operation}`, headers: { "x-internal-key": key }, payload });

  it("identifies each host by its own service key", async () => {
    const app = dispatcher();
    const lease = (await post(app, hostKeys.review, "acquire", { ownerUserId: 1, harness: "review-agent" })).json();
    expect(await store.status(reviewHost)).toMatchObject({ online: true, execution: "managed" });
    expect((await post(app, hostKeys.legacy, "acquire", { ownerUserId: 1, harness: "review-agent" })).json().error.code).toBe("host_mismatch");
    expect((await post(app, "not-a-host-key".repeat(4), "acquire", { ownerUserId: 1 })).statusCode).toBe(401);
    // Another host's key cannot act on this host's epoch.
    expect((await post(app, hostKeys.legacy, "heartbeat", { epoch: lease.epoch })).statusCode).toBe(409);
    const id = randomUUID();
    expect((await post(app, hostKeys.review, "session", { epoch: lease.epoch, sessionId: id, resume: false })).statusCode).toBe(200);
    const { token } = (await post(app, hostKeys.review, "token", { epoch: lease.epoch, sessionId: id })).json();
    const claims = await verifyInferenceCapability(signingKey, token);
    expect(claims).toMatchObject({ kind: "hosted-session", session: id });
    expect((await post(app, hostKeys.legacy, "token", { epoch: lease.epoch, sessionId: id })).json().error.code).toBe("native_host");
    expect((await post(app, hostKeys.legacy, "acquire", { ownerUserId: 1, harness: "interactive-demo" })).statusCode).toBe(200);
    await app.close();
  });

  it("refuses to start a host on a transport its harness policy does not allow", async () => {
    const app = dispatcher({ review: { ...policy, hosting: { transports: ["direct"] } } });
    const refused = await post(app, hostKeys.review, "acquire", { ownerUserId: 1, harness: "review-agent" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("transport_not_allowed");
    expect(await store.status(reviewHost)).toEqual({ online: false });
    await app.close();
  });
});

describe("migration 010", () => {
  it("keeps the singleton row for adoption, unbinds open tickets, and preserves sessions", async () => {
    const admin = new pg.Client({ connectionString: inject("databaseUrl") });
    await admin.connect();
    const database = `owner_hosts_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(inject("databaseUrl"));
    url.pathname = `/${database}`;
    const legacy = new pg.Pool({ connectionString: url.href });
    try {
      const directory = join(root, "src", "job-store", "migrations");
      await legacy.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql") && name < "010").sort()) {
        await legacy.query(await readFile(join(directory, file), "utf8"));
        await legacy.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      }
      const computeId = randomUUID();
      const epoch = randomUUID();
      const sessionId = randomUUID();
      await legacy.query(
        `INSERT INTO demo_host (id, compute_id, owner, epoch, lease_until, environment_id, owner_user_id, execution)
         VALUES (1, $1, 'alice', $2, now() - interval '1 second', 'legacy-environment', 7, 'managed')`, [computeId, epoch]);
      await legacy.query("INSERT INTO hosted_sessions (id, owner, harness, model, token_budget) VALUES ($1, 'alice', $2, 'grok-4.6', 1000)",
        [sessionId, JSON.stringify(harnesses.get("interactive-demo")![0])]);
      await legacy.query("INSERT INTO hosted_connection_tickets (digest, owner, epoch, expires_at) VALUES ('digest', 'alice', $1, now() + interval '1 minute')", [epoch]);

      expect(await migrate(legacy)).toContain("010_owner_hosts.sql");
      expect((await legacy.query("SELECT count(*)::int AS count FROM hosted_connection_tickets")).rows[0].count).toBe(0);
      expect((await legacy.query("SELECT host_harness FROM hosted_sessions")).rows).toEqual([{ host_harness: null }]);
      const migrated = new HostStore(legacy);
      expect(await migrated.adoptLegacyHost("interactive-demo")).toBe(true);
      const host = { harness: "interactive-demo", owner: "alice" };
      expect(await migrated.status(host)).toEqual({ online: false, execution: "managed", environmentId: "legacy-environment" });
      expect((await migrated.list(host)).map((session) => session.id)).toEqual([sessionId]);
      await expect(migrated.acquire(host, 30, 8)).rejects.toThrow(/configured owner/);
      expect((await migrated.acquire(host, 30, 7)).computeId).toBe(computeId);
    } finally {
      await legacy.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });
});
