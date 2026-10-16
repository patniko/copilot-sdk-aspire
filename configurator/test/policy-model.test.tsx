import { describe, expect, it } from "vitest";
import type { EffectiveHostingPolicy, ExecutionPolicy } from "../server/types";
import {
  countIssues,
  differencesFromBase,
  draftKey,
  effectiveHosting,
  formatPolicyValue,
  freeName,
  isDirty,
  issueGroup,
  overriddenGroups,
  overridesFrom,
  renameKey,
  smallestSize,
  UNCARDED_GROUPS,
  withGroup,
} from "../src/views/policy/model";

const base: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["gpt-5"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 200_000,
  maxConcurrentAttemptsPerPrincipal: 4,
  maxQueuedJobsPerPrincipal: 100,
  retry: { maxAttempts: 3, backoffSeconds: 30 },
  leaseSeconds: 60,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
};

describe("policy page model", () => {
  it("places each issue on the card that owns its field, and global limits on the limits card", () => {
    expect(issueGroup({ level: "error", path: "allowedProfiles", message: "" })).toBe("agents");
    expect(issueGroup({ level: "warning", path: "retry.maxAttempts", message: "" })).toBe("limits");
    expect(issueGroup({ level: "warning", path: "leaseSeconds", message: "" })).toBe("limits");
    expect(issueGroup({ level: "warning", path: "requirements.processIsolation", message: "" })).toBe("controls");
    expect(issueGroup({ level: "error", path: "harness", message: "" })).toBeUndefined();
    expect(issueGroup({ level: "error", path: "(root)", message: "" })).toBeUndefined();
  });

  it("counts errors and warnings", () => {
    expect(countIssues([
      { level: "error", path: "a", message: "" },
      { level: "warning", path: "b", message: "" },
      { level: "warning", path: "c", message: "" },
    ])).toEqual({ errors: 1, warnings: 2 });
  });

  it("keeps card order stable when toggling overrides", () => {
    expect(withGroup(["controls"], "agents", true)).toEqual(["agents", "controls"]);
    expect(withGroup(["agents", "controls"], "agents", false)).toEqual(["controls"]);
    expect(overriddenGroups({ retry: base.retry, builtinTools: [] })).toEqual(["limits", "tools"]);
  });

  it("writes explicit values for optional overridden fields so they do not inherit", () => {
    expect(overridesFrom(base, ["tools", "model"])).toEqual({
      builtinTools: [],
      permissionModes: [],
      maxReasoningEffort: "xhigh",
      allowLongContext: false,
    });
  });

  it("is dirty in harness scope only when the override file would change", () => {
    const saved = { policy: base, groups: [] };
    const globalEdit = { policy: { ...base, leaseSeconds: 90 }, groups: [] };
    expect(isDirty(globalEdit, saved, true)).toBe(false);
    expect(isDirty(globalEdit, saved, false)).toBe(true);
    expect(isDirty({ policy: base, groups: ["limits"] }, saved, true)).toBe(true);
    const reordered = { policy: { ...base, retry: { backoffSeconds: 30, maxAttempts: 3 } }, groups: [] };
    expect(isDirty(reordered, saved, false)).toBe(false);
  });

  it("describes how an overridden card differs from the base policy", () => {
    const policy = { ...base, maxDurationSeconds: 1200, retry: { maxAttempts: 1, backoffSeconds: 30 } };
    expect(differencesFromBase("limits", policy, base)).toEqual([
      { field: "maxDurationSeconds", label: "Max duration", base: "600s", value: "1200s" },
      { field: "retry", label: "Retry", base: "maxAttempts 3, backoffSeconds 30", value: "maxAttempts 1, backoffSeconds 30" },
    ]);
    expect(differencesFromBase("model", { ...base, maxReasoningEffort: "high" }, base)).toEqual([
      { field: "maxReasoningEffort", label: "Reasoning cap", base: "no cap", value: "high" },
    ]);
    expect(differencesFromBase("agents", base, base)).toEqual([]);
  });

  it("keeps base and harness drafts apart", () => {
    expect(draftKey("")).toBe("policy:base");
    expect(draftKey("text-summarizer")).toBe("policy:harness:text-summarizer");
  });

  it("gives approval, MCP and hosting overrides their own cards, and keeps every field a card owns", () => {
    expect(UNCARDED_GROUPS).toEqual([]);
    const overrides = { hosting: { modes: ["isolated", "shared"] as Array<"isolated" | "shared"> }, approvalModes: ["manual" as const] };
    const groups = overriddenGroups(overrides);
    expect(groups).toEqual(["approvals", "hosting"]);
    const policy = { ...base, ...overrides, permissionHandlers: ["inherited"] };
    expect(overridesFrom(policy, withGroup(groups, "agents", true))).toEqual({
      allowedProfiles: base.allowedProfiles,
      allowedModels: base.allowedModels,
      approvalModes: ["manual"],
      permissionHandlers: ["inherited"],
      hosting: { modes: ["isolated", "shared"] },
    });
    expect(issueGroup({ level: "error", path: "hosting.defaultSize", message: "" })).toBe("hosting");
    expect(issueGroup({ level: "warning", path: "mcpServers.docs.allowPrivateNetwork", message: "" })).toBe("mcp");
    expect(issueGroup({ level: "warning", path: "permissionHandlers.0", message: "" })).toBe("approvals");
    expect(issueGroup({ level: "warning", path: "approvalModes", message: "" })).toBe("approvals");
  });

  it("writes explicit defaults for overridden approval, MCP and hosting cards so they do not inherit", () => {
    expect(overridesFrom(base, ["approvals", "mcp", "hosting"])).toEqual({
      approvalModes: ["manual"],
      permissionHandlers: [],
      mcpServers: {},
      hosting: {},
    });
  });

  it("summarizes hosting and MCP values for the differences list", () => {
    expect(formatPolicyValue("hosting", undefined)).toBe("defaults (isolated only)");
    expect(formatPolicyValue("approvalModes", undefined)).toBe("manual");
    expect(formatPolicyValue("mcpServers", { search: { url: "https://mcp.example.com", tools: ["a"] } })).toBe("search");
    expect(formatPolicyValue("hosting", { modes: ["isolated", "shared"], defaultSize: "small", promotion: { approval: ["ask"] } })).toBe(
      "modes isolated, shared; default size small; promotion ask",
    );
    const policy = { ...base, hosting: { modes: ["shared" as const] } };
    expect(differencesFromBase("hosting", policy, base)).toEqual([
      { field: "hosting", label: "Hosting", base: "defaults (isolated only)", value: "modes shared" },
    ]);
  });

  it("shows the documented defaults for omitted hosting ceilings", () => {
    const defaults: EffectiveHostingPolicy = {
      modes: ["isolated"],
      transports: ["direct", "github"],
      sizes: { small: { cpus: 0.5, memoryMiB: 1024 }, large: { cpus: 2, memoryMiB: 4096 } },
      defaultSize: "small",
      workers: { maxConcurrentPerSession: 4, maxPerSession: 16, maxPerPrincipal: 8, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: false, allowCoordinatorAnswers: false },
      promotion: { approval: ["ask"] },
      crafting: { templates: {} },
    };
    expect(effectiveHosting(undefined, defaults)).toEqual(defaults);
    const custom = effectiveHosting({ sizes: { big: { cpus: 4, memoryMiB: 8192 }, tiny: { cpus: 0.25, memoryMiB: 512 } }, workers: { maxPerSession: 2 } }, defaults);
    expect(custom.defaultSize).toBe("tiny");
    expect(custom.workers).toEqual({ ...defaults.workers, maxPerSession: 2 });
    expect(custom.modes).toEqual(["isolated"]);
    expect(smallestSize({ b: { cpus: 1, memoryMiB: 1024 }, a: { cpus: 1, memoryMiB: 1024 } })).toBe("a");
  });

  it("renames entries in place and finds unused names", () => {
    expect(Object.keys(renameKey({ first: 1, second: 2, third: 3 }, "second", "middle"))).toEqual(["first", "middle", "third"]);
    expect(freeName("size", [])).toBe("size");
    expect(freeName("size", ["size", "size-2"])).toBe("size-3");
  });
});
