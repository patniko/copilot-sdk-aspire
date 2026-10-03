import {
  ExecutionPolicy,
  HarnessDefinition,
  modelOptionViolations,
  renderSkillMarkdown,
  requiredRunnerCapabilities,
  securityGaps,
  SLUG,
} from "@copilot-agent/contracts";
import { canonicalJson, createAjv, sha256Hex } from "@copilot-agent/service-defaults";
import type { Decision, EffectiveLimits, HarnessDocument, Issue, ProfileSummary } from "./types.js";

export interface ValidationContext {
  policy: ExecutionPolicy;
  profiles: ProfileSummary[];
  /** All harness documents in the repository, for duplicate detection. */
  all: HarnessDocument[];
  /** Committed harness.json + instructions for this folder, if any. */
  committed?: { manifest: string; instructions?: string; skills?: Record<string, string> };
}

const RESERVED_TOOLS = new Set(["submit_result"]);

function issue(level: Issue["level"], path: string, message: string, fix?: Issue["fix"]): Issue {
  return fix ? { level, path, message, fix } : { level, path, message };
}

/** The exact API definition candidate: manifest fields plus inline instructions and skills. */
export function definitionOf(document: HarnessDocument): unknown {
  const { instructionsFile: _instructionsFile, skills: _skillNames, ...rest } = document.manifest as typeof document.manifest &
    Record<string, unknown>;
  const skills = document.skills ?? [];
  return { ...rest, instructions: document.instructions, ...(skills.length ? { skills } : {}) };
}

function manifestForDisk(document: HarnessDocument): HarnessDocument["manifest"] {
  const manifest = { ...document.manifest };
  const skills = document.skills ?? [];
  if (skills.length > 0) {
    manifest.skills = skills.map((skill) => skill.name);
  } else {
    delete manifest.skills;
  }
  return manifest;
}

function requiredCapabilities(candidate: unknown): string[] {
  const parsed = HarnessDefinition.safeParse(candidate);
  if (parsed.success) {
    return requiredRunnerCapabilities(parsed.data);
  }
  const value = (candidate && typeof candidate === "object" ? candidate : {}) as Record<string, unknown>;
  const features: string[] = [];
  const prompt = value.prompt as { mode?: unknown } | undefined;
  const model = value.model as { reasoningEffort?: unknown; contextTier?: unknown } | undefined;
  if (prompt && prompt.mode !== undefined && prompt.mode !== "replace") features.push("prompt-sections");
  if (model?.reasoningEffort || model?.contextTier) features.push("model-options");
  if (Array.isArray(value.agents) && value.agents.length > 0) features.push("custom-agents");
  if (Array.isArray(value.skills) && value.skills.length > 0) features.push("skills");
  return features;
}

/** Validates a harness exactly as the API will at load and admission time, plus authoring checks. */
export function validateHarness(document: HarnessDocument, context: ValidationContext): Issue[] {
  const issues: Issue[] = [];
  const { manifest } = document;
  const candidate = definitionOf(document);
  const candidateCapabilities = requiredCapabilities(candidate);

  if (typeof manifest.instructionsFile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(manifest.instructionsFile)) {
    issues.push(issue("error", "instructionsFile", "Use a simple .md file name inside the harness folder."));
  }
  if (!document.instructions.trim()) {
    issues.push(issue("error", "instructions", "Instructions are required."));
  }

  const parsed = HarnessDefinition.safeParse(candidate);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) {
      issues.push(issue("error", zodIssue.path.join(".") || "(root)", zodIssue.message));
    }
  }

  (document.skills ?? []).forEach((skill, index) => {
    if (!SLUG.test(skill.name)) {
      issues.push(issue("error", `skills.${index}.name`, "Skill names use lowercase letters, digits, and hyphens."));
    }
  });

  const modelShape = (candidate && typeof candidate === "object" ? candidate : {}) as {
    model?: { reasoningEffort?: string; contextTier?: string };
    agents?: Array<{ name: string; reasoningEffort?: string }>;
  };
  if (modelShape.model) {
    for (const violation of modelOptionViolations({ model: modelShape.model, agents: modelShape.agents }, context.policy)) {
      issues.push(issue("error", violation.path, violation.message));
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
    const missingCapabilities = candidateCapabilities.filter((capability) => !profile.capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      issues.push(
        issue(
          "error",
          "runners.allowedProfiles",
          `Profile '${profileId}' does not support: ${missingCapabilities.join(", ")}.`,
        ),
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

  if (Array.isArray(manifest.agents)) {
    manifest.agents.forEach((agent, index) => {
      if (agent.model && !context.policy.allowedModels.includes(agent.model)) {
        issues.push(issue("error", `agents.${index}.model`, `Agent model '${agent.model}' is not approved by the operator policy.`));
      }
    });
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
      const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
      const currentSkills = Object.fromEntries((document.skills ?? []).map((skill) => [skill.name, renderSkillMarkdown(skill)]));
      const skillNames = new Set([...Object.keys(context.committed.skills ?? {}), ...Object.keys(currentSkills)]);
      const skillsChanged = [...skillNames].some(
        (name) => normalize(context.committed?.skills?.[name] ?? "") !== normalize(currentSkills[name] ?? ""),
      );
      const changed =
        canonicalJson(JSON.parse(context.committed.manifest)) !== canonicalJson(manifestForDisk(document)) ||
        (context.committed.instructions !== undefined &&
          normalize(context.committed.instructions) !== normalize(document.instructions)) ||
        skillsChanged;
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
  const parsed = HarnessDefinition.safeParse(definitionOf(document));
  return parsed.success ? `sha256:${sha256Hex(canonicalJson(parsed.data))}` : undefined;
}

export function requiredCapabilitiesOf(document: HarnessDocument): string[] {
  return requiredCapabilities(definitionOf(document));
}

export function decisions(document: HarnessDocument, context: ValidationContext): Decision[] {
  const { manifest } = document;
  const result: Decision[] = [];
  const effective = effectiveLimits(document, context.policy);
  const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const skills = document.skills ?? [];
  const profileSummaries = (manifest.runners?.allowedProfiles ?? [])
    .map((id) => context.profiles.find((profile) => profile.id === id))
    .filter((profile): profile is ProfileSummary => Boolean(profile));

  result.push({
    kind: "host",
    title: "Inference goes through the gateway",
    detail: `The gateway uses ${effective.model ?? "an operator-approved model"} and holds the Foundry credential; the runner only gets a job-scoped token.`,
    path: "model",
  });

  tools.forEach((tool, index) => {
    const users = agents
      .filter((agent) => agent.tools.includes(tool.name))
      .map((agent) => agent.displayName ?? agent.name);
    const delegated = tool.delegatedOnly
      ? ` Only sub-agents ${users.length ? users.join(", ") : "(none configured)"} can call it.`
      : "";
    result.push({
      kind: "host",
      title:
        tool.kind === "python"
          ? `${tool.name} runs pinned code (${tool.binding}) in the runner as an unprivileged user`
          : `${tool.name} is implemented by the execution profile`,
      detail:
        tool.kind === "python"
          ? `The selected runner provides ${tool.binding} and executes it without service credentials.${delegated}`
          : `The selected execution profile provides ${tool.binding}; review the profile implementation.${delegated}`,
      path: `tools.${index}`,
    });
  });

  if (manifest.prompt?.mode === "append" || manifest.prompt?.mode === "customize") {
    const changes =
      manifest.prompt.mode === "customize"
        ? manifest.prompt.sections
            ?.filter((section) => section.action === "remove" || section.action === "replace")
            .map((section) => `${section.action} ${section.name}`)
            .join(", ")
        : undefined;
    result.push({
      kind: "review",
      title: "Includes the Copilot foundation prompt",
      detail:
        `About 6.7 KB of GitHub Copilot coding-agent guidance precedes your instructions; review that it suits the job.` +
        (changes ? ` Customized sections: ${changes}.` : ""),
      path: "prompt.mode",
    });
  } else {
    result.push({
      kind: "info",
      title: "Your instructions are the whole system prompt",
      detail: "The runner appends the structured result contract after your instructions.",
      path: "prompt.mode",
    });
  }

  agents.forEach((agent, index) => {
    const parts = [
      agent.tools.length ? `tools: ${agent.tools.join(", ")}` : undefined,
      agent.skills?.length ? `skills: ${agent.skills.join(", ")}` : undefined,
      agent.model ? `model: ${agent.model}` : undefined,
      agent.reasoningEffort ? `reasoning effort: ${agent.reasoningEffort}` : undefined,
    ].filter(Boolean);
    const reliesOnlyOnInstructions = agent.tools.length === 0 && !(agent.skills?.length);
    result.push({
      kind: reliesOnlyOnInstructions ? "review" : "info",
      title: `${agent.displayName ?? agent.name} sub-agent`,
      detail: reliesOnlyOnInstructions ? "Relies only on its instructions." : parts.join("; "),
      path: `agents.${index}`,
    });
  });

  skills.forEach((skill, index) => {
    const preloaded = agents.filter((agent) => agent.skills?.includes(skill.name)).map((agent) => agent.displayName ?? agent.name);
    result.push({
      kind: "info",
      title: preloaded.length ? `${skill.name} preloaded into ${preloaded.join(", ")}` : `${skill.name} loads on demand`,
      detail: skill.description || "Skill content is empty and should be completed.",
      path: `skills.${index}`,
    });
  });

  if (manifest.model?.reasoningEffort) {
    result.push({
      kind: "info",
      title: `Reasoning effort ${manifest.model.reasoningEffort} is sent to the model`,
      detail: "Models that do not support it ignore it.",
      path: "model.reasoningEffort",
    });
  }
  if (manifest.model?.contextTier === "long_context") {
    result.push({
      kind: "review",
      title: "Long-context tier requested",
      detail: "Review cost and latency before using the long-context model tier.",
      path: "model.contextTier",
    });
  }

  for (const gap of context.policy.acknowledgedGaps) {
    if (gap === "egress-not-enforced") {
      result.push({
        kind: "gap",
        title: "Runner network egress is not enforced",
        detail: "The operator acknowledged that runners can reach the network directly; tools and the agent are only expected to use the gateway.",
        path: "policy.acknowledgedGaps",
      });
    }
    if (gap === "process-isolation-not-enforced") {
      result.push({
        kind: "gap",
        title: "Runner process isolation is not enforced",
        detail: "The operator acknowledged that runners may share a user with the executor.",
        path: "policy.acknowledgedGaps",
      });
    }
  }

  if (manifest.retry?.safeToRetry && tools.some((tool) => tool.kind === "host")) {
    result.push({
      kind: "review",
      title: "Automatic retries can repeat host tool effects",
      detail: "Keep safeToRetry only if every host tool is read-only or idempotent.",
      path: "retry.safeToRetry",
    });
  }

  if (profileSummaries.length > 0) {
    result.push({
      kind: "host",
      title: `Runs on ${profileSummaries.map((profile) => profile.displayName).join(", ")}`,
      detail: profileSummaries.map((profile) => `${profile.displayName}: ${profile.language} / ${profile.sdk}`).join("; "),
      path: "runners.allowedProfiles",
    });
  }

  return result;
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
