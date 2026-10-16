import { describe, expect, it } from "vitest";
import { HarnessDefinition, hostingModeOf, runsOnSharedWorker } from "@copilot-agent/contracts";
import { canonicalJson, sha256Hex } from "@copilot-agent/service-defaults";

const conversation = {
  schemaVersion: "1",
  name: "lead",
  version: "1.0.0",
  description: "A coordinator.",
  interaction: "conversation",
  instructions: "Coordinate.",
  model: { preferred: "m", allowed: ["m", "judge"] },
  tools: [],
  input: { schema: { type: "object" } },
  output: { schema: { type: "object" } },
  limits: { maxDurationSeconds: 60, maxInferenceTokens: 1000 },
  retry: { safeToRetry: false, maxAttempts: 1 },
  runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
} as const;
const { interaction: _interaction, ...batch } = conversation;

const issues = (value: unknown) => {
  const result = HarnessDefinition.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};
const paths = (value: unknown) => issues(value).map((issue) => issue.split(":")[0]);
const digest = (value: unknown) => `sha256:${sha256Hex(canonicalJson(HarnessDefinition.parse(value)))}`;

describe("harness hosting contract", () => {
  it("accepts the plan's illustrative orchestrator harness unchanged", () => {
    const harness = {
      ...conversation,
      builtinTools: ["files", "web"],
      mcpServers: [{ server: "docs-search", tools: ["search", "fetch_page"] }],
      permissions: { default: "ask", kinds: { url: "allow" }, approvalMode: "assisted", judgeModel: "judge" },
      hosting: {
        mode: "orchestrator",
        workers: {
          harnesses: ["repo-analyst", "test-runner"], sizes: ["small", "medium"], maxConcurrent: 4, maxPerSession: 12,
          sharedStorage: "session", humanAuthority: "inherit", crafting: { template: "general-worker" },
        },
        handoffs: [{ harness: "coding-agent", description: "Changes that need a real checkout", history: "summary" }],
      },
    };
    expect(issues(harness)).toEqual([]);
    expect(HarnessDefinition.parse(harness)).toEqual(harness);
    expect(hostingModeOf(HarnessDefinition.parse(harness))).toBe("orchestrator");
  });

  it("defaults to isolated hosting and identifies modes that stay on the shared worker", () => {
    expect(hostingModeOf(HarnessDefinition.parse(conversation))).toBe("isolated");
    expect(["isolated", "shared", "promotable", "orchestrator"].map((mode) => runsOnSharedWorker(mode as never))).toEqual([false, true, false, true]);
  });

  it("requires an explicit, known mode and rejects unknown hosting fields", () => {
    expect(paths({ ...conversation, hosting: {} })).toEqual(["hosting.mode"]);
    expect(paths({ ...conversation, hosting: { mode: "serverless" } })).toEqual(["hosting.mode"]);
    expect(paths({ ...conversation, hosting: { mode: "isolated", region: "west" } })).toEqual(["hosting"]);
  });

  it("allows mode-specific settings only with their mode", () => {
    expect(issues({ ...conversation, hosting: { mode: "shared", promotion: { size: "small" } } })).toEqual([
      "hosting.promotion: Promotion settings apply only to promotable harnesses.",
    ]);
    expect(issues({ ...conversation, hosting: { mode: "promotable", promotion: { size: "small", approval: "allow" } } })).toEqual([]);
    expect(issues({ ...conversation, hosting: { mode: "promotable", workers: { harnesses: ["coder"] } } })).toEqual([
      "hosting.workers: Worker settings apply only to orchestrator harnesses.",
    ]);
    expect(issues({ ...conversation, hosting: { mode: "orchestrator" } })).toEqual([
      "hosting.workers: An orchestrator harness needs workers: list worker harnesses or a crafting template.",
    ]);
    expect(paths({ ...conversation, hosting: { mode: "promotable", promotion: { approval: "sometimes" } } })).toEqual(["hosting.promotion.approval"]);
  });

  it("validates worker settings", () => {
    const workers = (value: object) => ({ ...conversation, hosting: { mode: "orchestrator", workers: value } });
    expect(issues(workers({ harnesses: [] }))).toEqual(["hosting.workers.harnesses: List at least one worker harness or set a crafting template."]);
    expect(issues(workers({ harnesses: [], crafting: { template: "general-worker" } }))).toEqual([]);
    expect(issues(workers({ harnesses: ["lead", "coder", "coder"] }))).toEqual([
      "hosting.workers.harnesses.0: A harness cannot be its own worker.",
      "hosting.workers.harnesses.2: Worker harness 'coder' is listed more than once.",
    ]);
    expect(issues(workers({ harnesses: ["coder"], sizes: ["small", "small"] }))).toEqual(["hosting.workers.sizes.1: Size 'small' is listed more than once."]);
    expect(issues(workers({ harnesses: ["coder"], maxConcurrent: 8, maxPerSession: 4 }))).toEqual([
      "hosting.workers.maxConcurrent: maxConcurrent cannot exceed maxPerSession.",
    ]);
    expect(paths(workers({ harnesses: ["coder"], maxConcurrent: 0 }))).toEqual(["hosting.workers.maxConcurrent"]);
    expect(paths(workers({ harnesses: ["coder"], maxConcurrent: 33 }))).toEqual(["hosting.workers.maxConcurrent"]);
    expect(paths(workers({ harnesses: ["coder"], maxPerSession: 257 }))).toEqual(["hosting.workers.maxPerSession"]);
    expect(paths(workers({ harnesses: ["coder"], sizes: [] }))).toEqual(["hosting.workers.sizes"]);
    expect(paths(workers({ harnesses: ["coder"], sharedStorage: "global" }))).toEqual(["hosting.workers.sharedStorage"]);
    expect(paths(workers({ harnesses: ["coder"], humanAuthority: "coordinator" }))).toEqual(["hosting.workers.humanAuthority"]);
    expect(paths(workers({ harnesses: ["Not A Slug"] }))).toEqual(["hosting.workers.harnesses.0"]);
  });

  it("validates handoff targets", () => {
    const handoffs = (value: unknown[]) => ({ ...conversation, hosting: { mode: "shared", handoffs: value } });
    expect(issues(handoffs([{ harness: "coder", description: "Code", history: "full", approval: "allow" }]))).toEqual([]);
    expect(issues(handoffs([{ harness: "lead", description: "Self" }]))).toEqual(["hosting.handoffs.0.harness: A harness cannot hand off to itself."]);
    expect(issues(handoffs([{ harness: "coder", description: "A" }, { harness: "coder", description: "B" }]))).toEqual([
      "hosting.handoffs.1.harness: Handoff target 'coder' is listed more than once.",
    ]);
    expect(paths(handoffs([{ harness: "coder" }]))).toEqual(["hosting.handoffs.0.description"]);
    expect(paths(handoffs([{ harness: "coder", description: "Code", history: "partial" }]))).toEqual(["hosting.handoffs.0.history"]);
    expect(paths(handoffs(Array.from({ length: 9 }, (_, index) => ({ harness: `target-${index}`, description: "x" }))))).toEqual(["hosting.handoffs"]);
  });

  it("keeps shell, Python, and local MCP tools off the shared worker", () => {
    const tools = [
      { name: "stats", kind: "python", description: "Stats.", binding: "python:stats" },
      { name: "local_files", kind: "mcp-local", description: "Files.", binding: "mcp:files" },
      { name: "lookup", kind: "host", description: "Look up.", binding: "host:lookup" },
    ];
    const harness = (mode: string, extra: object = {}) => ({ ...conversation, builtinTools: ["files", "shell", "web", "agents"], tools, hosting: { mode, ...extra } });
    const shared = [
      "builtinTools.1: Shared placement cannot run shell commands; use isolated or promotable hosting, or an orchestrator worker.",
      "tools.0.kind: Shared placement cannot run Python tools; use isolated or promotable hosting, or an orchestrator worker.",
      "tools.1.kind: Shared placement cannot run local (stdio) MCP tools; use isolated or promotable hosting, or an orchestrator worker.",
    ];
    expect(issues(harness("shared"))).toEqual(shared);
    expect(issues(harness("orchestrator", { workers: { harnesses: ["coder"] } }))).toEqual(shared);
    expect(issues(harness("promotable"))).toEqual([]);
    expect(issues(harness("isolated"))).toEqual([]);
  });

  it("validates remote MCP requests", () => {
    expect(issues({ ...conversation, mcpServers: [{ server: "docs-search", tools: ["search", "search"] }, { server: "docs-search", tools: ["x.y-z_1"] }] }))
      .toEqual([
        "mcpServers.0.tools.1: Tool 'search' is listed more than once.",
        "mcpServers.1.server: MCP server 'docs-search' is listed more than once.",
      ]);
    expect(paths({ ...conversation, mcpServers: [{ server: "docs-search", tools: [] }] })).toEqual(["mcpServers.0.tools"]);
    expect(paths({ ...conversation, mcpServers: [{ server: "docs-search", tools: ["has space"] }] })).toEqual(["mcpServers.0.tools.0"]);
    expect(paths({ ...conversation, mcpServers: [{ server: "docs-search", tools: ["search"], url: "https://x.example" }] })).toEqual(["mcpServers.0"]);
  });

  it("validates approval mode settings", () => {
    const permissions = (value: object) => ({ ...conversation, permissions: { default: "ask", ...value } });
    expect(issues(permissions({ approvalMode: "assisted", judgeModel: "judge" }))).toEqual([]);
    expect(issues(permissions({ approvalMode: "assisted", judgeModel: "other" }))).toEqual([
      "permissions.judgeModel: The judge model must be one of the harness's allowed models.",
    ]);
    expect(issues(permissions({ approvalMode: "manual", judgeModel: "judge" }))).toEqual([
      "permissions.judgeModel: A judge model applies only to the assisted approval mode.",
    ]);
    expect(issues(permissions({ approvalMode: "custom" }))).toEqual(["permissions.handler: The custom approval mode needs a registered permission handler."]);
    expect(issues(permissions({ approvalMode: "custom", handler: "acme-approvals" }))).toEqual([]);
    expect(issues(permissions({ approvalMode: "allow-all", handler: "acme-approvals" }))).toEqual([
      "permissions.handler: A permission handler applies only to the custom approval mode.",
    ]);
    expect(paths(permissions({ approvalMode: "yolo" }))).toEqual(["permissions.approvalMode"]);
  });

  it("rejects hosting, remote MCP, and non-manual approval modes on batch harnesses", () => {
    expect(issues({ ...batch, hosting: { mode: "isolated" } })).toEqual([
      "hosting: Hosting applies only to conversation harnesses; batch harnesses run as jobs on the executor.",
    ]);
    expect(issues({ ...batch, mcpServers: [] })).toEqual(["mcpServers: Remote MCP servers are available only to conversation harnesses."]);
    for (const approvalMode of ["assisted", "allow-all"]) {
      expect(issues({ ...batch, permissions: { default: "ask", approvalMode } })).toEqual([
        "permissions.approvalMode: Batch harnesses use the manual approval mode; other approval modes need a conversation harness.",
      ]);
    }
    expect(issues({ ...batch, permissions: { default: "ask", approvalMode: "custom", handler: "acme-approvals" } })).toEqual([
      "permissions.approvalMode: Batch harnesses use the manual approval mode; other approval modes need a conversation harness.",
    ]);
    expect(issues({ ...batch, permissions: { default: "ask", approvalMode: "manual" } })).toEqual([]);
  });
});

describe("harness digests with hosting fields", () => {
  it("keeps the digest when the new fields are omitted and adds no defaults", () => {
    expect(HarnessDefinition.parse(conversation)).toEqual(conversation);
    expect(digest(conversation)).toBe(digest({ ...conversation }));
    const withHosting = { ...conversation, hosting: { mode: "isolated" } };
    expect(HarnessDefinition.parse(withHosting)).toEqual(withHosting);
  });

  it("includes the new fields in the digest when present", () => {
    const base = digest(conversation);
    expect(digest({ ...conversation, hosting: { mode: "isolated" } })).not.toBe(base);
    expect(digest({ ...conversation, mcpServers: [{ server: "docs-search", tools: ["search"] }] })).not.toBe(base);
    expect(digest({ ...conversation, permissions: { default: "ask" } })).not.toBe(digest({ ...conversation, permissions: { default: "ask", approvalMode: "manual" } }));
    expect(digest({ ...conversation, hosting: { mode: "shared" } })).not.toBe(digest({ ...conversation, hosting: { mode: "isolated" } }));
  });
});
