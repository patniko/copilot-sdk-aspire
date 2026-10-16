import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "@copilot-agent/contracts";
import { templateHarness } from "../server/repo.js";
import type { HarnessDocument, ProfileSummary } from "../server/types.js";
import { validateHarness, validatePolicy, validatePolicyOverride } from "../server/validate.js";

const profiles: ProfileSummary[] = [
  {
    id: "node-ts-agent", displayName: "TS", language: "typescript", sdk: "sdk", sdkVersion: "1", firstParty: true,
    toolBindings: ["python:stats", "host:lookup", "host:fetch"], capabilities: ["cancel", "structured-result", "builtin-tools", "interactive"],
    inProcessBindings: ["host:lookup"], permissionHandlers: ["acme-approvals"],
  },
];

const policy: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["approved-model"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 500_000,
  maxConcurrentAttemptsPerPrincipal: 2,
  maxQueuedJobsPerPrincipal: 10,
  retry: { maxAttempts: 2, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  builtinTools: ["files", "shell", "web"],
  permissionModes: ["ask", "allow"],
};

const open: ExecutionPolicy = {
  ...policy,
  approvalModes: ["manual", "assisted"],
  mcpServers: { "docs-search": { url: "https://mcp.example.com/docs", auth: { secret: "docs-search-token" }, tools: ["search"] } },
  hosting: { modes: ["isolated", "shared", "promotable", "orchestrator"] },
};

function document(name: string, mutate: (d: HarnessDocument) => void = () => undefined): HarnessDocument {
  const doc = templateHarness(name, "approved-model", ["node-ts-agent"]);
  doc.manifest.interaction = "conversation";
  mutate(doc);
  return doc;
}

const errors = (doc: HarnessDocument, extra: Partial<Parameters<typeof validateHarness>[1]> = {}) =>
  validateHarness(doc, { policy: open, profiles, all: [doc], ...extra })
    .filter((issue) => issue.level === "error")
    .map((issue) => `${issue.path}: ${issue.message}`);

describe("hosting validation in the configurator", () => {
  it("leaves conversation harnesses without hosting fields valid", () => {
    expect(errors(document("chat"), { policy })).toEqual([]);
  });

  it("reports a disallowed mode at hosting.mode", () => {
    expect(errors(document("chat", (d) => void (d.manifest.hosting = { mode: "shared" })), { policy })).toEqual([
      "hosting.mode: The operator policy does not allow shared hosting for this harness.",
    ]);
    expect(errors(document("chat", (d) => void (d.manifest.hosting = { mode: "shared" })))).toEqual([]);
  });

  it("reports schema rules for batch harnesses and shared placement", () => {
    const batch = templateHarness("job", "approved-model", ["node-ts-agent"]);
    batch.manifest.hosting = { mode: "isolated" };
    expect(errors(batch)).toEqual(["hosting: Hosting applies only to conversation harnesses; batch harnesses run as jobs on the executor."]);
    const shared = document("chat", (d) => {
      d.manifest.hosting = { mode: "shared" };
      d.manifest.builtinTools = ["files", "shell"];
      d.manifest.permissions = { default: "ask" };
    });
    expect(errors(shared)).toEqual([
      "builtinTools.1: Shared placement cannot run shell commands; use isolated or promotable hosting, or an orchestrator worker.",
    ]);
  });

  it("checks approval modes, judge models, handlers, and the MCP catalog against the effective policy", () => {
    expect(errors(document("chat", (d) => void (d.manifest.permissions = { default: "ask", approvalMode: "allow-all" })))).toEqual([
      "permissions.approvalMode: The operator policy does not allow the 'allow-all' approval mode.",
    ]);
    expect(errors(document("chat", (d) => {
      d.manifest.model = { preferred: "approved-model", allowed: ["approved-model", "judge"] };
      d.manifest.permissions = { default: "ask", approvalMode: "assisted", judgeModel: "judge" };
    }))).toEqual(["permissions.judgeModel: Judge model 'judge' is not approved by the operator policy."]);
    expect(errors(document("chat", (d) => void (d.manifest.mcpServers = [{ server: "docs-search", tools: ["search", "write"] }])))).toEqual([
      "mcpServers.0.tools.1: The operator's catalog does not approve tool 'write' on 'docs-search'.",
    ]);
    const custom = document("chat", (d) => void (d.manifest.permissions = { default: "ask", approvalMode: "custom", handler: "other" }));
    expect(errors(custom, { policy: { ...open, approvalModes: ["custom"], permissionHandlers: ["other"] } })).toEqual([
      "permissions.handler: Profile 'node-ts-agent' does not provide the 'other' permission handler.",
    ]);
  });

  it("allows only in-process-safe host bindings on the shared worker", () => {
    const shared = document("chat", (d) => {
      d.manifest.hosting = { mode: "shared" };
      d.manifest.tools = [
        { name: "lookup", kind: "host", description: "Look up.", binding: "host:lookup" },
        { name: "fetch_record", kind: "host", description: "Fetch.", binding: "host:fetch" },
      ];
    });
    expect(errors(shared)).toEqual(["tools.1.binding: Profile 'node-ts-agent' does not mark 'host:fetch' safe to run in a shared worker."]);
  });

  it("checks worker and handoff targets against the other harnesses and their policies", () => {
    const coder = document("coder");
    const triage = document("triage", (d) => void (d.manifest.hosting = { mode: "shared" }));
    const batch = templateHarness("job", "approved-model", ["node-ts-agent"]);
    const lead = document("lead", (d) => {
      d.manifest.hosting = {
        mode: "orchestrator",
        workers: { harnesses: ["coder", "triage", "job", "missing"] },
        handoffs: [{ harness: "triage", description: "Back to triage" }],
      };
    });
    const all = [coder, triage, batch, lead];
    expect(errors(lead, { all })).toEqual([
      "hosting.workers.harnesses.1: Worker harness 'triage' must use isolated hosting.",
      "hosting.workers.harnesses.2: Worker harness 'job' is not a conversation harness.",
      "hosting.workers.harnesses.3: Worker harness 'missing' is not a published harness.",
    ]);
    const policyFor = (name: string) => (name === "triage" ? policy : open);
    expect(errors(lead, { all, policyFor })).toContain(
      "hosting.handoffs.0.harness: The operator policy does not allow shared hosting for handoff target 'triage'.",
    );
  });
});

describe("hosting policy validation in the configurator", () => {
  it("warns about settings that cannot take effect", () => {
    const result = validatePolicy({
      ...policy,
      approvalModes: ["manual", "custom"],
      permissionHandlers: ["unregistered"],
      hosting: {
        crafting: {
          templates: {
            general: { toolBindings: [], builtinTools: ["agents"], models: ["other-model"], approvalModes: ["assisted"], maxDurationSeconds: 600, sizes: ["small"] },
          },
        },
      },
    }, profiles);
    expect(result.issues.filter((issue) => issue.level === "warning").map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "permissionHandlers.0",
      "hosting.crafting.templates.general.models.0",
      "hosting.crafting.templates.general.approvalModes.0",
      "hosting.crafting.templates.general.builtinTools.0",
    ]));
    expect(validatePolicy({ ...policy, approvalModes: ["custom"] }, profiles).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warning", path: "approvalModes" })]),
    );
  });

  it("reports invalid hosting ceilings with field paths, including in overrides", () => {
    expect(validatePolicy({ ...policy, hosting: { defaultSize: "xl" } }, profiles).issues).toEqual([
      { level: "error", path: "hosting.defaultSize", message: "Size 'xl' is not in the size catalog." },
    ]);
    const override = validatePolicyOverride(
      { schemaVersion: "1", harness: "chat", overrides: { hosting: { modes: ["shared"], defaultSize: "xl" } } },
      { base: policy, profiles, harnessNames: ["chat"] },
    );
    expect(override.issues).toEqual([{ level: "error", path: "overrides.hosting.defaultSize", message: "Size 'xl' is not in the size catalog." }]);
    const valid = validatePolicyOverride(
      { schemaVersion: "1", harness: "chat", overrides: { hosting: { modes: ["shared"] }, approvalModes: ["manual", "assisted"] } },
      { base: policy, profiles, harnessNames: ["chat"] },
    );
    expect(valid.issues).toEqual([]);
    expect(valid.effective?.hosting).toEqual({ modes: ["shared"] });
  });
});
