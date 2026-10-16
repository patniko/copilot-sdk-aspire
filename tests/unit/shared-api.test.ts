import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SHARED_WORKER_FEATURES, SharedSessionLimits } from "@copilot-agent/contracts";
import type { JobEventListener, JobStore } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, createService, HttpError } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { sharedHarness, sharedRegistry } from "../integration/fixtures/shared-harness.js";

const key = "alice-key-0123456789abcdefghij";
const headers = { authorization: `Bearer ${key}` };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const controls: Array<Record<string, unknown>> = [];
let worker: FastifyInstance;
let api: FastifyInstance;

beforeAll(async () => {
  worker = createService({ name: "fake-session-host" });
  worker.post("/internal/shared", async (request) => {
    const command = request.body as Record<string, unknown>;
    controls.push(command);
    if (command.operation === "connect" && (command.request as { transport?: string }).transport === "github") {
      throw new HttpError(422, "transport_unsupported", "Shared hosting supports direct WSS only.", { prerequisite: undefined });
    }
    if (command.operation === "close") throw new HttpError(403, "relay_owner_only", "Owner only.");
    if (command.operation === "get") throw new HttpError(500, "internal", "Hidden detail.");
    const harness = { name: "chat", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
    const now = new Date().toISOString();
    if (command.operation === "connect") {
      return {
        sessionId: id, destination: "shared", transport: "direct", ahpSessionId: id, url: `ws://127.0.0.1:1/sessions/${id}`,
        token: "t".repeat(40), expiresAt: now, serverKey: { keyId: "k", algorithm: "x25519-sealedbox", publicKey: "p" },
      };
    }
    return {
      id, label: "", model: "fixture", closed: false, online: false, createdAt: now, lastActivityAt: now, harness, mode: "shared", placement: "shared",
      segment: { generation: 1, placement: "shared", harness, ahpSessionId: id, startedAt: now },
      limits: SharedSessionLimits.parse({}), budget: { usedTokens: 0, reservedTokens: 0, remainingTokens: 1 }, jobs: 0, continuations: 0,
    };
  });
  await worker.listen({ port: 0, host: "127.0.0.1" });
  const registry = await sharedRegistry([
    sharedHarness("chat"),
    { ...sharedHarness("chat", { version: "0.9.0" }) },
    sharedHarness("isolated-chat", { hosting: undefined }),
    sharedHarness("closed-mode"),
    { ...sharedHarness("batch-only", { interaction: undefined, hosting: undefined }) },
  ], {}, { "closed-mode": { hosting: { modes: ["isolated"] } } });
  const harnesses = new Map(registry.harnesses);
  const profiles = new Map(registry.profiles);
  api = buildApi({
    store: { ping: async () => undefined } as unknown as JobStore, listener: {} as JobEventListener,
    admission: new Admission({ harnesses, profiles, policies: registry.policies }),
    authenticator: new ApiKeyAuthenticator(`alice:${key}`), harnesses, maxOpenJobsPerPrincipal: 10, console: false,
    shared: { url: `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`, key: "worker-key" },
    hosting: { harnesses, profiles, policies: registry.policies, deployment: { isolatedHosts: [], sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] } } },
  });
});
afterAll(async () => { await api?.close(); await worker?.close(); });

describe("harness-driven shared session routes", () => {
  it("evaluates hosting before contacting the worker and forwards the resolved version", async () => {
    const create = (payload: unknown) => api.inject({ method: "POST", url: "/v1/sessions", headers, payload: payload as object });
    expect((await create({ label: "x" })).json().error.code).toBe("invalid_request");
    expect((await create({ harness: "missing" })).statusCode).toBe(404);
    expect((await create({ harness: "chat", version: "2.0.0" })).json().error.code).toBe("harness_not_found");
    const isolated = await create({ harness: "isolated-chat" });
    expect(isolated.statusCode).toBe(409);
    expect(isolated.json().error).toMatchObject({ code: "hosting_unavailable" });
    const closed = await create({ harness: "closed-mode" });
    expect(closed.statusCode).toBe(422);
    expect(closed.json().error).toMatchObject({ code: "hosting_mode_not_allowed", details: { path: "hosting.mode" } });
    expect((await create({ harness: "batch-only" })).json().error.code).toBe("policy_rejected");
    expect(controls).toEqual([]);
    const created = await create({ harness: "chat", label: "Mine" });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/v1/sessions/${id}`);
    expect(controls.at(-1)).toEqual({ operation: "create", principal: "alice", request: { harness: "chat", version: "1.0.0", label: "Mine" } });
    await create({ harness: "chat", version: "0.9.0" });
    expect(controls.at(-1)).toMatchObject({ request: { version: "0.9.0" } });
  });

  it("requests connections over one transport and passes hosting errors through with their details", async () => {
    const direct = await api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers });
    expect(direct.statusCode).toBe(200);
    expect(direct.headers["cache-control"]).toBe("no-store");
    expect(controls.at(-1)).toEqual({ operation: "connect", principal: "alice", id, request: { transport: "direct" } });
    const relay = await api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers, payload: { transport: "github" } });
    expect(relay.statusCode).toBe(422);
    expect(relay.json().error).toMatchObject({ code: "transport_unsupported", message: "Shared hosting supports direct WSS only." });
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers, payload: { transport: "pigeon" } })).statusCode).toBe(400);
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${id}/close`, headers, payload: {} })).statusCode).toBe(403);
    const hidden = await api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers });
    expect(hidden.statusCode).toBe(503);
    expect(hidden.body).not.toContain("Hidden detail");
  });
});
