import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "@copilot-agent/contracts";
import { loadHarnesses } from "@copilot-agent/service-defaults";
import { invocation, UnsafeArgumentError } from "../server/process.js";
import { Repo, templateHarness } from "../server/repo.js";
import { deployEnvironment, DeployTargetSchema } from "../server/settings.js";
import { createFromTemplate, listTemplates } from "../server/templates.js";
import type { HarnessDocument, ProfileSummary } from "../server/types.js";
import { decisions, harnessDigest, validateHarness, validatePolicy, validatePolicyOverride } from "../server/validate.js";
import { effectiveLimits } from "../server/validate.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const customerConfigRoot = join(repoRoot, "examples", "customer-config");

const profiles: ProfileSummary[] = [
  { id: "node-ts-agent", displayName: "TS", language: "typescript", sdk: "sdk", sdkVersion: "1", firstParty: true, toolBindings: ["python:stats"], capabilities: ["cancel", "structured-result"] },
  { id: "python-agent", displayName: "Py", language: "python", sdk: "sdk", sdkVersion: "1", firstParty: false, toolBindings: [], capabilities: ["cancel", "structured-result"] },
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
  maxReasoningEffort: "medium",
};

function harness(mutate: (d: HarnessDocument) => void = () => undefined): HarnessDocument {
  const doc = templateHarness("sample", "approved-model", ["node-ts-agent"]);
  mutate(doc);
  return doc;
}

const validate = (doc: HarnessDocument, extra: Partial<Parameters<typeof validateHarness>[1]> = {}) =>
  validateHarness(doc, { policy, profiles, all: [doc], ...extra });
const errors = (doc: HarnessDocument, extra?: Partial<Parameters<typeof validateHarness>[1]>) =>
  validate(doc, extra).filter((i) => i.level === "error").map((i) => i.path);

describe("validateHarness", () => {
  it("accepts the template", () => {
    expect(validate(harness())).toEqual([]);
  });

  it("reports examples that do not match the input schema", () => {
    expect(errors(harness((d) => void ((d.manifest.input.schema as { examples: unknown[] }).examples = [{ other: 1 }])))).toContain(
      "input.schema.examples.0",
    );
  });

  it("requires object schemas and valid JSON Schema", () => {
    expect(errors(harness((d) => void (d.manifest.output.schema = { type: "string" })))).toContain("output.schema");
    expect(errors(harness((d) => void (d.manifest.input.schema = { type: "object", properties: { a: { type: "nope" } } })))).toContain(
      "input.schema",
    );
  });

  it("rejects tools no profile provides, reserved names, and duplicates", () => {
    const doc = harness((d) => {
      d.manifest.tools = [
        { name: "submit_result", kind: "python", description: "x", binding: "python:stats" },
        { name: "dup", kind: "python", description: "x", binding: "python:stats" },
        { name: "dup", kind: "python", description: "x", binding: "python:missing" },
      ];
    });
    expect(errors(doc)).toEqual(expect.arrayContaining(["tools.0.name", "tools.2.name", "tools.2.binding"]));
  });

  it("rejects allowed profiles that cannot provide the requested tools", () => {
    const doc = harness((d) => {
      d.manifest.tools = [{ name: "stats", kind: "python", description: "x", binding: "python:stats" }];
      d.manifest.runners = { allowedProfiles: ["node-ts-agent", "python-agent"], defaultProfile: "node-ts-agent" };
    });
    expect(errors(doc)).toContain("runners.allowedProfiles");
  });

  it("rejects profiles that lack required runner features", () => {
    const doc = harness((d) => void (d.manifest.prompt = { mode: "append" }));
    expect(validate(doc).some((i) => i.level === "error" && i.message.includes("prompt-sections"))).toBe(true);
  });

  it("rejects model options above the policy cap", () => {
    const doc = harness((d) => void (d.manifest.model = { ...d.manifest.model, reasoningEffort: "high" }));
    expect(errors(doc)).toContain("model.reasoningEffort");
  });

  it("rejects built-in tools and permission modes the policy does not allow", () => {
    const doc = harness((d) => {
      d.manifest.builtinTools = ["shell"];
      d.manifest.permissions = { default: "allow", kinds: { read: "ask" }, questions: true };
    });
    expect(errors(doc)).toEqual(expect.arrayContaining(["builtinTools.0", "permissions.default", "permissions.kinds.read", "permissions.questions"]));
    const allowed = { ...policy, builtinTools: ["shell" as const], permissionModes: ["ask" as const, "allow" as const] };
    const capable = profiles.map((p) => ({ ...p, capabilities: [...p.capabilities, "builtin-tools", "interactive"] }));
    expect(errors(doc, { policy: allowed, profiles: capable })).toEqual([]);
  });

  it("warns when built-in tools are enabled but every action is denied", () => {
    const doc = harness((d) => void (d.manifest.builtinTools = ["files"]));
    const capable = profiles.map((p) => ({ ...p, capabilities: [...p.capabilities, "builtin-tools"] }));
    const issues = validate(doc, { policy: { ...policy, builtinTools: ["files"] }, profiles: capable });
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ level: "warning", path: "permissions" })]));
  });

  it("warns when the policy does not approve a profile and errors when no model is approved", () => {
    const unapprovedProfile = harness((d) => void (d.manifest.runners = { allowedProfiles: ["node-ts-agent", "python-agent"], defaultProfile: "node-ts-agent" }));
    expect(validate(unapprovedProfile).some((i) => i.level === "warning" && i.path === "runners.allowedProfiles")).toBe(true);
    expect(errors(harness((d) => void (d.manifest.model = { preferred: "other", allowed: ["other"] })))).toContain("model");
  });

  it("detects duplicate published versions", () => {
    const a = harness();
    const b = { ...harness(), folder: "sample@copy" };
    expect(errors(a, { all: [a, b] })).toContain("version");
  });

  it("asks for a version bump when example content changed, ignoring line endings", () => {
    const doc = harness();
    const committed = { manifest: JSON.stringify(doc.manifest), instructions: doc.instructions.replace(/\n/g, "\r\n") };
    expect(validate(doc, { committed })).toEqual([]);
    const edited = harness((d) => void (d.instructions = "Different."));
    const warning = validate(edited, { committed }).find((i) => i.path === "version");
    expect(warning).toMatchObject({ level: "warning", fix: "bump-patch" });
  });

  it("computes limits as the intersection of harness and policy", () => {
    const doc = harness((d) => {
      d.manifest.limits = { maxDurationSeconds: 900, maxInferenceTokens: 10_000 };
      d.manifest.retry = { safeToRetry: true, maxAttempts: 5 };
    });
    expect(effectiveLimits(doc, policy)).toEqual({ maxDurationSeconds: 600, tokenBudget: 10_000, maxAttempts: 2, model: "approved-model" });
  });

  it("matches the platform loader digest for insights-team", async () => {
    const repo = new Repo(customerConfigRoot, repoRoot);
    const document = await repo.readHarness("insights-team");
    const snapshots = await loadHarnesses(customerConfigRoot);
    expect(harnessDigest(document)).toBe(snapshots.get("insights-team")![0]!.digest);
  });

  it("describes decisions for the insights-team harness", async () => {
    const repo = new Repo(customerConfigRoot, repoRoot);
    const document = await repo.readHarness("insights-team");
    const context = { policy: await repo.readPolicy(), profiles: await repo.listProfiles(), all: await repo.listHarnesses() };
    const result = decisions(document, context);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "review", path: "prompt.mode" })]));
    expect(result.some((d) => d.kind === "host" && d.title.includes("compute_statistics") && d.detail.includes("Only sub-agents"))).toBe(true);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "gap", title: "Runner network egress is not enforced" })]));
  });

  it("validates every shipped template without errors", async () => {
    const repo = new Repo(customerConfigRoot, repoRoot);
    const shippedPolicy = await repo.readPolicy();
    const shippedProfiles = await repo.listProfiles();
    for (const template of listTemplates(shippedPolicy, shippedProfiles)) {
      const document = createFromTemplate(template.id, `template-${template.id}`, shippedPolicy.allowedModels[0]!, template.profiles, shippedPolicy);
      const issues = validateHarness(document, { policy: shippedPolicy, profiles: shippedProfiles, all: [document] });
      expect(issues.filter((i) => i.level === "error"), template.id).toEqual([]);
    }
  });

  it("ships the Copilot coding agent sample, valid and matching its template", async () => {
    const repo = new Repo(customerConfigRoot, repoRoot);
    const [shippedPolicy, shippedProfiles, document] = await Promise.all([repo.readPolicy(), repo.listProfiles(), repo.readHarness("copilot-coding-agent")]);
    const issues = validateHarness(document, { policy: shippedPolicy, profiles: shippedProfiles, all: [document] });
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    const fromTemplate = createFromTemplate("copilot-coding", "copilot-coding-agent", shippedPolicy.allowedModels[0]!, document.manifest.runners.allowedProfiles, shippedPolicy);
    expect(document.manifest).toEqual(fromTemplate.manifest);
    const result = decisions(document, { policy: shippedPolicy, profiles: shippedProfiles, all: [document] });
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "gap", title: "Shell and web tools can reach any network address" })]));
    expect(document.manifest.tools).toEqual([]);
    expect(document.manifest.agents ?? []).toEqual([]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Copilot built-in sub-agents are enabled", path: "builtinTools" }),
      expect.objectContaining({ title: "Managed job configuration, not native Copilot defaults", path: "runners" }),
    ]));
    const snapshots = await loadHarnesses(customerConfigRoot);
    expect(harnessDigest(document)).toBe(snapshots.get("copilot-coding-agent")![0]!.digest);
  });

  it("does not report built-in agents for a custom-agent-only harness", () => {
    const doc = harness((d) => {
      d.manifest.agents = [{ name: "reviewer", description: "Review the answer", instructions: "Review.", tools: [] }];
    });
    const result = decisions(doc, { policy, profiles, all: [doc] });
    expect(result.some((decision) => decision.title === "Copilot built-in sub-agents are enabled")).toBe(false);
    expect(result.some((decision) => decision.title === "reviewer sub-agent")).toBe(true);
  });

  it("does not describe a conversation harness as a batch job", () => {
    const doc = harness((d) => void (d.manifest.interaction = "conversation"));
    const result = decisions(doc, { policy, profiles, all: [doc] });
    expect(result.some((decision) => decision.title === "Managed job configuration, not native Copilot defaults")).toBe(false);
  });
});

describe("validatePolicy", () => {
  it("flags unknown profiles and unacknowledged gaps the shipped executor has", () => {
    const result = validatePolicy({ ...policy, allowedProfiles: ["ghost"], acknowledgedGaps: [] }, profiles);
    expect(result.issues.some((i) => i.level === "error" && i.message.includes("ghost"))).toBe(true);
    expect(result.issues.some((i) => i.level === "warning" && i.message.includes("egress"))).toBe(true);
  });
});

describe("validatePolicyOverride", () => {
  const context = { base: policy, profiles, harnessNames: ["sample"], fileHarness: "sample" };
  const document = (overrides: unknown, harnessName = "sample") => ({ schemaVersion: "1", harness: harnessName, overrides });

  it("returns the effective policy for a valid override", () => {
    const result = validatePolicyOverride(document({ maxDurationSeconds: 60, allowedProfiles: ["node-ts-agent", "python-agent"] }), context);
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(result.effective).toMatchObject({ maxDurationSeconds: 60, allowedProfiles: ["node-ts-agent", "python-agent"], leaseSeconds: 30 });
  });

  it("rejects global-only fields, unknown harnesses, and mismatched file names", () => {
    expect(validatePolicyOverride(document({ leaseSeconds: 10 }), context).issues[0]?.level).toBe("error");
    expect(validatePolicyOverride(document({}, "ghost"), { ...context, fileHarness: "ghost" }).issues.map((i) => i.message).join()).toMatch(/No harness named 'ghost'/);
    expect(validatePolicyOverride(document({}, "sample"), { ...context, fileHarness: "other" }).issues.some((i) => i.path === "harness")).toBe(true);
  });

  it("reports problems with the effective policy but not with inherited global fields", () => {
    const result = validatePolicyOverride(document({ allowedProfiles: ["ghost"] }), { ...context, base: { ...policy, leaseSeconds: 10 } });
    expect(result.issues.some((i) => i.level === "error" && i.message.includes("ghost"))).toBe(true);
    expect(result.issues.some((i) => i.path === "leaseSeconds")).toBe(false);
    expect(validatePolicyOverride(document({}), context).issues.some((i) => i.level === "warning" && i.path === "overrides")).toBe(true);
  });
});

describe("deployment inputs", () => {
  const target = {
    name: "staging",
    tenantId: "00000000-0000-0000-0000-000000000001",
    subscriptionId: "00000000-0000-0000-0000-000000000002",
    location: "westus2",
    resourceGroup: "rg-agents",
    foundryAccount: "acct",
    foundryResourceGroup: "ai",
    foundryEndpoint: "https://acct.openai.azure.com/openai/v1",
    foundryDeployments: ["gpt-a", "gpt-b"],
  };

  it("maps a target to the variables aspire deploy reads", () => {
    expect(
      deployEnvironment(target, { foundryEndpoint: "", foundryDeployments: [], npmRegistry: "https://npm.example/", pipIndexUrl: "", nugetServiceIndex: "" }),
    ).toMatchObject({
      Azure__SubscriptionId: target.subscriptionId,
      Azure__ResourceGroup: "rg-agents",
      "Parameters__foundry-deployments": "gpt-a,gpt-b",
      "Parameters__foundry-account": "acct",
      "Parameters__npm-registry": "https://npm.example/",
    });
  });

  it("rejects endpoints with credentials or query strings", () => {
    expect(DeployTargetSchema.safeParse({ ...target, foundryEndpoint: "https://user:pw@acct.openai.azure.com/openai/v1" }).success).toBe(false);
    expect(DeployTargetSchema.safeParse({ ...target, foundryEndpoint: "https://acct.openai.azure.com/openai/v1?api-key=x" }).success).toBe(false);
  });
});

describe("command invocation", () => {
  it.runIf(process.platform === "win32")("refuses shell metacharacters for shell-routed CLIs on Windows", () => {
    expect(() => invocation("az", ["group", "show", "--name", "rg&calc"])).toThrow(UnsafeArgumentError);
    expect(() => invocation("pnpm", ["test", "%PATH%"])).toThrow(UnsafeArgumentError);
    expect(invocation("az", ["group", "show", "--name", "rg-agents"]).file).toBe("cmd.exe");
  });

  it("spawns native executables directly without a shell", () => {
    expect(invocation("aspire", ["describe", "--format", "Json"])).toMatchObject({ file: "aspire", args: ["describe", "--format", "Json"] });
  });
});
