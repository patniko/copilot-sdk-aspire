import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { z } from "zod";
import { CopilotClient, RuntimeConnection, type PermissionRequestResult } from "@github/copilot-sdk";
import { expect, inject, it } from "vitest";
import { migrate, SessionFileStore } from "@copilot-agent/job-store";
import { EgressFilter, environmentSecretResolver, RemoteMcpCatalogClient } from "@copilot-agent/service-defaults";
import { SharedSessionRuntime } from "../../src/session-host/src/runtime.js";
import { webFetchPermissionRequest, webFetchTool } from "../../src/session-host/src/web-fetch.js";
import { remoteMcpToolFor, remoteMcpTools } from "../../src/session-host/src/remote-mcp-tools.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { FakeMcpServer } from "../fakes/fake-mcp-server.js";

const enabled = process.env.HYBRID_SESSION_RUNTIME_TESTS === "1";
const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const wire = z.object({
  stream: z.boolean().optional(),
  messages: z.array(z.object({
    role: z.string(), content: z.unknown().optional(),
    tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string(), description: z.string().optional() }).passthrough() })).default([]),
}).passthrough();

/** A synthetic OpenAI-compatible model that makes the planned tool calls in order, then answers. */
function syntheticModel(plan: () => Array<{ name: string; arguments: object }>, record: { bodies: string[]; errors: string[]; finished: boolean; advertised: Array<{ name: string; description?: string }> }): Server {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.once("end", () => {
      try {
        record.bodies.push(body);
        const payload = wire.parse(JSON.parse(body));
        record.advertised = payload.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description }));
        const next = plan()[payload.messages.flatMap((message) => message.tool_calls ?? []).length];
        if (!next) record.finished = true;
        const toolCall = next ? { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.arguments) } } : undefined;
        const base = { id: randomUUID(), model: "qualification-model", created: Math.floor(Date.now() / 1000) };
        const usage = { prompt_tokens: 50, completion_tokens: 10 };
        const delta = { role: "assistant", ...(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: "EGRESS_RUNTIME_DONE" }) };
        if (!payload.stream) {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            ...base, object: "chat.completion", usage,
            choices: [{ index: 0, message: { role: "assistant", content: toolCall ? null : "EGRESS_RUNTIME_DONE", ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? "tool_calls" : "stop" }],
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        record.errors.push(error instanceof Error ? error.message : "Synthetic inference failed.");
        response.writeHead(500).end();
      }
    });
  });
}

/** A public-looking name for the loopback test site; only these test seams route it there. */
function webEgress(): EgressFilter {
  return new EgressFilter({
    testing: {
      resolve: async (name) => {
        const answers: Record<string, string> = { "docs.example.": "93.184.216.34", "other.example.": "93.184.216.35" };
        if (!answers[name]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
        return [{ address: answers[name], family: 4 }];
      },
      dial: (target) => (target.address.startsWith("93.184.216.") ? { address: "127.0.0.1", family: 4 } : target),
    },
  });
}

function website(): Server {
  return createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
      .end(`<html><head><title>Runtime page</title></head><body><h1>Shared sessions</h1><p>Served at ${request.url}</p></body></html>`);
  });
}

it.skipIf(!enabled)("lets a shared in-process session use the filtered web tool and an approved remote MCP tool without exposing the credential", async () => {
  await localRuntimeArtifacts();
  const credential = `synthetic-runtime-mcp-credential-${randomUUID()}`;
  const forms = [credential, Buffer.from(credential).toString("base64")];
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const root = await mkdtemp(join(tmpdir(), "shared-egress-runtime-"));
  const id = randomUUID();
  const record = { bodies: [] as string[], errors: [] as string[], finished: false, advertised: [] as Array<{ name: string; description?: string }> };
  const { bodies, errors } = record;
  const events: unknown[] = [];
  const reports: unknown[] = [];
  let runtime: SharedSessionRuntime | undefined;
  const site = website();
  const mcp = new FakeMcpServer({ credential, echoCredential: true, mode: "sse" });
  let sitePort = 0;
  // Fetch a page, try the metadata address, call two remote MCP tools, then answer.
  const upstream = syntheticModel(() => [
    { name: "web_fetch", arguments: { url: `http://docs.example:${sitePort}/runtime-page` } },
    { name: "web_fetch", arguments: { url: "http://169.254.169.254/latest/meta-data/" } },
    { name: "docs-search__search", arguments: { query: "egress" } },
    { name: "docs-search__leak", arguments: {} },
  ], record);
  try {
    await migrate(pool);
    for (const server of [site, upstream]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    sitePort = (site.address() as AddressInfo).port;
    await mcp.start();
    const catalog = new RemoteMcpCatalogClient({
      catalog: { "docs-search": { url: mcp.url, allowPrivateNetwork: true, auth: { secret: "docs-search-token" }, tools: ["search", "leak"] } },
      egress: new EgressFilter(),
      secrets: environmentSecretResolver({ MCP_SECRET_DOCS_SEARCH_TOKEN: credential }),
      report: (event, detail) => reports.push({ event, ...detail }),
    });
    const selection = [{ server: "docs-search", tools: ["search", "leak", "admin_reset"] }];
    const described = await catalog.describe(selection);
    const mcpSession = catalog.session(selection);
    runtime = new SharedSessionRuntime(root, new SessionFileStore(pool), () => undefined, 1);
    await runtime.start();
    await runtime.open({
      id, principal: "egress-principal", githubUserId: 1, model: "qualification-model",
      instructions: "Synthetic shared session for the egress qualification.",
      provider: { type: "openai", baseUrl: address(upstream), apiKey: "synthetic-unused", wireApi: "completions" },
      tools: () => [
        webFetchTool({ egress: webEgress(), urlRule: "allow", report: (event, detail) => reports.push({ event, ...detail }) }),
        ...remoteMcpTools(described.tools, mcpSession),
      ],
      hooks: () => ({ onPreToolUse: async () => ({ permissionDecision: "allow" }) }),
      onEvent: (_context, event) => { events.push(event); },
    });
    await runtime.sendSystem(id, "Use the web and remote MCP tools as planned.");
    const deadline = Date.now() + 60_000;
    const types = () => events.map((event) => (event as { type?: string }).type);
    while (!record.finished || !types().includes("session.idle")) {
      if (errors.length) throw new Error(errors.join("\n"));
      if (Date.now() > deadline || (types().includes("session.idle") && !record.finished)) {
        const last = bodies.at(-1) ? wire.parse(JSON.parse(bodies.at(-1)!)).messages.slice(-2) : [];
        throw new Error(`The turn ended early after ${bodies.length} model calls; events: ${types().join(",")}; last messages: ${JSON.stringify(last).slice(0, 3000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await mcpSession.close();

    const advertised = record.advertised;
    const names = advertised.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["web_fetch", "docs-search__search", "docs-search__leak"]));
    expect(names).not.toContain("docs-search__admin_reset");
    expect(advertised.find((tool) => tool.name === "web_fetch")?.description).toContain("Local, private, and internal network addresses are refused");
    const toolResults = (index: number) => JSON.stringify(wire.parse(JSON.parse(bodies[index]!)).messages.filter((message) => message.role === "tool").at(-1)?.content);
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    expect(toolResults(1)).toContain("Shared sessions");
    expect(toolResults(1)).toContain("untrusted data from the web");
    expect(toolResults(2)).toContain("cloud metadata address");
    expect(toolResults(3)).toContain("Results for egress");
    expect(toolResults(4)).toContain("[redacted]");
    const stored = await pool.query<{ content: Buffer | null }>("SELECT content FROM session_files WHERE namespace_id=$1", [id]);
    for (const text of [...bodies, JSON.stringify(events), JSON.stringify(reports), ...stored.rows.map((row) => row.content?.toString("utf8") ?? "")]) {
      for (const form of forms) expect(text).not.toContain(form);
    }
    expect(mcp.requests.some((request) => request.headers.authorization === `Bearer ${credential}`)).toBe(true);
  } finally {
    try { await runtime?.stop(); }
    finally {
      try {
        await mcp.stop();
        for (const server of [site, upstream]) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [id]);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}, 120_000);

it.skipIf(!enabled)("routes web_fetch and remote MCP approvals through the runtime's permission requests", async () => {
  await localRuntimeArtifacts();
  const root = await mkdtemp(join(tmpdir(), "shared-egress-permissions-"));
  const record = { bodies: [] as string[], errors: [] as string[], finished: false, advertised: [] as Array<{ name: string; description?: string }> };
  const site = website();
  const hits: string[] = [];
  site.on("request", (request) => hits.push(`${request.headers.host}${request.url}`));
  const mcp = new FakeMcpServer();
  let sitePort = 0;
  // An approved fetch, an approved MCP call, then a fetch the person refuses.
  const upstream = syntheticModel(() => [
    { name: "web_fetch", arguments: { url: `http://docs.example:${sitePort}/approved` } },
    { name: "docs-search__search", arguments: { query: "permissions" } },
    { name: "web_fetch", arguments: { url: `http://other.example:${sitePort}/refused` } },
  ], record);
  const client = new CopilotClient({
    connection: RuntimeConnection.forInProcess(), mode: "empty", baseDirectory: join(root, "runtime"), useLoggedInUser: false, logLevel: "error",
  });
  const prompts: unknown[] = [];
  try {
    for (const server of [site, upstream]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    sitePort = (site.address() as AddressInfo).port;
    await mcp.start();
    const catalog = new RemoteMcpCatalogClient({
      catalog: { "docs-search": { url: mcp.url, allowPrivateNetwork: true, tools: ["search"] } },
      egress: new EgressFilter(), secrets: environmentSecretResolver({}),
    });
    const selection = [{ server: "docs-search", tools: ["search"] }];
    const described = await catalog.describe(selection);
    const mcpSession = catalog.session(selection);
    const tools = [webFetchTool({ egress: webEgress(), urlRule: "ask" }), ...remoteMcpTools(described.tools, mcpSession)];
    await client.start();
    const session = await client.createSession({
      model: "qualification-model", streaming: true, workingDirectory: root,
      provider: { type: "openai", baseUrl: address(upstream), apiKey: "synthetic-unused", wireApi: "completions" },
      tools, availableTools: tools.map((tool) => `custom:${tool.name}`), enableConfigDiscovery: false, skipCustomInstructions: true,
      // Stands in for the host's approval-mode handler: the harness rule for web_fetch is `url`, not the default.
      onPermissionRequest: async (request): Promise<PermissionRequestResult> => {
        const url = webFetchPermissionRequest(request);
        if (url) {
          prompts.push(url);
          return new URL(url.url).hostname === "docs.example" ? { kind: "approve-once" } : { kind: "reject", feedback: "The person declined." };
        }
        const remote = request.kind === "custom-tool" ? remoteMcpToolFor(described.tools, request.toolName) : undefined;
        if (remote) {
          prompts.push({ kind: "mcp", ...remote });
          return { kind: "approve-once" };
        }
        return { kind: "reject", feedback: "Unexpected permission request." };
      },
    });
    try { await session.sendAndWait({ prompt: "Fetch, search, then fetch again." }, 60_000); }
    finally { await session.disconnect(); }
    await mcpSession.close();
    if (record.errors.length) throw new Error(record.errors.join("\n"));
    expect(prompts).toEqual([
      expect.objectContaining({ kind: "url", url: `http://docs.example:${sitePort}/approved`, intention: "Fetch a web page for the conversation" }),
      { kind: "mcp", server: "docs-search", tool: "search", readOnly: true },
      expect.objectContaining({ kind: "url", url: `http://other.example:${sitePort}/refused` }),
    ]);
    expect(hits).toEqual([`docs.example:${sitePort}/approved`]);
    expect(record.bodies.some((body) => body.includes("Results for permissions"))).toBe(true);
  } finally {
    try { expect(await client.stop()).toEqual([]); }
    finally {
      await mcp.stop();
      for (const server of [site, upstream]) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);
