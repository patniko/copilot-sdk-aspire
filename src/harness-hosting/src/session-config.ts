import type { HarnessDefinition } from "@copilot-agent/contracts";
import type { SessionConfig } from "@github/copilot-sdk";

export const RESULT_CONTRACT = `

## Result contract
When you have finished, call the \`submit_result\` tool exactly once with the complete final result.
The arguments must satisfy the tool's JSON schema. Do not put the final result in a chat message.`;

/**
 * Built-in SDK agents. The task tool could otherwise launch them, and some carry shell or file
 * tools the harness never requested. Only the harness's own sub-agents are reachable.
 */
export const BUILTIN_AGENTS = [
  "explore",
  "task",
  "general-purpose",
  "code-review",
  "research",
  "rubber-duck",
  "security-review",
  "rem-agent",
];

const BUILTIN_TOOL_GROUPS: Record<NonNullable<HarnessDefinition["builtinTools"]>[number], string[]> = {
  files: ["view", "glob", "grep", "create", "edit", "apply_patch"],
  shell: [
    "bash",
    "read_bash",
    "write_bash",
    "stop_bash",
    "list_bash",
    "powershell",
    "read_powershell",
    "write_powershell",
    "stop_powershell",
    "list_powershell",
  ],
  web: ["web_fetch"],
  agents: ["task", "read_agent", "list_agents", "write_agent"],
};

export type HarnessSessionOptions = Pick<
  SessionConfig,
  | "systemMessage"
  | "availableTools"
  | "reasoningEffort"
  | "contextTier"
  | "customAgents"
  | "defaultAgent"
  | "excludedBuiltinAgents"
  | "enableSkills"
  | "skillDirectories"
>;

/**
 * Maps a harness definition to Copilot SDK session options. `customToolNames` are the bound
 * harness tools plus submit_result; `skillsDirectory` holds the materialized SKILL.md folders.
 */
export function buildSessionOptions(
  definition: HarnessDefinition,
  customToolNames: string[],
  skillsDirectory: string,
  interaction: "job" | "conversation" = "job",
): HarnessSessionOptions {
  const content = definition.instructions + (interaction === "job" ? RESULT_CONTRACT : "");
  const prompt = definition.prompt ?? { mode: "replace" as const };
  const systemMessage: HarnessSessionOptions["systemMessage"] =
    prompt.mode === "customize"
      ? {
          mode: "customize",
          content,
          sections: Object.fromEntries(
            (prompt.sections ?? []).map((s) => [
              s.name,
              s.action === "remove" ? { action: "remove" as const } : { action: s.action, content: s.content },
            ]),
          ),
        }
      : { mode: prompt.mode, content };

  const agents = definition.agents ?? [];
  const skills = definition.skills ?? [];
  const availableTools = customToolNames.map((name) => `custom:${name}`);
  for (const group of definition.builtinTools ?? []) {
    availableTools.push(...BUILTIN_TOOL_GROUPS[group].map((name) => `builtin:${name}`));
  }
  if (agents.length > 0) availableTools.push("builtin:task");
  if (skills.length > 0) availableTools.push("builtin:skill");
  if (definition.permissions?.questions === true) availableTools.push("builtin:ask_user");

  const options: HarnessSessionOptions = {
    systemMessage,
    availableTools: [...new Set(availableTools)],
    excludedBuiltinAgents: definition.builtinTools?.includes("agents") ? [] : [...BUILTIN_AGENTS],
  };
  if (definition.model.reasoningEffort) options.reasoningEffort = definition.model.reasoningEffort;
  if (definition.model.contextTier) options.contextTier = definition.model.contextTier;
  if (agents.length > 0) {
    options.customAgents = agents.map((agent) => ({
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
    const delegated = definition.tools.filter((t) => t.delegatedOnly).map((t) => t.name);
    if (delegated.length > 0) options.defaultAgent = { excludedTools: delegated };
  }
  if (skills.length > 0) {
    options.enableSkills = true;
    options.skillDirectories = [skillsDirectory];
  }
  return options;
}
