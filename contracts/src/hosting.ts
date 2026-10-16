import { z } from "zod";
import {
  approvalModeOf,
  APPROVAL_MODES,
  type HarnessDefinition,
  HOSTING_APPROVALS,
  HOSTING_MODES,
  type HostingMode,
  hostingModeOf,
  requiredRunnerCapabilities,
  SLUG,
} from "./harness.js";
import {
  ContainerSize,
  effectiveApprovalModes,
  EffectiveHarnessHosting,
  effectiveHarnessHosting,
  effectiveHostingPolicy,
  type ExecutionPolicy,
  type ExecutionProfile,
  hostedProfileViolations,
  hostingPolicyViolations,
  HOSTING_TRANSPORTS,
  type HostingTransport,
  modelOptionViolations,
  type PolicyViolation,
  toolPolicyViolations,
  transportsForMode,
  WorkerPolicy,
  HandoffCeilings,
} from "./profile.js";
import { handoffHistoryFor, placementMoveAllowed, placementsOf, startingPlacement } from "./placement.js";

/** The execution profile whose TypeScript SDK mapping hosts conversations; hosted conversations are TypeScript only. */
export const CONVERSATION_PROFILE = "node-ts-agent";

/** Hosts a deployment can provide (docs/HOSTING-MODES-PLAN.md, section 4). */
export const HOSTING_HOSTS = ["executor", "isolated-host", "session-containers", "shared-worker", "worker-containers"] as const;
export type HostingHost = (typeof HOSTING_HOSTS)[number];

/**
 * Harness features a host must implement before it serves a harness that requests them. A host that lacks one
 * makes the harness unavailable instead of silently ignoring the request.
 */
export const HOSTING_FEATURES = [
  "remote-mcp",
  "approval-modes",
  "custom-approval",
  "handoffs",
  "promotion",
  "crafted-workers",
  "inherited-authority",
  "shared-storage",
] as const;
export type HostingFeature = (typeof HOSTING_FEATURES)[number];

const PRINCIPAL = /^[A-Za-z0-9._@-]{1,128}$/;
const Transports = z.array(z.enum(HOSTING_TRANSPORTS)).max(HOSTING_TRANSPORTS.length);
const Features = z.array(z.enum(HOSTING_FEATURES)).max(HOSTING_FEATURES.length);
const HostOffer = z.object({ transports: Transports, features: Features }).strict();

/**
 * Which hosts and transports a deployment provides, and the harness features each host implements. Services build
 * it from their own configuration; it is never caller input.
 */
export const HostingDeployment = z
  .object({
    /** The batch executor: a shared pool, or one-shot containers on demand. Absent means jobs cannot run. */
    executor: z.enum(["pool", "dedicated"]).optional(),
    /** Hosts that each serve one isolated conversation harness for one owning principal (today: the demo host). */
    isolatedHosts: z
      .array(
        z
          .object({
            harness: z.string().regex(SLUG),
            /** The API principal that owns the host; only it can connect, over either transport. */
            owner: z.string().regex(PRINCIPAL),
            transports: Transports,
            features: Features,
          })
          .strict(),
      )
      .max(64),
    /** Per-session isolated containers for any principal. */
    sessionContainers: HostOffer.optional(),
    /** The shared worker that runs shared-runtime agent loops (today: the local hybrid session host). */
    sharedWorker: HostOffer.optional(),
    /** Containers for orchestrator workers. */
    workerContainers: z.object({ features: Features }).strict().optional(),
  })
  .strict();
export type HostingDeployment = z.infer<typeof HostingDeployment>;

/**
 * Hosting error codes and their HTTP statuses:
 * - hosting_mode_not_allowed: the effective policy does not allow the harness's mode.
 * - policy_rejected: another field-scoped policy, profile, or reference problem.
 * - transport_not_allowed: the effective policy does not allow the transport.
 * - transport_unsupported: the mode does not support the transport (shared-runtime modes are direct only).
 * - relay_owner_only: a principal other than an isolated host's owner requested the GitHub relay.
 * - hosting_unavailable: allowed, but this deployment lacks the host, transport, or feature named as prerequisite.
 */
export const HOSTING_ERROR_CODES = [
  "hosting_mode_not_allowed",
  "transport_not_allowed",
  "policy_rejected",
  "transport_unsupported",
  "relay_owner_only",
  "hosting_unavailable",
] as const;
export type HostingErrorCode = (typeof HOSTING_ERROR_CODES)[number];

export const HOSTING_ERROR_STATUS: Readonly<Record<HostingErrorCode, number>> = Object.freeze({
  hosting_mode_not_allowed: 422,
  transport_not_allowed: 422,
  policy_rejected: 422,
  transport_unsupported: 422,
  relay_owner_only: 403,
  hosting_unavailable: 409,
});

/** What a deployment must provide: a host, a transport on a host, or a feature of a host. */
export const HostingPrerequisite = z
  .object({
    kind: z.enum(["host", "transport", "feature"]),
    name: z.enum([...HOSTING_HOSTS, ...HOSTING_TRANSPORTS, ...HOSTING_FEATURES]),
  })
  .strict();
export type HostingPrerequisite = z.infer<typeof HostingPrerequisite>;

export const HostingProblem = z
  .object({
    code: z.enum(HOSTING_ERROR_CODES),
    message: z.string().min(1).max(1000),
    /** The harness field the problem comes from, as a dotted path. */
    path: z.string().max(200).optional(),
    /** For hosting_unavailable: what the deployment lacks. */
    prerequisite: HostingPrerequisite.optional(),
  })
  .strict();
export type HostingProblem = z.infer<typeof HostingProblem>;

/** One transport for one harness: whether policy and the mode allow it, and whether this deployment offers it. */
export const HostingTransportView = z
  .object({
    transport: z.enum(HOSTING_TRANSPORTS),
    allowed: z.boolean(),
    /** Offered to the principal the view was built for. */
    available: z.boolean(),
    problem: HostingProblem.optional(),
  })
  .strict();
export type HostingTransportView = z.infer<typeof HostingTransportView>;

/**
 * - ready: allowed and deployed; a connection still needs an available transport.
 * - not_allowed: the effective policy does not allow the mode.
 * - rejected: another policy, profile, or reference problem.
 * - unavailable: allowed, but the deployment lacks a prerequisite.
 */
export const HOSTING_STATUSES = ["ready", "not_allowed", "rejected", "unavailable"] as const;
export type HostingStatus = (typeof HOSTING_STATUSES)[number];

/** Where the agent loop starts: the batch executor, a dedicated container, or the shared worker. */
export const HOSTING_PLACEMENTS = ["executor", "container", "shared"] as const;
export type HostingPlacement = (typeof HOSTING_PLACEMENTS)[number];

/** A worker or handoff target: its latest published definition and effective policy. */
export interface HostingTarget {
  definition: Pick<HarnessDefinition, "interaction" | "hosting">;
  policy: Pick<ExecutionPolicy, "hosting">;
}

export interface HostingEvaluationInput {
  definition: HarnessDefinition;
  /** The harness's effective policy (the base policy plus its override). */
  policy: ExecutionPolicy;
  /** Approved execution profiles by id; conversations use CONVERSATION_PROFILE. */
  profiles: ReadonlyMap<string, ExecutionProfile>;
  deployment: HostingDeployment;
  /** Resolves worker and handoff targets. Omitted skips those checks. */
  lookup?: (harness: string) => HostingTarget | undefined;
  /** The principal transports are evaluated for. Omitted means the owner of any isolated host. */
  principal?: string;
}

export interface HostingEvaluation {
  interaction: "batch" | "conversation";
  mode: HostingMode;
  placement: HostingPlacement;
  status: HostingStatus;
  /** Every problem, ordered as admission reports them: the first one blocks hosting. */
  problems: HostingProblem[];
  /** Direct and GitHub relay for conversations; empty for batch harnesses, which use the jobs API. */
  transports: HostingTransportView[];
  effective: EffectiveHarnessHosting;
}

/**
 * Checks worker and handoff targets: each must be a published conversation harness whose own mode its policy allows,
 * and a worker must use isolated hosting. With the source's effective `policy`, it also checks that the history a
 * handoff without one resolves to (summary across placements, full within one) is allowed for every placement move
 * the source and target modes imply. Moves from a container back to shared placement are refused at handoff time.
 */
export function hostingReferenceViolations(
  definition: Pick<HarnessDefinition, "interaction" | "hosting">,
  lookup: (harness: string) => HostingTarget | undefined,
  policy?: Pick<ExecutionPolicy, "hosting">,
): PolicyViolation[] {
  if (definition.interaction !== "conversation") return [];
  const problems: PolicyViolation[] = [];
  const target = (name: string, path: string, role: string): HostingTarget | undefined => {
    const found = lookup(name);
    if (!found) problems.push({ path, message: `${role} '${name}' is not a published harness.` });
    else if (found.definition.interaction !== "conversation") problems.push({ path, message: `${role} '${name}' is not a conversation harness.` });
    else return found;
    return undefined;
  };
  if (hostingModeOf(definition) === "orchestrator") {
    definition.hosting?.workers?.harnesses.forEach((name, index) => {
      const path = `hosting.workers.harnesses.${index}`;
      const found = target(name, path, "Worker harness");
      if (!found) return;
      if (hostingModeOf(found.definition) !== "isolated") problems.push({ path, message: `Worker harness '${name}' must use isolated hosting.` });
      else if (!effectiveHostingPolicy(found.policy).modes.includes("isolated")) {
        problems.push({ path, message: `The operator policy does not allow isolated hosting for worker harness '${name}'.` });
      }
    });
  }
  const sourcePlacements = placementsOf(hostingModeOf(definition));
  const allowedHistory = policy ? effectiveHostingPolicy(policy).handoffs.history : undefined;
  definition.hosting?.handoffs?.forEach((handoff, index) => {
    const path = `hosting.handoffs.${index}.harness`;
    const found = target(handoff.harness, path, "Handoff target");
    if (!found) return;
    const mode = hostingModeOf(found.definition);
    if (!effectiveHostingPolicy(found.policy).modes.includes(mode)) {
      problems.push({ path, message: `The operator policy does not allow ${mode} hosting for handoff target '${handoff.harness}'.` });
    }
    const to = startingPlacement(mode);
    const moves = sourcePlacements.filter((from) => placementMoveAllowed(from, to));
    if (moves.length === 0) {
      problems.push({ path, message: `Handoff target '${handoff.harness}' runs on the shared worker, and a conversation in a container never moves back to shared placement.` });
      return;
    }
    if (!allowedHistory || handoff.history !== undefined) return;
    const defaults = [...new Set(moves.map((from) => handoffHistoryFor(undefined, from, to)))];
    const refused = defaults.filter((history) => !allowedHistory.includes(history));
    if (refused.length) {
      problems.push({
        path: `hosting.handoffs.${index}.history`,
        message: `The default history for '${handoff.harness}' (${refused.join(", ")}) is not allowed by the operator policy; choose a history it allows.`,
      });
    }
  });
  return problems;
}

/**
 * Field-scoped reasons the effective policy, the conversation profile, or the registry rejects a conversation
 * harness. Hosted admission and the hosting view report these before any deployment prerequisite.
 */
export function conversationPolicyProblems(
  definition: HarnessDefinition,
  policy: ExecutionPolicy,
  profiles: ReadonlyMap<string, ExecutionProfile>,
  lookup?: (harness: string) => HostingTarget | undefined,
): HostingProblem[] {
  const problems: HostingProblem[] = [];
  const rejected = (path: string, message: string) => problems.push({ code: "policy_rejected", path, message });
  const profile = profiles.get(CONVERSATION_PROFILE);
  if (!profile || !policy.allowedProfiles.includes(CONVERSATION_PROFILE)) {
    rejected("runners.allowedProfiles", `The operator policy does not approve the ${CONVERSATION_PROFILE} profile that hosts conversations.`);
  } else if (!definition.runners.allowedProfiles.includes(CONVERSATION_PROFILE)) {
    rejected("runners.allowedProfiles", `Conversation harnesses must allow the ${CONVERSATION_PROFILE} profile.`);
  }
  if (profile) {
    definition.tools.forEach((tool, index) => {
      if (!profile.toolBindings.includes(tool.binding)) rejected(`tools.${index}.binding`, `Profile '${profile.id}' cannot provide binding '${tool.binding}'.`);
    });
    const missing = requiredRunnerCapabilities(definition).filter((capability) => !profile.capabilities.includes(capability));
    if (missing.length) rejected("runners.allowedProfiles", `Profile '${profile.id}' does not support: ${missing.join(", ")}.`);
    for (const violation of hostedProfileViolations(definition, profile)) rejected(violation.path, violation.message);
  }
  for (const violation of [...modelOptionViolations(definition, policy), ...toolPolicyViolations(definition, policy)]) {
    rejected(violation.path, violation.message);
  }
  if (![definition.model.preferred, ...definition.model.allowed].some((model) => policy.allowedModels.includes(model))) {
    rejected("model", "None of the harness's models are approved by the operator policy.");
  }
  definition.agents?.forEach((agent, index) => {
    if (agent.model && !policy.allowedModels.includes(agent.model)) {
      rejected(`agents.${index}.model`, `Agent model '${agent.model}' is not approved by the operator policy.`);
    }
  });
  for (const violation of hostingPolicyViolations(definition, policy)) problems.push({ ...violation });
  if (lookup) for (const violation of hostingReferenceViolations(definition, lookup, policy)) rejected(violation.path, violation.message);
  return problems;
}

const TRANSPORT_LABELS: Record<HostingTransport, string> = { direct: "direct WSS transport", github: "GitHub relay" };

interface RequestedFeature {
  feature: HostingFeature;
  path: string;
  label: string;
}

/** Features the harness's agent loop needs from every host that runs it. */
function loopFeatures(definition: HarnessDefinition): RequestedFeature[] {
  const features: RequestedFeature[] = [];
  if (definition.mcpServers?.length) features.push({ feature: "remote-mcp", path: "mcpServers", label: "remote MCP servers" });
  const approval = approvalModeOf(definition.permissions);
  if (approval === "assisted" || approval === "allow-all") {
    features.push({ feature: "approval-modes", path: "permissions.approvalMode", label: `the ${approval} approval mode` });
  }
  if (approval === "custom") features.push({ feature: "custom-approval", path: "permissions.approvalMode", label: "custom permission handlers" });
  if (definition.hosting?.handoffs?.length) features.push({ feature: "handoffs", path: "hosting.handoffs", label: "handoffs" });
  return features;
}

/** Hosts, transports, and features this deployment lacks for the harness's mode. */
function deploymentProblems(definition: HarnessDefinition, mode: HostingMode, deployment: HostingDeployment): HostingProblem[] {
  const problems: HostingProblem[] = [];
  const missingHost = (name: HostingHost, message: string) =>
    problems.push({ code: "hosting_unavailable", message, prerequisite: { kind: "host", name } });
  const missingFeature = (name: HostingFeature, path: string, message: string) =>
    problems.push({ code: "hosting_unavailable", path, message, prerequisite: { kind: "feature", name } });
  const requested = loopFeatures(definition);
  const requireFeatures = (host: string, features: readonly HostingFeature[]) => {
    for (const entry of requested) {
      if (!features.includes(entry.feature)) missingFeature(entry.feature, entry.path, `The ${host} does not support ${entry.label} yet.`);
    }
  };
  const { sharedWorker, sessionContainers, workerContainers } = deployment;
  if (mode === "isolated") {
    const candidates = [
      ...deployment.isolatedHosts.filter((host) => host.harness === definition.name).map((host) => host.features),
      ...(sessionContainers ? [sessionContainers.features] : []),
    ];
    if (candidates.length === 0) {
      missingHost("isolated-host", `Isolated hosting for '${definition.name}' needs a host for this harness or session containers.`);
    } else if (!candidates.some((features) => requested.every((entry) => features.includes(entry.feature)))) {
      for (const entry of requested) {
        if (!candidates.some((features) => features.includes(entry.feature))) {
          missingFeature(entry.feature, entry.path, `No isolated host for '${definition.name}' supports ${entry.label} yet.`);
        }
      }
    }
    return problems;
  }
  if (!sharedWorker) missingHost("shared-worker", `${capitalize(mode)} hosting needs the shared worker.`);
  else requireFeatures("shared worker", sharedWorker.features);
  if (mode === "promotable") {
    if (sharedWorker && !sharedWorker.features.includes("promotion")) {
      missingFeature("promotion", "hosting.mode", "The shared worker does not support promotion yet.");
    }
    if (!sessionContainers) missingHost("session-containers", "Promotion needs session containers.");
    else requireFeatures("session containers", sessionContainers.features);
  }
  if (mode === "orchestrator") {
    const workers = definition.hosting?.workers;
    if (!workerContainers) missingHost("worker-containers", "Orchestrator hosting needs worker containers.");
    else {
      const needs: RequestedFeature[] = [
        ...(workers?.crafting ? [{ feature: "crafted-workers" as const, path: "hosting.workers.crafting", label: "crafted workers" }] : []),
        ...(workers?.humanAuthority === "inherit"
          ? [{ feature: "inherited-authority" as const, path: "hosting.workers.humanAuthority", label: "inherited human authority" }]
          : []),
        ...(workers?.sharedStorage === "session" ? [{ feature: "shared-storage" as const, path: "hosting.workers.sharedStorage", label: "shared session storage" }] : []),
      ];
      for (const entry of needs) {
        if (!workerContainers.features.includes(entry.feature)) missingFeature(entry.feature, entry.path, `Worker containers do not support ${entry.label} yet.`);
      }
    }
  }
  return problems;
}

function transportViews(
  definition: HarnessDefinition,
  mode: HostingMode,
  policy: ExecutionPolicy,
  deployment: HostingDeployment,
  principal: string | undefined,
): HostingTransportView[] {
  const allowedByPolicy = effectiveHostingPolicy(policy).transports;
  return HOSTING_TRANSPORTS.map((transport): HostingTransportView => {
    const label = TRANSPORT_LABELS[transport];
    const blocked = (allowed: boolean, problem: HostingProblem): HostingTransportView => ({ transport, allowed, available: false, problem });
    if (!transportsForMode(mode).includes(transport)) {
      return blocked(false, {
        code: "transport_unsupported",
        message: `${capitalize(mode)} hosting supports direct WSS only; the GitHub relay serves isolated hosts.`,
      });
    }
    if (!allowedByPolicy.includes(transport)) {
      return blocked(false, { code: "transport_not_allowed", message: `The operator policy does not allow the ${label} for this harness.` });
    }
    const ready: HostingTransportView = { transport, allowed: true, available: true };
    if (mode !== "isolated") {
      if (deployment.sharedWorker?.transports.includes(transport)) return ready;
      return blocked(true, deployment.sharedWorker
        ? { code: "hosting_unavailable", message: `The shared worker does not offer the ${label}.`, prerequisite: { kind: "transport", name: transport } }
        : { code: "hosting_unavailable", message: `${capitalize(mode)} hosting needs the shared worker.`, prerequisite: { kind: "host", name: "shared-worker" } });
    }
    if (deployment.sessionContainers?.transports.includes(transport)) return ready;
    const owned = deployment.isolatedHosts.filter((host) => host.harness === definition.name && host.transports.includes(transport));
    if (owned.some((host) => principal === undefined || host.owner === principal)) return ready;
    if (owned.length > 0) {
      return blocked(true, transport === "github"
        ? { code: "relay_owner_only", message: `Only the owner of the isolated host for '${definition.name}' can use the GitHub relay.` }
        : {
            code: "hosting_unavailable",
            message: `The isolated host for '${definition.name}' serves only its owner; other principals need session containers.`,
            prerequisite: { kind: "host", name: "session-containers" },
          });
    }
    return blocked(true, {
      code: "hosting_unavailable",
      message: `No host for '${definition.name}' offers the ${label}.`,
      prerequisite: { kind: "transport", name: transport },
    });
  });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const PRIORITY = new Map(HOSTING_ERROR_CODES.map((code, index) => [code, index]));

/**
 * Evaluates where and whether a harness can be hosted: policy first (validation and admission), then the
 * deployment's hosts and features, then each transport for the principal. There is no fallback to another mode.
 */
export function evaluateHosting(input: HostingEvaluationInput): HostingEvaluation {
  const { definition, policy, deployment } = input;
  const effective = effectiveHarnessHosting(definition, policy);
  if (definition.interaction !== "conversation") {
    const problems: HostingProblem[] = deployment.executor
      ? []
      : [{ code: "hosting_unavailable", message: "Batch jobs need the executor.", prerequisite: { kind: "host", name: "executor" } }];
    return { interaction: "batch", mode: "isolated", placement: "executor", status: problems.length ? "unavailable" : "ready", problems, transports: [], effective };
  }
  const mode = hostingModeOf(definition);
  const policyProblems = conversationPolicyProblems(definition, policy, input.profiles, input.lookup);
  const problems = [...policyProblems, ...deploymentProblems(definition, mode, deployment)]
    .map((problem, index) => ({ problem, index }))
    .sort((a, b) => PRIORITY.get(a.problem.code)! - PRIORITY.get(b.problem.code)! || a.index - b.index)
    .map(({ problem }) => problem);
  const status: HostingStatus = problems.some((problem) => problem.code === "hosting_mode_not_allowed")
    ? "not_allowed"
    : problems.some((problem) => problem.code !== "hosting_unavailable")
      ? "rejected"
      : problems.length
        ? "unavailable"
        : "ready";
  return {
    interaction: "conversation",
    mode,
    placement: mode === "isolated" ? "container" : "shared",
    status,
    problems,
    transports: transportViews(definition, mode, policy, deployment, input.principal),
    effective,
  };
}

/** The problem that blocks a connection over `transport`, in admission order, or undefined when it can connect. */
export function connectionProblem(evaluation: HostingEvaluation, transport: HostingTransport): HostingProblem | undefined {
  if (evaluation.problems[0]) return evaluation.problems[0];
  const view = evaluation.transports.find((entry) => entry.transport === transport);
  if (!view) return { code: "transport_unsupported", message: "Batch harnesses run as jobs; they have no client transport." };
  return view.problem;
}

/** The operator ceilings that apply to one harness, without server URLs or secret references. */
export const HostingCeilings = z
  .object({
    modes: z.array(z.enum(HOSTING_MODES)),
    transports: z.array(z.enum(HOSTING_TRANSPORTS)),
    approvalModes: z.array(z.enum(APPROVAL_MODES)),
    permissionHandlers: z.array(z.string()),
    sizes: z.record(z.string(), ContainerSize),
    defaultSize: z.string(),
    workers: WorkerPolicy.required(),
    promotion: z.object({ approval: z.array(z.enum(HOSTING_APPROVALS)) }).strict(),
    handoffs: HandoffCeilings,
    craftingTemplates: z.array(z.string()),
    mcpServers: z.array(z.object({ server: z.string(), tools: z.array(z.string()) }).strict()),
  })
  .strict();
export type HostingCeilings = z.infer<typeof HostingCeilings>;

export function hostingCeilingsOf(policy: ExecutionPolicy): HostingCeilings {
  const hosting = effectiveHostingPolicy(policy);
  return {
    modes: hosting.modes,
    transports: hosting.transports,
    approvalModes: effectiveApprovalModes(policy),
    permissionHandlers: [...(policy.permissionHandlers ?? [])],
    sizes: hosting.sizes,
    defaultSize: hosting.defaultSize,
    workers: hosting.workers,
    promotion: hosting.promotion,
    handoffs: hosting.handoffs,
    craftingTemplates: Object.keys(hosting.crafting.templates).sort(),
    mcpServers: Object.entries(policy.mcpServers ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([server, entry]) => ({ server, tools: [...entry.tools] })),
  };
}

/** The read-only hosting view of one harness version for one principal (`GET /v1/hosting`). */
export const HarnessHostingView = z
  .object({
    harness: z.string(),
    version: z.string(),
    digest: z.string(),
    interaction: z.enum(["batch", "conversation"]),
    mode: z.enum(HOSTING_MODES),
    placement: z.enum(HOSTING_PLACEMENTS),
    status: z.enum(HOSTING_STATUSES),
    problems: z.array(HostingProblem),
    transports: z.array(HostingTransportView),
    effective: EffectiveHarnessHosting,
    ceilings: HostingCeilings,
  })
  .strict();
export type HarnessHostingView = z.infer<typeof HarnessHostingView>;

/** The deployment's hosts without owner principals. */
export const HostingHostsView = z
  .object({
    executor: z.enum(["pool", "dedicated"]).optional(),
    isolatedHosts: z.array(z.object({ harness: z.string(), transports: Transports, features: Features }).strict()),
    sessionContainers: HostOffer.optional(),
    sharedWorker: HostOffer.optional(),
    workerContainers: z.object({ features: Features }).strict().optional(),
  })
  .strict();
export type HostingHostsView = z.infer<typeof HostingHostsView>;

export const HostingOverview = z.object({ hosts: HostingHostsView, harnesses: z.array(HarnessHostingView) }).strict();
export type HostingOverview = z.infer<typeof HostingOverview>;

export function hostingHostsOf(deployment: HostingDeployment): HostingHostsView {
  return {
    ...(deployment.executor ? { executor: deployment.executor } : {}),
    isolatedHosts: deployment.isolatedHosts.map(({ harness, transports, features }) => ({ harness, transports: [...transports], features: [...features] })),
    ...(deployment.sessionContainers ? { sessionContainers: structuredClone(deployment.sessionContainers) } : {}),
    ...(deployment.sharedWorker ? { sharedWorker: structuredClone(deployment.sharedWorker) } : {}),
    ...(deployment.workerContainers ? { workerContainers: structuredClone(deployment.workerContainers) } : {}),
  };
}
