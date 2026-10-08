import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPolicyOverride,
  type ExecutionPolicy,
  HarnessPolicyOverride,
  jobSecurityGaps,
  policyFor,
  securityRequirementsOf,
} from "@copilot-agent/contracts";
import { assertOverridesMatchHarnesses, ConfigError, loadPolicyOverrides, loadPolicySet, policyDigest } from "@copilot-agent/service-defaults";

const base: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["m"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 10_000,
  maxConcurrentAttemptsPerPrincipal: 2,
  maxQueuedJobsPerPrincipal: 10,
  retry: { maxAttempts: 2, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  builtinTools: ["files"],
  maxReasoningEffort: "medium",
};

describe("HarnessPolicyOverride", () => {
  it("accepts only overridable fields", () => {
    expect(HarnessPolicyOverride.safeParse({ schemaVersion: "1", harness: "coder", overrides: { maxDurationSeconds: 60 } }).success).toBe(true);
    for (const field of ["leaseSeconds", "maxConcurrentAttemptsPerPrincipal", "maxQueuedJobsPerPrincipal", "schemaVersion"]) {
      expect(HarnessPolicyOverride.safeParse({ schemaVersion: "1", harness: "coder", overrides: { [field]: 10 } }).success, field).toBe(false);
    }
    expect(HarnessPolicyOverride.safeParse({ schemaVersion: "1", harness: "Not A Slug", overrides: {} }).success).toBe(false);
  });

  it("replaces overridden fields and inherits the rest", () => {
    const override = { schemaVersion: "1" as const, harness: "coder", overrides: { builtinTools: [], allowedModels: ["x"] } };
    const effective = applyPolicyOverride(base, override);
    expect(effective.builtinTools).toEqual([]);
    expect(effective.allowedModels).toEqual(["x"]);
    expect(effective.maxReasoningEffort).toBe("medium");
    expect(effective.leaseSeconds).toBe(30);
    expect(applyPolicyOverride(base, undefined)).toBe(base);
    const set = { base, overrides: new Map([["coder", override]]) };
    expect(policyFor(set, "coder").allowedModels).toEqual(["x"]);
    expect(policyFor(set, "other")).toBe(base);
  });

  it("derives job requirements and the gaps an executor leaves", () => {
    const requirements = securityRequirementsOf(base);
    expect(requirements).toEqual({ requiresUidIsolation: true, requiresEgressEnforcement: true, acknowledgedGaps: ["egress-not-enforced"] });
    expect(jobSecurityGaps(requirements, { processIsolation: "uid", egress: "none" })).toEqual(["egress-not-enforced"]);
    expect(jobSecurityGaps(requirements, { processIsolation: "none", egress: "gateway-only" })).toEqual(["process-isolation-not-enforced"]);
  });

  it("produces a stable digest that changes with the effective policy", () => {
    expect(policyDigest(base)).toBe(policyDigest({ ...base }));
    expect(policyDigest(base)).not.toBe(policyDigest({ ...base, maxDurationSeconds: 60 }));
  });
});

describe("policy override loading", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function workspace(files: Record<string, unknown>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "policy-overrides-"));
    await mkdir(join(root, "policy", "harnesses"), { recursive: true });
    await writeFile(join(root, "policy", "execution-policy.json"), JSON.stringify(base));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, "policy", "harnesses", name), typeof content === "string" ? content : JSON.stringify(content));
    }
    return root;
  }

  it("loads overrides keyed by harness and treats a missing directory as none", async () => {
    const dir = await workspace({ "coder.json": { schemaVersion: "1", harness: "coder", overrides: { maxDurationSeconds: 60 } }, "notes.txt": "ignored" });
    const set = await loadPolicySet(dir);
    expect([...set.overrides.keys()]).toEqual(["coder"]);
    expect(policyFor(set, "coder").maxDurationSeconds).toBe(60);
    await rm(join(dir, "policy", "harnesses"), { recursive: true });
    expect((await loadPolicyOverrides(dir)).size).toBe(0);
  });

  it("rejects invalid, misnamed, and orphaned overrides", async () => {
    await expect(loadPolicyOverrides(await workspace({ "coder.json": "{" }))).rejects.toBeInstanceOf(ConfigError);
    await rm(root!, { recursive: true, force: true });
    await expect(
      loadPolicyOverrides(await workspace({ "coder.json": { schemaVersion: "1", harness: "coder", overrides: { leaseSeconds: 5 } } })),
    ).rejects.toThrow(/invalid/);
    await rm(root!, { recursive: true, force: true });
    await expect(
      loadPolicyOverrides(await workspace({ "other.json": { schemaVersion: "1", harness: "coder", overrides: {} } })),
    ).rejects.toThrow(/must be named/);
    const set = { base, overrides: new Map([["typo", { schemaVersion: "1" as const, harness: "typo", overrides: {} }]]) };
    expect(() => assertOverridesMatchHarnesses(set, ["coder"])).toThrow(/typo/);
    expect(() => assertOverridesMatchHarnesses(set, ["typo"])).not.toThrow();
  });
});
