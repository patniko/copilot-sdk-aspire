import {
  CONVERSATION_PROFILE, HarnessDefinition, type AgentDefinition, type BuiltinToolGroup, type HarnessMcpServer, type HostingConfig,
  type PermissionsConfig, type PromptConfig, type ReasoningEffort, type SkillDefinition, type ToolRequest,
} from "@copilot-agent/contracts";

/** The model an agent runs with: one model, or a preferred model and the others it may fall back to. */
export type AgentModel = string | { preferred: string; allowed?: string[]; reasoningEffort?: ReasoningEffort };

/** A conversation agent defined in code. Everything not listed gets conversation defaults. */
export interface AgentSpec {
  /** Lowercase slug, for example `release-notes-writer`. Must not be the name of a published harness. */
  name: string;
  description?: string;
  /** The agent's instructions (system prompt), inline. */
  instructions: string;
  model: AgentModel;
  /** Where the agent loop runs. `shared` by default: no container, but no shell, Python, or local MCP tools. */
  hosting?: "shared" | "isolated" | "promotable" | HostingConfig;
  version?: string;
  prompt?: PromptConfig;
  builtinTools?: BuiltinToolGroup[];
  tools?: ToolRequest[];
  mcpServers?: HarnessMcpServer[];
  permissions?: PermissionsConfig;
  skills?: SkillDefinition[];
  agents?: AgentDefinition[];
  limits?: { maxDurationSeconds?: number; maxInferenceTokens?: number };
}

/** Conversation defaults, matching the published conversation examples. */
export const AGENT_DEFAULTS = Object.freeze({
  version: "0.1.0",
  limits: { maxDurationSeconds: 300, maxInferenceTokens: 200_000 },
});

/** A definition that does not pass the harness schema; `issues` lists each problem by path. */
export class AgentDefinitionError extends Error {
  constructor(readonly issues: Array<{ path: string; message: string }>) {
    super(`Invalid agent definition:\n${issues.map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`).join("\n")}`);
    this.name = "AgentDefinitionError";
  }
}

/**
 * Turns an agent spec into a validated conversation `HarnessDefinition`, the same document a published harness is.
 * Mistakes the schema can see fail here, before anything is sent; operator policy is still applied by the service.
 */
export function defineAgent(spec: AgentSpec): HarnessDefinition {
  const model = typeof spec.model === "string" ? { preferred: spec.model } : spec.model;
  const hosting: HostingConfig = typeof spec.hosting === "object" ? spec.hosting : { mode: spec.hosting ?? "shared" };
  const candidate = {
    schemaVersion: "1",
    name: spec.name,
    version: spec.version ?? AGENT_DEFAULTS.version,
    description: spec.description ?? `${spec.name}, defined in code.`,
    interaction: "conversation",
    hosting,
    instructions: spec.instructions,
    ...(spec.prompt ? { prompt: spec.prompt } : {}),
    model: {
      preferred: model.preferred,
      allowed: model.allowed?.length ? [...new Set([model.preferred, ...model.allowed])] : [model.preferred],
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    },
    tools: spec.tools ?? [],
    ...(spec.builtinTools ? { builtinTools: spec.builtinTools } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {}),
    ...(spec.skills ? { skills: spec.skills } : {}),
    ...(spec.agents ? { agents: spec.agents } : {}),
    input: { schema: { type: "object", additionalProperties: false } },
    output: { schema: { type: "object" } },
    limits: { ...AGENT_DEFAULTS.limits, ...spec.limits },
    // Conversations are interactive; a turn is never replayed automatically.
    retry: { safeToRetry: false, maxAttempts: 1 },
    runners: { allowedProfiles: [CONVERSATION_PROFILE], defaultProfile: CONVERSATION_PROFILE },
  };
  const parsed = HarnessDefinition.safeParse(candidate);
  if (!parsed.success) {
    throw new AgentDefinitionError(parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  }
  return parsed.data;
}
