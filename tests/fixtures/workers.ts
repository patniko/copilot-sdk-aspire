import { join } from "node:path";
import {
  type CraftingTemplate, type ExecutionPolicy, HarnessDefinition, HarnessPolicyOverride, type HarnessSnapshot, type HostingWorkers,
} from "@copilot-agent/contracts";
import { canonicalJson, loadPolicySet, loadProfiles, sha256Hex, type WorkerRegistry } from "@copilot-agent/service-defaults";

const repo = join(import.meta.dirname, "..", "..");

/** The only model the synthetic worker policy approves. */
export const MODEL = "fixture";

/** A synthetic isolated conversation harness; `changes` replace top-level fields. */
export function conversation(name: string, changes: Partial<Record<keyof HarnessDefinition, unknown>> = {}): HarnessDefinition {
  return HarnessDefinition.parse({
    schemaVersion: "1", name, version: "1.0.0", description: "Synthetic conversation harness.", interaction: "conversation",
    instructions: "Do the synthetic task.", model: { preferred: MODEL, allowed: [MODEL] }, tools: [],
    permissions: { default: "ask" },
    input: { schema: { type: "object", additionalProperties: false } }, output: { schema: { type: "object" } },
    limits: { maxDurationSeconds: 600, maxInferenceTokens: 200_000 }, retry: { safeToRetry: false, maxAttempts: 1 },
    runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
    ...changes,
  });
}

/** A synthetic orchestrator coordinator. */
export function coordinator(name: string, workers: HostingWorkers, changes: Partial<Record<keyof HarnessDefinition, unknown>> = {}): HarnessDefinition {
  return conversation(name, { hosting: { mode: "orchestrator", workers }, permissions: { default: "deny" }, ...changes });
}

export function snapshot(definition: HarnessDefinition): HarnessSnapshot {
  return { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
}

/** The crafting template the synthetic policy offers as `general`. */
export const TEMPLATE: CraftingTemplate = {
  toolBindings: ["python:stats"], builtinTools: ["files", "shell"], models: [MODEL], approvalModes: ["manual", "assisted"],
  maxDurationSeconds: 900, maxInferenceTokens: 100_000, sizes: ["small", "medium"],
};

/** The example base policy with orchestrators, inherited authority, assisted approvals, and the `general` template allowed. */
export function workerPolicy(base: ExecutionPolicy, changes: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...base, allowedModels: [MODEL], approvalModes: ["manual", "assisted"],
    hosting: { modes: ["isolated", "shared", "orchestrator"], workers: { allowInheritedAuthority: true }, crafting: { templates: { general: TEMPLATE } } },
    ...changes,
  };
}

/** Published harnesses, the repository's execution profiles, and the synthetic worker policy. */
export async function workerRegistry(
  definitions: readonly HarnessDefinition[],
  changes: Partial<ExecutionPolicy> = {},
  overrides: Record<string, HarnessPolicyOverride["overrides"]> = {},
): Promise<WorkerRegistry> {
  const [profiles, examples] = await Promise.all([loadProfiles(repo), loadPolicySet(join(repo, "examples", "customer-config"))]);
  const harnesses = new Map<string, HarnessSnapshot[]>();
  for (const definition of definitions) harnesses.set(definition.name, [...(harnesses.get(definition.name) ?? []), snapshot(definition)]);
  return {
    harnesses, profiles,
    policies: {
      base: workerPolicy(examples.base, changes),
      overrides: new Map(Object.entries(overrides).map(([harness, values]) => [harness, HarnessPolicyOverride.parse({ schemaVersion: "1", harness, overrides: values })])),
    },
  };
}
