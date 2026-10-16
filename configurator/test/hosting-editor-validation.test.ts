import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "@copilot-agent/contracts";
import { authoringPrompt, validateAuthoringDraft } from "../server/authoring.js";
import { templateHarness } from "../server/repo.js";
import type { BindingInfo, HarnessDocument, ProfileSummary } from "../server/types.js";
import { decisions, validateHarness, validatePolicy } from "../server/validate.js";

// Covers what the hosting editor adds on top of the stage 1 configurator checks (hosting-validation.test.ts).
const profiles: ProfileSummary[] = [
  {
    id: "node-ts-agent", displayName: "TS", language: "typescript", sdk: "sdk", sdkVersion: "1", firstParty: true,
    toolBindings: ["python:stats", "shared:get-job"], capabilities: ["cancel", "structured-result", "builtin-tools", "interactive", "custom-agents"],
    inProcessBindings: ["shared:get-job"], permissionHandlers: ["workspace-drafts"],
  },
  {
    id: "python-agent", displayName: "Py", language: "python", sdk: "sdk", sdkVersion: "1", firstParty: false,
    toolBindings: ["python:stats"], capabilities: ["cancel", "structured-result", "builtin-tools", "interactive"],
  },
];

const policy: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent", "python-agent"],
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
  approvalModes: ["manual", "assisted", "custom"],
  permissionHandlers: ["workspace-drafts"],
  mcpServers: { "docs-search": { url: "https://mcp.example.com/docs", auth: { secret: "docs-search-token" }, tools: ["search"] } },
  hosting: { modes: ["isolated", "shared", "orchestrator"], workers: { allowInheritedAuthority: true } },
};

function conversation(name = "chat", mutate: (d: HarnessDocument) => void = () => undefined): HarnessDocument {
  const doc = templateHarness(name, "approved-model", ["node-ts-agent"]);
  doc.manifest.interaction = "conversation";
  mutate(doc);
  return doc;
}

const errors = (doc: HarnessDocument, all: HarnessDocument[] = [doc], effective: ExecutionPolicy = policy) =>
  validateHarness(doc, { policy: effective, profiles, all })
    .filter((issue) => issue.level === "error")
    .map((issue) => `${issue.path}: ${issue.message}`);

describe("hosted admission checks in the harness editor", () => {
  it("requires the conversation profile, as hosted admission does", () => {
    const python = conversation("chat", (d) => void (d.manifest.runners = { allowedProfiles: ["python-agent"], defaultProfile: "python-agent" }));
    expect(errors(python)).toEqual(["runners.allowedProfiles: Conversation harnesses must allow the node-ts-agent profile."]);
    expect(errors(templateHarness("job", "approved-model", ["python-agent"]))).toEqual([]);
  });

  it("does not repeat a problem the editor already reports in its own words", () => {
    const unapproved = conversation("chat", (d) => void (d.manifest.model = { preferred: "other", allowed: ["other"] }));
    expect(errors(unapproved).filter((entry) => entry.startsWith("model:"))).toHaveLength(1);
  });

  it("reports a disallowed mode while unrelated fields are still invalid", () => {
    const draft = conversation("chat", (d) => {
      d.manifest.description = "";
      d.manifest.hosting = { mode: "promotable" };
    });
    expect(errors(draft)).toEqual(
      expect.arrayContaining(["hosting.mode: The operator policy does not allow promotable hosting for this harness."]),
    );
  });

  it("keeps validating when MCP entries are malformed", () => {
    const draft = conversation("chat", (d) => void ((d.manifest as { mcpServers?: unknown }).mcpServers = [null, { server: "docs-search" }]));
    expect(() => errors(draft)).not.toThrow();
    expect(errors(draft).some((entry) => entry.startsWith("mcpServers.0"))).toBe(true);
  });

  it("accepts a shared harness with remote MCP, assisted approval and a handoff the policy allows", () => {
    const coder = conversation("coder");
    const chat = conversation("chat", (d) => {
      d.manifest.builtinTools = ["files", "web"];
      d.manifest.permissions = { default: "ask", approvalMode: "assisted", judgeModel: "approved-model" };
      d.manifest.mcpServers = [{ server: "docs-search", tools: ["search"] }];
      d.manifest.hosting = { mode: "shared", handoffs: [{ harness: "coder", description: "Changes that need a checkout", history: "summary" }] };
    });
    expect(errors(chat, [chat, coder])).toEqual([]);
  });
});

describe("hosting decisions in the Live plan", () => {
  it("describes placement, isolation limits, approvals, inherited authority, handoffs and remote MCP", () => {
    const lead = conversation("lead", (d) => {
      d.manifest.permissions = { default: "ask", approvalMode: "assisted" };
      d.manifest.mcpServers = [{ server: "docs-search", tools: ["search"] }];
      d.manifest.hosting = {
        mode: "orchestrator",
        workers: { harnesses: ["coder"], humanAuthority: "inherit" },
        handoffs: [{ harness: "coder", description: "Hand over coding work" }],
      };
    });
    const titles = decisions(lead, { policy, profiles, all: [lead] }).map((decision) => decision.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Shared coordinator with container workers",
        "Shared placement separates sessions inside one process",
        "Workers may act on the person's own instructions",
        "Hands off to coder",
        "Assisted approvals: the runtime's safety judge decides first",
        "Remote MCP servers: docs-search",
      ]),
    );
    const isolated = decisions(conversation("chat"), { policy, profiles, all: [] }).map((decision) => decision.title);
    expect(isolated).toContain("Hosted in an isolated container");
    expect(isolated).not.toContain("Shared placement separates sessions inside one process");
    const batch = decisions(templateHarness("job", "approved-model", ["node-ts-agent"]), { policy, profiles, all: [] }).map((decision) => decision.title);
    expect(batch).toContain("Managed job configuration, not native Copilot defaults");
    expect(batch.some((title) => title.startsWith("Hosted"))).toBe(false);
  });
});

describe("hosting policy warnings added by the editor", () => {
  it("flags development network access, missing transports, ineffective authority and unknown template bindings", () => {
    const result = validatePolicy({
      ...policy,
      approvalModes: ["manual"],
      mcpServers: { local: { url: "http://mcp:8080/mcp", auth: { secret: "local-token" }, tools: ["search"], allowPrivateNetwork: true } },
      hosting: {
        modes: ["isolated", "shared"],
        transports: ["github"],
        workers: { allowInheritedAuthority: true },
        crafting: {
          templates: {
            general: { toolBindings: ["python:stats", "host:missing"], builtinTools: ["files"], models: ["approved-model"], approvalModes: ["manual"], maxDurationSeconds: 600, sizes: ["small"] },
          },
        },
      },
    }, profiles);
    expect(result.issues).toEqual([
      expect.objectContaining({ level: "warning", path: "mcpServers.local.allowPrivateNetwork" }),
      expect.objectContaining({ level: "warning", path: "hosting.transports" }),
      expect.objectContaining({ level: "warning", path: "hosting.workers.allowInheritedAuthority" }),
      expect.objectContaining({ level: "warning", path: "hosting.crafting.templates.general.toolBindings.1" }),
    ]);
  });
});

describe("Copilot-assisted authoring for shared placement", () => {
  const bindings: BindingInfo[] = [
    { id: "python:stats", kind: "python", description: "Statistics", profiles: ["node-ts-agent", "python-agent"] },
    { id: "shared:get-job", kind: "host", description: "Job status", profiles: ["node-ts-agent"] },
  ];

  it("offers only bindings the shared worker can run in process", () => {
    const shared = conversation("chat", (d) => void (d.manifest.hosting = { mode: "shared" }));
    const prompt = authoringPrompt({ kind: "tool", description: "Look up a delegated job", document: shared }, { policy, profiles, all: [shared] }, bindings);
    expect(prompt).toContain("shared:get-job");
    expect(prompt).not.toContain("python:stats");
    expect(prompt).toContain("shared worker");
    const isolated = conversation("chat");
    expect(authoringPrompt({ kind: "tool", description: "Compute", document: isolated }, { policy, profiles, all: [isolated] }, bindings)).toContain("python:stats");
  });

  it("rejects a draft tool the harness's placement cannot run, with field-scoped errors", () => {
    const shared = conversation("chat", (d) => void (d.manifest.hosting = { mode: "shared" }));
    const draft = { kind: "tool" as const, tool: { name: "compute_stats", description: "Statistics", kind: "python" as const, binding: "python:stats" } };
    expect(() => validateAuthoringDraft("tool", draft, shared, { policy, profiles, all: [shared] }, bindings)).toThrow(
      /tools\.0\.kind: Shared placement cannot run Python tools/,
    );
  });
});
