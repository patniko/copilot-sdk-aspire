import { modelOptionViolations, requiredRunnerCapabilities, toolPolicyViolations, type ExecutionPolicy, type ExecutionProfile, type HarnessSnapshot } from "@copilot-agent/contracts";
import { HttpError } from "./http.js";

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
  const missing = definition.tools.some((tool) => !profile.toolBindings.includes(tool.binding))
    || requiredRunnerCapabilities(definition).some((capability) => !profile.capabilities.includes(capability));
  const problems = [...modelOptionViolations(definition, policy), ...toolPolicyViolations(definition, policy)];
  if (missing || problems.length) {
    throw new HttpError(422, "host_policy_rejected", problems[0]?.message ?? "The host cannot satisfy the requested tools or capabilities.");
  }
  const model = [definition.model.preferred, ...definition.model.allowed].find((name) => policy.allowedModels.includes(name));
  if (!model || definition.agents?.some((agent) => agent.model && !policy.allowedModels.includes(agent.model))) {
    throw new HttpError(422, "host_policy_rejected", "The host model or a sub-agent model is not approved.");
  }
  return { model, tokenBudget: Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob) };
}
