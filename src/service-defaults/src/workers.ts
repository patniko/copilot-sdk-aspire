import {
  type ApprovalMode,
  approvalModeOf,
  type ContainerSize,
  craftWorkerDefinition,
  DEFAULT_INPUT_TIMEOUT_SECONDS,
  type ExecutionPolicy,
  type ExecutionProfile,
  type HarnessDefinition,
  type HarnessSnapshot,
  type HostingFeature,
  type PolicySet,
  policyFor,
  workerCeilings,
  type WorkerCreation,
  workerDepthProblems,
  type WorkerSharedAccess,
  type WorkerSource,
} from "@copilot-agent/contracts";
import { admitHostedHarness } from "./host-policy.js";
import { HttpError } from "./http.js";
import { canonicalJson, policyDigest, sha256Hex } from "./registry.js";

/** Published harnesses, approved profiles, and policies, as the coordinator's host loads them. */
export interface WorkerRegistry {
  harnesses: ReadonlyMap<string, HarnessSnapshot[]>;
  profiles: ReadonlyMap<string, ExecutionProfile>;
  policies: PolicySet;
}

/** A worker request resolved against the registry and current policy: what the worker ledger records and runs. */
export interface WorkerPlan {
  name: string;
  source: WorkerSource;
  harness: { name: string; version: string; digest: string };
  definition: HarnessDefinition;
  /** The crafting template a crafted worker was validated against. */
  template?: string;
  /** Digest of the worker's effective policy at admission. */
  policyDigest: string;
  size: string;
  resources: ContainerSize;
  sharedVolume: WorkerSharedAccess;
  approvalMode: ApprovalMode;
  /** The worker's assisted judge receives the coordinator session's recorded human messages. */
  inheritHumanAuthority: boolean;
  /** The coordinator may answer this worker's questions. */
  coordinatorAnswers: boolean;
  model: string;
  /** The most of the conversation's aggregate budget the worker may reserve. */
  tokenBudget: number;
  maxTurnSeconds: number;
  /** How long one of the worker's approvals or questions waits for a person. */
  inputTimeoutSeconds: number;
  idleSeconds: number;
  lifetimeSeconds: number;
  task: string;
  /** The coordinator's per-session and per-principal worker ceilings; the deployment ceiling is the host's. */
  capacity: { maxPerSession: number; maxConcurrent: number; maxPerPrincipal: number };
}

export interface WorkerPlanningOptions {
  /** Harness features the worker containers implement. A worker that needs another one is unavailable. */
  features: readonly HostingFeature[];
}

/**
 * The policy a crafted worker is checked against: its coordinator's effective policy, which holds the crafting template,
 * with the template standing in for the isolated-hosting grant (crafted workers always run isolated).
 */
export function craftedWorkerPolicy(coordinator: ExecutionPolicy): ExecutionPolicy {
  return { ...coordinator, hosting: { ...(coordinator.hosting ?? {}), modes: ["isolated"] } };
}

const rejected = (path: string, message: string, details: Record<string, unknown> = {}) =>
  new HttpError(422, "policy_rejected", message, { path, ...details });

/**
 * Resolves `create_worker` for a coordinator (docs/HOSTING-MODES-PLAN.md, sections 7.4 and 7.5). A listed worker is the
 * latest published version of one of the coordinator's worker harnesses under its own effective policy. A crafted worker
 * is composed within the coordinator's crafting template. Both pass depth-one checks and the same hosted-harness admission
 * as an isolated host, for worker containers with `options.features`. Sizes come from the coordinator's effective worker
 * sizes (and the template's, for crafted workers). Problems are HTTP errors with paths into the request.
 */
export function planWorker(
  registry: WorkerRegistry,
  coordinator: { definition: HarnessDefinition; policy: ExecutionPolicy },
  request: WorkerCreation,
  options: WorkerPlanningOptions,
): WorkerPlan {
  const ceilings = workerCeilings(coordinator.definition, coordinator.policy);
  if (!ceilings) throw rejected("harness", "Only an orchestrator coordinator can start workers, and workers cannot start workers.");
  let snapshot: HarnessSnapshot;
  let policy: ExecutionPolicy;
  let template: string | undefined;
  let sizes = ceilings.sizes;
  if (request.harness !== undefined) {
    if (!ceilings.harnesses.includes(request.harness)) {
      throw rejected("harness", `'${request.harness}' is not one of this coordinator's worker harnesses.`);
    }
    const latest = registry.harnesses.get(request.harness)?.[0];
    if (!latest) throw rejected("harness", `Worker harness '${request.harness}' is not published.`);
    snapshot = latest;
    policy = policyFor(registry.policies, request.harness);
  } else {
    const crafting = ceilings.crafting;
    if (!crafting || !request.craft) throw rejected("craft", "This coordinator has no crafting template, so it cannot craft workers.");
    if (registry.harnesses.has(request.name)) {
      throw rejected("name", `'${request.name}' is a published harness; give the crafted worker another name.`);
    }
    const crafted = craftWorkerDefinition({
      name: request.name, spec: request.craft, template: crafting.template, ceiling: crafting.ceiling,
      coordinator: coordinator.definition.name, policy: coordinator.policy,
    });
    if (!crafted.definition) {
      const first = crafted.problems[0]!;
      throw rejected(first.path, first.message, { problems: crafted.problems.slice(0, 20) });
    }
    snapshot = { definition: crafted.definition, digest: `sha256:${sha256Hex(canonicalJson(crafted.definition))}` };
    policy = craftedWorkerPolicy(coordinator.policy);
    template = crafting.template;
    sizes = sizes.filter((size) => crafting.ceiling.sizes.includes(size.name));
  }
  const { definition } = snapshot;
  const subject = request.harness !== undefined ? `Worker harness '${request.harness}'` : "The crafted worker";
  const depth = workerDepthProblems(definition)[0];
  if (depth) throw rejected(request.harness !== undefined ? "harness" : "craft", `${subject}: ${depth.message}`, { field: depth.path });
  let admitted: { model: string; tokenBudget: number };
  try {
    admitted = admitHostedHarness(snapshot, registry.profiles, policy, { host: "Worker containers", features: options.features, code: "policy_rejected" });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
    throw new HttpError(error.statusCode, error.code, `${subject}: ${error.message}`, {
      ...details, path: request.harness !== undefined ? "harness" : "craft", ...(typeof details.path === "string" ? { field: details.path } : {}),
    });
  }
  const sizeName = request.size ?? sizes[0]?.name;
  const size = sizes.find((entry) => entry.name === sizeName);
  if (!size) {
    const offered = sizes.map((entry) => entry.name).join(", ") || "none";
    throw rejected("size", sizeName ? `Size '${sizeName}' is not available to this worker (available: ${offered}).` : "No worker size is available to this worker.");
  }
  const sharedVolume = request.sharedVolume ?? (ceilings.sharedStorage === "session" ? "read-write" : "none");
  if (ceilings.sharedStorage === "none" && sharedVolume !== "none") {
    throw rejected("sharedVolume", "This coordinator does not give its workers a shared volume.");
  }
  const approvalMode = approvalModeOf(definition.permissions);
  return {
    name: request.name,
    source: request.harness !== undefined ? "listed" : "crafted",
    harness: { name: definition.name, version: definition.version, digest: snapshot.digest },
    definition,
    ...(template !== undefined ? { template } : {}),
    policyDigest: policyDigest(policy),
    size: size.name,
    resources: { ...size.resources },
    sharedVolume,
    approvalMode,
    inheritHumanAuthority: ceilings.inheritHumanAuthority && approvalMode === "assisted",
    coordinatorAnswers: ceilings.coordinatorAnswers,
    model: admitted.model,
    tokenBudget: Math.min(request.tokenBudget ?? admitted.tokenBudget, admitted.tokenBudget),
    maxTurnSeconds: Math.min(definition.limits.maxDurationSeconds, policy.maxDurationSeconds),
    inputTimeoutSeconds: definition.permissions?.timeoutSeconds ?? DEFAULT_INPUT_TIMEOUT_SECONDS,
    idleSeconds: ceilings.idleSeconds,
    lifetimeSeconds: ceilings.maxLifetimeSeconds,
    task: request.task,
    capacity: { maxPerSession: ceilings.maxPerSession, maxConcurrent: ceilings.maxConcurrent, maxPerPrincipal: ceilings.maxPerPrincipal },
  };
}
