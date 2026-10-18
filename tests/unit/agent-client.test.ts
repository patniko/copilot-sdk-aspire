import { HarnessDefinition } from "@copilot-agent/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULTS, AgentDefinitionError, AgentPlatform, AgentPlatformError, defineAgent, localApiUrl,
} from "../../src/agent-client/src/index.js";

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date().toISOString();

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION, label: "demo", model: "github/claude-sonnet-5.5", closed: false, online: true, createdAt: NOW, lastActivityAt: NOW,
    harness: { name: "release-notes-writer", version: "0.1.0", digest: DIGEST },
    mode: "shared", placement: "shared",
    segment: { generation: 1, placement: "shared", ahpSessionId: "ahp-1", startedAt: NOW },
    limits: {},
    budget: { usedTokens: 0, reservedTokens: 0, remainingTokens: 500_000 },
    jobs: 0, continuations: 0,
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION, destination: "shared", transport: "direct", ahpSessionId: "ahp-1",
    url: `ws://127.0.0.1:7000/sessions/${SESSION}`, token: "t".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    serverKey: { keyId: "k1", algorithm: "x25519-sealedbox", publicKey: "cHVibGlj" },
    ...overrides,
  };
}

interface Recorded { method: string; url: string; headers: Record<string, string>; body?: unknown }

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET", url: String(input), headers: init?.headers as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const agent = () => defineAgent({ name: "release-notes-writer", instructions: "Write release notes.", model: "github/claude-sonnet-5.5" });

describe("defineAgent", () => {
  it("fills conversation defaults and produces a valid harness definition", () => {
    const definition = agent();
    expect(HarnessDefinition.parse(definition)).toEqual(definition);
    expect(definition).toMatchObject({
      schemaVersion: "1", version: AGENT_DEFAULTS.version, interaction: "conversation", hosting: { mode: "shared" },
      model: { preferred: "github/claude-sonnet-5.5", allowed: ["github/claude-sonnet-5.5"] },
      tools: [], limits: AGENT_DEFAULTS.limits, retry: { safeToRetry: false, maxAttempts: 1 },
      runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
      input: { schema: { type: "object", additionalProperties: false } }, output: { schema: { type: "object" } },
    });
    expect(definition.description).toContain("release-notes-writer");
  });

  it("accepts model fallbacks, hosting configs, and limit overrides", () => {
    const definition = defineAgent({
      name: "explainer", instructions: "Explain.", version: "1.2.3",
      model: { preferred: "a/model", allowed: ["b/model"] }, hosting: { mode: "promotable", promotion: { approval: "allow" } },
      builtinTools: ["files", "shell"], limits: { maxInferenceTokens: 50_000 },
    });
    expect(definition.model.allowed).toEqual(["a/model", "b/model"]);
    expect(definition.hosting).toEqual({ mode: "promotable", promotion: { approval: "allow" } });
    expect(definition.limits).toEqual({ maxDurationSeconds: 300, maxInferenceTokens: 50_000 });
    expect(definition.version).toBe("1.2.3");
  });

  it("rejects mistakes locally with readable paths", () => {
    expect(() => defineAgent({ name: "Bad Name", instructions: "x", model: "m" })).toThrow(AgentDefinitionError);
    try {
      defineAgent({ name: "shell-on-shared", instructions: "x", model: "m", hosting: "shared", builtinTools: ["shell"] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentDefinitionError);
      expect((error as AgentDefinitionError).issues).toEqual([expect.objectContaining({ path: "builtinTools.0" })]);
      expect((error as Error).message).toMatch(/builtinTools\.0: Shared placement cannot run shell commands/);
    }
  });
});

describe("AgentPlatform", () => {
  it("refuses insecure or credentialed API URLs and keeps the key out of its JSON", () => {
    expect(() => new AgentPlatform({ apiUrl: "http://example.com", apiKey: "k" })).toThrow(/HTTPS/);
    expect(() => new AgentPlatform({ apiUrl: "https://user:pw@example.com", apiKey: "k" })).toThrow(/credentials/);
    const platform = new AgentPlatform({ apiUrl: "http://127.0.0.1:5000", apiKey: "secret-key" });
    expect(JSON.stringify(platform)).not.toContain("secret-key");
  });

  it("creates a session from a definition and provisions a connection", async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: view() }, { status: 200, body: connection() }]);
    const platform = new AgentPlatform({ apiUrl: "http://127.0.0.1:5000", apiKey: "dev-key", fetch });
    const definition = agent();
    const session = await platform.createSession(definition, { label: "demo" });
    expect(session.id).toBe(SESSION);
    expect(session.view.placement).toBe("shared");
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:5000/v1/sessions", body: { definition, label: "demo" } });
    expect(calls[0]!.headers.authorization).toBe("Bearer dev-key");
    const material = await session.connection();
    expect(material.ahpSessionId).toBe("ahp-1");
    expect(calls[1]).toMatchObject({ method: "POST", url: `http://127.0.0.1:5000/v1/sessions/${SESSION}/connection`, body: { transport: "direct" } });
  });

  it("creates a session from a published harness name and reads existing sessions", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: view({ mode: "isolated", placement: "container" }) },
      { status: 200, body: view() },
    ]);
    const platform = new AgentPlatform({ apiUrl: "https://agents.example.com", apiKey: "k", fetch });
    await platform.createSession("shared-researcher", { version: "1.0.0" });
    expect(calls[0]!.body).toEqual({ harness: "shared-researcher", version: "1.0.0" });
    const existing = await platform.session(SESSION.toUpperCase());
    expect(existing.view.mode).toBe("shared");
    expect(calls[1]).toMatchObject({ method: "GET", url: `https://agents.example.com/v1/sessions/${SESSION}` });
    await expect(platform.session("not-a-uuid")).rejects.toThrow(/UUID/);
  });

  it("lists sessions, answers worker requests, lists workers, and requests promotion", async () => {
    const REQUEST = "7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const workerRequest = {
      id: REQUEST, sessionId: SESSION, workerId: "8b1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", worker: "builder",
      harness: { name: "hybrid-builder", version: "1.0.0" }, state: "pending",
      request: { kind: "permission", permission: { type: "shell", command: "python3 /shared/hello.py" } },
      createdAt: NOW, expiresAt: NOW,
    };
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { sessions: [view()] } },
      { status: 200, body: { requests: [workerRequest] } },
      { status: 200, body: { ...workerRequest, state: "answered", response: { kind: "permission", approved: true, scope: "once" }, answeredBy: "principal", resolvedAt: NOW } },
      { status: 200, body: view({ mode: "promotable" }) },
      { status: 200, body: { workers: [] } },
      { status: 202, body: { sessionId: SESSION, created: true, promotion: { id: REQUEST, state: "requested", source: "api", reason: "needs a shell", size: "small", requestedAt: NOW } } },
    ]);
    const platform = new AgentPlatform({ apiUrl: "http://127.0.0.1:5000", apiKey: "k", fetch });
    expect((await platform.sessions()).map((session) => session.id)).toEqual([SESSION]);
    const [pending] = await platform.workerInputRequests();
    expect(pending!.request.kind).toBe("permission");
    expect(calls[1]).toMatchObject({ method: "GET", url: "http://127.0.0.1:5000/v1/worker-input-requests?state=pending" });
    await platform.respondToWorker(SESSION, REQUEST, { kind: "permission", approved: true, scope: "once" });
    expect(calls[2]).toMatchObject({
      method: "POST", url: `http://127.0.0.1:5000/v1/sessions/${SESSION}/input-requests/${REQUEST}/respond`,
      body: { kind: "permission", approved: true, scope: "once" },
    });
    const session = await platform.session(SESSION);
    expect(await session.workers()).toEqual([]);
    expect(calls[4]).toMatchObject({ method: "GET", url: `http://127.0.0.1:5000/v1/sessions/${SESSION}/workers` });
    expect((await session.promote("needs a shell")).created).toBe(true);
    expect(calls[5]).toMatchObject({ method: "POST", url: `http://127.0.0.1:5000/v1/sessions/${SESSION}/promote`, body: { reason: "needs a shell" } });
    await expect(platform.respondToWorker(SESSION, "nope", { kind: "permission", approved: false })).rejects.toThrow(/UUIDs/);
  });

  it("maps API errors to AgentPlatformError", async () => {
    const { fetch } = fakeFetch([
      { status: 422, body: { error: { code: "policy_rejected", message: "None of the harness's models are approved by the operator policy.", details: { path: "model" } } } },
      { status: 403, body: { error: { code: "inline_harnesses_disabled", message: "Inline harnesses are disabled." } } },
      { status: 500, body: "not json-shaped" },
    ]);
    const platform = new AgentPlatform({ apiUrl: "http://localhost:5000", apiKey: "k", fetch });
    const refused = await platform.createSession(agent()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentPlatformError);
    expect(refused).toMatchObject({ status: 422, code: "policy_rejected", details: { path: "model" } });
    expect((refused as Error).message).toMatch(/models are approved by the operator policy/);
    await expect(platform.createSession(agent())).rejects.toMatchObject({ status: 403, code: "inline_harnesses_disabled" });
    await expect(platform.createSession(agent())).rejects.toMatchObject({ status: 500, code: undefined, message: "The agent API answered 500." });
  });

  it("reports an unreachable API and rejects invalid connection material", async () => {
    const unreachable = new AgentPlatform({
      apiUrl: "http://127.0.0.1:5000", apiKey: "k", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    await expect(unreachable.session(SESSION)).rejects.toMatchObject({ status: 0, code: "unreachable" });
    const { fetch } = fakeFetch([
      { status: 200, body: view() },
      { status: 200, body: connection({ url: `ws://broker.example.com/sessions/${SESSION}` }) },
    ]);
    const session = await new AgentPlatform({ apiUrl: "http://127.0.0.1:5000", apiKey: "k", fetch }).session(SESSION);
    await expect(session.connection()).rejects.toMatchObject({ code: "invalid_connection" });
  });

  it("resolves the local stack from the environment or aspire describe output", async () => {
    const platform = await AgentPlatform.local({ env: { AGENT_API_URL: "http://127.0.0.1:5123", AGENT_API_KEY: "k" } });
    expect(platform.apiUrl).toBe("http://127.0.0.1:5123/");
    const describeOutput = `banner\n${JSON.stringify({ resources: [
      { displayName: "postgres", urls: [{ name: "tcp", url: "tcp://x" }] },
      { displayName: "agent-api", urls: [{ name: "https", url: "https://localhost:7001" }, { name: "http", url: "http://localhost:5001" }] },
    ] })}`;
    expect(localApiUrl(describeOutput)).toBe("http://localhost:5001");
    expect(localApiUrl("not json")).toBeUndefined();
    expect(localApiUrl(JSON.stringify({ resources: [] }))).toBeUndefined();
  });
});
