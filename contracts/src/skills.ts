import type { SkillDefinition } from "./harness.js";

/**
 * SKILL.md format: YAML-style frontmatter with `name` and `description`, followed by the
 * Markdown body. Only single-line scalar values are supported; that is all the SDK reads.
 */
export function parseSkillMarkdown(text: string): { name?: string; description?: string; content: string } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    return { content: normalized.trim() };
  }
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = unquote(pair[2]!.trim());
  }
  return { name: fields.name, description: fields.description, content: normalized.slice(match[0].length).trim() };
}

export function renderSkillMarkdown(skill: SkillDefinition): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.trim()}\n`;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
