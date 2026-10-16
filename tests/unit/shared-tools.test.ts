import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@github/copilot-sdk";
import { HarnessDefinition, SHARED_TOOLS } from "@copilot-agent/contracts";
import type { SessionFileLease, SharedSessionRecord } from "@copilot-agent/job-store";
import { buildSessionOptions } from "../../src/harness-hosting/src/session-config.js";
import type { SharedActivationPlan } from "../../src/session-host/src/admission.js";
import { BUILTIN_AGENTS, sharedSessionSettings } from "../../src/session-host/src/harness-session.js";
import type { SharedActivationContext } from "../../src/session-host/src/runtime.js";
import type { SharedEgress } from "../../src/session-host/src/shared-egress.js";
import { sharedToolset } from "../../src/session-host/src/toolkit.js";
import { delegationTools, taskListTools, workspaceTools } from "../../src/session-host/src/tools.js";
import { SHARED_TOOL_OUTPUT_BYTES, SHARED_TOOL_RESULT_LIMIT_BYTES } from "../../src/session-host/src/tool-output.js";
import { SessionWorkspace } from "../../src/session-host/src/workspace.js";
import { sharedHarness } from "../integration/fixtures/shared-harness.js";
import { fixtureFilesystem } from "../runtime/filesystem.js";

let root: string;
let context: SharedActivationContext;
let lifetime: AbortController;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shared-tools-test-"));
  const anchor = join(root, "anchor");
  await mkdir(anchor);
  const storage = fixtureFilesystem(join(root, "storage"), process.platform === "win32" ? "windows" : "posix");
  await storage.mkdir(anchor, true);
  lifetime = new AbortController();
  context = {
    lease: { id: "session", principal: "alice", epoch: "epoch" } as SessionFileLease,
    signal: lifetime.signal, workspace: new SessionWorkspace(anchor, storage, lifetime.signal, () => undefined),
    stateDirectory: join(root, "session-state"), runtimeSessionId: "session",
    humanMessages: async () => [],
  };
});
afterEach(async () => { lifetime.abort(); await rm(root, { recursive: true, force: true }); });

const byName = (tools: Array<{ tool: Tool }>) => new Map(tools.map(({ tool }) => [tool.name, tool]));
const call = async (tool: Tool | undefined, args: unknown) => {
  if (!tool) throw new Error("Missing tool.");
  return tool.handler!(args, { sessionId: "session", toolCallId: "call", toolName: tool.name, arguments: args } as never) as Promise<Record<string, unknown>>;
};

describe("shared workspace tools", () => {
  it("read, write, edit, list, and search files in the provider-backed workspace only", async () => {
    const entries = workspaceTools(context);
    expect(entries.map(({ tool, rule }) => [tool.name, rule.kind, rule.quietUnderAsk ?? false])).toEqual([
      [SHARED_TOOLS.readFile, "read", true], [SHARED_TOOLS.writeFile, "write", false], [SHARED_TOOLS.editFile, "write", false],
      [SHARED_TOOLS.listFiles, "read", true], [SHARED_TOOLS.searchFiles, "read", true],
    ]);
    const tools = byName(entries);
    await call(tools.get(SHARED_TOOLS.writeFile), { path: "notes/plan.md", content: "Alpha line\nbeta line\nGamma\n" });
    await expect(call(tools.get(SHARED_TOOLS.writeFile), { path: "notes/plan.md", content: "replaced" })).rejects.toThrow(/already exists/);
    const read = await call(tools.get(SHARED_TOOLS.readFile), { path: "notes/plan.md" });
    expect(read).toMatchObject({ data: "Alpha line\nbeta line\nGamma\n", encoding: "utf-8", truncated: false });
    const edited = await call(tools.get(SHARED_TOOLS.editFile), { path: "notes/plan.md", oldText: "beta", newText: "Beta $& $1", ifMatch: read.etag });
    expect(edited).toMatchObject({ replacements: 1 });
    expect((await call(tools.get(SHARED_TOOLS.readFile), { path: "notes/plan.md" })).data).toBe("Alpha line\nBeta $& $1 line\nGamma\n");
    await expect(call(tools.get(SHARED_TOOLS.editFile), { path: "notes/plan.md", oldText: "line", newText: "row" })).rejects.toThrow(/occurs 2 times/);
    await expect(call(tools.get(SHARED_TOOLS.editFile), { path: "notes/plan.md", oldText: "missing", newText: "x" })).rejects.toThrow(/not found/);
    await expect(call(tools.get(SHARED_TOOLS.editFile), { path: "notes/plan.md", oldText: "Gamma", newText: "x", ifMatch: read.etag })).rejects.toThrow(/changed/);
    expect(await call(tools.get(SHARED_TOOLS.editFile), { path: "notes/plan.md", oldText: "line", newText: "row", replaceAll: true })).toMatchObject({ replacements: 2 });
    await call(tools.get(SHARED_TOOLS.writeFile), { path: "readme.txt", content: "nothing relevant" });
    expect(await call(tools.get(SHARED_TOOLS.listFiles), {})).toEqual({ entries: [{ name: "notes", type: "directory" }, { name: "readme.txt", type: "file" }] });
    const search = await call(tools.get(SHARED_TOOLS.searchFiles), { query: "ROW" });
    expect(search).toEqual({ matches: [{ path: "notes/plan.md", line: 1, text: "Alpha row" }, { path: "notes/plan.md", line: 2, text: "Beta $& $1 row" }], truncated: false });
    expect(await call(tools.get(SHARED_TOOLS.searchFiles), { query: "ROW", caseSensitive: true })).toEqual({ matches: [], truncated: false });
    expect(await call(tools.get(SHARED_TOOLS.searchFiles), { query: "plan" })).toMatchObject({ matches: [{ path: "notes/plan.md" }] });
    expect(await call(tools.get(SHARED_TOOLS.searchFiles), { query: "row", maxResults: 1 })).toMatchObject({ truncated: true, matches: [{ line: 1 }] });
    for (const path of ["../escape.txt", "/absolute.txt", "C:\\escape.txt"]) {
      await expect(call(tools.get(SHARED_TOOLS.writeFile), { path, content: "x" }), path).rejects.toThrow();
    }
    // Content lives in the provider; the native anchor stays empty.
    expect(await readdir(join(root, "anchor"))).toEqual([]);
  });

  it("keeps a bounded task list in session storage outside the workspace", async () => {
    const tools = byName(taskListTools(context));
    expect(taskListTools(context).every(({ rule }) => rule.kind === undefined)).toBe(true);
    expect(await call(tools.get(SHARED_TOOLS.getTasks), {})).toEqual({ tasks: [] });
    const stored = await call(tools.get(SHARED_TOOLS.updateTasks), { tasks: [{ title: "Research", status: "in_progress" }, { id: "write", title: "Write", status: "pending", notes: "Later." }] });
    expect(stored.tasks).toEqual([
      { id: "task-1", title: "Research", status: "in_progress" }, { id: "write", title: "Write", status: "pending", notes: "Later." },
    ]);
    expect(await call(tools.get(SHARED_TOOLS.getTasks), {})).toEqual(stored);
    await expect(call(tools.get(SHARED_TOOLS.updateTasks), { tasks: [{ id: "a", title: "One", status: "done" }, { id: "a", title: "Two", status: "done" }] })).rejects.toThrow(/unique/);
    await expect(call(tools.get(SHARED_TOOLS.updateTasks), { tasks: Array.from({ length: 51 }, (_, index) => ({ title: `T${index}`, status: "pending" })) })).rejects.toThrow();
    expect(await call(byName(workspaceTools(context)).get(SHARED_TOOLS.listFiles), {})).toEqual({ entries: [] });
  });

  // The runtime moves a result above 20 KiB to a file no shared tool can read, even for shared sessions once a client
  // attaches, so every result stays within the shared output budget and says how to get the rest.
  it("keeps large reads, listings, searches, and task lists inline, with a note on how to continue", async () => {
    const json = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const tools = byName(workspaceTools(context));
    const line = (index: number) => `${String(index).padStart(4, "0")} "needle" café 中文 😀 ${"a".repeat(240)}\n`;
    const text = Array.from({ length: 110 }, (_, index) => line(index)).join("");
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(30_000);
    await call(tools.get(SHARED_TOOLS.writeFile), { path: "big.md", content: text });
    let offset = 0;
    let read = "";
    for (let reads = 0; ; reads++) {
      expect(reads).toBeLessThan(10);
      const part = await call(tools.get(SHARED_TOOLS.readFile), { path: "big.md", offset, length: 32 * 1024 });
      expect(json(part)).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
      read += part.data as string;
      if (!part.truncated) break;
      expect(part.note).toContain(`call ${SHARED_TOOLS.readFile} with offset ${part.nextOffset}`);
      offset = part.nextOffset as number;
    }
    expect(read).toBe(text);

    const search = await call(tools.get(SHARED_TOOLS.searchFiles), { query: "needle", maxResults: 200 });
    expect(json(search)).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
    expect(search).toMatchObject({ truncated: true, note: expect.stringContaining("result size limit") });
    expect((search.matches as unknown[]).length).toBeLessThan(110);

    for (let index = 0; index < 150; index++) {
      await call(tools.get(SHARED_TOOLS.writeFile), { path: `many/${String(index).padStart(3, "0")}-${"n".repeat(100)}.md`, content: "x" });
    }
    const first = await call(tools.get(SHARED_TOOLS.listFiles), { path: "many" });
    expect(json(first)).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
    expect(first).toMatchObject({ total: 150, truncated: true, nextOffset: (first.entries as unknown[]).length });
    const rest = await call(tools.get(SHARED_TOOLS.listFiles), { path: "many", offset: first.nextOffset });
    expect(rest).toMatchObject({ offset: first.nextOffset });
    expect((first.entries as unknown[]).length + (rest.entries as unknown[]).length).toBe(150);

    const tasks = byName(taskListTools(context));
    await call(tasks.get(SHARED_TOOLS.updateTasks), { tasks: [{ title: "Keep", status: "pending" }] });
    const crowded = { tasks: Array.from({ length: 50 }, (_, index) => ({ title: `Task ${index}`, status: "pending", notes: "n".repeat(1000) })) };
    expect(await call(tasks.get(SHARED_TOOLS.updateTasks), crowded)).toMatchObject({
      resultType: "failure", textResultForLlm: expect.stringContaining("keep it within 12 KiB"),
    });
    expect(await call(tasks.get(SHARED_TOOLS.getTasks), {})).toMatchObject({ tasks: [{ title: "Keep" }] });
  });
});

describe("delegation tools", () => {
  it("bound a delegated job's result, error, and artifact reads so that they stay inline", async () => {
    const json = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const jobId = "11111111-1111-4111-8111-111111111111";
    const artifactId = "22222222-2222-4222-8222-222222222222";
    const job = {
      id: jobId, state: "failed", harness: { name: "child", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` }, profile: "node-ts-agent",
      createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z", maxDurationSeconds: 60, attempts: 1, maxAttempts: 1,
      acknowledgedGaps: [], usage: { inputTokens: 1, outputTokens: 1, requests: 1 }, pendingInputs: 0,
      result: { summary: "中".repeat(10_000) }, error: { code: "runner_failed", message: "e".repeat(5000) },
    };
    const deps = {
      admission: async () => { throw new Error("Not used."); }, profiles: async () => new Map(), maxOpenJobs: 2,
      jobs: { getJob: async () => job },
      delegations: {
        list: async () => [{ jobId }], artifacts: async () => [],
        artifact: async () => ({ path: "outputs/report.md", sha256: "b".repeat(64), content: Buffer.from("x\n".repeat(20_000), "utf8") }),
      },
    };
    const requests = [
      { name: "get_job", kind: "host", binding: "shared:get-job", description: "Read a job." },
      { name: "read_output", kind: "host", binding: "shared:read-job-artifact", description: "Read an output." },
    ];
    const tools = byName(delegationTools(requests as never, { id: "session", principal: "alice" } as SharedSessionRecord, [], context,
      () => { throw new Error("No turn."); }, deps as never));
    const viewed = await call(tools.get("get_job"), { jobId });
    expect(json(viewed)).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
    expect(viewed).toMatchObject({ id: jobId, state: "failed", resultTruncated: true, note: expect.stringContaining("which read_output reads in parts") });
    expect(viewed.result).toBeUndefined();
    expect((viewed.resultPreview as string).startsWith("{\"summary\":\"中中")).toBe(true);
    expect((viewed.error as { message: string }).message).toHaveLength(2048);
    job.result = { summary: "small" };
    expect(await call(tools.get("get_job"), { jobId })).toMatchObject({ result: { summary: "small" } });
    const part = await call(tools.get("read_output"), { jobId, artifactId, length: 32 * 1024 });
    expect(json(part)).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
    expect(part).toMatchObject({ path: "outputs/report.md", truncated: true, note: expect.stringContaining("call read_output with offset") });
  });
});

describe("shared base tool set", () => {
  const plan = (changes: Parameters<typeof sharedHarness>[1], policy: Partial<SharedActivationPlan["policy"]> = {}): SharedActivationPlan => {
    const snapshot = sharedHarness("toolkit", changes);
    return {
      harness: { name: "toolkit", version: "1.0.0", digest: snapshot.digest }, definition: snapshot.definition, model: "fixture",
      policy: { ...policy } as SharedActivationPlan["policy"], profile: {} as SharedActivationPlan["profile"],
      approval: { mode: "manual", initial: "manual", available: ["manual"] }, delegation: [],
    };
  };
  const record = { id: "session", principal: "alice" } as SharedSessionRecord;
  const fakeTool = (name: string): Tool => ({ name, description: name, parameters: { type: "object" }, handler: async () => "ok" });
  const egress = (calls: unknown[]): SharedEgress => ({
    webFetch: (ctx) => { calls.push({ web: ctx.urlRule }); return fakeTool("web_fetch"); },
    connectMcp: async (servers) => {
      calls.push({ mcp: servers });
      return {
        tools: [fakeTool("mcp_docs_search_search"), fakeTool("mcp_docs_search_delete")],
        descriptors: [
          { name: "mcp_docs_search_search", server: "docs-search", tool: "search", readOnly: false, readOnlyHint: true, description: "", inputSchema: {} },
          { name: "mcp_docs_search_delete", server: "docs-search", tool: "delete", readOnly: false, description: "", inputSchema: {} },
        ] as never,
        refused: [], close: async () => undefined,
      };
    },
  });

  it("refuses a remote MCP server that is not in the effective operator catalog", async () => {
    const calls: unknown[] = [];
    await expect(sharedToolset(plan({ mcpServers: [{ server: "docs-search", tools: ["search"] }] }), record, context,
      () => { throw new Error("No turn."); }, { egress: egress(calls) })).rejects.toThrow(/catalog/);
    expect(calls).toEqual([]);
  });

  it("connects only the approved catalog servers and keeps the web rule on the tool", async () => {
    const calls: unknown[] = [];
    const catalog = { "docs-search": { url: "https://mcp.example.com", tools: ["search", "delete"] } };
    const toolset = await sharedToolset(plan({
      builtinTools: ["files", "web"], mcpServers: [{ server: "docs-search", tools: ["search", "delete"] }],
      permissions: { default: "ask", kinds: { url: "deny" } },
    }, { mcpServers: catalog }), record, context, () => { throw new Error("No turn."); }, { egress: egress(calls) });
    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      ...Object.values(SHARED_TOOLS).filter((name) => name !== "web_fetch" && name !== "get_task_list" && name !== "update_task_list"),
      "get_task_list", "update_task_list", "web_fetch", "mcp_docs_search_search", "mcp_docs_search_delete",
    ]);
    expect(calls).toEqual([{ web: "deny" }, { mcp: [{ name: "docs-search", policy: catalog["docs-search"], tools: ["search", "delete"] }] }]);
    expect(toolset.rules.get("web_fetch")).toMatchObject({ kind: "url" });
    // A remote server's read-only hint is untrusted, so no remote tool runs quietly under `ask`.
    for (const name of ["mcp_docs_search_search", "mcp_docs_search_delete"]) expect(toolset.rules.get(name)?.quietUnderAsk, name).toBeUndefined();
    expect(toolset.rules.get("mcp_docs_search_delete")!.target!({})).toBe("docs-search:delete");
  });

  it("holds every tool's result to the shared ceiling, whichever tool returns it", async () => {
    const huge: SharedEgress = {
      webFetch: () => ({ name: "web_fetch", description: "Huge.", parameters: { type: "object" }, handler: async () => "w".repeat(100_000) }),
      connectMcp: async () => { throw new Error("Not used."); },
    };
    const toolset = await sharedToolset(plan({ builtinTools: ["web"] }), record, context, () => { throw new Error("No turn."); }, { egress: huge });
    const result = await toolset.tools.find((tool) => tool.name === "web_fetch")!.handler!({}, {} as never) as string;
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(SHARED_TOOL_RESULT_LIMIT_BYTES);
    expect(result).toContain("[Result truncated at 18 KiB by the shared worker");
  });

  it("gives every shared session the task list, and refuses tools it cannot provide", async () => {
    const minimal = await sharedToolset(plan({}), record, context, () => { throw new Error("No turn."); }, {});
    expect(minimal.tools.map((tool) => tool.name)).toEqual(["get_task_list", "update_task_list"]);
    await expect(sharedToolset(plan({ builtinTools: ["web"] }), record, context, () => { throw new Error("No turn."); }, {})).rejects.toThrow(/egress/);
    await expect(sharedToolset(plan({
      tools: [{ name: "delegate_job", kind: "host", binding: "shared:delegate-job", description: "Delegate." }],
    }), record, context, () => { throw new Error("No turn."); }, {})).rejects.toThrow(/delegation/);
  });
});

describe("shared session settings", () => {
  const definition = HarnessDefinition.parse({
    ...sharedHarness("settings").definition,
    prompt: { mode: "customize", sections: [{ name: "tone", action: "replace", content: "Be terse." }, { name: "safety", action: "remove", content: "" }] },
    model: { preferred: "fixture", allowed: ["fixture", "other"], reasoningEffort: "medium", contextTier: "long_context" },
    tools: [{ name: "lookup", kind: "host", binding: "shared:get-job", description: "Look up a job.", delegatedOnly: true }],
    agents: [{ name: "helper", description: "Helps.", instructions: "Help with lookups.", tools: ["lookup"], skills: ["style"], model: "other" }],
    skills: [{ name: "style", description: "House style.", content: "Write plainly." }],
    permissions: { default: "deny", questions: true },
    builtinTools: ["agents"],
  });

  it("maps instructions, prompt mode, model options, and sub-agents like the batch runner's conversation mapping", () => {
    const shared = sharedSessionSettings(definition);
    const batch = buildSessionOptions(definition, ["lookup"], "/skills", "conversation");
    expect(shared.systemMessage).toEqual(batch.systemMessage);
    expect(shared.reasoningEffort).toBe(batch.reasoningEffort);
    expect(shared.contextTier).toBe(batch.contextTier);
    expect(shared.customAgents).toEqual(batch.customAgents);
    expect(shared.defaultAgent).toEqual(batch.defaultAgent);
    for (const mode of ["replace", "append"] as const) {
      const simple = HarnessDefinition.parse({ ...definition, prompt: { mode } });
      expect(sharedSessionSettings(simple).systemMessage).toEqual(buildSessionOptions(simple, [], "/skills", "conversation").systemMessage);
    }
  });

  it("offers questions, in-runtime sub-agents, and skills without built-in agents or files", async () => {
    const settings = sharedSessionSettings(definition);
    expect(settings.builtinTools.sort()).toEqual(["ask_user", "list_agents", "read_agent", "skill", "task", "write_agent"]);
    expect(settings.excludedBuiltinAgents).toEqual(BUILTIN_AGENTS);
    expect(settings.enableSkills).toBe(true);
    const signal = new AbortController().signal;
    expect(await settings.skillProvider!.listSkills({ signal })).toEqual([{ name: "style", description: "House style." }]);
    expect(await settings.skillProvider!.readSkill("STYLE", { signal })).toContain("Write plainly.");
    expect(await settings.skillProvider!.readSkill("missing", { signal })).toBeUndefined();
    expect(sharedSessionSettings(sharedHarness("bare").definition).builtinTools).toEqual([]);
  });
});
