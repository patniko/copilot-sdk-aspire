import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import type { ExecutionPolicy, ExecutionProfile, HarnessSnapshot } from "@copilot-agent/contracts";
import { HttpError, loadHarnesses, loadPolicy, loadProfiles } from "@copilot-agent/service-defaults";
import { Admission } from "../../src/agent-api/src/admission.js";

const root = join(import.meta.dirname, "..", "..");
const customerConfigRoot = join(root, "examples", "customer-config");
let harnesses: Map<string, HarnessSnapshot[]>;
let profiles: Map<string, ExecutionProfile>;
let policy: ExecutionPolicy;

const validInput = {
  question: "q",
  dataset: { name: "d", columns: ["x"], rows: [[1], [2]] },
};

beforeAll(async () => {
  [harnesses, profiles, policy] = await Promise.all([
    loadHarnesses(customerConfigRoot),
    loadProfiles(root),
    loadPolicy(customerConfigRoot),
  ]);
});

function admit(submission: object, policyOverrides: Partial<ExecutionPolicy> = {}) {
  return new Admission({ harnesses, profiles, policy: { ...policy, ...policyOverrides } }).admit(
    submission as Parameters<Admission["admit"]>[0],
  );
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof HttpError ? error.code : "unexpected";
  }
  return undefined;
}

function httpError(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) {
      return error;
    }
  }
  throw new Error("Expected HttpError");
}

function admitWithDefinition(definition: HarnessSnapshot["definition"], policyOverrides: Partial<ExecutionPolicy> = {}) {
  const snapshot: HarnessSnapshot = { definition, digest: `test:${definition.name}` };
  return new Admission({
    harnesses: new Map([[definition.name, [snapshot]]]),
    profiles,
    policy: { ...policy, ...policyOverrides },
  }).admit({ harness: { name: definition.name }, input: validInput });
}

describe("Admission", () => {
  it("admits the published harness with intersected limits", () => {
    const admitted = admit({ harness: { name: "dataset-analyst" }, input: validInput, deadlineSeconds: 45 });
    expect(admitted.profile).toBe("node-ts-agent");
    expect(admitted.model).toBe("grok-4.6");
    expect(admitted.maxDurationSeconds).toBe(45);
    expect(admitted.tokenBudget).toBe(Math.min(300_000, policy.maxInferenceTokensPerJob));
    expect(admitted.harness.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces a stable request hash for identical submissions", () => {
    const a = admit({ harness: { name: "dataset-analyst" }, input: validInput });
    const b = admit({ input: { dataset: validInput.dataset, question: "q" }, harness: { name: "dataset-analyst" } });
    expect(a.requestHash).toBe(b.requestHash);
  });

  it("rejects unknown harnesses and versions", () => {
    expect(errorCode(() => admit({ harness: { name: "missing" }, input: validInput }))).toBe("harness_not_found");
    expect(
      errorCode(() => admit({ harness: { name: "dataset-analyst", version: "9.9.9" }, input: validInput })),
    ).toBe("harness_not_found");
  });

  it("rejects input that does not match the harness schema", () => {
    expect(errorCode(() => admit({ harness: { name: "dataset-analyst" }, input: { question: "q" } }))).toBe(
      "invalid_input",
    );
  });

  it("rejects profiles the operator has not approved", () => {
    expect(
      errorCode(() =>
        admit({ harness: { name: "dataset-analyst" }, profile: "python-agent", input: validInput }, {
          allowedProfiles: ["node-ts-agent"],
        }),
      ),
    ).toBe("policy_rejected");
  });

  it("rejects harness models the operator has not approved", () => {
    expect(
      errorCode(() => admit({ harness: { name: "dataset-analyst" }, input: validInput }, { allowedModels: ["other"] })),
    ).toBe("policy_rejected");
  });

  it("rejects built-in tools disallowed by policy", () => {
    const base = harnesses.get("dataset-analyst")![0]!.definition;
    const error = httpError(() =>
      admitWithDefinition({ ...base, builtinTools: ["shell"] }, { builtinTools: [] }),
    );
    expect(error.code).toBe("policy_rejected");
    expect(error.details).toMatchObject({
      problems: [{ path: "builtinTools.0" }],
    });
  });

  it("rejects permission modes disallowed by policy", () => {
    const base = harnesses.get("dataset-analyst")![0]!.definition;
    const error = httpError(() =>
      admitWithDefinition(
        { ...base, permissions: { default: "allow", kinds: { shell: "ask" }, questions: true } },
        { permissionModes: [] },
      ),
    );
    expect(error.code).toBe("policy_rejected");
    expect(error.details).toMatchObject({
      problems: [{ path: "permissions.default" }, { path: "permissions.kinds.shell" }, { path: "permissions.questions" }],
    });
  });
});
