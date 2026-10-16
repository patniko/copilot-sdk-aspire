import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { ExecutionPolicy, ExecutionProfile, HarnessDefinition, HarnessSnapshot } from "@copilot-agent/contracts";
import { HostStore, JobStore, migrate } from "@copilot-agent/job-store";
import { loadHarnesses, loadPolicy, loadProfiles } from "@copilot-agent/service-defaults";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";

const root = join(import.meta.dirname, "..", "..");
const examples = join(root, "examples", "customer-config");
const hostKey = "host-key-".padEnd(48, "x");
const signingKey = "signing-key-".padEnd(64, "x");

let pool: pg.Pool;
let hostStore: HostStore;
let harness: HarnessSnapshot;
let policy: ExecutionPolicy;
let profiles: Map<string, ExecutionProfile>;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  hostStore = new HostStore(pool);
  [harness, policy, profiles] = await Promise.all([
    loadHarnesses(examples).then((registry) => registry.get("interactive-demo")![0]!),
    loadPolicy(examples),
    loadProfiles(root),
  ]);
});
beforeEach(async () => { await pool.query("TRUNCATE demo_host, owner_hosts, hosted_sessions, hosted_connection_tickets CASCADE"); });
afterAll(async () => { await pool.end(); });

function dispatcher(snapshot: HarnessSnapshot, effective: ExecutionPolicy): FastifyInstance {
  return buildDispatcher({
    store: new JobStore(pool),
    hostStore,
    policies: { base: effective, overrides: new Map() },
    executorKey: "executor-key-".padEnd(40, "x"),
    gatewayKey: "gateway-key-".padEnd(40, "x"),
    signingKey,
    host: {
      store: hostStore, profiles, signingKey,
      hosts: [{ harness: snapshot.definition.name, owner: "alice", key: hostKey, transport: "direct", execution: "managed", snapshot, policy: effective }],
    },
  });
}

const post = (app: FastifyInstance, operation: string, payload: object) =>
  app.inject({ method: "POST", url: `/internal/host/${operation}`, headers: { "x-internal-key": hostKey }, payload });

const variant = (overrides: Partial<HarnessDefinition>): HarnessSnapshot => ({
  definition: { ...harness.definition, ...overrides },
  digest: "sha256:variant",
});

describe("demo host admission through the dispatcher", () => {
  it("keeps admitting the shipped isolated harness and its sessions", async () => {
    const app = dispatcher(harness, policy);
    const acquired = await post(app, "acquire", { ownerUserId: 1 });
    expect(acquired.statusCode).toBe(200);
    const { epoch } = acquired.json() as { epoch: string };
    const session = await post(app, "session", { epoch, sessionId: randomUUID(), resume: false });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ model: "grok-4.6", harness: { digest: harness.digest } });
    await app.close();
  });

  it("refuses modes and features the isolated demo host cannot serve", async () => {
    const shared = dispatcher(variant({ hosting: { mode: "shared" } }), { ...policy, hosting: { modes: ["isolated", "shared"] } });
    const sharedResponse = await post(shared, "acquire", { ownerUserId: 1 });
    expect(sharedResponse.statusCode).toBe(422);
    expect(sharedResponse.json()).toMatchObject({
      error: { code: "host_policy_rejected", message: "The demo host serves isolated harnesses; this harness requests shared hosting." },
    });
    await shared.close();

    const disallowed = dispatcher(harness, { ...policy, hosting: { modes: ["shared"] } });
    expect((await post(disallowed, "acquire", { ownerUserId: 1 })).json()).toMatchObject({ error: { code: "hosting_mode_not_allowed" } });
    await disallowed.close();

    const withMcp = dispatcher(
      variant({ mcpServers: [{ server: "docs-search", tools: ["search"] }] }),
      { ...policy, mcpServers: { "docs-search": { url: "https://mcp.example.com/docs", tools: ["search"] } } },
    );
    const mcpResponse = await post(withMcp, "acquire", { ownerUserId: 1 });
    expect(mcpResponse.statusCode).toBe(409);
    expect(mcpResponse.json()).toMatchObject({
      error: { code: "hosting_unavailable", details: { path: "mcpServers", prerequisite: { kind: "feature", name: "remote-mcp" } } },
    });
    await withMcp.close();
    expect((await pool.query("SELECT count(*)::int AS hosts FROM owner_hosts")).rows[0]).toEqual({ hosts: 0 });
  });
});
