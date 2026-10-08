import { z } from "zod";
import { BUILTIN_TOOL_GROUPS, type HarnessDefinition, REASONING_EFFORTS, RUNNER_FEATURES, SLUG } from "./harness.js";
import { RUNNER_PROTOCOL_VERSION } from "./runner-protocol.js";

export const ProcessIsolation = z.enum(["none", "uid"]);
export type ProcessIsolation = z.infer<typeof ProcessIsolation>;

export const EgressEnforcement = z.enum(["none", "gateway-only"]);
export type EgressEnforcement = z.infer<typeof EgressEnforcement>;

/**
 * An operator-approved execution profile. Selecting a language never grants credentials,
 * disables confinement, or widens network access.
 */
export const ExecutionProfile = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().regex(SLUG),
    displayName: z.string().min(1).max(200),
    runnerProtocol: z.literal(RUNNER_PROTOCOL_VERSION),
    agent: z
      .object({
        language: z.enum(["typescript", "python"]),
        sdk: z.string().min(1),
        sdkVersion: z.string().min(1),
        firstParty: z.boolean(),
      })
      .strict(),
    entrypoint: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
        /** Working directory for the runner relative to the executor configuration root. */
        directory: z.string().min(1),
        /**
         * Non-secret environment for the runner. `{root}` expands to the executor configuration root.
         * Credentials are never configured here; the runner receives only its job-scoped capability.
         */
        env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(1000)).default({}),
      })
      .strict(),
    toolchains: z.array(z.object({ name: z.string(), version: z.string() }).strict()),
    /** Tool bindings this profile can satisfy. */
    toolBindings: z.array(z.string().min(1)),
    capabilities: z.array(z.enum(["cancel", "structured-result", "trace-context", "local-mcp", ...RUNNER_FEATURES])),
  })
  .strict();
export type ExecutionProfile = z.infer<typeof ExecutionProfile>;

/** Operator-enforced ceilings. Harnesses and callers can only narrow these. */
export const ExecutionPolicy = z
  .object({
    schemaVersion: z.literal("1"),
    allowedProfiles: z.array(z.string().regex(SLUG)).min(1),
    allowedModels: z.array(z.string().min(1)).min(1),
    maxDurationSeconds: z.number().int().min(10).max(3600),
    maxInferenceTokensPerJob: z.number().int().min(1000),
    maxConcurrentAttemptsPerPrincipal: z.number().int().min(1).max(1000),
    maxQueuedJobsPerPrincipal: z.number().int().min(1).max(100_000),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(5),
        backoffSeconds: z.number().int().min(1).max(3600),
      })
      .strict(),
    leaseSeconds: z.number().int().min(10).max(600),
    requirements: z
      .object({
        processIsolation: ProcessIsolation,
        egress: EgressEnforcement,
      })
      .strict(),
    /**
     * Explicit operator acknowledgement of requirements the execution target cannot enforce.
     * Without an acknowledgement, executors that cannot enforce a requirement cannot claim work.
     * Acknowledged gaps are recorded on every attempt.
     */
    acknowledgedGaps: z.array(z.enum(["egress-not-enforced", "process-isolation-not-enforced"])),
    /** Highest reasoning effort a harness or sub-agent may request. Omitted means no cap. */
    maxReasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    /** Whether harnesses may request the long-context model tier. Omitted means not allowed. */
    allowLongContext: z.boolean().optional(),
    /** Built-in tool groups harnesses may enable. Omitted means none. */
    builtinTools: z.array(z.enum(BUILTIN_TOOL_GROUPS)).optional(),
    /** Permission modes harnesses may use besides deny ("ask" routes to people, "allow" approves automatically). */
    permissionModes: z.array(z.enum(["ask", "allow"])).optional(),
  })
  .strict();
export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;
export type SecurityGap = ExecutionPolicy["acknowledgedGaps"][number];

/**
 * Policy fields an operator may override for one harness. Lease timing and per-caller quotas
 * (`leaseSeconds`, `maxConcurrentAttemptsPerPrincipal`, `maxQueuedJobsPerPrincipal`) stay global.
 */
export const HARNESS_OVERRIDABLE_POLICY_FIELDS = [
  "allowedProfiles",
  "allowedModels",
  "maxDurationSeconds",
  "maxInferenceTokensPerJob",
  "retry",
  "requirements",
  "acknowledgedGaps",
  "maxReasoningEffort",
  "allowLongContext",
  "builtinTools",
  "permissionModes",
] as const;
export type HarnessOverridablePolicyField = (typeof HARNESS_OVERRIDABLE_POLICY_FIELDS)[number];

/**
 * Operator-owned override for one harness, stored as `policy/harnesses/<harness>.json`. Each listed
 * field replaces the base policy value for every version of that harness; omitted fields inherit.
 * Harness definitions cannot reference or select a policy.
 */
export const HarnessPolicyOverride = z
  .object({
    schemaVersion: z.literal("1"),
    harness: z.string().regex(SLUG),
    overrides: ExecutionPolicy.pick({
      allowedProfiles: true,
      allowedModels: true,
      maxDurationSeconds: true,
      maxInferenceTokensPerJob: true,
      retry: true,
      requirements: true,
      acknowledgedGaps: true,
      maxReasoningEffort: true,
      allowLongContext: true,
      builtinTools: true,
      permissionModes: true,
    })
      .partial()
      .strict(),
  })
  .strict();
export type HarnessPolicyOverride = z.infer<typeof HarnessPolicyOverride>;

/** The base policy plus operator overrides keyed by harness name. */
export interface PolicySet {
  base: ExecutionPolicy;
  overrides: ReadonlyMap<string, HarnessPolicyOverride>;
}

/** Applies a harness override to the base policy. */
export function applyPolicyOverride(base: ExecutionPolicy, override: HarnessPolicyOverride | undefined): ExecutionPolicy {
  if (!override) return base;
  const effective: Record<string, unknown> = { ...base };
  for (const field of HARNESS_OVERRIDABLE_POLICY_FIELDS) {
    const value = override.overrides[field];
    if (value !== undefined) effective[field] = value;
  }
  return effective as ExecutionPolicy;
}

/** The effective policy for one harness: the base policy plus that harness's override, if any. */
export function policyFor(set: PolicySet, harness: string): ExecutionPolicy {
  return applyPolicyOverride(set.base, set.overrides.get(harness));
}

/** Security controls a job's effective policy requires, recorded at admission and matched at claim time. */
export interface JobSecurityRequirements {
  requiresUidIsolation: boolean;
  requiresEgressEnforcement: boolean;
  acknowledgedGaps: SecurityGap[];
}

export function securityRequirementsOf(policy: ExecutionPolicy): JobSecurityRequirements {
  return {
    requiresUidIsolation: policy.requirements.processIsolation === "uid",
    requiresEgressEnforcement: policy.requirements.egress === "gateway-only",
    acknowledgedGaps: [...policy.acknowledgedGaps],
  };
}

/** Controls a job requires that the executor does not enforce, whether or not they are acknowledged. */
export function jobSecurityGaps(
  requirements: Pick<JobSecurityRequirements, "requiresUidIsolation" | "requiresEgressEnforcement">,
  executor: Pick<ExecutorCapabilities, "processIsolation" | "egress">,
): SecurityGap[] {
  const gaps: SecurityGap[] = [];
  if (requirements.requiresUidIsolation && executor.processIsolation !== "uid") gaps.push("process-isolation-not-enforced");
  if (requirements.requiresEgressEnforcement && executor.egress !== "gateway-only") gaps.push("egress-not-enforced");
  return gaps;
}

/**
 * Checks a harness's model options against policy ceilings. Returns field-scoped problems; the
 * agent API rejects such jobs, and the configurator shows them as errors.
 */
export function modelOptionViolations(
  definition: { model: { reasoningEffort?: string; contextTier?: string }; agents?: Array<{ name: string; reasoningEffort?: string }> },
  policy: Pick<ExecutionPolicy, "maxReasoningEffort" | "allowLongContext">,
): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  const rank = (effort: string | undefined) => (effort ? REASONING_EFFORTS.indexOf(effort as never) : -1);
  const cap = policy.maxReasoningEffort;
  if (cap && rank(definition.model.reasoningEffort) > rank(cap)) {
    problems.push({ path: "model.reasoningEffort", message: `Reasoning effort exceeds the policy maximum (${cap}).` });
  }
  definition.agents?.forEach((agent, index) => {
    if (cap && rank(agent.reasoningEffort) > rank(cap)) {
      problems.push({ path: `agents.${index}.reasoningEffort`, message: `Reasoning effort exceeds the policy maximum (${cap}).` });
    }
  });
  if (definition.model.contextTier === "long_context" && !policy.allowLongContext) {
    problems.push({ path: "model.contextTier", message: "The operator policy does not allow the long-context tier." });
  }
  return problems;
}

/** Checks built-in tools and permission modes against the policy. Same shape as modelOptionViolations. */
export function toolPolicyViolations(
  definition: Pick<HarnessDefinition, "builtinTools" | "permissions">,
  policy: Pick<ExecutionPolicy, "builtinTools" | "permissionModes">,
): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  const allowedGroups = new Set(policy.builtinTools ?? []);
  (definition.builtinTools ?? []).forEach((group, index) => {
    if (!allowedGroups.has(group)) {
      problems.push({ path: `builtinTools.${index}`, message: `The operator policy does not allow the '${group}' built-in tools.` });
    }
  });
  const allowedModes = new Set<string>(["deny", ...(policy.permissionModes ?? [])]);
  const permissions = definition.permissions;
  if (permissions) {
    if (!allowedModes.has(permissions.default)) {
      problems.push({ path: "permissions.default", message: `The operator policy does not allow the '${permissions.default}' permission mode.` });
    }
    for (const [kind, mode] of Object.entries(permissions.kinds ?? {})) {
      if (mode && !allowedModes.has(mode)) {
        problems.push({ path: `permissions.kinds.${kind}`, message: `The operator policy does not allow the '${mode}' permission mode.` });
      }
    }
    if (permissions.questions && !allowedModes.has("ask")) {
      problems.push({ path: "permissions.questions", message: "Questions need the 'ask' permission mode, which the operator policy does not allow." });
      }
  }
  return problems;
}

/** What an executor actually enforces, reported on every claim. */
export const ExecutorCapabilities = z
  .object({
    executorId: z.string().min(1).max(200),
    imageDigest: z.string().max(200).optional(),
    profiles: z.array(z.string().regex(SLUG)),
    processIsolation: ProcessIsolation,
    egress: EgressEnforcement,
    platform: z.string().max(100),
  })
  .strict();
export type ExecutorCapabilities = z.infer<typeof ExecutorCapabilities>;

/**
 * Returns the security gaps between what the policy requires and what the executor enforces.
 * The dispatcher hands a job only to executors whose gaps the job's effective policy acknowledges.
 */
export function securityGaps(policy: ExecutionPolicy, executor: ExecutorCapabilities): SecurityGap[] {
  return jobSecurityGaps(securityRequirementsOf(policy), executor);
}
