import type { CustomAgentConfig, SessionConfig, SkillProvider } from "@github/copilot-sdk";
import { renderSkillMarkdown, type HarnessDefinition } from "@copilot-agent/contracts";

/**
 * Built-in SDK agents. Shared placement never offers them: they rely on built-in file and shell tools that are not
 * qualified over `sessionFs`. The harness's own sub-agents run in the same runtime.
 */
export const BUILTIN_AGENTS = [
  "explore", "task", "general-purpose", "code-review", "research", "rubber-duck", "security-review", "rem-agent",
];

/** The harness-derived SDK session settings for shared placement, apart from tools, provider, and callbacks. */
export interface SharedSessionSettings {
  systemMessage: NonNullable<SessionConfig["systemMessage"]>;
  reasoningEffort?: SessionConfig["reasoningEffort"];
  contextTier?: SessionConfig["contextTier"];
  customAgents?: CustomAgentConfig[];
  defaultAgent?: SessionConfig["defaultAgent"];
  excludedBuiltinAgents: string[];
  enableSkills?: boolean;
  skillProvider?: SkillProvider;
  /** Built-in runtime tools the session may use, by bare name; application tools are added separately. */
  builtinTools: string[];
}

/**
 * Maps a harness to shared-placement session settings. Instructions, prompt mode, model options, skills, and
 * sub-agents follow `buildSessionOptions(definition, ..., "conversation")` in harness-hosting; the differences are
 * deliberate: skills come from a provider instead of files, and the built-in tool groups map to application tools.
 */
export function sharedSessionSettings(definition: HarnessDefinition): SharedSessionSettings {
  const content = definition.instructions;
  const prompt = definition.prompt ?? { mode: "replace" as const };
  const systemMessage: SharedSessionSettings["systemMessage"] = prompt.mode === "customize"
    ? {
        mode: "customize",
        content,
        sections: Object.fromEntries((prompt.sections ?? []).map((section) => [
          section.name,
          section.action === "remove" ? { action: "remove" as const } : { action: section.action, content: section.content },
        ])),
      }
    : { mode: prompt.mode, content };
  const agents = definition.agents ?? [];
  const skills = definition.skills ?? [];
  const builtinTools: string[] = [];
  if (agents.length > 0) builtinTools.push("task");
  if (definition.builtinTools?.includes("agents")) builtinTools.push("task", "read_agent", "list_agents", "write_agent");
  if (skills.length > 0) builtinTools.push("skill");
  if (definition.permissions?.questions === true) builtinTools.push("ask_user");
  const settings: SharedSessionSettings = {
    systemMessage,
    excludedBuiltinAgents: [...BUILTIN_AGENTS],
    builtinTools: [...new Set(builtinTools)],
  };
  if (definition.model.reasoningEffort) settings.reasoningEffort = definition.model.reasoningEffort;
  if (definition.model.contextTier) settings.contextTier = definition.model.contextTier;
  if (agents.length > 0) {
    settings.customAgents = agents.map((agent) => ({
      name: agent.name,
      displayName: agent.displayName ?? agent.name,
      description: agent.description,
      prompt: agent.instructions,
      tools: [...agent.tools],
      infer: true,
      ...(agent.skills?.length ? { skills: [...agent.skills] } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    }));
    const delegated = definition.tools.filter((tool) => tool.delegatedOnly).map((tool) => tool.name);
    if (delegated.length > 0) settings.defaultAgent = { excludedTools: delegated };
  }
  if (skills.length > 0) {
    settings.enableSkills = true;
    settings.skillProvider = {
      listSkills: () => skills.map((skill) => ({ name: skill.name, description: skill.description })),
      readSkill: (name) => {
        const skill = skills.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
        return skill ? renderSkillMarkdown(skill) : undefined;
      },
    };
  }
  return settings;
}
