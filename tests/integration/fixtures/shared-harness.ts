import { join } from "node:path";
import {
  HarnessDefinition, HarnessPolicyOverride, SharedSessionLimits,
  type ExecutionPolicy, type HarnessSnapshot, type HostingDeployment,
} from "@copilot-agent/contracts";
import { canonicalJson, loadPolicySet, loadProfiles, sha256Hex } from "@copilot-agent/service-defaults";
import { SharedAdmission } from "../../../src/session-host/src/admission.js";
import { SharedConfiguration, type SharedRegistry } from "../../../src/session-host/src/configuration.js";
import { PERMISSION_HANDLERS } from "../../../src/session-host/src/permission-handlers.js";

const repo = join(import.meta.dirname, "..", "..", "..");

/** A synthetic published conversation harness with shared hosting; `changes` replace top-level fields. */
export function sharedHarness(name: string, changes: Partial<Record<keyof HarnessDefinition, unknown>> = {}): HarnessSnapshot {
  const definition = HarnessDefinition.parse({
    schemaVersion: "1", name, version: "1.0.0", description: "Synthetic shared harness.", interaction: "conversation",
    hosting: { mode: "shared" }, instructions: "Reply briefly to the synthetic application message.",
    model: { preferred: "fixture", allowed: ["fixture"] }, tools: [],
    input: { schema: { type: "object", additionalProperties: false } }, output: { schema: { type: "object" } },
    limits: { maxDurationSeconds: 180, maxInferenceTokens: 1_000_000 }, retry: { safeToRetry: false, maxAttempts: 1 },
    runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
    ...changes,
  });
  return { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
}

/**
 * Published harnesses, the repository's execution profiles, and the example base policy with shared hosting allowed.
 * `policy` replaces base fields; `overrides` are per-harness policy overrides.
 */
export async function sharedRegistry(
  snapshots: readonly HarnessSnapshot[],
  policy: Partial<ExecutionPolicy> = {},
  overrides: Record<string, HarnessPolicyOverride["overrides"]> = {},
): Promise<SharedRegistry> {
  const [profiles, examples] = await Promise.all([loadProfiles(repo), loadPolicySet(join(repo, "examples", "customer-config"))]);
  const harnesses = new Map<string, HarnessSnapshot[]>();
  for (const snapshot of snapshots) harnesses.set(snapshot.definition.name, [...(harnesses.get(snapshot.definition.name) ?? []), snapshot]);
  return {
    harnesses, profiles,
    policies: {
      base: { ...examples.base, allowedModels: ["fixture"], hosting: { modes: ["isolated", "shared"] }, ...policy },
      overrides: new Map(Object.entries(overrides).map(([harness, values]) => [harness, HarnessPolicyOverride.parse({ schemaVersion: "1", harness, overrides: values })])),
    },
  };
}

export function sharedAdmission(
  registry: SharedRegistry,
  options: { sessionLimits?: Partial<SharedSessionLimits>; delegation?: string[]; deployment?: HostingDeployment; handlers?: Iterable<string> } = {},
): SharedAdmission {
  return new SharedAdmission({
    configuration: SharedConfiguration.fixed(registry),
    sessionLimits: SharedSessionLimits.parse(options.sessionLimits ?? {}),
    delegationHarnesses: options.delegation ?? [],
    permissionHandlers: new Set(options.handlers ?? PERMISSION_HANDLERS.keys()),
    ...(options.deployment ? { deployment: options.deployment } : {}),
  });
}
