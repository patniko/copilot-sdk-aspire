import { z } from "zod";
import {
  APPROVAL_MODES,
  type ApprovalMode,
  approvalModeOf,
  BUILTIN_TOOL_GROUPS,
  DEFAULT_HOSTING_APPROVAL,
  HANDOFF_HISTORY,
  type HarnessDefinition,
  HOSTING_APPROVALS,
  HOSTING_MODES,
  type HostingMode,
  hostingModeOf,
  MCP_TOOL_NAME,
  permissionModesUsed,
  REASONING_EFFORTS,
  RUNNER_FEATURES,
  runsOnSharedWorker,
  SLUG,
} from "./harness.js";
import { RUNNER_PROTOCOL_VERSION } from "./runner-protocol.js";

const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;
const DISTINCT = "Each value can be listed once.";

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
    /**
     * Host tool bindings, from `toolBindings`, that are also safe to run inside a shared worker's process: no shell,
     * real files, or spawned processes. Omitted means none, so shared placement cannot run this profile's bindings.
     */
    inProcessBindings: z.array(z.string().min(1)).refine(distinct, DISTINCT).optional(),
    /** Custom permission handlers (reviewed integrator code) this profile provides for the `custom` approval mode. */
    permissionHandlers: z.array(z.string().regex(SLUG)).refine(distinct, DISTINCT).optional(),
    capabilities: z.array(z.enum(["cancel", "structured-result", "trace-context", "local-mcp", "workspace-artifacts", ...RUNNER_FEATURES])),
  })
  .strict()
  .superRefine((profile, ctx) => {
    profile.inProcessBindings?.forEach((binding, index) => {
      if (!profile.toolBindings.includes(binding)) {
        ctx.addIssue({ code: "custom", path: ["inProcessBindings", index], message: `'${binding}' is not one of this profile's toolBindings.` });
      }
    });
  });
export type ExecutionProfile = z.infer<typeof ExecutionProfile>;

/** Client transports for hosted conversations: direct WSS, or the GitHub relay (Mission Control). */
export const HOSTING_TRANSPORTS = ["direct", "github"] as const;
export type HostingTransport = (typeof HOSTING_TRANSPORTS)[number];

/** A container size the operator offers, within the ExecutionContainerSettings bounds. */
export const ContainerSize = z
  .object({
    cpus: z.number().min(0.25).max(8),
    memoryMiB: z.number().int().min(256).max(16_384),
  })
  .strict();
export type ContainerSize = z.infer<typeof ContainerSize>;

/** The size catalog used when a policy defines none. */
export const DEFAULT_CONTAINER_SIZES: Readonly<Record<string, ContainerSize>> = Object.freeze({
  small: { cpus: 0.5, memoryMiB: 1024 },
  medium: { cpus: 1, memoryMiB: 2048 },
  large: { cpus: 2, memoryMiB: 4096 },
});

/** Ceilings for orchestrator workers. Omitted fields take DEFAULT_WORKER_POLICY values. */
export const WorkerPolicy = z
  .object({
    maxConcurrentPerSession: z.number().int().min(1).max(32).optional(),
    maxPerSession: z.number().int().min(1).max(256).optional(),
    maxPerPrincipal: z.number().int().min(1).max(256).optional(),
    idleSeconds: z.number().int().min(30).max(86_400).optional(),
    maxLifetimeSeconds: z.number().int().min(60).max(86_400).optional(),
    /** Whether coordinator harnesses may set `hosting.workers.humanAuthority: "inherit"`. */
    allowInheritedAuthority: z.boolean().optional(),
  })
  .strict();
export type WorkerPolicy = z.infer<typeof WorkerPolicy>;

export const DEFAULT_WORKER_POLICY: Readonly<Required<WorkerPolicy>> = Object.freeze({
  maxConcurrentPerSession: 4,
  maxPerSession: 16,
  maxPerPrincipal: 8,
  idleSeconds: 900,
  maxLifetimeSeconds: 3600,
  allowInheritedAuthority: false,
});

/** The ceiling for worker harnesses a coordinator crafts at runtime. Crafted definitions can only narrow it. */
export const CraftingTemplate = z
  .object({
    description: z.string().min(1).max(1000).optional(),
    toolBindings: z.array(z.string().min(1).max(200)).max(64).refine(distinct, DISTINCT),
    builtinTools: z.array(z.enum(BUILTIN_TOOL_GROUPS)).max(BUILTIN_TOOL_GROUPS.length).refine(distinct, DISTINCT),
    models: z.array(z.string().min(1).max(200)).min(1).max(16).refine(distinct, DISTINCT),
    approvalModes: z.array(z.enum(APPROVAL_MODES)).min(1).max(APPROVAL_MODES.length).refine(distinct, DISTINCT),
    maxDurationSeconds: z.number().int().min(10).max(3600),
    maxInferenceTokens: z.number().int().min(1000).max(5_000_000).optional(),
    sizes: z.array(z.string().regex(SLUG)).min(1).max(8).refine(distinct, DISTINCT),
  })
  .strict();
export type CraftingTemplate = z.infer<typeof CraftingTemplate>;

/**
 * Hosting ceilings for conversation harnesses. Batch jobs always run on the executor. Omitted fields take the
 * defaults in effectiveHostingPolicy(); a per-harness override of `hosting` replaces the whole block.
 */
export const HostingPolicy = z
  .object({
    /** Allowed hosting modes. Omitted means isolated only. */
    modes: z.array(z.enum(HOSTING_MODES)).min(1).max(HOSTING_MODES.length).refine(distinct, DISTINCT).optional(),
    /** Allowed client transports. Omitted means direct and github; shared-runtime modes support direct only. */
    transports: z.array(z.enum(HOSTING_TRANSPORTS)).min(1).max(HOSTING_TRANSPORTS.length).refine(distinct, DISTINCT).optional(),
    /** Container size catalog by name. Omitted means DEFAULT_CONTAINER_SIZES. */
    sizes: z.record(z.string().regex(SLUG), ContainerSize).optional(),
    /** Size used when a harness names none. Omitted means the smallest size in the catalog. */
    defaultSize: z.string().regex(SLUG).optional(),
    workers: WorkerPolicy.optional(),
    /** Allowed approvals for model-initiated promotion. Omitted means ask only. */
    promotion: z
      .object({ approval: z.array(z.enum(HOSTING_APPROVALS)).min(1).max(HOSTING_APPROVALS.length).refine(distinct, DISTINCT).optional() })
      .strict()
      .optional(),
    /**
     * Handoff ceilings: the approvals a harness's handoff targets may use (omitted means ask only) and the history
     * policies they may pass (omitted means all three). Only `full` keeps the person's messages as approval authority.
     */
    handoffs: z
      .object({
        approval: z.array(z.enum(HOSTING_APPROVALS)).min(1).max(HOSTING_APPROVALS.length).refine(distinct, DISTINCT).optional(),
        history: z.array(z.enum(HANDOFF_HISTORY)).min(1).max(HANDOFF_HISTORY.length).refine(distinct, DISTINCT).optional(),
      })
      .strict()
      .optional(),
    /** Templates for crafted workers, by name. Omitted means none, so crafting is disabled. */
    crafting: z.object({ templates: z.record(z.string().regex(SLUG), CraftingTemplate) }).strict().optional(),
  })
  .strict()
  .superRefine((hosting, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const sizes = hosting.sizes ?? DEFAULT_CONTAINER_SIZES;
    const count = Object.keys(sizes).length;
    if (count < 1 || count > 8) issue(["sizes"], "Define between one and eight container sizes.");
    if (hosting.defaultSize !== undefined && !Object.hasOwn(sizes, hosting.defaultSize)) {
      issue(["defaultSize"], `Size '${hosting.defaultSize}' is not in the size catalog.`);
    }
    const workers = withDefaults(DEFAULT_WORKER_POLICY, hosting.workers);
    if (workers.maxConcurrentPerSession > workers.maxPerSession) {
      issue(["workers", "maxConcurrentPerSession"], "maxConcurrentPerSession cannot exceed maxPerSession.");
    }
    const templates = Object.entries(hosting.crafting?.templates ?? {});
    if (templates.length > 16) issue(["crafting", "templates"], "Define at most 16 crafting templates.");
    for (const [name, template] of templates) {
      template.sizes.forEach((size, index) => {
        if (!Object.hasOwn(sizes, size)) issue(["crafting", "templates", name, "sizes", index], `Size '${size}' is not in the size catalog.`);
      });
    }
  });
export type HostingPolicy = z.infer<typeof HostingPolicy>;

const MCP_AUTH_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const RESERVED_MCP_HEADERS = new Set([
  "accept", "connection", "content-length", "content-type", "cookie", "host", "mcp-protocol-version", "mcp-session-id",
  "transfer-encoding", "upgrade",
]);

/**
 * A remote MCP server an operator approves. Its credential is a secret reference that only the hosting process
 * resolves; neither the model nor the harness sees the URL or the secret.
 */
export const McpServerPolicy = z
  .object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    description: z.string().min(1).max(1000).optional(),
    /** One service credential, by secret name. Sent as `Authorization: Bearer <secret>`, or raw in `header`. */
    auth: z
      .object({
        secret: z.string().regex(SLUG),
        header: z.string().regex(MCP_AUTH_HEADER).optional(),
      })
      .strict()
      .optional(),
    /** Tools harnesses may request from this server. */
    tools: z.array(z.string().regex(MCP_TOOL_NAME)).min(1).max(128).refine(distinct, DISTINCT),
    /**
     * Operator-only development allowance, omitted means false. Only this server's exact configured origin, never a
     * redirect, may resolve to loopback, RFC 1918, CGNAT, or IPv6 unique-local addresses or use `localhost`, a
     * single-label, or a container name; with it, a credential may also be sent over http. Link-local, cloud metadata,
     * unspecified, multicast and reserved addresses, IPv4-mapped, -compatible, and NAT64 forms, and the deployment's own
     * internal service endpoints stay refused. The shared-placement egress filter enforces this at runtime.
     */
    allowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      return;
    }
    if (url.username || url.password) issue(["url"], "Put the credential in auth.secret, not in the URL.");
    if (url.hash) issue(["url"], "Remove the URL fragment.");
    if (server.auth && url.protocol !== "https:" && server.allowPrivateNetwork !== true) {
      issue(["url"], "A server that receives a credential must use https unless allowPrivateNetwork is set.");
    }
    const header = server.auth?.header?.toLowerCase();
    if (header && RESERVED_MCP_HEADERS.has(header)) issue(["auth", "header"], `'${server.auth!.header}' is a protocol header.`);
  });
export type McpServerPolicy = z.infer<typeof McpServerPolicy>;

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
    /** Approval modes harnesses may use for requests that would otherwise prompt a person. Omitted means manual only. */
    approvalModes: z.array(z.enum(APPROVAL_MODES)).min(1).max(APPROVAL_MODES.length).refine(distinct, DISTINCT).optional(),
    /** Custom permission handlers harnesses may select. Omitted means none. */
    permissionHandlers: z.array(z.string().regex(SLUG)).max(32).refine(distinct, DISTINCT).optional(),
    /** Remote MCP server catalog, by name. Omitted means none. */
    mcpServers: z
      .record(z.string().regex(SLUG), McpServerPolicy)
      .refine((servers) => Object.keys(servers).length <= 32, "Define at most 32 MCP servers.")
      .optional(),
    /** Hosting ceilings for conversation harnesses. Omitted means isolated hosting with the default settings. */
    hosting: HostingPolicy.optional(),
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
  "approvalModes",
  "permissionHandlers",
  "mcpServers",
  "hosting",
] as const;
export type HarnessOverridablePolicyField = (typeof HARNESS_OVERRIDABLE_POLICY_FIELDS)[number];

/**
 * Operator-owned override for one harness, stored as `policy/harnesses/<harness>.json`. Each listed
 * field replaces the base policy value for every version of that harness; omitted fields inherit.
 * Object fields such as `hosting` are replaced whole: their omitted sub-fields take defaults, not base values.
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
      approvalModes: true,
      permissionHandlers: true,
      mcpServers: true,
      hosting: true,
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

/** A policy problem scoped to a field of the harness definition (a dotted path, as the configurator shows it). */
export interface PolicyViolation {
  path: string;
  message: string;
}

/** Approval modes the policy allows. */
export function effectiveApprovalModes(policy: Pick<ExecutionPolicy, "approvalModes">): ApprovalMode[] {
  return [...(policy.approvalModes ?? ["manual"])];
}

/**
 * Checks built-in tools, permission and approval modes, and remote MCP requests against the policy. Same shape as
 * modelOptionViolations; job admission, claim-time revocation, hosted admission, and the configurator use it.
 */
export function toolPolicyViolations(
  definition: Pick<HarnessDefinition, "builtinTools" | "permissions" | "mcpServers">,
  policy: Pick<ExecutionPolicy, "allowedModels" | "builtinTools" | "permissionModes" | "approvalModes" | "permissionHandlers" | "mcpServers">,
): PolicyViolation[] {
  const problems: PolicyViolation[] = [];
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
    // The approval mode matters when it is set explicitly or when a request can reach a person.
    const approvalMode = approvalModeOf(permissions);
    const requested = permissions.approvalMode !== undefined || permissionModesUsed(permissions).has("ask");
    if (requested && !effectiveApprovalModes(policy).includes(approvalMode)) {
      problems.push({ path: "permissions.approvalMode", message: `The operator policy does not allow the '${approvalMode}' approval mode.` });
    }
    if (permissions.judgeModel !== undefined && !policy.allowedModels.includes(permissions.judgeModel)) {
      problems.push({ path: "permissions.judgeModel", message: `Judge model '${permissions.judgeModel}' is not approved by the operator policy.` });
    }
    if (permissions.handler !== undefined && !(policy.permissionHandlers ?? []).includes(permissions.handler)) {
      problems.push({ path: "permissions.handler", message: `The operator policy does not allow the '${permissions.handler}' permission handler.` });
    }
  }
  const catalog = policy.mcpServers ?? {};
  (Array.isArray(definition.mcpServers) ? definition.mcpServers : []).forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const server = Object.hasOwn(catalog, entry.server) ? catalog[entry.server] : undefined;
    if (!server) {
      problems.push({ path: `mcpServers.${index}.server`, message: `The operator's MCP catalog has no server '${entry.server}'.` });
      return;
    }
    (Array.isArray(entry.tools) ? entry.tools : []).forEach((tool, toolIndex) => {
      if (!server.tools.includes(tool)) {
        problems.push({ path: `mcpServers.${index}.tools.${toolIndex}`, message: `The operator's catalog does not approve tool '${tool}' on '${entry.server}'.` });
      }
    });
  });
  return problems;
}

/** Transports each hosting mode supports. Shared-runtime modes use direct WSS only in the first delivery. */
export function transportsForMode(mode: HostingMode): HostingTransport[] {
  return mode === "isolated" ? [...HOSTING_TRANSPORTS] : ["direct"];
}

/** Handoff approvals and history policies the effective policy allows. */
export const HandoffCeilings = z
  .object({ approval: z.array(z.enum(HOSTING_APPROVALS)), history: z.array(z.enum(HANDOFF_HISTORY)) })
  .strict();
export type HandoffCeilings = z.infer<typeof HandoffCeilings>;

/** Hosting ceilings with defaults applied. */
export const EffectiveHostingPolicy = z
  .object({
    modes: z.array(z.enum(HOSTING_MODES)),
    transports: z.array(z.enum(HOSTING_TRANSPORTS)),
    sizes: z.record(z.string(), ContainerSize),
    defaultSize: z.string(),
    workers: WorkerPolicy.required(),
    promotion: z.object({ approval: z.array(z.enum(HOSTING_APPROVALS)) }).strict(),
    handoffs: HandoffCeilings,
    crafting: z.object({ templates: z.record(z.string(), CraftingTemplate) }).strict(),
  })
  .strict();
export type EffectiveHostingPolicy = z.infer<typeof EffectiveHostingPolicy>;

function withDefaults<T extends object>(defaults: Readonly<T>, value: Partial<T> | undefined): T {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, entry] of Object.entries(value ?? {})) if (entry !== undefined) result[key] = entry;
  return result as T;
}

function smallestSize(sizes: Readonly<Record<string, ContainerSize>>): string {
  const order = Object.entries(sizes).sort(
    ([nameA, a], [nameB, b]) => a.memoryMiB - b.memoryMiB || a.cpus - b.cpus || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0),
  );
  return order[0]?.[0] ?? "";
}

/** The hosting ceilings a policy sets, with the documented defaults for omitted fields. */
export function effectiveHostingPolicy(policy: Pick<ExecutionPolicy, "hosting">): EffectiveHostingPolicy {
  const hosting = policy.hosting;
  const sizes = structuredClone({ ...(hosting?.sizes ?? DEFAULT_CONTAINER_SIZES) });
  return {
    modes: [...(hosting?.modes ?? ["isolated"])],
    transports: [...(hosting?.transports ?? HOSTING_TRANSPORTS)],
    sizes,
    defaultSize: hosting?.defaultSize ?? smallestSize(sizes),
    workers: withDefaults(DEFAULT_WORKER_POLICY, hosting?.workers),
    promotion: { approval: [...(hosting?.promotion?.approval ?? [DEFAULT_HOSTING_APPROVAL])] },
    handoffs: {
      approval: [...(hosting?.handoffs?.approval ?? [DEFAULT_HOSTING_APPROVAL])],
      history: [...(hosting?.handoffs?.history ?? HANDOFF_HISTORY)],
    },
    crafting: { templates: structuredClone(hosting?.crafting?.templates ?? {}) },
  };
}

/** A hosting problem: a field-scoped violation with the error code admission returns for it. */
export interface HostingViolation extends PolicyViolation {
  code: "hosting_mode_not_allowed" | "transport_not_allowed" | "policy_rejected";
}

/**
 * Checks a conversation harness's hosting request against its effective policy: the mode and a transport for it,
 * promotion, worker sizes, inherited human authority, the crafting template, and each handoff's approval and explicit
 * history. Worker and handoff targets are checked against the registry in hosting.ts. Batch harnesses always run on
 * the executor and return no problems.
 */
export function hostingPolicyViolations(
  definition: Pick<HarnessDefinition, "interaction" | "hosting">,
  policy: Pick<ExecutionPolicy, "hosting">,
): HostingViolation[] {
  if (definition.interaction !== "conversation") return [];
  const ceilings = effectiveHostingPolicy(policy);
  const problems: HostingViolation[] = [];
  const rejected = (path: string, message: string) => problems.push({ path, message, code: "policy_rejected" });
  const mode = hostingModeOf(definition);
  const supported = transportsForMode(mode);
  if (!ceilings.modes.includes(mode)) {
    problems.push({ path: "hosting.mode", code: "hosting_mode_not_allowed", message: `The operator policy does not allow ${mode} hosting for this harness.` });
  } else if (!supported.some((transport) => ceilings.transports.includes(transport))) {
    problems.push({
      path: "hosting.mode",
      code: "transport_not_allowed",
      message: `The operator policy allows no transport that ${mode} hosting supports (${supported.join(", ")}).`,
    });
  }
  const hosting = definition.hosting;
  if (mode === "promotable") {
    const size = hosting?.promotion?.size;
    if (size !== undefined && !Object.hasOwn(ceilings.sizes, size)) {
      rejected("hosting.promotion.size", `Size '${size}' is not in the operator's size catalog.`);
    }
    const approval = hosting?.promotion?.approval ?? DEFAULT_HOSTING_APPROVAL;
    if (!ceilings.promotion.approval.includes(approval)) {
      rejected("hosting.promotion.approval", `The operator policy does not allow '${approval}' approval for promotion.`);
    }
  }
  const workers = mode === "orchestrator" ? hosting?.workers : undefined;
  if (workers) {
    workers.sizes?.forEach((size, index) => {
      if (!Object.hasOwn(ceilings.sizes, size)) rejected(`hosting.workers.sizes.${index}`, `Size '${size}' is not in the operator's size catalog.`);
    });
    if (workers.humanAuthority === "inherit" && !ceilings.workers.allowInheritedAuthority) {
      rejected("hosting.workers.humanAuthority", "The operator policy does not allow workers to inherit human authority.");
    }
    const template = workers.crafting?.template;
    if (template !== undefined && !Object.hasOwn(ceilings.crafting.templates, template)) {
      rejected("hosting.workers.crafting.template", `The operator policy has no crafting template '${template}'.`);
    }
  }
  // Omitted history resolves per move (summary across placements, full within one); hosting.ts checks that default
  // against the target's placement.
  hosting?.handoffs?.forEach((handoff, index) => {
    const approval = handoff.approval ?? DEFAULT_HOSTING_APPROVAL;
    if (!ceilings.handoffs.approval.includes(approval)) {
      rejected(`hosting.handoffs.${index}.approval`, `The operator policy does not allow '${approval}' approval for handoffs.`);
    }
    if (handoff.history !== undefined && !ceilings.handoffs.history.includes(handoff.history)) {
      rejected(`hosting.handoffs.${index}.history`, `The operator policy does not allow '${handoff.history}' history for handoffs.`);
    }
  });
  return problems;
}

/**
 * Checks what a hosted conversation needs from the conversation profile beyond tool bindings and runner
 * capabilities: in-process approval for host tools on a shared worker, and a registered custom permission handler.
 */
export function hostedProfileViolations(
  definition: Pick<HarnessDefinition, "interaction" | "hosting" | "tools" | "permissions">,
  profile: Pick<ExecutionProfile, "id" | "inProcessBindings" | "permissionHandlers">,
): PolicyViolation[] {
  const problems: PolicyViolation[] = [];
  if (definition.interaction === "conversation" && runsOnSharedWorker(hostingModeOf(definition))) {
    definition.tools.forEach((tool, index) => {
      if (tool.kind === "host" && !(profile.inProcessBindings ?? []).includes(tool.binding)) {
        problems.push({ path: `tools.${index}.binding`, message: `Profile '${profile.id}' does not mark '${tool.binding}' safe to run in a shared worker.` });
      }
    });
  }
  const handler = definition.permissions?.handler;
  if (handler !== undefined && !(profile.permissionHandlers ?? []).includes(handler)) {
    problems.push({ path: "permissions.handler", message: `Profile '${profile.id}' does not provide the '${handler}' permission handler.` });
  }
  return problems;
}

/** What a harness's hosting request resolves to under its effective policy. */
export const EffectiveHarnessHosting = z
  .object({
    mode: z.enum(HOSTING_MODES),
    /** Whether the harness declares a hosting block rather than defaulting to isolated. */
    declared: z.boolean(),
    approvalMode: z.enum(APPROVAL_MODES),
    promotion: z.object({ size: z.string(), approval: z.enum(HOSTING_APPROVALS) }).strict().optional(),
    workers: z
      .object({
        harnesses: z.array(z.string()),
        sizes: z.array(z.string()),
        maxConcurrent: z.number().int(),
        maxPerSession: z.number().int(),
        sharedStorage: z.enum(["none", "session"]),
        humanAuthority: z.enum(["none", "inherit"]),
        craftingTemplate: z.string().optional(),
      })
      .strict()
      .optional(),
    /** History is absent when the default applies: summary across placements, full within one placement. */
    handoffs: z.array(
      z
        .object({
          harness: z.string(),
          description: z.string(),
          history: z.enum(HANDOFF_HISTORY).optional(),
          approval: z.enum(HOSTING_APPROVALS),
        })
        .strict(),
    ),
    /** Requested servers and tools that the policy's catalog approves. */
    mcpServers: z.array(z.object({ server: z.string(), tools: z.array(z.string()) }).strict()),
  })
  .strict();
export type EffectiveHarnessHosting = z.infer<typeof EffectiveHarnessHosting>;

/** Resolves defaults and narrows the harness's hosting request by its effective policy. */
export function effectiveHarnessHosting(
  definition: Pick<HarnessDefinition, "hosting" | "permissions" | "mcpServers">,
  policy: Pick<ExecutionPolicy, "hosting" | "mcpServers">,
): EffectiveHarnessHosting {
  const ceilings = effectiveHostingPolicy(policy);
  const mode = hostingModeOf(definition);
  const hosting = definition.hosting;
  const workers = mode === "orchestrator" ? hosting?.workers : undefined;
  const catalog = policy.mcpServers ?? {};
  const maxPerSession = Math.min(workers?.maxPerSession ?? ceilings.workers.maxPerSession, ceilings.workers.maxPerSession);
  return {
    mode,
    declared: hosting !== undefined,
    approvalMode: approvalModeOf(definition.permissions),
    ...(mode === "promotable"
      ? { promotion: { size: hosting?.promotion?.size ?? ceilings.defaultSize, approval: hosting?.promotion?.approval ?? DEFAULT_HOSTING_APPROVAL } }
      : {}),
    ...(workers
      ? {
          workers: {
            harnesses: [...workers.harnesses],
            sizes: (workers.sizes ?? [ceilings.defaultSize]).filter((size) => Object.hasOwn(ceilings.sizes, size)),
            maxConcurrent: Math.min(workers.maxConcurrent ?? ceilings.workers.maxConcurrentPerSession, ceilings.workers.maxConcurrentPerSession, maxPerSession),
            maxPerSession,
            sharedStorage: workers.sharedStorage ?? "none",
            humanAuthority: workers.humanAuthority ?? "none",
            ...(workers.crafting ? { craftingTemplate: workers.crafting.template } : {}),
          },
        }
      : {}),
    handoffs: (hosting?.handoffs ?? []).map((handoff) => ({
      harness: handoff.harness,
      description: handoff.description,
      ...(handoff.history ? { history: handoff.history } : {}),
      approval: handoff.approval ?? DEFAULT_HOSTING_APPROVAL,
    })),
    mcpServers: (definition.mcpServers ?? []).flatMap((entry) => {
      const server = Object.hasOwn(catalog, entry.server) ? catalog[entry.server] : undefined;
      const tools = server ? entry.tools.filter((tool) => server.tools.includes(tool)) : [];
      return tools.length ? [{ server: entry.server, tools }] : [];
    }),
  };
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
