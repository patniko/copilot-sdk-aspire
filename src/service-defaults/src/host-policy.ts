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
} from "@copilot-agent/contracts";
import { HttpError } from "./http.js";
import { DEMO_HOST_FEATURES, hostingError } from "./hosting.js";

/** In-process bindings only the shared worker implements; containers cannot bind them. */
const SHARED_ONLY_BINDINGS = new Set<string>(SHARED_WORKER_BINDINGS);

export function admitHostedHarness(
  harness: HarnessSnapshot,
  profiles: Map<string, ExecutionProfile>,
  policy: ExecutionPolicy,
): { model: string; tokenBudget: number } {
  const definition = harness.definition;
  if (definition.interaction !== "conversation") {
    throw new HttpError(422, "host_policy_rejected", "The demo host requires a conversation harness.");
  }
  const profile = profiles.get("node-ts-agent");
  if (!profile || !policy.allowedProfiles.includes(profile.id) || !definition.runners.allowedProfiles.includes(profile.id)) {
    throw new HttpError(422, "host_policy_rejected", "The TypeScript host profile is not approved.");
  }
  const missing = definition.tools.some((tool) => !profile.toolBindings.includes(tool.binding) || SHARED_ONLY_BINDINGS.has(tool.binding))
    || requiredRunnerCapabilities(definition).some((capability) => !profile.capabilities.includes(capability));
  const problems = [...modelOptionViolations(definition, policy), ...toolPolicyViolations(definition, policy)];
  if (missing || problems.length) {
    throw new HttpError(422, "host_policy_rejected", problems[0]?.message ?? "The host cannot satisfy the requested tools or capabilities.");
  }
  const model = [definition.model.preferred, ...definition.model.allowed].find((name) => policy.allowedModels.includes(name));
  if (!model || definition.agents?.some((agent) => agent.model && !policy.allowedModels.includes(agent.model))) {
    throw new HttpError(422, "host_policy_rejected", "The host model or a sub-agent model is not approved.");
  }
  // The demo host is an isolated host for exactly this harness; it never runs another mode in its place.
  const mode = hostingModeOf(definition);
  if (mode !== "isolated") {
    throw new HttpError(422, "host_policy_rejected", `The demo host serves isolated harnesses; this harness requests ${mode} hosting.`);
  }
  const evaluation = evaluateHosting({
    definition,
    policy,
    profiles,
    deployment: { isolatedHosts: [{ harness: definition.name, owner: "demo-host", transports: [], features: [...DEMO_HOST_FEATURES] }] },
  });
  const problem = evaluation.problems[0];
  if (problem) throw hostingError(problem, "host_policy_rejected");
  return { model, tokenBudget: Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob) };
}
