import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { SharedConnection, SharedSessionView } from "@copilot-agent/contracts";
import { migrate } from "@copilot-agent/job-store";
import { EgressFilter, environmentSecretResolver } from "@copilot-agent/service-defaults";
import { createSharedEgress } from "../../src/session-host/src/shared-egress.js";
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
// file and gave the model a pointer that no shared tool can read, even though the shared session disables that.
it.skipIf(!enabled)("gives the model a large remote MCP result inline, bounded, while a CLI is attached", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const root = await mkdtemp(join(tmpdir(), "shared-large-output-"));
  const principal = `large-output-${randomUUID().slice(0, 8)}`;
  const key = `large-output-key-${randomUUID()}`;
  const mcp = new FakeMcpServer();
  const sessions: string[] = [];
  let model: SyntheticModel | undefined;
  let stack: SharedStack | undefined;
  let cli: QualificationCli | undefined;
  try {
    await migrate(pool);
    await mcp.start();
    model = await syntheticModel((request) => {
      if (!inspect.lastUser(request).includes("SEARCH BIG")) return { content: "LARGE_OUTPUT_READY" };
      return inspect.called(request).includes("mcp_docs_search_big")
        ? { content: "LARGE_OUTPUT_DONE" }
        : { call: { name: "mcp_docs_search_big", arguments: { bytes: 100_000 } } };
    });
    const registry = await sharedRegistry([sharedHarness("large-output", {
      builtinTools: ["files"], mcpServers: [{ server: "docs-search", tools: ["big"] }],
      permissions: { default: "allow", kinds: { read: "allow", write: "allow" } },
    })], {
      mcpServers: { "docs-search": { url: mcp.url, allowPrivateNetwork: true, tools: ["big"] } },
    }, { "large-output": { hosting: { modes: ["shared"] } } });
    stack = await sharedStack({
      pool, root, registry, admission: sharedAdmission(registry), modelUrl: model.url,
      egress: createSharedEgress({ egress: new EgressFilter(), secrets: environmentSecretResolver({}) }),
      principals: { [principal]: githubUserId }, apiKeys: { [principal]: key },
    });
    const headers = { authorization: `Bearer ${key}` };
    const session = SharedSessionView.parse((await stack.api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "large-output" } })).json());
    sessions.push(session.id);
    const connection = SharedConnection.parse((await stack.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers })).json());
    await mkdir(join(root, "cli"));
    cli = new QualificationCli(join(root, "cli"), credential);
    await cli.connect(connection);
    await cli.send("SEARCH BIG");
    await cli.waitFor("LARGE_OUTPUT_DONE", 120_000);
    const result = inspect.results(model.requests.at(-1)!).at(-1) ?? "";
    expect(result).not.toContain("Output too large");
    expect(result).toContain("x".repeat(16_000));
    expect(result).toContain("[Result truncated at 16 KiB");
    expect(model.errors).toEqual([]);
  } catch (error) {
    throw new Error(`Large-output CLI gate failed.\n${(cli?.output ?? "").slice(-4000).split(credential).join("[redacted]")}`, { cause: error });
  } finally {
    try { await cli?.stop(); }
    finally {
      try { await stack?.close(); await model?.close(); await mcp.stop(); }
      finally {
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
}, 300_000);
