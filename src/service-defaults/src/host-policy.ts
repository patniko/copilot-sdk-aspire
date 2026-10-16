import {
  evaluateHosting,
  hostingModeOf,
  modelOptionViolations,
  requiredRunnerCapabilities,
  SHARED_WORKER_BINDINGS,
  toolPolicyViolations,
  type ExecutionPolicy,
  type ExecutionProfile,
  type HarnessSnapshot,
  type HostingFeature,
} from "@copilot-agent/contracts";
import { HttpError } from "./http.js";
import { DEMO_HOST_FEATURES, hostingError } from "./hosting.js";

/** In-process bindings only the shared worker implements; containers cannot bind them. */
const SHARED_ONLY_BINDINGS = new Set<string>(SHARED_WORKER_BINDINGS);

/** The container host a hosted harness is admitted for. */
export interface HostedAdmissionTarget {
  /** The host as a sentence subject in error messages. */
  host: string;
  /** Harness features the host implements; a harness that needs another is unavailable there. */
  features: readonly HostingFeature[];
  /** The error code for policy problems. */
  code: string;
}

export const DEMO_HOST_ADMISSION: HostedAdmissionTarget = Object.freeze({
  host: "The demo host",
  features: DEMO_HOST_FEATURES,
  code: "host_policy_rejected",
});

export function admitHostedHarness(
  harness: HarnessSnapshot,
  profiles: ReadonlyMap<string, ExecutionProfile>,
  policy: ExecutionPolicy,
  target: HostedAdmissionTarget = DEMO_HOST_ADMISSION,
): { model: string; tokenBudget: number } {
  const definition = harness.definition;
  if (definition.interaction !== "conversation") {
    throw new HttpError(422, target.code, `${target.host} requires a conversation harness.`);
  }
  const profile = profiles.get("node-ts-agent");
  if (!profile || !policy.allowedProfiles.includes(profile.id) || !definition.runners.allowedProfiles.includes(profile.id)) {
    throw new HttpError(422, target.code, "The TypeScript host profile is not approved.");
  }
  const missing = definition.tools.some((tool) => !profile.toolBindings.includes(tool.binding) || SHARED_ONLY_BINDINGS.has(tool.binding))
    || requiredRunnerCapabilities(definition).some((capability) => !profile.capabilities.includes(capability));
  const problems = [...modelOptionViolations(definition, policy), ...toolPolicyViolations(definition, policy)];
  if (missing || problems.length) {
    throw new HttpError(422, target.code, problems[0]?.message ?? "The host cannot satisfy the requested tools or capabilities.");
  }
  const model = [definition.model.preferred, ...definition.model.allowed].find((name) => policy.allowedModels.includes(name));
  if (!model || definition.agents?.some((agent) => agent.model && !policy.allowedModels.includes(agent.model))) {
    throw new HttpError(422, target.code, "The host model or a sub-agent model is not approved.");
  }
  // The demo host is an isolated host for exactly this harness; it never runs another mode in its place.
  const mode = hostingModeOf(definition);
  if (mode !== "isolated") {
    throw new HttpError(422, target.code, `${target.host} serves isolated harnesses; this harness requests ${mode} hosting.`);
  }
  const evaluation = evaluateHosting({
    definition,
    policy,
    profiles,
    deployment: { isolatedHosts: [{ harness: definition.name, owner: "demo-host", transports: [], features: [...target.features] }] },
  });
  const problem = evaluation.problems[0];
  if (problem) throw hostingError(problem, target.code);
  return { model, tokenBudget: Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob) };
}
