import { z } from "zod";

export const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,62}$/;
/** A tool name on a remote MCP server: 1-128 ASCII letters, digits, underscores, hyphens, or dots. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

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

/**
 * deny: refuse; allow: approve automatically; ask: follow the Copilot CLI's interactive defaults
 * (workspace reads, read-only commands and read-only MCP tools run) and route everything else to a person.
 */
export const PermissionMode = z.enum(["deny", "ask", "allow"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * What happens to a permission request that the per-kind rules would route to a person (`ask`). Per-kind `deny`
 * and `allow` rules still apply first.
 * - manual (default): a person decides.
 * - assisted: the Copilot runtime's safety judge approves the request or sends it to a person. The judge is
 *   probabilistic guidance, not a security boundary.
 * - allow-all: the request is approved automatically.
 * - custom: an integrator-registered permission handler, selected by name, decides.
 * Batch harnesses support manual only; the other modes apply to conversation harnesses.
 */
export const APPROVAL_MODES = ["manual", "assisted", "allow-all", "custom"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "manual";

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
    /** Who decides requests that would otherwise prompt a person. Omitted means manual. */
    approvalMode: z.enum(APPROVAL_MODES).optional(),
    /** Model for the assisted judge; one of the harness's allowed models. Omitted means the session's model. */
    judgeModel: z.string().min(1).max(200).optional(),
    /** The registered permission handler for the custom approval mode. */
    handler: z.string().regex(SLUG).optional(),
  })
  .strict()
  .superRefine((permissions, ctx) => {
    if (permissions.judgeModel !== undefined && permissions.approvalMode !== "assisted") {
      ctx.addIssue({ code: "custom", path: ["judgeModel"], message: "A judge model applies only to the assisted approval mode." });
    }
    if (permissions.approvalMode === "custom" && permissions.handler === undefined) {
      ctx.addIssue({ code: "custom", path: ["handler"], message: "The custom approval mode needs a registered permission handler." });
    }
    if (permissions.handler !== undefined && permissions.approvalMode !== "custom") {
      ctx.addIssue({ code: "custom", path: ["handler"], message: "A permission handler applies only to the custom approval mode." });
    }
  });
export type PermissionsConfig = z.infer<typeof PermissionsConfig>;

export const DEFAULT_INPUT_TIMEOUT_SECONDS = 600;

/** The approval mode that applies to a harness's permission requests. */
export function approvalModeOf(permissions: Pick<PermissionsConfig, "approvalMode"> | undefined): ApprovalMode {
  return permissions?.approvalMode ?? DEFAULT_APPROVAL_MODE;
}

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

/** A remote MCP server from the operator's catalog, with the tools this harness requests from it. */
export const HarnessMcpServer = z
  .object({
    /** Server name in the operator policy's `mcpServers` catalog. The harness never sees its URL or credential. */
    server: z.string().regex(SLUG),
    tools: z.array(z.string().regex(MCP_TOOL_NAME)).min(1).max(64),
  })
  .strict();
export type HarnessMcpServer = z.infer<typeof HarnessMcpServer>;

/**
 * Where a conversation harness's agent loop runs (docs/HOSTING-MODES-PLAN.md, section 2). A harness without a
 * `hosting` block is `isolated`.
 * - isolated: entirely inside a dedicated Linux container.
 * - shared: on a shared in-process runtime with virtual files; no shell, Python, or local MCP tools.
 * - promotable: starts shared and can move one way into a dedicated container.
 * - orchestrator: a shared coordinator that runs worker harnesses in containers.
 */
export const HOSTING_MODES = ["isolated", "shared", "promotable", "orchestrator"] as const;
export type HostingMode = (typeof HOSTING_MODES)[number];
export const DEFAULT_HOSTING_MODE: HostingMode = "isolated";

/** Whether a model-initiated promotion or handoff needs a person (`ask`) or runs automatically (`allow`). */
export const HOSTING_APPROVALS = ["ask", "allow"] as const;
export type HostingApproval = (typeof HOSTING_APPROVALS)[number];
export const DEFAULT_HOSTING_APPROVAL: HostingApproval = "ask";

/** History a handoff target receives. */
export const HANDOFF_HISTORY = ["full", "summary", "none"] as const;
export type HandoffHistory = (typeof HANDOFF_HISTORY)[number];

/** Promotion settings for `promotable` harnesses. */
export const HostingPromotion = z
  .object({
    /** Container size after promotion, from the operator's catalog. Omitted means the catalog's default size. */
    size: z.string().regex(SLUG).optional(),
    /** Whether a model-initiated promotion needs a person. Omitted means `ask`. */
    approval: z.enum(HOSTING_APPROVALS).optional(),
  })
  .strict();
export type HostingPromotion = z.infer<typeof HostingPromotion>;

/** Container workers an `orchestrator` coordinator may start. */
export const HostingWorkers = z
  .object({
    /** Published conversation harnesses with isolated hosting that may run as workers. */
    harnesses: z.array(z.string().regex(SLUG)).max(16),
    /** Requested subset of the operator's sizes. Omitted means the catalog's default size only. */
    sizes: z.array(z.string().regex(SLUG)).min(1).max(8).optional(),
    /** Concurrent workers per session; capped by policy. */
    maxConcurrent: z.number().int().min(1).max(32).optional(),
    /** Workers created over one session's lifetime; capped by policy. */
    maxPerSession: z.number().int().min(1).max(256).optional(),
    /** `session` gives the session's workers one shared volume. Omitted means `none`. */
    sharedStorage: z.enum(["none", "session"]).optional(),
    /**
     * `inherit` lets workers' assisted judges use this session's recorded human messages as authority, within a
     * policy ceiling. Omitted means `none`.
     */
    humanAuthority: z.enum(["none", "inherit"]).optional(),
    /** An operator crafting template; omitted means the coordinator cannot craft worker harnesses. */
    crafting: z.object({ template: z.string().regex(SLUG) }).strict().optional(),
  })
  .strict();
export type HostingWorkers = z.infer<typeof HostingWorkers>;

/** A predefined handoff target. */
export const HostingHandoff = z
  .object({
    /** A published conversation harness. */
    harness: z.string().regex(SLUG),
    /** Shown to the model as the transfer tool's description. */
    description: z.string().min(1).max(1000),
    /** Omitted means `summary` across placements and `full` within one placement. */
    history: z.enum(HANDOFF_HISTORY).optional(),
    /** Omitted means `ask`. */
    approval: z.enum(HOSTING_APPROVALS).optional(),
  })
  .strict();
export type HostingHandoff = z.infer<typeof HostingHandoff>;

/** Per-harness hosting request. Operator policy decides which modes and settings are allowed. */
export const HostingConfig = z
  .object({
    mode: z.enum(HOSTING_MODES),
    promotion: HostingPromotion.optional(),
    workers: HostingWorkers.optional(),
    handoffs: z.array(HostingHandoff).max(8).optional(),
  })
  .strict();
export type HostingConfig = z.infer<typeof HostingConfig>;

/** The hosting mode a harness requests; harnesses without a `hosting` block are isolated. */
export function hostingModeOf(definition: { hosting?: Pick<HostingConfig, "mode"> }): HostingMode {
  return definition.hosting?.mode ?? DEFAULT_HOSTING_MODE;
}

/** True for modes whose agent loop never leaves the shared worker, where shell, Python, and local MCP tools cannot run. */
export function runsOnSharedWorker(mode: HostingMode): boolean {
  return mode === "shared" || mode === "orchestrator";
}

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
    /** Explicit opt-in to the hosted conversation path; not a batch result contract. */
    interaction: z.literal("conversation").optional(),
    /** Where a conversation harness's agent loop runs. Omitted means isolated; batch harnesses cannot set it. */
    hosting: HostingConfig.optional(),
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
    /** Remote MCP servers and tools from the operator's catalog. Conversation harnesses only. */
    mcpServers: z.array(HarnessMcpServer).max(16).optional(),
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
    hostingIssues(h, issue);
  });
export type HarnessDefinition = z.infer<typeof HarnessDefinition>;

/**
 * Hosting, remote MCP, and approval-mode rules that depend only on the harness itself (docs/HOSTING-MODES-PLAN.md,
 * section 3). Rules that depend on operator policy, execution profiles, other harnesses, or the deployment live in
 * profile.ts and hosting.ts.
 */
function hostingIssues(
  h: {
    name: string;
    interaction?: "conversation";
    hosting?: HostingConfig;
    mcpServers?: HarnessMcpServer[];
    permissions?: PermissionsConfig;
    model: { allowed: string[] };
    builtinTools?: BuiltinToolGroup[];
    tools: ToolRequest[];
  },
  issue: (path: (string | number)[], message: string) => void,
): void {
  const permissions = h.permissions;
  if (permissions?.judgeModel !== undefined && !h.model.allowed.includes(permissions.judgeModel)) {
    issue(["permissions", "judgeModel"], "The judge model must be one of the harness's allowed models.");
  }
  const servers = new Set<string>();
  h.mcpServers?.forEach((entry, index) => {
    if (servers.has(entry.server)) issue(["mcpServers", index, "server"], `MCP server '${entry.server}' is listed more than once.`);
    servers.add(entry.server);
    entry.tools.forEach((tool, toolIndex) => {
      if (entry.tools.indexOf(tool) !== toolIndex) issue(["mcpServers", index, "tools", toolIndex], `Tool '${tool}' is listed more than once.`);
    });
  });

  // Batch runners do not implement these features in both languages, so batch harnesses cannot request them.
  if (h.interaction !== "conversation") {
    if (h.hosting !== undefined) {
      issue(["hosting"], "Hosting applies only to conversation harnesses; batch harnesses run as jobs on the executor.");
    }
    if (h.mcpServers !== undefined) issue(["mcpServers"], "Remote MCP servers are available only to conversation harnesses.");
    if (approvalModeOf(permissions) !== DEFAULT_APPROVAL_MODE) {
      issue(["permissions", "approvalMode"], "Batch harnesses use the manual approval mode; other approval modes need a conversation harness.");
    }
    return;
  }

  const hosting = h.hosting;
  const mode = hostingModeOf(h);
  if (hosting?.promotion && mode !== "promotable") {
    issue(["hosting", "promotion"], "Promotion settings apply only to promotable harnesses.");
  }
  if (hosting?.workers && mode !== "orchestrator") {
    issue(["hosting", "workers"], "Worker settings apply only to orchestrator harnesses.");
  }
  if (mode === "orchestrator" && !hosting?.workers) {
    issue(["hosting", "workers"], "An orchestrator harness needs workers: list worker harnesses or a crafting template.");
  }
  const workers = hosting?.workers;
  if (workers) {
    if (workers.harnesses.length === 0 && !workers.crafting) {
      issue(["hosting", "workers", "harnesses"], "List at least one worker harness or set a crafting template.");
    }
    workers.harnesses.forEach((name, index) => {
      if (name === h.name) issue(["hosting", "workers", "harnesses", index], "A harness cannot be its own worker.");
      else if (workers.harnesses.indexOf(name) !== index) issue(["hosting", "workers", "harnesses", index], `Worker harness '${name}' is listed more than once.`);
    });
    workers.sizes?.forEach((size, index) => {
      if (workers.sizes!.indexOf(size) !== index) issue(["hosting", "workers", "sizes", index], `Size '${size}' is listed more than once.`);
    });
    if (workers.maxConcurrent !== undefined && workers.maxPerSession !== undefined && workers.maxConcurrent > workers.maxPerSession) {
      issue(["hosting", "workers", "maxConcurrent"], "maxConcurrent cannot exceed maxPerSession.");
    }
  }
  hosting?.handoffs?.forEach((handoff, index) => {
    if (handoff.harness === h.name) issue(["hosting", "handoffs", index, "harness"], "A harness cannot hand off to itself.");
    else if (hosting.handoffs!.findIndex((other) => other.harness === handoff.harness) !== index) {
      issue(["hosting", "handoffs", index, "harness"], `Handoff target '${handoff.harness}' is listed more than once.`);
    }
  });

  // A shared worker has no shell, real filesystem, or process isolation. Promotable harnesses activate these tools
  // only after promotion; orchestrators reach them through workers.
  if (runsOnSharedWorker(mode)) {
    const instead = "use isolated or promotable hosting, or an orchestrator worker";
    h.builtinTools?.forEach((group, index) => {
      if (group === "shell") issue(["builtinTools", index], `Shared placement cannot run shell commands; ${instead}.`);
    });
    h.tools.forEach((tool, index) => {
      if (tool.kind === "python") issue(["tools", index, "kind"], `Shared placement cannot run Python tools; ${instead}.`);
      if (tool.kind === "mcp-local") issue(["tools", index, "kind"], `Shared placement cannot run local (stdio) MCP tools; ${instead}.`);
    });
  }
}

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
