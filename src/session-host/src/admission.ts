import {
  type ApprovalMode, approvalModeOf, connectionProblem, effectiveApprovalModes, evaluateHosting, type ExecutionPolicy,
  type ExecutionProfile, type HarnessDefinition, type HarnessSnapshot, type HostingDeployment, type HostingEvaluation,
  type HostingTarget, type HostingTransport, policyFor, RUNTIME_APPROVAL_MODES, type RuntimeApprovalMode,
  SHARED_TOOLS, SHARED_WORKER_BINDINGS, SHARED_WORKER_FEATURES, SHARED_WORKER_TRANSPORTS, type SharedHarnessRef, type SharedSessionCreation,
  SharedSessionDefinition, SharedSessionLimits, CONVERSATION_PROFILE,
} from "@copilot-agent/contracts";
import { canonicalJson, hostingError, HttpError, policyDigest, sha256Hex } from "@copilot-agent/service-defaults";
import type { SharedConfiguration, SharedRegistry } from "./configuration.js";

/** What this worker offers to hosting evaluation; the shared worker does not know about other hosts. */
export const SHARED_WORKER_DEPLOYMENT: HostingDeployment = Object.freeze({
  isolatedHosts: [],
  sharedWorker: { transports: [...SHARED_WORKER_TRANSPORTS], features: [...SHARED_WORKER_FEATURES] },
});

/** The approval settings an activation applies (docs/HOSTING-MODES-PLAN.md, section 3, "Approval modes"). */
export interface SharedApprovalPlan {
  /** The harness's approval mode. */
  mode: ApprovalMode;
  /** The runtime mode the session starts in; `custom` runs in `manual` with the handler deciding first. */
  initial: RuntimeApprovalMode;
  /** Runtime modes an attached client may switch among: the harness's effective policy, never empty. */
  available: RuntimeApprovalMode[];
  judgeModel?: string;
  handler?: string;
}

/** Everything an activation needs from the admitted snapshot and the current effective policy. */
export interface SharedActivationPlan {
  harness: SharedHarnessRef;
  definition: HarnessDefinition;
  model: string;
  policy: ExecutionPolicy;
  profile: ExecutionProfile;
  approval: SharedApprovalPlan;
  /** Batch harnesses the session's delegation tools may run. */
  delegation: SharedHarnessRef[];
}

export interface SharedAdmissionOptions {
  configuration: Pick<SharedConfiguration, "current">;
  /** Operator ceilings for every session (Aspire `hybrid-session-limits`). */
  sessionLimits: SharedSessionLimits;
  /** Published batch harnesses a session's `delegate_job` may run (Aspire `hybrid-harnesses`). */
  delegationHarnesses: readonly string[];
  /** Custom permission handlers this worker implements. */
  permissionHandlers: ReadonlySet<string>;
  deployment?: HostingDeployment;
}

const DELEGATION_BINDINGS = new Set<string>(SHARED_WORKER_BINDINGS);
const RESERVED_TOOL_NAMES = new Set<string>(Object.values(SHARED_TOOLS));

/**
 * Admits shared-placement sessions from published conversation harnesses and re-checks them against the current
 * effective policy on every activation and connection. There is no fallback to another mode or transport.
 */
export class SharedAdmission {
  readonly #deployment: HostingDeployment;

  constructor(private readonly options: SharedAdmissionOptions) {
    this.#deployment = options.deployment ?? SHARED_WORKER_DEPLOYMENT;
    SharedSessionLimits.parse(options.sessionLimits);
  }

  /** The admitted snapshot for a new session. */
  async admit(principal: string, request: SharedSessionCreation): Promise<SharedSessionDefinition> {
    const registry = await this.options.configuration.current();
    const versions = registry.harnesses.get(request.harness);
    const snapshot = request.version ? versions?.find((entry) => entry.definition.version === request.version) : versions?.[0];
    if (!snapshot) throw new HttpError(404, "harness_not_found", "The requested harness version is not published.");
    const { definition } = snapshot;
    const policy = policyFor(registry.policies, definition.name);
    this.#evaluate(registry, definition, policy, principal);
    const model = admittedModel(definition, policy);
    const ceilings = this.options.sessionLimits;
    const tokenBudget = Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob, ceilings.tokenBudget);
    const limits = SharedSessionLimits.parse({
      ...ceilings,
      tokenBudget,
      turnTokenBudget: Math.min(ceilings.turnTokenBudget, tokenBudget),
      maxTurnSeconds: Math.min(definition.limits.maxDurationSeconds, policy.maxDurationSeconds, ceilings.maxTurnSeconds),
    });
    const delegates = definition.tools.some((tool) => tool.kind === "host" && DELEGATION_BINDINGS.has(tool.binding));
    return SharedSessionDefinition.parse({
      model,
      limits,
      harness: {
        name: definition.name, version: definition.version, digest: snapshot.digest,
        mode: "shared" as const, definition, policyDigest: policyDigest(policy),
      },
      ...(delegates ? { delegation: { harnesses: this.#delegationTargets(registry) } } : {}),
    });
  }

  /** Re-checks a retained session against the current policy before it activates. */
  async activation(definition: SharedSessionDefinition, principal?: string): Promise<SharedActivationPlan> {
    const harness = definition.harness;
    if (!harness?.definition) {
      throw new HttpError(409, "invalid_state", "This conversation was created before harness-driven shared hosting; create a new conversation.");
    }
    if (`sha256:${sha256Hex(canonicalJson(harness.definition))}` !== harness.digest) {
      throw new HttpError(409, "invalid_state", "The conversation's admitted harness snapshot failed its integrity check.");
    }
    const registry = await this.options.configuration.current();
    const policy = policyFor(registry.policies, harness.name);
    this.#evaluate(registry, harness.definition, policy, principal);
    if (!policy.allowedModels.includes(definition.model)) {
      throw new HttpError(409, "policy_revoked", "The conversation's admitted model is no longer approved by the operator policy.");
    }
    const profile = registry.profiles.get(CONVERSATION_PROFILE)!;
    return {
      harness: { name: harness.name, version: harness.version, digest: harness.digest },
      definition: harness.definition,
      model: definition.model,
      policy,
      profile,
      approval: approvalPlan(harness.definition, policy),
      delegation: definition.delegation?.harnesses ?? [],
    };
  }

  /** Refuses a transport the session's mode or current policy does not allow, before anything is activated. */
  async connectable(definition: SharedSessionDefinition, transport: HostingTransport, principal: string): Promise<void> {
    const harness = definition.harness;
    if (!harness?.definition) {
      throw new HttpError(409, "invalid_state", "This conversation was created before harness-driven shared hosting; create a new conversation.");
    }
    const registry = await this.options.configuration.current();
    const evaluation = this.#evaluation(registry, harness.definition, policyFor(registry.policies, harness.name), principal);
    const problem = connectionProblem(evaluation, transport);
    if (problem) throw hostingError(problem);
  }

  #evaluation(registry: SharedRegistry, definition: HarnessDefinition, policy: ExecutionPolicy, principal?: string): HostingEvaluation {
    const lookup = (name: string): HostingTarget | undefined => {
      const latest = registry.harnesses.get(name)?.[0];
      return latest ? { definition: latest.definition, policy: policyFor(registry.policies, name) } : undefined;
    };
    return evaluateHosting({
      definition, policy, profiles: registry.profiles, deployment: this.#deployment, lookup,
      ...(principal === undefined ? {} : { principal }),
    });
  }

  #evaluate(registry: SharedRegistry, definition: HarnessDefinition, policy: ExecutionPolicy, principal?: string): void {
    const evaluation = this.#evaluation(registry, definition, policy, principal);
    if (evaluation.interaction !== "conversation") {
      throw new HttpError(422, "policy_rejected", "Batch harnesses run as jobs; create conversations from conversation harnesses.");
    }
    if (evaluation.problems[0]) throw hostingError(evaluation.problems[0]);
    if (evaluation.placement !== "shared") {
      throw new HttpError(409, "hosting_unavailable", `${definition.name} uses ${evaluation.mode} hosting, which the shared worker does not run.`,
        { prerequisite: { kind: "host", name: "session-containers" } });
    }
    const profile = registry.profiles.get(CONVERSATION_PROFILE)!;
    definition.tools.forEach((tool, index) => {
      if (RESERVED_TOOL_NAMES.has(tool.name)) {
        throw new HttpError(422, "policy_rejected", `'${tool.name}' is reserved for the shared worker's own tools.`, { path: `tools.${index}.name` });
      }
      if (tool.kind === "host" && (profile.inProcessBindings ?? []).includes(tool.binding) && !DELEGATION_BINDINGS.has(tool.binding)) {
        throw new HttpError(422, "policy_rejected", `The shared worker does not implement binding '${tool.binding}'.`, { path: `tools.${index}.binding` });
      }
    });
    const handler = definition.permissions?.handler;
    if (handler !== undefined && !this.options.permissionHandlers.has(handler)) {
      throw new HttpError(422, "policy_rejected", `The shared worker does not implement permission handler '${handler}'.`, { path: "permissions.handler" });
    }
  }

  #delegationTargets(registry: SharedRegistry): SharedHarnessRef[] {
    return this.options.delegationHarnesses.flatMap((name) => {
      const latest: HarnessSnapshot | undefined = registry.harnesses.get(name)?.[0];
      if (!latest || latest.definition.interaction === "conversation") return [];
      return [{ name: latest.definition.name, version: latest.definition.version, digest: latest.digest }];
    });
  }
}

/** The first of the harness's preferred and allowed models that its effective policy approves. */
export function admittedModel(definition: HarnessDefinition, policy: ExecutionPolicy): string {
  const model = [definition.model.preferred, ...definition.model.allowed].find((name) => policy.allowedModels.includes(name));
  if (!model) throw new HttpError(422, "policy_rejected", "None of the harness's models are approved by the operator policy.", { path: "model" });
  return model;
}

/**
 * The runtime modes a session may hold. A `custom` harness stays in `manual`, because `allow-all` would let the
 * runtime approve requests without consulting the handler. Otherwise the policy's runtime modes are offered; when it
 * allows none, `manual` remains as the floor, since asking a person never widens what runs.
 */
export function approvalPlan(definition: HarnessDefinition, policy: ExecutionPolicy): SharedApprovalPlan {
  const mode = approvalModeOf(definition.permissions);
  if (mode === "custom") {
    return { mode, initial: "manual", available: ["manual"], ...(definition.permissions?.handler ? { handler: definition.permissions.handler } : {}) };
  }
  const allowed = effectiveApprovalModes(policy);
  const offered = RUNTIME_APPROVAL_MODES.filter((candidate) => allowed.includes(candidate));
  const available: RuntimeApprovalMode[] = offered.length ? offered : ["manual"];
  const initial = available.includes(mode) ? mode : available[0]!;
  const judgeModel = definition.permissions?.judgeModel;
  return { mode, initial, available, ...(judgeModel && available.includes("assisted") ? { judgeModel } : {}) };
}
