import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { SharedConnection, SharedSessionView } from "@copilot-agent/contracts";
import { migrate } from "@copilot-agent/job-store";
import { EgressFilter, environmentSecretResolver } from "@copilot-agent/service-defaults";
import { createSharedEgress } from "../../src/session-host/src/shared-egress.js";
import { SHARED_TOOL_OUTPUT_BYTES, SHARED_TOOL_RESULT_LIMIT_BYTES } from "../../src/session-host/src/tool-output.js";
import { FakeMcpServer } from "../fakes/fake-mcp-server.js";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";
import { sharedStack, type SharedStack } from "./fixtures/shared-stack.js";
import { inspect, syntheticModel, type SyntheticModel } from "./fixtures/synthetic-model.js";

const enabled = process.env.HYBRID_CLI_TESTS === "1";

// Real MCP servers return results above the runtime's 20 KiB large-output threshold (Microsoft Learn's docs search
// returned 22.7 KB in the real-model demonstration). With a client attached, the runtime moved such a result into a
// file and gave the model a pointer that no shared tool can read, even though the shared session disables that. Every
// shared tool that can return more therefore bounds its own result: here a workspace read, a search, a web page of
// three-byte characters, and a remote MCP result, all in one turn while the CLI is attached.
it.skipIf(!enabled)("gives the model large shared tool results inline, bounded, while a CLI is attached", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const root = await mkdtemp(join(tmpdir(), "shared-large-output-"));
  const principal = `large-output-${randomUUID().slice(0, 8)}`;
  const key = `large-output-key-${randomUUID()}`;
  const mcp = new FakeMcpServer();
  const page = "中文字符".repeat(10_000);
  const site = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(page); });
  const note = Array.from({ length: 110 }, (_, index) => `${String(index).padStart(4, "0")} "needle" café 中文 ${"a".repeat(240)}\n`).join("");
  const sessions: string[] = [];
  let model: SyntheticModel | undefined;
  let stack: SharedStack | undefined;
  let cli: QualificationCli | undefined;
  try {
    await migrate(pool);
    await mcp.start();
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const port = (site.address() as AddressInfo).port;
    const steps = [
      { name: "write_workspace_file", arguments: { path: "notes/big.md", content: note } },
      { name: "read_workspace_file", arguments: { path: "notes/big.md", length: 32 * 1024 } },
      { name: "search_workspace_files", arguments: { query: "needle", maxResults: 200 } },
      { name: "web_fetch", arguments: { url: `http://docs.example:${port}/cjk`, max_length: 20_000 } },
      { name: "mcp_docs_search_big", arguments: { bytes: 100_000 } },
    ];
    model = await syntheticModel((request) => {
      if (!inspect.lastUser(request).includes("LARGE RESULTS")) return { content: "LARGE_OUTPUT_READY" };
      const step = steps[inspect.called(request).length];
      return step ? { call: step } : { content: "LARGE_OUTPUT_DONE" };
    });
    const registry = await sharedRegistry([sharedHarness("large-output", {
      builtinTools: ["files", "web"], mcpServers: [{ server: "docs-search", tools: ["big"] }],
      permissions: { default: "allow", kinds: { read: "allow", write: "allow", url: "allow" } },
    })], {
      mcpServers: { "docs-search": { url: mcp.url, allowPrivateNetwork: true, tools: ["big"] } },
    }, { "large-output": { hosting: { modes: ["shared"] } } });
    // A public-looking name for the loopback test site; only this test seam routes it there.
    const egress = new EgressFilter({
      testing: {
        resolve: async (name) => {
          if (name !== "docs.example.") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
          return [{ address: "93.184.216.34", family: 4 }];
        },
        dial: (target) => (target.address === "93.184.216.34" ? { address: "127.0.0.1", family: 4 } : target),
      },
    });
    stack = await sharedStack({
      pool, root, registry, admission: sharedAdmission(registry), modelUrl: model.url,
      egress: createSharedEgress({ egress, secrets: environmentSecretResolver({}) }),
      principals: { [principal]: githubUserId }, apiKeys: { [principal]: key },
    });
    const headers = { authorization: `Bearer ${key}` };
    const session = SharedSessionView.parse((await stack.api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "large-output" } })).json());
    sessions.push(session.id);
    const connection = SharedConnection.parse((await stack.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers })).json());
    await mkdir(join(root, "cli"));
    cli = new QualificationCli(join(root, "cli"), credential);
    await cli.connect(connection);
    await cli.send("LARGE RESULTS");
    await cli.waitFor("LARGE_OUTPUT_DONE", 180_000);
    const [, read, search, web, remote] = inspect.results(model.requests.at(-1)!).slice(-steps.length);
    for (const [name, result] of [["read", read], ["search", search], ["web", web], ["mcp", remote]] as const) {
      expect(result, name).toBeDefined();
      expect(result, name).not.toContain("Output too large");
      expect(Buffer.byteLength(result!, "utf8"), name).toBeLessThanOrEqual(SHARED_TOOL_RESULT_LIMIT_BYTES);
    }
    // Each result says what it left out and how to continue.
    const part = JSON.parse(read!) as { data: string; nextOffset: number; note: string };
    expect(Buffer.byteLength(read!, "utf8")).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
    expect(note.startsWith(part.data)).toBe(true);
    expect(part.note).toBe(`More remains: call read_workspace_file with offset ${part.nextOffset} to continue.`);
    expect(JSON.parse(search!)).toMatchObject({ truncated: true, note: expect.stringContaining("result size limit") });
    const end = Number(/start_index=(\d+) to continue/.exec(web!)?.[1]);
    expect(end).toBeGreaterThan(5000);
    expect(web).toContain(page.slice(0, end));
    expect(remote).toContain("x".repeat(16_000));
    expect(remote).toContain("[Result truncated at 16 KiB");
    expect(model.errors).toEqual([]);
  } catch (error) {
    throw new Error(`Large-output CLI gate failed.\n${(cli?.output ?? "").slice(-4000).split(credential).join("[redacted]")}`, { cause: error });
  } finally {
    try { await cli?.stop(); }
    finally {
      try {
        await stack?.close(); await model?.close(); await mcp.stop();
        if (site.listening) await new Promise<void>((resolve) => site.close(() => resolve()));
      }
      finally {
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
}, 300_000);
