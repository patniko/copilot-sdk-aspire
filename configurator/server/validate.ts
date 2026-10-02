import { ExecutionPolicy, HarnessDefinition, securityGaps } from "@copilot-agent/contracts";
import { canonicalJson, createAjv, sha256Hex } from "@copilot-agent/service-defaults";
import type { EffectiveLimits, HarnessDocument, Issue, ProfileSummary } from "./types.js";

export interface ValidationContext {
  policy: ExecutionPolicy;
  profiles: ProfileSummary[];
  /** All harness documents in the repository, for duplicate detection. */
  all: HarnessDocument[];
  /** Committed harness.json + instructions for this folder, if any. */
  committed?: { manifest: string; instructions?: string };
}

const RESERVED_TOOLS = new Set(["submit_result"]);

function issue(level: Issue["level"], path: string, message: string, fix?: Issue["fix"]): Issue {
  return fix ? { level, path, message, fix } : { level, path, message };
}

/** Validates a harness exactly as the API will at load and admission time, plus authoring checks. */
export function validateHarness(document: HarnessDocument, context: ValidationContext): Issue[] {
  const issues: Issue[] = [];
  const { manifest } = document;
  const { instructionsFile, ...rest } = manifest as typeof manifest & Record<string, unknown>;

  if (typeof instructionsFile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(instructionsFile)) {
    issues.push(issue("error", "instructionsFile", "Use a simple .md file name inside the harness folder."));
  }
  if (!document.instructions.trim()) {
    issues.push(issue("error", "instructions", "Instructions are required."));
  }

  const parsed = HarnessDefinition.safeParse({ ...rest, instructions: document.instructions || " " });
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) {
      issues.push(issue("error", zodIssue.path.join(".") || "(root)", zodIssue.message));
    }
  }

  const ajv = createAjv();
  for (const key of ["input", "output"] as const) {
    const schema = manifest[key]?.schema;
    if (!schema || typeof schema !== "object") {
      continue;
    }
    if (schema.type !== "object") {
      issues.push(issue("error", `${key}.schema`, 'The schema must describe an object ("type": "object").'));
    }
    try {
      const validate = ajv.compile(schema);
      const examples = (schema as { examples?: unknown }).examples;
      if (Array.isArray(examples)) {
        examples.forEach((example, index) => {
          if (!validate(example)) {
            const first = validate.errors?.[0];
            issues.push(
              issue(
                "error",
                `${key}.schema.examples.${index}`,
                `Example ${index + 1} does not match the schema: ${first?.instancePath || "(root)"} ${first?.message ?? ""}`.trim(),
              ),
            );
          }
        });
      } else if (key === "input") {
        issues.push(issue("warning", "input.schema.examples", "Add an example input so testers and the job console can prefill it."));
      }
    } catch (error) {
      issues.push(issue("error", `${key}.schema`, `Invalid JSON Schema: ${(error as Error).message}`));
    }
  }

  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const names = new Set<string>();
  tools.forEach((tool, index) => {
    if (RESERVED_TOOLS.has(tool.name)) {
      issues.push(issue("error", `tools.${index}.name`, `'${tool.name}' is reserved by the runners.`));
    }
    if (names.has(tool.name)) {
      issues.push(issue("error", `tools.${index}.name`, `Duplicate tool name '${tool.name}'.`));
    }
    names.add(tool.name);
    if (!context.profiles.some((p) => p.toolBindings.includes(tool.binding))) {
      issues.push(issue("error", `tools.${index}.binding`, `No execution profile provides binding '${tool.binding}'.`));
    }
  });

  const allowedProfiles = manifest.runners?.allowedProfiles ?? [];
  for (const profileId of allowedProfiles) {
    const profile = context.profiles.find((p) => p.id === profileId);
    if (!profile) {
      issues.push(issue("error", "runners.allowedProfiles", `Execution profile '${profileId}' does not exist.`));
      continue;
    }
    const missing = tools.map((t) => t.binding).filter((b) => !profile.toolBindings.includes(b));
    if (missing.length > 0) {
      issues.push(
        issue("error", "runners.allowedProfiles", `Profile '${profileId}' cannot provide: ${[...new Set(missing)].join(", ")}.`),
      );
    }
    if (!context.policy.allowedProfiles.includes(profileId)) {
      issues.push(
        issue("warning", "runners.allowedProfiles", `The operator policy does not approve '${profileId}'; jobs using it are rejected.`),
      );
    }
  }

  const models = manifest.model ? [manifest.model.preferred, ...manifest.model.allowed] : [];
  if (models.length > 0 && !models.some((m) => context.policy.allowedModels.includes(m))) {
    issues.push(issue("error", "model", "None of these models are approved by the operator policy; every job would be rejected."));
  } else if (manifest.model && !context.policy.allowedModels.includes(manifest.model.preferred)) {
    issues.push(issue("warning", "model.preferred", "The preferred model is not approved; jobs fall back to another allowed model."));
  }

  if (manifest.limits) {
    if (manifest.limits.maxDurationSeconds > context.policy.maxDurationSeconds) {
      issues.push(
        issue("warning", "limits.maxDurationSeconds", `Capped at ${context.policy.maxDurationSeconds}s by the operator policy.`),
      );
    }
    if (manifest.limits.maxInferenceTokens > context.policy.maxInferenceTokensPerJob) {
      issues.push(
        issue("warning", "limits.maxInferenceTokens", `Capped at ${context.policy.maxInferenceTokensPerJob} tokens by the operator policy.`),
      );
    }
  }
  if (manifest.retry && manifest.retry.maxAttempts > context.policy.retry.maxAttempts) {
    issues.push(issue("warning", "retry.maxAttempts", `Capped at ${context.policy.retry.maxAttempts} attempts by the operator policy.`));
  }
  if (manifest.retry?.safeToRetry && tools.some((t) => t.kind === "host")) {
    issues.push(
      issue("warning", "retry.safeToRetry", "Host tools may have external effects; only mark the harness safe to retry if every tool is read-only."),
    );
  }

  const duplicates = context.all.filter(
    (d) => d.folder !== document.folder && d.manifest.name === manifest.name && d.manifest.version === manifest.version,
  );
  if (duplicates.length > 0) {
    issues.push(
      issue("error", "version", `${manifest.name} ${manifest.version} is already published in harnesses/${duplicates[0]!.folder}.`),
    );
  }

  if (context.committed) {
    try {
      const committed = JSON.parse(context.committed.manifest) as { name?: string; version?: string };
      const current = JSON.stringify(manifest);
      const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
      const changed =
        canonicalJson(JSON.parse(context.committed.manifest)) !== canonicalJson(JSON.parse(current)) ||
        (context.committed.instructions !== undefined &&
          normalize(context.committed.instructions) !== normalize(document.instructions));
      if (changed && committed.name === manifest.name && committed.version === manifest.version) {
        issues.push(
          issue(
            "warning",
            "version",
            `Content changed but the version is still ${manifest.version}. Bump the version so deployed jobs and callers can tell them apart.`,
            "bump-patch",
          ),
        );
      }
    } catch {
      // The committed file was not JSON; nothing to compare.
    }
  }

  return issues;
}

export function harnessDigest(document: HarnessDocument): string | undefined {
  const { instructionsFile: _ignored, ...rest } = document.manifest as typeof document.manifest & Record<string, unknown>;
  const parsed = HarnessDefinition.safeParse({ ...rest, instructions: document.instructions });
  return parsed.success ? `sha256:${sha256Hex(canonicalJson(parsed.data))}` : undefined;
}

export function effectiveLimits(document: HarnessDocument, policy: ExecutionPolicy): EffectiveLimits {
  const { manifest } = document;
  const candidates = manifest.model ? [manifest.model.preferred, ...manifest.model.allowed] : [];
  return {
    maxDurationSeconds: Math.min(manifest.limits?.maxDurationSeconds ?? Infinity, policy.maxDurationSeconds),
    tokenBudget: Math.min(manifest.limits?.maxInferenceTokens ?? Infinity, policy.maxInferenceTokensPerJob),
    maxAttempts: Math.min(manifest.retry?.maxAttempts ?? Infinity, policy.retry.maxAttempts),
    model: candidates.find((m) => policy.allowedModels.includes(m)),
  };
}

export function validatePolicy(raw: unknown, profiles: ProfileSummary[]): { policy?: ExecutionPolicy; issues: Issue[] } {
  const parsed = ExecutionPolicy.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((i) => issue("error", i.path.join(".") || "(root)", i.message)),
    };
  }
  const policy = parsed.data;
  const issues: Issue[] = [];
  for (const id of policy.allowedProfiles) {
    if (!profiles.some((p) => p.id === id)) {
      issues.push(issue("error", "allowedProfiles", `Execution profile '${id}' does not exist.`));
    }
  }
  // What a uid-isolating executor without egress control would be missing.
  const reference = securityGaps(policy, {
    executorId: "reference",
    profiles: [],
    processIsolation: "uid",
    egress: "none",
    platform: "linux",
  });
  for (const gap of policy.acknowledgedGaps) {
    if (gap === "egress-not-enforced" && policy.requirements.egress !== "gateway-only") {
      issues.push(issue("warning", "acknowledgedGaps", "Egress is not required, so acknowledging 'egress-not-enforced' has no effect."));
    }
    if (gap === "process-isolation-not-enforced" && policy.requirements.processIsolation !== "uid") {
      issues.push(
        issue("warning", "acknowledgedGaps", "Process isolation is not required, so this acknowledgement has no effect."),
      );
    }
  }
  for (const gap of reference) {
    if (!policy.acknowledgedGaps.includes(gap)) {
      issues.push(
        issue(
          "warning",
          "acknowledgedGaps",
          `The shipped executor cannot enforce '${gap.replace("-not-enforced", "")}'; executors will refuse to claim work until it is enforced or acknowledged.`,
        ),
      );
    }
  }
  if (policy.requirements.processIsolation === "none") {
    issues.push(issue("warning", "requirements.processIsolation", "Runners would share the executor's user and could read its service key."));
  }
  if (policy.leaseSeconds < 15) {
    issues.push(issue("warning", "leaseSeconds", "Short leases can expire during slow network calls and cause duplicate attempts."));
  }
  return { policy, issues };
}
