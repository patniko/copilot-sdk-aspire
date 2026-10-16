import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
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

it.skipIf(!enabled)("serves two shared harnesses to two principals on one worker over direct WSS with filtered web and remote MCP and no containers", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const mcpCredential = `gate-mcp-credential-${randomUUID()}`;
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const root = await mkdtemp(join(tmpdir(), "shared-gate-"));
  const alice = `gate-alice-${randomUUID().slice(0, 8)}`;
  const bob = `gate-bob-${randomUUID().slice(0, 8)}`;
  const keys = { [alice]: `alice-key-${randomUUID()}`, [bob]: `bob-key-${randomUUID()}` };
  const as = (principal: string) => ({ authorization: `Bearer ${keys[principal]}` });
  const sessions: string[] = [];
  const events: string[] = [];
  const reports: unknown[] = [];
  const hits: string[] = [];
  let port = 0;
  const site = createServer((request, response) => {
    hits.push(request.url ?? "");
    if (request.url === "/redirect-internal") return void response.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
    response.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>Gate</title></head><body><p>Shared gate page at ${request.url}</p></body></html>`);
  });
  const mcp = new FakeMcpServer({ credential: mcpCredential, echoCredential: true });
  let model: SyntheticModel | undefined;
  let stack: SharedStack | undefined;
  const clis: QualificationCli[] = [];
  try {
    await migrate(pool);
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    port = (site.address() as AddressInfo).port;
    await mcp.start();
    // Each step of the plan is one tool call; the model answers once the plan is exhausted.
    const research = [
      { name: "web_fetch", arguments: { url: `http://docs.example:${port}/page` } },
      { name: "web_fetch", arguments: { url: "http://169.254.169.254/latest/meta-data/" } },
      { name: "web_fetch", arguments: { url: `http://127.0.0.1:${port}/secret` } },
      { name: "web_fetch", arguments: { url: "http://10.0.0.7/internal" } },
      { name: "web_fetch", arguments: { url: `http://docs.example:${port}/redirect-internal` } },
      { name: "mcp_docs_search_search", arguments: { query: "shared gate" } },
      { name: "mcp_docs_search_leak", arguments: {} },
    ];
    model = await syntheticModel((request) => {
      const system = inspect.system(request);
      const calls = inspect.called(request);
      if (system.includes("GATE_RESEARCHER") && inspect.lastUser(request).includes("RESEARCH")) {
        const next = research[calls.length];
        return next ? { call: next } : { content: "RESEARCH_DONE" };
      }
      if (system.includes("GATE_NOTES") && inspect.lastUser(request).includes("NOTE")) {
        return calls.includes("write_workspace_file")
          ? { content: "NOTE_DONE" }
          : { call: { name: "write_workspace_file", arguments: { path: "notes.md", content: "Written for the second principal." } } };
      }
      return { content: "GATE_OK" };
    });
    const registry = await sharedRegistry([
      sharedHarness("gate-researcher", {
        instructions: "GATE_RESEARCHER: research with the web and remote MCP tools.",
        builtinTools: ["files", "web"], mcpServers: [{ server: "docs-search", tools: ["search", "leak"] }],
        permissions: { default: "allow", kinds: { read: "allow", write: "allow", url: "allow" } },
      }),
      sharedHarness("gate-notes", {
        instructions: "GATE_NOTES: keep notes in the workspace.", builtinTools: ["files"],
        permissions: { default: "deny", kinds: { read: "allow", write: "allow" } },
      }),
    ], {
      mcpServers: { "docs-search": { url: mcp.url, allowPrivateNetwork: true, auth: { secret: "docs-search-token" }, tools: ["search", "leak"] } },
    }, {
      "gate-researcher": { hosting: { modes: ["shared"], transports: ["direct"] }, approvalModes: ["manual", "assisted"] },
      "gate-notes": { hosting: { modes: ["shared"] } },
    });
    // A public-looking name for the loopback test site; only this test seam routes it there.
    const egress = createSharedEgress({
      egress: new EgressFilter({
        testing: {
          resolve: async (name) => {
            if (name !== "docs.example.") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
            return [{ address: "93.184.216.34", family: 4 }];
          },
          dial: (target) => (target.address === "93.184.216.34" ? { address: "127.0.0.1", family: 4 } : target),
        },
      }),
      secrets: environmentSecretResolver({ MCP_SECRET_DOCS_SEARCH_TOKEN: mcpCredential }),
      report: (event, detail) => reports.push({ event, ...detail }),
    });
    stack = await sharedStack({
      pool, root, registry, admission: sharedAdmission(registry), modelUrl: model.url, egress,
      principals: { [alice]: githubUserId, [bob]: githubUserId }, apiKeys: keys, workerLimits: { residentSessions: 4, activeTurns: 2 },
      report: (event) => events.push(event),
    });
    const api = stack.api;
    const create = async (principal: string, harness: string) => {
      const response = await api.inject({ method: "POST", url: "/v1/sessions", headers: as(principal), payload: { harness } });
      expect(response.statusCode, response.body).toBe(201);
      const view = SharedSessionView.parse(response.json());
      sessions.push(view.id);
      return view;
    };
    const connect = async (principal: string, id: string) => {
      const response = await api.inject({ method: "POST", url: `/v1/sessions/${id}/connection`, headers: as(principal), payload: { transport: "direct" } });
      expect(response.statusCode, response.body).toBe(200);
      return SharedConnection.parse(response.json());
    };
    const researcher = await create(alice, "gate-researcher");
    const notes = await create(bob, "gate-notes");
    expect(researcher).toMatchObject({ mode: "shared", placement: "shared", harness: { name: "gate-researcher" }, segment: { generation: 1, ahpSessionId: researcher.id } });
    expect(notes).toMatchObject({ mode: "shared", placement: "shared", harness: { name: "gate-notes" } });

    // Principal isolation at the API: another principal cannot see, connect to, or close a session.
    expect((await api.inject({ method: "GET", url: `/v1/sessions/${researcher.id}`, headers: as(bob) })).statusCode).toBe(404);
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${researcher.id}/connection`, headers: as(bob) })).statusCode).toBe(404);
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${researcher.id}/close`, headers: as(bob), payload: {} })).statusCode).toBe(404);
    expect((await api.inject({ method: "GET", url: "/v1/sessions", headers: as(bob) })).json().sessions.map((view: { id: string }) => view.id)).toEqual([notes.id]);
    // The GitHub relay is refused for a shared harness before anything is activated.
    const relay = await api.inject({ method: "POST", url: `/v1/sessions/${researcher.id}/connection`, headers: as(alice), payload: { transport: "github" } });
    expect(relay.statusCode).toBe(422);
    expect(relay.json().error.code).toBe("transport_unsupported");
    expect(stack.service.residentCount).toBe(0);

    await mkdir(join(root, "cli-alice"));
    await mkdir(join(root, "cli-bob"));
    const aliceCli = new QualificationCli(join(root, "cli-alice"), credential);
    clis.push(aliceCli);
    await aliceCli.connect(await connect(alice, researcher.id));
    await aliceCli.send("RESEARCH the shared gate");
    await aliceCli.waitFor("RESEARCH_DONE", 120_000);

    // Ticket isolation: a ticket issued for one principal's session cannot open another principal's session.
    const spare = await connect(alice, researcher.id);
    expect(await stack.service.resolveConnection(`/sessions/${notes.id}`, spare.token)).toBeUndefined();
    const bobCli = new QualificationCli(join(root, "cli-bob"), credential);
    clis.push(bobCli);
    await bobCli.connect(await connect(bob, notes.id));
    await bobCli.send("NOTE for the second principal");
    await bobCli.waitFor("NOTE_DONE", 120_000);
    // Both harnesses are resident on the same worker at the same time, each for its own principal.
    expect(stack.service.residentsByHarness()).toEqual({ "gate-researcher": 1, "gate-notes": 1 });

    // Filtered web access and remote MCP, with every refused address kept off the network.
    const final = model.requests.filter((request) => inspect.system(request).includes("GATE_RESEARCHER")).at(-1)!;
    const results = inspect.results(final);
    expect(results).toHaveLength(research.length);
    expect(results[0]).toContain("Shared gate page at /page");
    for (const index of [1, 2, 3, 4]) expect(results[index], research[index]!.arguments.url).toMatch(/refused/i);
    expect(results[1]).toContain("metadata");
    expect(results[5]).toContain("Results for shared gate");
    expect(results[6]).toContain("[redacted]");
    expect(hits).toEqual(["/page", "/redirect-internal"]);
    expect(mcp.requests.some((request) => request.headers.authorization === `Bearer ${mcpCredential}`)).toBe(true);


    // No container was allocated for any of this work.
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM execution_allocations")).rows[0]!.count).toBe(0);
    // The MCP credential never reached the model, the terminals, the stored history, or the reports.
    const stored = await pool.query<{ content: Buffer | null }>("SELECT content FROM session_files WHERE namespace_id=ANY($1::uuid[])", [sessions]);
    for (const text of [...model.bodies, ...clis.map((cli) => cli.output), JSON.stringify(reports), JSON.stringify(events), ...stored.rows.map((row) => row.content?.toString("utf8") ?? "")]) {
      expect(text.includes(mcpCredential)).toBe(false);
      for (const grant of stack.grants) expect(text.includes(grant)).toBe(false);
    }
    expect(model.errors).toEqual([]);
    expect(events.filter((event) => event.endsWith("_failed"))).toEqual([]);
  } catch (error) {
    const tails = clis.map((cli) => cli.output.slice(-4000)).join("\n----\n").split(credential).join("[redacted]");
    throw new Error(`Shared gate failed.\n${tails}`, { cause: error });
  } finally {
    try { for (const cli of clis) await cli.stop(); }
    finally {
      try { await stack?.close(); await model?.close(); await mcp.stop(); }
      finally {
        if (site.listening) await new Promise<void>((resolve) => site.close(() => resolve()));
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
}, 420_000);
