import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { EgressFilter, environmentSecretResolver } from "@copilot-agent/service-defaults";
import { createSharedEgress } from "../../src/session-host/src/shared-egress.js";
import { FakeMcpServer } from "../fakes/fake-mcp-server.js";

const credential = "synthetic-adapter-credential-0001";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

const invoke = async (tool: { handler?: (args: never, invocation: ToolInvocation) => unknown }, args: Record<string, unknown>) =>
  await tool.handler!(args as never, { sessionId: "s", toolCallId: "c", toolName: "t", arguments: args }) as ToolResultObject;

function testEgress(): EgressFilter {
  return new EgressFilter({
    testing: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      dial: (target) => (target.address === "93.184.216.34" ? { address: "127.0.0.1", family: 4 } : target),
    },
  });
}

describe("shared egress adapter", () => {
  it("gives an activation a filtered web_fetch whose in-flight requests stop with the activation", async () => {
    const site: Server = createServer((request, response) => {
      if (request.url === "/hang") return;
      response.writeHead(200, { "content-type": "text/plain" }).end("adapter page");
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { site.closeAllConnections(); site.close(() => resolve()); }));
    const port = (site.address() as AddressInfo).port;
    const egress = createSharedEgress({ egress: testEgress() });
    const activation = new AbortController();
    const tool = egress.webFetch({ sessionId: "s", signal: activation.signal, urlRule: "ask" });
    expect(tool.name).toBe("web_fetch");
    expect((await invoke(tool, { url: `http://docs.example:${port}/` })).textResultForLlm).toContain("adapter page");
    const pending = invoke(tool, { url: `http://docs.example:${port}/hang` });
    setTimeout(() => activation.abort(), 100);
    expect(await pending).toEqual({ resultType: "failure", textResultForLlm: "The fetch failed: The request was cancelled." });
    expect((await invoke(egress.webFetch({ sessionId: "s", signal: new AbortController().signal, urlRule: "deny" }), { url: `http://docs.example:${port}/` })).resultType).toBe("denied");
  });

  it("connects an activation to the approved remote tools from the effective policy and ends its MCP session with it", async () => {
    const server = await new FakeMcpServer({ credential }).start();
    closers.push(() => server.stop());
    const reports: unknown[] = [];
    const egress = createSharedEgress({
      egress: new EgressFilter(), secrets: environmentSecretResolver({ MCP_SECRET_DOCS_SEARCH_TOKEN: credential }), report: (event, detail) => reports.push({ event, ...detail }),
    });
    const policy = { url: server.url, description: "Docs", auth: { secret: "docs-search-token" }, tools: ["search", "fetch_page"], allowPrivateNetwork: true };
    const first = new AbortController();
    const connection = await egress.connectMcp([{ name: "docs-search", policy, tools: ["search", "admin_reset"] }], { sessionId: "one", signal: first.signal });
    expect(connection.tools.map((tool) => tool.name)).toEqual(["mcp_docs_search_search"]);
    expect(connection.refused).toEqual([{ server: "docs-search", tool: "admin_reset", reason: "unapproved_tool" }]);
    expect(connection.descriptors[0]).toMatchObject({ server: "docs-search", tool: "search", readOnly: true });
    expect(await invoke(connection.tools[0]!, { query: "adapter" })).toEqual({ resultType: "success", textResultForLlm: "Results for adapter" });
    const second = await egress.connectMcp([{ name: "docs-search", policy, tools: ["search"] }], { sessionId: "two", signal: new AbortController().signal });
    expect(server.requests.filter((request) => request.rpcMethod === "tools/list")).toHaveLength(1);
    first.abort();
    await expect.poll(() => server.requests.filter((request) => request.httpMethod === "DELETE").length).toBe(2);
    expect(await invoke(connection.tools[0]!, { query: "after close" })).toMatchObject({ resultType: "failure" });
    await second.close();
    expect(JSON.stringify(reports)).not.toContain(credential);
  });
});
