import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "../server/types";
import {
  countIssues,
  differencesFromBase,
  draftKey,
  isDirty,
  issueGroup,
  overriddenGroups,
  overridesFrom,
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

  it("keeps override fields that have no card yet and lists their issues at the document level", () => {
    const overrides = { hosting: { modes: ["isolated", "shared"] as Array<"isolated" | "shared"> }, approvalModes: ["manual" as const] };
    const groups = overriddenGroups(overrides);
    expect(groups).toEqual(["approvalModes", "hosting"]);
    const policy = { ...base, ...overrides, permissionHandlers: ["inherited"] };
    expect(overridesFrom(policy, withGroup(groups, "agents", true))).toEqual({
      allowedProfiles: base.allowedProfiles,
      allowedModels: base.allowedModels,
      approvalModes: ["manual"],
      hosting: { modes: ["isolated", "shared"] },
    });
    expect(issueGroup({ level: "error", path: "hosting.defaultSize", message: "" })).toBeUndefined();
    expect(issueGroup({ level: "warning", path: "mcpServers", message: "" })).toBeUndefined();
  });
});
