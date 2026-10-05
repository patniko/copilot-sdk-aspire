import { z } from "zod";

export const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,62}$/;

/** A JSON Schema document. Validated structurally by Ajv at load time, not by zod. */
export const JsonSchemaDocument = z.record(z.string(), z.unknown());
export type JsonSchemaDocument = z.infer<typeof JsonSchemaDocument>;

export const ToolRequest = z
  .object({
    name: z.string().regex(TOOL_NAME),
    /** Where the implementation comes from. The harness requests; host bindings decide. */
    kind: z.enum(["host", "python", "mcp-local"]),
    description: z.string().min(1).max(1000),
    /** Reference to an implementation in the selected execution profile's toolchain. */
    binding: z.string().min(1).max(200),
    /** Hide the tool from the coordinating agent; only sub-agents that list it can call it. */
    delegatedOnly: z.boolean().optional(),
  })
  .strict();
export type ToolRequest = z.infer<typeof ToolRequest>;

/** Named sections of the Copilot foundation prompt that `customize` mode can change. */
export const PROMPT_SECTIONS = [
  "preamble",
  "identity",
  "tone",
  "tool_efficiency",
  "environment_context",
  "code_change_rules",
  "guidelines",
  "safety",
  "tool_instructions",
  "custom_instructions",
  "runtime_instructions",
  "last_instructions",
] as const;
export type PromptSection = (typeof PROMPT_SECTIONS)[number];

export const PromptSectionOverride = z
  .object({
    name: z.enum(PROMPT_SECTIONS),
    action: z.enum(["replace", "append", "prepend", "remove"]),
    content: z.string().max(20_000),
  })
  .strict();
export type PromptSectionOverride = z.infer<typeof PromptSectionOverride>;

/**
 * How the harness instructions relate to the Copilot foundation prompt.
 * - replace (default): the instructions are the whole system prompt.
 * - append: the Copilot foundation prompt, followed by the instructions.
 * - customize: the foundation prompt with named sections changed, followed by the instructions.
 */
export const PromptConfig = z
  .object({
    mode: z.enum(["replace", "append", "customize"]),
    sections: z.array(PromptSectionOverride).max(PROMPT_SECTIONS.length).optional(),
  })
  .strict()
  .superRefine((prompt, ctx) => {
    if (prompt.mode !== "customize" && prompt.sections?.length) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "Sections apply only in customize mode." });
    }
    const seen = new Set<string>();
    prompt.sections?.forEach((section, index) => {
      if (seen.has(section.name)) {
        ctx.addIssue({ code: "custom", path: ["sections", index, "name"], message: "Each section can be changed once." });
      }
      if (section.action !== "remove" && !section.content.trim()) {
        ctx.addIssue({ code: "custom", path: ["sections", index, "content"], message: "Add content, or use the remove action." });
      }
      seen.add(section.name);
    });
  });
export type PromptConfig = z.infer<typeof PromptConfig>;

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Groups of built-in Copilot tools a harness can enable. Runners map each group to the SDK's
 * built-in tool names; every call still goes through the harness permission rules.
 * - files: view, glob, grep, create, edit
 * - shell: the platform shell (bash on Linux) with its read/write/stop/list companions
 * - web: web_fetch
 * - agents: the SDK's built-in sub-agents (explore, general-purpose, ...) and the task tools
 */
export const BUILTIN_TOOL_GROUPS = ["files", "shell", "web", "agents"] as const;
export type BuiltinToolGroup = (typeof BUILTIN_TOOL_GROUPS)[number];

/** Permission request kinds a harness can set individually; other kinds use `default`. */
export const PERMISSION_KINDS = ["read", "write", "shell", "url"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/** deny: refuse; ask: route to a person through the job's input requests; allow: approve automatically. */
export const PermissionMode = z.enum(["deny", "ask", "allow"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * How the runner answers the agent's permission requests and questions. Omitted means every
 * permission request is denied and the agent cannot ask questions. Harness tools never ask.
 */
export const PermissionsConfig = z
  .object({
    default: PermissionMode,
    kinds: z
      .object({
        read: PermissionMode.optional(),
        write: PermissionMode.optional(),
        shell: PermissionMode.optional(),
        url: PermissionMode.optional(),
      })
      .strict()
      .optional(),
    /** Lets the agent ask people questions (the SDK's ask_user tool), answered through the API. */
    questions: z.boolean().optional(),
    /** How long one approval or question waits for an answer before it is denied. Default 600, capped by the attempt deadline. */
    timeoutSeconds: z.number().int().min(30).max(3600).optional(),
  })
  .strict();
export type PermissionsConfig = z.infer<typeof PermissionsConfig>;

export const DEFAULT_INPUT_TIMEOUT_SECONDS = 600;

/** The mode that applies to a permission request kind (unknown kinds use the default). */
export function permissionModeFor(permissions: PermissionsConfig | undefined, kind: string): PermissionMode {
  if (!permissions) return "deny";
  const specific = (permissions.kinds as Record<string, PermissionMode | undefined> | undefined)?.[kind];
  return specific ?? permissions.default;
}

/** Every permission mode a harness can produce, for policy checks. */
export function permissionModesUsed(permissions: PermissionsConfig | undefined): Set<PermissionMode> {
  const modes = new Set<PermissionMode>(["deny"]);
  if (!permissions) return modes;
  modes.add(permissions.default);
  for (const mode of Object.values(permissions.kinds ?? {})) if (mode) modes.add(mode);
  return modes;
}

/** True when the harness may wait for people (approvals or questions). */
export function isInteractive(permissions: PermissionsConfig | undefined): boolean {
  return !!permissions && (permissions.questions === true || permissionModesUsed(permissions).has("ask"));
}

/** A skill: on-demand instructions the agent loads by name. Stored as skills/<name>/SKILL.md. */
export const SkillDefinition = z
  .object({
    name: z.string().regex(SLUG),
    description: z.string().min(1).max(1000),
    content: z.string().min(1).max(64_000),
  })
  .strict();
export type SkillDefinition = z.infer<typeof SkillDefinition>;

/** A sub-agent the coordinating agent can delegate to. Tools and skills are subsets of the harness's. */
export const AgentDefinition = z
  .object({
    name: z.string().regex(SLUG),
    displayName: z.string().min(1).max(100).optional(),
    description: z.string().min(1).max(1000),
    instructions: z.string().min(1).max(20_000),
    tools: z.array(z.string().regex(TOOL_NAME)).max(64),
    /** Skills injected into this agent's context when it starts. */
    skills: z.array(z.string().regex(SLUG)).max(16).optional(),
    model: z.string().min(1).max(200).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/**
 * Harness definition v1. A harness requests capabilities; it never grants them.
 * Effective capabilities are the intersection of the harness, caller authorization,
 * and operator execution policy. Optional fields are omitted when unused so existing
 * harnesses keep their digests.
 */
export const HarnessDefinition = z
  .object({
    schemaVersion: z.literal("1"),
    name: z.string().regex(SLUG),
    version: z.string().regex(SEMVER),
    description: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(100_000),
    prompt: PromptConfig.optional(),
    model: z
      .object({
        preferred: z.string().min(1).max(200),
        allowed: z.array(z.string().min(1).max(200)).min(1),
        reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
        contextTier: z.enum(["default", "long_context"]).optional(),
      })
      .strict(),
    tools: z.array(ToolRequest).max(64),
    builtinTools: z.array(z.enum(BUILTIN_TOOL_GROUPS)).max(BUILTIN_TOOL_GROUPS.length).optional(),
    permissions: PermissionsConfig.optional(),
    skills: z.array(SkillDefinition).max(10).optional(),
    agents: z.array(AgentDefinition).max(8).optional(),
    input: z.object({ schema: JsonSchemaDocument }).strict(),
    output: z.object({ schema: JsonSchemaDocument }).strict(),
    limits: z
      .object({
        maxDurationSeconds: z.number().int().min(10).max(3600),
        maxInferenceTokens: z.number().int().min(1000).max(5_000_000),
      })
      .strict(),
    retry: z
      .object({
        /** Only read-only workloads may be retried automatically after an uncertain outcome. */
        safeToRetry: z.boolean(),
        maxAttempts: z.number().int().min(1).max(5),
      })
      .strict(),
    runners: z
      .object({
        allowedProfiles: z.array(z.string().regex(SLUG)).min(1),
        defaultProfile: z.string().regex(SLUG),
      })
      .strict()
      .refine((r) => r.allowedProfiles.includes(r.defaultProfile), {
        message: "defaultProfile must be one of allowedProfiles",
      }),
  })
  .strict()
  .superRefine((h, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (!h.model.allowed.includes(h.model.preferred)) {
      issue(["model", "preferred"], "model.preferred must be one of model.allowed");
    }
    const toolNames = new Set<string>();
    h.tools.forEach((tool, index) => {
      if (toolNames.has(tool.name)) issue(["tools", index, "name"], `Duplicate tool name '${tool.name}'.`);
      toolNames.add(tool.name);
    });
    const skillNames = new Set<string>();
    h.skills?.forEach((skill, index) => {
      if (skillNames.has(skill.name)) issue(["skills", index, "name"], `Duplicate skill '${skill.name}'.`);
      skillNames.add(skill.name);
    });
    const agentNames = new Set<string>();
    h.agents?.forEach((agent, index) => {
      if (agentNames.has(agent.name)) issue(["agents", index, "name"], `Duplicate agent '${agent.name}'.`);
      agentNames.add(agent.name);
      agent.tools.forEach((tool, toolIndex) => {
        if (!toolNames.has(tool)) issue(["agents", index, "tools", toolIndex], `Agent tool '${tool}' is not a harness tool.`);
      });
      agent.skills?.forEach((skill, skillIndex) => {
        if (!skillNames.has(skill)) issue(["agents", index, "skills", skillIndex], `Agent skill '${skill}' is not a harness skill.`);
      });
      if (agent.model && !h.model.allowed.includes(agent.model)) {
        issue(["agents", index, "model"], "An agent model must be one of the harness's allowed models.");
      }
    });
    const delegated = h.tools.filter((t) => t.delegatedOnly);
    if (new Set(h.builtinTools ?? []).size !== (h.builtinTools ?? []).length) {
      issue(["builtinTools"], "Each built-in tool group can be listed once.");
    }
    if (delegated.length > 0 && !h.agents?.length) {
      issue(["tools"], "Delegated-only tools need at least one sub-agent that uses them.");
    }
    for (const tool of delegated) {
      if (!h.agents?.some((a) => a.tools.includes(tool.name))) {
        issue(["tools", h.tools.indexOf(tool), "delegatedOnly"], `No sub-agent can call delegated-only tool '${tool.name}'.`);
      }
    }
  });
export type HarnessDefinition = z.infer<typeof HarnessDefinition>;

/** A published, immutable harness version with its content digest. */
export interface HarnessSnapshot {
  definition: HarnessDefinition;
  digest: string;
}

/** Runner capabilities a harness needs beyond the protocol baseline (cancel, structured-result). */
export function requiredRunnerCapabilities(definition: HarnessDefinition): RunnerFeature[] {
  const features: RunnerFeature[] = [];
  if (definition.prompt && definition.prompt.mode !== "replace") features.push("prompt-sections");
  if (definition.model.reasoningEffort || definition.model.contextTier) features.push("model-options");
  if (definition.agents?.length) features.push("custom-agents");
  if (definition.skills?.length) features.push("skills");
  if (definition.builtinTools?.length) features.push("builtin-tools");
  if (isInteractive(definition.permissions)) features.push("interactive");
  return features;
}

export const RUNNER_FEATURES = ["prompt-sections", "model-options", "custom-agents", "skills", "builtin-tools", "interactive"] as const;
export type RunnerFeature = (typeof RUNNER_FEATURES)[number];
