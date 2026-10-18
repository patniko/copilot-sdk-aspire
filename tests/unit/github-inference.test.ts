import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayWireApi } from "@copilot-agent/contracts";
import { GitHubUpstream, wireApiFor, type GitHubEndpoint, type GitHubModelSource } from "../../src/inference-gateway/src/github-upstream.js";

function source(overrides: Partial<Record<string, Partial<GitHubEndpoint>>> = {}) {
  const calls = { endpoint: [] as string[], started: 0, stopped: 0 };
  const endpoints: Record<string, GitHubEndpoint> = {
    "claude-x": { type: "anthropic", baseUrl: "https://copilot.example/", headers: { Authorization: "Bearer gho_operator", "Content-Type": "application/json", "X-Interaction-Id": "fixed", "Copilot-Integration-Id": "cli", Empty: undefined } },
    "gpt-x": { type: "openai", wireApi: "responses", baseUrl: "https://copilot.example", headers: {}, apiKey: "gho_operator" },
    "deep-x": { type: "openai", wireApi: "completions", baseUrl: "https://copilot.example", headers: { Authorization: "Bearer gho_operator" }, sessionToken: { token: "s1", header: "Copilot-Session-Token" } },
  };
  for (const [model, endpoint] of Object.entries(overrides)) endpoints[model] = { ...endpoints[model]!, ...endpoint };
  const factory = async (): Promise<GitHubModelSource> => {
    calls.started++;
    return {
      listModels: async () => [
        { id: "auto" }, { id: "claude-x", policyState: "enabled" }, { id: "gpt-x" }, { id: "deep-x", policyState: "enabled" },
        { id: "blocked-x", policyState: "disabled" },
      ],
      endpoint: async (model) => {
        calls.endpoint.push(model);
        const endpoint = endpoints[model];
        if (!endpoint) throw new Error(`no endpoint for ${model}`);
        return endpoint;
      },
      stop: async () => { calls.stopped++; },
    };
  };
  return { factory, calls };
}

describe("GitHub upstream", () => {
  it("routes the account's usable models under github/ with their wire APIs", async () => {
    const { routes, missing } = await new GitHubUpstream(source().factory).discover();
    expect(missing).toEqual([]);
    expect(routes).toEqual([
      { model: "github/claude-x", baseUrl: "https://copilot.example", deployment: "claude-x", auth: "github", wireApi: "completions" },
      { model: "github/gpt-x", baseUrl: "https://copilot.example", deployment: "gpt-x", auth: "github", wireApi: "responses" },
      { model: "github/deep-x", baseUrl: "https://copilot.example", deployment: "deep-x", auth: "github", wireApi: "completions" },
    ]);
  });

  it("exposes only requested models and reports unavailable ones", async () => {
    const { routes, missing } = await new GitHubUpstream(source().factory, ["gpt-x", "blocked-x", "nope"]).discover();
    expect(routes.map((route) => route.model)).toEqual(["github/gpt-x"]);
    expect(missing).toEqual(["blocked-x", "nope"]);
  });

  it("keeps the credential headers and drops the ones the gateway owns", async () => {
    const upstream = new GitHubUpstream(source().factory);
    expect(await upstream.endpoint("claude-x")).toEqual({
      baseUrl: "https://copilot.example",
      headers: { Authorization: "Bearer gho_operator", "Copilot-Integration-Id": "cli" },
      expiresAt: undefined,
    });
    expect((await upstream.endpoint("gpt-x")).headers).toEqual({ Authorization: "Bearer gho_operator" });
    expect((await upstream.endpoint("deep-x")).headers).toMatchObject({ "Copilot-Session-Token": "s1" });
  });

  it("caches endpoints until invalidated", async () => {
    const { factory, calls } = source();
    const upstream = new GitHubUpstream(factory);
    await upstream.endpoint("claude-x");
    await upstream.endpoint("claude-x");
    expect(calls.endpoint).toEqual(["claude-x"]);
    upstream.invalidate("claude-x");
    await upstream.endpoint("claude-x");
    expect(calls.endpoint).toEqual(["claude-x", "claude-x"]);
    expect(calls.started).toBe(1);
  });

  it("replaces a failed SDK client on the next request", async () => {
    const { factory, calls } = source();
    const upstream = new GitHubUpstream(factory);
    await expect(upstream.endpoint("missing")).rejects.toThrow(/no endpoint/);
    expect(calls.stopped).toBe(1);
    await upstream.endpoint("gpt-x");
    expect(calls.started).toBe(2);
  });

  it("serves Anthropic-shaped models over chat completions", () => {
    expect(wireApiFor({ type: "anthropic" })).toBe("completions");
    expect(wireApiFor({ type: "openai", wireApi: "responses" })).toBe("responses");
    expect(wireApiFor({ type: "openai" })).toBe("completions");
  });
});

describe("gatewayWireApi", () => {
  let server: Server;
  let base: string;
  const described: Record<string, string> = { "github/gpt-x": "responses", "github/gpt-y": "responses", "github/claude-x": "completions" };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const model = decodeURIComponent((req.url ?? "").replace(/^\/openai\/v1\/models\//, ""));
      const api = described[model];
      if (!api) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: model, object: "model", owned_by: "github", wire_api: api }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1/`;
  });
  afterAll(() => { server.close(); });

  it("uses the gateway's wire API for the session's models", async () => {
    expect(await gatewayWireApi(base, ["github/gpt-x", "github/gpt-y"])).toBe("responses");
    expect(await gatewayWireApi(base, ["github/claude-x"])).toBe("completions");
  });

  it("falls back to chat completions for undescribed models or an unreachable gateway", async () => {
    expect(await gatewayWireApi(base, ["grok-4.6"])).toBe("completions");
    expect(await gatewayWireApi("http://127.0.0.1:9/openai/v1", ["github/gpt-x"])).toBe("completions");
  });

  it("refuses models that need different wire APIs in one session", async () => {
    await expect(gatewayWireApi(base, ["github/gpt-x", "github/claude-x"])).rejects.toThrow(/different inference APIs/);
  });
});
