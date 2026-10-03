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
): HarnessSessionOptions {
  const content = definition.instructions + RESULT_CONTRACT;
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
  if (agents.length > 0) availableTools.push("builtin:task");
  if (skills.length > 0) availableTools.push("builtin:skill");

  const options: HarnessSessionOptions = { systemMessage, availableTools, excludedBuiltinAgents: [...BUILTIN_AGENTS] };
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
