import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityIntrospection, UsageReport } from "@copilot-agent/contracts";
import { signCapability } from "@copilot-agent/service-defaults";
import type { FastifyInstance } from "fastify";
import { parseRoutes, type InferenceRoute } from "../../src/inference-gateway/src/routes.js";
import { buildGateway } from "../../src/inference-gateway/src/server.js";

const signingKey = "s".repeat(64);
let upstream: Server;
let upstreamUrl: string;
let gateway: FastifyInstance;
let gatewayUrl: string;
let received: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
let upstreamMode: "json" | "sse" | "redirect" | "responses-json" | "responses-sse" | "unauthorized" = "json";
let introspection: CapabilityIntrospection | Error = { active: true, remainingTokens: 1000 };
const usage: UsageReport[] = [];
const invalidated: string[] = [];

async function token(models = ["grok-test"]): Promise<string> {
  return signCapability(signingKey, {
    attemptId: randomUUID(),
    jti: randomUUID(),
    jobId: randomUUID(),
    attempt: 1,
    principal: "dev",
    models,
    tokenBudget: 1000,
    expiresAt: new Date(Date.now() + 60_000),
  });
}

function chat(bearer: string | undefined, body: object, extraHeaders: Record<string, string> = {}, path = "chat/completions") {
  return fetch(`${gatewayUrl}/openai/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      if (upstreamMode === "redirect") {
        res.writeHead(307, { location: "https://elsewhere.example/v1/chat/completions" }).end();
      } else if (upstreamMode === "unauthorized") {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "expired" } }));
      } else if (upstreamMode === "responses-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "response", output: [], usage: { input_tokens: 12, output_tokens: 3 } }));
      } else if (upstreamMode === "responses-sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\n');
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
        res.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":21,"output_tokens":4}}}\n\n');
      } else if (upstreamMode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-upstream-secret-header": "leak" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/openai/v1`;

  gateway = buildGateway({
    signingKey,
    routes: { routes: new Map<string, InferenceRoute>([
      ["grok-test", { model: "grok-test", baseUrl: upstreamUrl, deployment: "deployment-1", auth: "entra" }],
      ["resp-test", { model: "resp-test", baseUrl: upstreamUrl, deployment: "deployment-2", auth: "entra", wireApi: "responses" }],
      ["github/gh-test", { model: "github/gh-test", baseUrl: "https://copilot.example", deployment: "gh-test", auth: "github", wireApi: "completions" }],
    ]) },
    upstreamToken: async () => "upstream-entra-token",
    github: {
      endpoint: async () => ({ baseUrl: upstreamUrl, headers: { Authorization: "Bearer github-operator-token", "Copilot-Integration-Id": "test-integration" } }),
      invalidate: (model) => { invalidated.push(model); },
    },
    introspect: async () => {
      if (introspection instanceof Error) {
        throw introspection;
      }
      return introspection;
    },
    reportUsage: async (report) => {
      usage.push(report);
    },
  });
  await gateway.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.close();
  upstream.close();
});

beforeEach(() => {
  received = [];
  usage.length = 0;
  invalidated.length = 0;
  upstreamMode = "json";
  introspection = { active: true, remainingTokens: 1000 };
});

describe("inference gateway", () => {
  it("requires a job capability", async () => {
    const response = await chat(undefined, { model: "grok-test", messages: [] });
    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("replaces caller credentials with its own upstream identity and forwards nothing else", async () => {
    const capability = await token();
    const response = await chat(capability, { model: "grok-test", messages: [{ role: "user", content: "hi" }] }, {
      cookie: "session=1",
      "x-forwarded-for": "10.0.0.1",
      "api-key": "caller-supplied",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-secret-header")).toBeNull();
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "ok" } }] });
    const call = received[0]!;
    expect(call.url).toBe("/openai/v1/chat/completions");
    expect(call.body.model).toBe("deployment-1");
    expect(call.headers.authorization).toBe("Bearer upstream-entra-token");
    expect(JSON.stringify(call.headers)).not.toContain(capability);
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers["x-forwarded-for"]).toBeUndefined();
    expect(call.headers["api-key"]).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(usage).toEqual([expect.objectContaining({ model: "grok-test", inputTokens: 10, outputTokens: 5 })]);
  });

  it("streams responses and accounts usage from the final chunk", async () => {
    upstreamMode = "sse";
    const response = await chat(await token(), { model: "grok-test", stream: true, messages: [] });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"content":"he"');
    expect(text).toContain("[DONE]");
    expect(received[0]!.body.stream_options).toEqual({ include_usage: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(usage[0]).toMatchObject({ inputTokens: 7, outputTokens: 2 });
  });

  it("rejects models outside the capability", async () => {
    const response = await chat(await token(["other"]), { model: "grok-test", messages: [] });
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects revoked capabilities", async () => {
    introspection = { active: false, reason: "revoked", remainingTokens: 0 };
    const response = await chat(await token(), { model: "grok-test", messages: [] });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("capability_revoked");
  });

  it("fails closed when authorization is unavailable", async () => {
    introspection = new Error("dispatcher down");
    const response = await chat(await token(), { model: "grok-test", messages: [] });
    expect(response.status).toBe(503);
    expect(received).toHaveLength(0);
  });

  it("refuses upstream redirects", async () => {
    upstreamMode = "redirect";
    const response = await chat(await token(), { model: "grok-test", messages: [] });
    expect(response.status).toBe(502);
  });
});

describe("model wire APIs", () => {
  it("describes one routed model without a capability, and nothing else", async () => {
    const described = await fetch(`${gatewayUrl}/openai/v1/models/${encodeURIComponent("github/gh-test")}`);
    expect(await described.json()).toEqual({ id: "github/gh-test", object: "model", created: 0, owned_by: "github", wire_api: "completions" });
    expect(await (await fetch(`${gatewayUrl}/openai/v1/models/resp-test`)).json()).toMatchObject({ wire_api: "responses" });
    expect((await fetch(`${gatewayUrl}/openai/v1/models/unknown`)).status).toBe(404);
    expect((await fetch(`${gatewayUrl}/openai/v1/models`)).status).toBe(401);
  });

  it("lists the capability's models with their wire APIs", async () => {
    const response = await fetch(`${gatewayUrl}/openai/v1/models`, {
      headers: { authorization: `Bearer ${await token(["grok-test", "resp-test", "missing"])}` },
    });
    const listed = (await response.json()) as { data: Array<{ id: string; wire_api: string; owned_by: string }> };
    expect(listed.data.map((model) => [model.id, model.wire_api])).toEqual([["grok-test", "completions"], ["resp-test", "responses"]]);
  });

  it("proxies the Responses API and accounts its usage", async () => {
    upstreamMode = "responses-json";
    const response = await chat(await token(["resp-test"]), { model: "resp-test", input: "hi" }, {}, "responses");
    expect(response.status).toBe(200);
    expect(received[0]).toMatchObject({ url: "/openai/v1/responses", body: { model: "deployment-2", input: "hi" } });
    expect(received[0]!.headers.authorization).toBe("Bearer upstream-entra-token");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(usage[0]).toMatchObject({ model: "resp-test", inputTokens: 12, outputTokens: 3 });
  });

  it("accounts streamed Responses usage from response.completed without adding stream options", async () => {
    upstreamMode = "responses-sse";
    const response = await chat(await token(["resp-test"]), { model: "resp-test", stream: true, input: "hi" }, {}, "responses");
    expect(await response.text()).toContain("response.completed");
    expect(received[0]!.body.stream_options).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(usage[0]).toMatchObject({ inputTokens: 21, outputTokens: 4 });
  });

  it("refuses a model over the other wire API", async () => {
    const wrong = await chat(await token(["resp-test"]), { model: "resp-test", messages: [] });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("unsupported_api_for_model");
    expect((await chat(await token(), { model: "grok-test", input: "hi" }, {}, "responses")).status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe("GitHub routes", () => {
  it("sends the gateway's GitHub credential and headers with the bare Copilot model", async () => {
    const capability = await token(["github/gh-test"]);
    const response = await chat(capability, { model: "github/gh-test", messages: [] }, { "api-key": "caller-supplied" });
    expect(response.status).toBe(200);
    const call = received[0]!;
    expect(call.body.model).toBe("gh-test");
    expect(call.headers.authorization).toBe("Bearer github-operator-token");
    expect(call.headers["copilot-integration-id"]).toBe("test-integration");
    expect(call.headers["x-interaction-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers["api-key"]).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain(capability);
    expect(JSON.stringify(call.headers)).not.toContain("upstream-entra-token");
  });

  it("forgets the endpoint when Copilot refuses the credential", async () => {
    upstreamMode = "unauthorized";
    const response = await chat(await token(["github/gh-test"]), { model: "github/gh-test", messages: [] });
    expect(response.status).toBe(401);
    expect(invalidated).toEqual(["gh-test"]);
  });
});

describe("route configuration", () => {
  const route = (overrides: object) =>
    JSON.stringify([{ model: "m", baseUrl: "https://x.openai.azure.com/openai/v1", deployment: "d", auth: "entra", ...overrides }]);

  it("accepts HTTPS routes using the gateway identity", () => {
    expect(parseRoutes(route({}), false).routes.get("m")?.baseUrl).toBe("https://x.openai.azure.com/openai/v1");
  });

  it("rejects plaintext, embedded credentials, and unauthenticated remote upstreams", () => {
    expect(() => parseRoutes(route({ baseUrl: "http://x.example/v1" }), false)).toThrow(/HTTPS/);
    expect(() => parseRoutes(route({ baseUrl: "https://u:p@x.example/v1" }), false)).toThrow(/credentials/);
    expect(() => parseRoutes(route({ auth: "none" }), false)).toThrow(/identity/);
    expect(() => parseRoutes(route({ baseUrl: "http://127.0.0.1:9/v1", auth: "none" }), true)).not.toThrow();
  });
});
