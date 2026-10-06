import {
  type ExecutionPolicy,
  type ExecutionProfile,
  type HarnessSnapshot,
  type JobSubmission,
  modelOptionViolations,
  requiredRunnerCapabilities,
  toolPolicyViolations,
} from "@copilot-agent/contracts";
import { canonicalJson, createAjv, HttpError, sha256Hex } from "@copilot-agent/service-defaults";
import type { ValidateFunction } from "ajv";

export interface AdmissionContext {
  harnesses: Map<string, HarnessSnapshot[]>;
  profiles: Map<string, ExecutionProfile>;
  policy: ExecutionPolicy;
}

export interface AdmittedJob {
  harness: HarnessSnapshot;
  profile: string;
  model: string;
  input: unknown;
  maxDurationSeconds: number;
  tokenBudget: number;
  maxAttempts: number;
  safeToRetry: boolean;
  requestHash: string;
}

/**
 * Validates a submission against the published harness, approved execution profiles, and the
 * operator policy. Effective limits are the intersection; a caller can only narrow them.
 */
export class Admission {
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #ajv = createAjv();

  constructor(private readonly context: AdmissionContext) {}

  admit(submission: JobSubmission): AdmittedJob {
    const { harnesses, profiles, policy } = this.context;
    const versions = harnesses.get(submission.harness.name);
    const harness = submission.harness.version
      ? versions?.find((v) => v.definition.version === submission.harness.version)
      : versions?.[0];
    if (!harness) {
      throw new HttpError(404, "harness_not_found", "The requested harness version is not published.");
    }
    const definition = harness.definition;
    if (definition.interaction === "conversation") {
      throw new HttpError(422, "policy_rejected", "Conversation harnesses run on the demo host, not as batch jobs.");
    }

    const profileId = submission.profile ?? definition.runners.defaultProfile;
    const profile = profiles.get(profileId);
    if (!definition.runners.allowedProfiles.includes(profileId)) {
      throw new HttpError(422, "policy_rejected", `Profile '${profileId}' is not allowed by the harness.`);
    }
    if (!policy.allowedProfiles.includes(profileId) || !profile) {
      throw new HttpError(422, "policy_rejected", `Profile '${profileId}' is not approved by the operator policy.`);
    }
    const missingBindings = definition.tools
      .map((t) => t.binding)
      .filter((binding) => !profile.toolBindings.includes(binding));
    if (missingBindings.length > 0) {
      throw new HttpError(422, "policy_rejected", `Profile '${profileId}' cannot satisfy the harness tool bindings.`, {
        missingBindings,
      });
    }
    for (const required of ["cancel", "structured-result", ...requiredRunnerCapabilities(definition)] as const) {
      if (!profile.capabilities.includes(required)) {
        throw new HttpError(422, "policy_rejected", `Profile '${profileId}' does not support '${required}'.`);
      }
    }
    const optionProblems = [...modelOptionViolations(definition, policy), ...toolPolicyViolations(definition, policy)];
    if (optionProblems.length > 0) {
      throw new HttpError(422, "policy_rejected", optionProblems[0]!.message, { problems: optionProblems });
    }

    const model = [definition.model.preferred, ...definition.model.allowed].find((m) =>
      policy.allowedModels.includes(m),
    );
    if (!model) {
      throw new HttpError(422, "policy_rejected", "None of the harness models are approved by the operator policy.");
    }
    const unapprovedAgentModels = (definition.agents ?? [])
      .filter((a) => a.model && !policy.allowedModels.includes(a.model))
      .map((a) => a.name);
    if (unapprovedAgentModels.length > 0) {
      throw new HttpError(422, "policy_rejected", "A sub-agent model is not approved by the operator policy.", {
        agents: unapprovedAgentModels,
      });
    }

    const validate = this.#inputValidator(harness);
    if (!validate(submission.input)) {
      throw new HttpError(400, "invalid_input", "The job input does not match the harness input schema.", {
        errors: (validate.errors ?? []).slice(0, 20).map((e) => ({ path: e.instancePath, message: e.message })),
      });
    }

    const maxDurationSeconds = Math.min(
      definition.limits.maxDurationSeconds,
      policy.maxDurationSeconds,
      submission.deadlineSeconds ?? Number.MAX_SAFE_INTEGER,
    );
    return {
      harness,
      profile: profileId,
      model,
      input: submission.input,
      maxDurationSeconds,
      tokenBudget: Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob),
      maxAttempts: Math.min(definition.retry.maxAttempts, policy.retry.maxAttempts),
      safeToRetry: definition.retry.safeToRetry,
      requestHash: sha256Hex(
        canonicalJson({
          harness: { name: definition.name, version: definition.version },
          profile: profileId,
          input: submission.input ?? null,
          deadlineSeconds: submission.deadlineSeconds ?? null,
        }),
      ),
    };
  }

  #inputValidator(harness: HarnessSnapshot): ValidateFunction {
    let validate = this.#validators.get(harness.digest);
    if (!validate) {
      validate = this.#ajv.compile(harness.definition.input.schema);
      this.#validators.set(harness.digest, validate);
    }
    return validate;
  }
}
