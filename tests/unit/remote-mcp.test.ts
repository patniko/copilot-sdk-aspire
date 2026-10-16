import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  EgressFilter, environmentSecretResolver, RemoteMcpCatalogClient, RemoteMcpServerConfig, resolveRemoteMcpSelections,
  type RemoteMcpCatalog, type RemoteMcpSelection, type RemoteMcpServerConfigInput,
} from "@copilot-agent/service-defaults";
import { FakeMcpServer, type FakeMcpOptions } from "../fakes/fake-mcp-server.js";

const credential = `synthetic-mcp-credential-${randomUUID()}`;
const forms = [credential, `Bearer ${credential}`, Buffer.from(credential).toString("base64"), Buffer.from(credential).toString("base64url"), encodeURIComponent(credential)];
const fakes: FakeMcpServer[] = [];
afterEach(async () => { await Promise.all(fakes.splice(0).map((fake) => fake.stop())); });

async function fake(options: FakeMcpOptions = {}): Promise<FakeMcpServer> {
  const server = await new FakeMcpServer(options).start();
  fakes.push(server);
  return server;
}

function client(entry: Partial<RemoteMcpServerConfigInput> & { url: string }, options: { secrets?: Record<string, string>; internal?: Array<{ host: string; port?: number }> } = {}) {
  const reports: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const catalog = new RemoteMcpCatalogClient({
    catalog: {
      "docs-search": {
        tools: ["search", "fetch_page", "leak", "fail", "slow", "big", "rpc_error"],
        allowPrivateNetwork: true,
        auth: { secret: "docs-search-token" },
        description: "Synthetic documentation search",
        ...entry,
      },
    },
    egress: new EgressFilter({ internal: options.internal }),
    secrets: environmentSecretResolver(options.secrets ?? { MCP_SECRET_DOCS_SEARCH_TOKEN: credential }),
    report: (event, detail) => reports.push({ event, detail }),
  });
  return { catalog, reports };
}

const everything: RemoteMcpSelection[] = [
  { server: "docs-search", tools: ["search", "leak", "fail", "slow", "big", "rpc_error", "admin_reset"] },
  { server: "unlisted-server", tools: ["anything"] },
];

function expectNoCredential(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const form of forms) expect(text).not.toContain(form);
}

describe("remote MCP configuration", () => {
  it("accepts the contracts' McpServerPolicy shape and refuses unsafe catalog entries", () => {
    const policy = { url: "https://mcp.example.com/docs", description: "Docs", auth: { secret: "docs-search-token", header: "X-Api-Key" }, tools: ["search", "fetch.page"] };
    expect(RemoteMcpServerConfig.parse(policy)).toMatchObject({ ...policy, timeoutSeconds: 30, maxResponseBytes: 1024 * 1024 });
    expect(RemoteMcpServerConfig.safeParse({ url: "http://mcp.example.com/", tools: ["search"] }).success).toBe(true);
    expect(RemoteMcpServerConfig.safeParse({ url: "http://127.0.0.1:9000/mcp", auth: { secret: "dev-token" }, allowPrivateNetwork: true, tools: ["search"] }).success).toBe(true);
    for (const invalid of [
      { url: "http://mcp.example.com/", auth: { secret: "docs-token" }, tools: ["search"] },
      { url: "https://user:pass@mcp.example.com/", tools: ["search"] },
      { url: "https://mcp.example.com/#fragment", tools: ["search"] },
      { url: "ftp://mcp.example.com/", tools: ["search"] },
      { url: "https://mcp.example.com/", tools: ["search", "search"] },
      { url: "https://mcp.example.com/", tools: [] },
      { url: "https://mcp.example.com/", tools: ["has space"] },
      { url: "https://mcp.example.com/", auth: { secret: "Not_A_Slug" }, tools: ["search"] },
      { url: "https://mcp.example.com/", auth: { secret: "docs-token", header: "Mcp-Session-Id" }, tools: ["search"] },
      { url: "https://mcp.example.com/", auth: { secret: "docs-token", scheme: "Token" }, tools: ["search"] },
      { url: "https://mcp.example.com/", tools: ["search"], extra: true },
    ]) expect(RemoteMcpServerConfig.safeParse(invalid).success).toBe(false);
  });

  it("exposes only the catalog ∩ requested tools with stable, unambiguous names, whatever the request order", () => {
    const catalog: RemoteMcpCatalog = {
      docs: RemoteMcpServerConfig.parse({ url: "https://mcp.example.com/", tools: ["search", "fetch.page", "fetch_page", "x".repeat(120), "search_search", "Lookup"] }),
      "docs-search": RemoteMcpServerConfig.parse({ url: "https://mcp.example.net/", tools: ["search"] }),
      [`long-${"s".repeat(57)}`]: RemoteMcpServerConfig.parse({ url: "https://mcp.example.org/", tools: ["lookup"] }),
    };
    const longServer = `long-${"s".repeat(57)}`;
    const forward = resolveRemoteMcpSelections(catalog, [
      { server: "docs", tools: ["search", "fetch.page", "fetch_page", "x".repeat(120), "search_search", "Lookup", "delete_all", "search"] },
      { server: "docs-search", tools: ["search"] },
      { server: longServer, tools: ["lookup"] },
      { server: "missing", tools: ["search"] },
    ]);
    expect(forward.refused).toEqual([
      { server: "docs", tool: "delete_all", reason: "unapproved_tool" },
      { server: "missing", reason: "unknown_server" },
    ]);
    const names = forward.approved.map((entry) => entry.name);
    const byPair = (list: typeof forward.approved) => Object.fromEntries(list.map((entry) => [`${entry.server}/${entry.tool}`, entry.name]));
    const named = byPair(forward.approved);
    expect(named["docs/search"]).toBe("mcp_docs_search");
    expect(named["docs/Lookup"]).toBe("mcp_docs_lookup");
    expect(names.every((name) => /^[a-z0-9_]{1,64}$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    // `fetch.page`/`fetch_page`, and `docs`+`search_search`/`docs-search`+`search`, sanitize to the same name: all get hashed forms.
    for (const pair of ["docs/fetch.page", "docs/fetch_page", "docs/search_search", "docs-search/search"]) {
      expect(named[pair]).toMatch(/^mcp_docs_(?:fetch_page|search_search)_[0-9a-f]{10}$/);
    }
    expect(names).not.toContain("mcp_docs_fetch_page");
    expect(names).not.toContain("mcp_docs_search_search");
    expect(named[`${longServer}/lookup`]).toHaveLength(64);
    const reverse = resolveRemoteMcpSelections(catalog, [
      { server: longServer, tools: ["lookup"] },
      { server: "docs-search", tools: ["search"] },
      { server: "docs", tools: ["Lookup", "search_search", "x".repeat(120), "fetch_page", "fetch.page", "search"] },
    ]);
    expect(byPair(reverse.approved)).toEqual(named);
  });
});

describe("remote MCP client", () => {
  it("lists, describes, and calls approved tools while keeping a malicious server's echoed credential out of everything model-visible", async () => {
    const server = await fake({ credential, echoCredential: true });
    const { catalog, reports } = client({ url: server.url });
    const described = await catalog.describe(everything);
    expect(described.refused).toEqual([
      { server: "docs-search", tool: "admin_reset", reason: "unapproved_tool" },
      { server: "unlisted-server", reason: "unknown_server" },
    ]);
    expect(described.tools.map((tool) => tool.name)).toEqual([
      "mcp_docs_search_search", "mcp_docs_search_leak", "mcp_docs_search_fail", "mcp_docs_search_slow", "mcp_docs_search_big", "mcp_docs_search_rpc_error",
    ]);
    const search = described.tools[0]!;
    expect(search).toMatchObject({ server: "docs-search", tool: "search", readOnly: true, available: true });
    expect(search.description).toContain("Synthetic documentation search");
    expect(search.description).toContain("[redacted]");
    expect(JSON.stringify(search.inputSchema)).toContain("[redacted]");
    expectNoCredential(described);

    const session = catalog.session(everything);
    expect(session.toolNames).not.toContain("mcp_docs_search_admin_reset");
    expect(await session.call("mcp_docs_search_search", { query: "egress" })).toEqual({ ok: true, text: "Results for egress", truncated: false });
    const leaked = await session.call("mcp_docs_search_leak", {});
    expect(leaked.ok).toBe(true);
    expect(leaked.text).toContain("[redacted]");
    const failed = await session.call("mcp_docs_search_fail", {});
    expect(failed).toMatchObject({ ok: false, text: "The tool failed on purpose." });
    const rpcError = await session.call("mcp_docs_search_rpc_error", {});
    expect(rpcError.ok).toBe(false);
    expect(rpcError.text).toContain("HTTP 500");
    expect(rpcError.text).toContain("[redacted]");
    expect(await session.call("mcp_docs_search_admin_reset", {})).toMatchObject({ ok: false, text: "This remote tool is not approved for this conversation." });
    expect((await session.call("mcp_docs_search_search", [1, 2])).ok).toBe(false);
    for (const value of [leaked, failed, rpcError]) expectNoCredential(value);

    await session.close();
    const authenticated = server.requests.filter((request) => request.httpMethod !== "GET");
    expect(authenticated.length).toBeGreaterThan(4);
    expect(authenticated.every((request) => request.headers.authorization === `Bearer ${credential}`)).toBe(true);
    expect(server.requests.filter((request) => request.rpcMethod === "tools/call").map((request) => (request.body as { params: { name: string } }).params.name))
      .not.toContain("admin_reset");
    expect(server.requests.filter((request) => request.httpMethod === "DELETE")).toHaveLength(2);
    expect(server.sessions.size).toBe(0);
    expect(reports.map((report) => report.event)).toEqual(expect.arrayContaining(["remote_mcp.refused", "remote_mcp.describe", "remote_mcp.call"]));
    expectNoCredential(reports);
  });

  it("sends the raw credential in a configured header", async () => {
    const server = await fake({ credential, credentialHeader: "X-Api-Key" });
    const { catalog } = client({ url: server.url, auth: { secret: "docs-search-token", header: "X-Api-Key" } });
    const session = catalog.session([{ server: "docs-search", tools: ["search"] }]);
    expect(await session.call("mcp_docs_search_search", { query: "header" })).toMatchObject({ ok: true });
    await session.close();
    expect(server.requests.every((request) => request.headers["x-api-key"] === credential && request.headers.authorization === undefined)).toBe(true);
  });

  it("handles event streams with server pings, split CRLF events, notifications, and stream resumption", async () => {
    const pinging = await fake({ credential, mode: "sse", pingBeforeResponse: true });
    const first = client({ url: pinging.url }).catalog.session([{ server: "docs-search", tools: ["search"] }]);
    expect(await first.call("mcp_docs_search_search", { query: "stream" })).toEqual({ ok: true, text: "Results for stream", truncated: false });
    expect(pinging.clientReplies).toEqual([expect.objectContaining({ jsonrpc: "2.0", result: {} })]);
    await first.close();
    const resuming = await fake({ credential, mode: "sse", resumeAfterClose: true });
    const second = client({ url: resuming.url }).catalog.session([{ server: "docs-search", tools: ["search"] }]);
    expect(await second.call("mcp_docs_search_search", { query: "resumed" })).toMatchObject({ ok: true, text: "Results for resumed" });
    expect(resuming.requests.find((request) => request.httpMethod === "GET")?.headers["last-event-id"]).toBe("prime-1");
    await second.close();
  });

  it("keeps conversations in separate MCP sessions and starts a new session once when the server expires one", async () => {
    const server = await fake({ credential });
    const { catalog } = client({ url: server.url });
    const selection = [{ server: "docs-search", tools: ["search"] }];
    const one = catalog.session(selection);
    const two = catalog.session(selection);
    await one.call("mcp_docs_search_search", { query: "one" });
    await two.call("mcp_docs_search_search", { query: "two" });
    const sessionIds = new Set(server.requests.filter((request) => request.rpcMethod === "tools/call").map((request) => request.headers["mcp-session-id"]));
    expect(sessionIds.size).toBe(2);
    server.expireSessions();
    expect(await one.call("mcp_docs_search_search", { query: "again" })).toMatchObject({ ok: true, text: "Results for again" });
    expect(server.requests.filter((request) => request.rpcMethod === "initialize")).toHaveLength(3);
    expect(server.requests.at(-1)?.headers["mcp-protocol-version"]).toBe("2025-11-25");
    await Promise.all([one.close(), two.close()]);
  });

  it("refuses loopback servers without the operator exception, internal endpoints even with it, and redirects always", async () => {
    const server = await fake();
    const { catalog: strict } = client({ url: server.url, auth: undefined, allowPrivateNetwork: false });
    const unavailable = await strict.describe([{ server: "docs-search", tools: ["search"] }]);
    expect(unavailable.tools[0]).toMatchObject({ available: false, inputSchema: { type: "object", additionalProperties: true } });
    const refused = await strict.session([{ server: "docs-search", tools: ["search"] }]).call("mcp_docs_search_search", { query: "x" });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("loopback address");
    expect(refused.text).not.toContain("127.0.0.1");
    const internal = await client({ url: server.url }, { internal: [{ host: "127.0.0.1", port: server.port }] }).catalog
      .session([{ server: "docs-search", tools: ["search"] }]).call("mcp_docs_search_search", { query: "x" });
    expect(internal.text).toContain("internal services");
    expect(server.requests).toEqual([]);

    const target = await fake();
    const redirecting = await fake({ redirectTo: target.url });
    const redirected = await client({ url: redirecting.url }).catalog.session([{ server: "docs-search", tools: ["search"] }]).call("mcp_docs_search_search", { query: "x" });
    expect(redirected.ok).toBe(false);
    expect(redirected.text).toContain("redirect");
    expect(target.requests).toEqual([]);
  });

  it("fails closed without a valid credential and sends nothing", async () => {
    const server = await fake({ credential });
    const cases: Array<Record<string, string>> = [{}, { MCP_SECRET_DOCS_SEARCH_TOKEN: "short" }, { MCP_SECRET_DOCS_SEARCH_TOKEN: `${credential}\r\nX-Injected: 1` }];
    for (const secrets of cases) {
      const result = await client({ url: server.url }, { secrets }).catalog.session([{ server: "docs-search", tools: ["search"] }])
        .call("mcp_docs_search_search", { query: "x" });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/credential/);
    }
    expect(server.requests).toEqual([]);
    const wrong = await client({ url: server.url }, { secrets: { MCP_SECRET_DOCS_SEARCH_TOKEN: "a-different-synthetic-value" } }).catalog
      .session([{ server: "docs-search", tools: ["search"] }]).call("mcp_docs_search_search", { query: "x" });
    expect(wrong.text).toContain("rejected the configured credential (HTTP 401)");
  });

  it("bounds time, size, and protocol: timeouts, cancellation, oversized and truncated results, incompatible versions", async () => {
    const server = await fake({ credential });
    const { catalog } = client({ url: server.url, timeoutSeconds: 1, maxResponseBytes: 256 * 1024 });
    const session = catalog.session([{ server: "docs-search", tools: ["slow", "big"] }]);
    const started = Date.now();
    const timedOut = await session.call("mcp_docs_search_slow", {});
    expect(timedOut).toMatchObject({ ok: false });
    expect(timedOut.text).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
    const controller = new AbortController();
    const pending = session.call("mcp_docs_search_slow", {}, controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect((await pending).text).toContain("cancelled");
    await expect.poll(() => server.cancellations.length).toBe(1);
    const tooLarge = await session.call("mcp_docs_search_big", { bytes: 512 * 1024 });
    expect(tooLarge.text).toContain("larger than the allowed size");
    const bounded = await session.call("mcp_docs_search_big", { bytes: 100_000 });
    expect(bounded).toMatchObject({ ok: true, truncated: true });
    expect(bounded.text.length).toBeLessThan(70_000);
    await session.close();

    const old = await fake({ credential, protocolVersion: "2024-11-05" });
    const incompatible = await client({ url: old.url }).catalog.session([{ server: "docs-search", tools: ["search"] }]).call("mcp_docs_search_search", { query: "x" });
    expect(incompatible.text).toContain("compatible protocol version");
  });
});
