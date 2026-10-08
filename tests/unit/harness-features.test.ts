import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HarnessDefinition,
  modelOptionViolations,
  parseSkillMarkdown,
  renderSkillMarkdown,
  requiredRunnerCapabilities,
  RunnerEventBody,
  type ExecutionPolicy,
  type ExecutionProfile,
  type HarnessSnapshot,
} from "@copilot-agent/contracts";
import { canonicalJson, HttpError, loadHarnesses, loadPolicy, loadProfiles, sha256Hex } from "@copilot-agent/service-defaults";
import { Admission } from "../../src/agent-api/src/admission.js";
import { BUILTIN_AGENTS, buildSessionOptions, RESULT_CONTRACT } from "../../src/harness-hosting/src/session-config.js";

const root = join(import.meta.dirname, "..", "..");
const customerConfigRoot = join(root, "examples", "customer-config");
let harnesses: Map<string, HarnessSnapshot[]>;
let profiles: Map<string, ExecutionProfile>;
let policy: ExecutionPolicy;

beforeAll(async () => {
  [harnesses, profiles, policy] = await Promise.all([
    loadHarnesses(customerConfigRoot),
    loadProfiles(root),
    loadPolicy(customerConfigRoot),
  ]);
});

const team = () => harnesses.get("insights-team")![0]!.definition;

function withChanges(change: (d: Record<string, any>) => void): ReturnType<typeof HarnessDefinition.safeParse> {
  const copy = structuredClone(team()) as Record<string, any>;
  change(copy);
  return HarnessDefinition.safeParse(copy);
}

const messages = (result: ReturnType<typeof HarnessDefinition.safeParse>) =>
  result.success ? [] : result.error.issues.map((i) => i.message);

describe("harness features contract", () => {
  it("loads the showcase harness with its skill inlined", () => {
    const definition = team();
    expect(definition.prompt?.mode).toBe("customize");
    expect(definition.agents?.map((a) => a.name)).toEqual(["statistician", "reviewer"]);
    expect(definition.skills?.[0]?.name).toBe("insight-review");
    expect(definition.skills?.[0]?.content).toMatch(/^# Insight review checklist/);
    expect(definition.skills?.[0]?.content).not.toContain("---");
    expect(requiredRunnerCapabilities(definition)).toEqual(["prompt-sections", "model-options", "custom-agents", "skills"]);
  });

  it("keeps existing harnesses free of new fields so their digests do not change", async () => {
    const definition = harnesses.get("dataset-analyst")![0]!.definition;
    expect(Object.keys(definition)).not.toContain("skills");
    expect(Object.keys(definition)).not.toContain("prompt");
    expect(requiredRunnerCapabilities(definition)).toEqual([]);
    const manifest = JSON.parse(await readFile(join(customerConfigRoot, "harnesses", "dataset-analyst", "harness.json"), "utf8"));
    const { instructionsFile, ...rest } = manifest;
    const instructions = await readFile(join(customerConfigRoot, "harnesses", "dataset-analyst", instructionsFile), "utf8");
    expect(harnesses.get("dataset-analyst")![0]!.digest).toBe(`sha256:${sha256Hex(canonicalJson({ ...rest, instructions }))}`);
  });

  it("rejects sub-agent tools and skills the harness does not declare", () => {
    expect(messages(withChanges((d) => d.agents[0].tools.push("rm_rf")))).toContain("Agent tool 'rm_rf' is not a harness tool.");
    expect(messages(withChanges((d) => (d.agents[1].skills = ["nope"])))).toContain("Agent skill 'nope' is not a harness skill.");
  });

  it("requires a sub-agent for every delegated-only tool", () => {
    expect(messages(withChanges((d) => (d.agents[0].tools = [])))).toContain(
      "No sub-agent can call delegated-only tool 'compute_statistics'.",
    );
    expect(messages(withChanges((d) => delete d.agents))).toContain("Delegated-only tools need at least one sub-agent that uses them.");
  });

  it("validates prompt sections", () => {
    expect(messages(withChanges((d) => (d.prompt.mode = "append")))).toContain("Sections apply only in customize mode.");
    expect(messages(withChanges((d) => d.prompt.sections.push({ name: "tone", action: "append", content: "x" })))).toContain(
      "Each section can be changed once.",
    );
    expect(messages(withChanges((d) => (d.prompt.sections[0].content = " ")))).toContain("Add content, or use the remove action.");
    expect(withChanges((d) => (d.prompt.sections[0].name = "not_a_section")).success).toBe(false);
  });

  it("rejects duplicate tool, skill and agent names", () => {
    expect(messages(withChanges((d) => d.agents.push({ ...d.agents[0] })))).toContain("Duplicate agent 'statistician'.");
    expect(messages(withChanges((d) => d.tools.push({ ...d.tools[0] })))).toContain("Duplicate tool name 'compute_statistics'.");
  });

  it("checks model options against policy caps", () => {
    const definition = { model: { reasoningEffort: "xhigh", contextTier: "long_context" }, agents: [{ name: "a", reasoningEffort: "high" }] };
    expect(modelOptionViolations(definition, { maxReasoningEffort: "medium" }).map((p) => p.path)).toEqual([
      "model.reasoningEffort",
      "agents.0.reasoningEffort",
      "model.contextTier",
    ]);
    expect(modelOptionViolations(definition, { allowLongContext: true })).toEqual([]);
  });

  it("allows the new runner events", () => {
    expect(RunnerEventBody.safeParse({ kind: "subagent.started", agent: "statistician" }).success).toBe(true);
    expect(RunnerEventBody.safeParse({ kind: "subagent.completed", agent: "reviewer", ok: false }).success).toBe(true);
    expect(RunnerEventBody.safeParse({ kind: "skill.used", skill: "insight-review" }).success).toBe(true);
    expect(RunnerEventBody.safeParse({ kind: "skill.used", skill: "x", content: "leak" }).success).toBe(false);
    expect(
      RunnerEventBody.safeParse({
        kind: "tool.started",
        tool: "bash",
        detail: { eventType: "tool.execution_start", data: { arguments: { command: "echo ok" } } },
      }).success,
    ).toBe(true);
  });
});

describe("SKILL.md format", () => {
  it("round-trips name, description and body", () => {
    const skill = { name: "csv-hygiene", description: 'Cleans "dirty" columns: nulls, text', content: "# Steps\n\n1. Drop nulls." };
    const parsed = parseSkillMarkdown(renderSkillMarkdown(skill));
    expect(parsed).toEqual(skill);
  });

  it("accepts CRLF files, single quotes and files without frontmatter", () => {
    expect(parseSkillMarkdown("---\r\nname: a-b\r\ndescription: 'It''s fine'\r\n---\r\nBody\r\n")).toEqual({
      name: "a-b",
      description: "It's fine",
      content: "Body",
    });
    expect(parseSkillMarkdown("Just text")).toEqual({ content: "Just text" });
  });
});

describe("skill loading", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "skills-"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  async function writeHarness(skillText: string | undefined, skills: unknown = ["s-one"]) {
    const harnessDir = join(dir, "harnesses", "h");
    await rm(join(dir, "harnesses"), { recursive: true, force: true });
    await mkdir(join(harnessDir, "skills", "s-one"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(customerConfigRoot, "harnesses", "text-summarizer", "harness.json"), "utf8"));
    await writeFile(join(harnessDir, "harness.json"), JSON.stringify({ ...manifest, skills }));
    await writeFile(join(harnessDir, manifest.instructionsFile), "Summarize.");
    if (skillText !== undefined) await writeFile(join(harnessDir, "skills", "s-one", "SKILL.md"), skillText);
  }

  it("rejects missing files, mismatched names and missing descriptions", async () => {
    await writeHarness(undefined);
    await expect(loadHarnesses(dir)).rejects.toThrow(/missing skills\/s-one\/SKILL.md/);
    await writeHarness("---\nname: other\ndescription: d\n---\nx");
    await expect(loadHarnesses(dir)).rejects.toThrow(/different name/);
    await writeHarness("---\nname: s-one\n---\nx");
    await expect(loadHarnesses(dir)).rejects.toThrow(/needs a description/);
    await writeHarness("x", ["../escape"]);
    await expect(loadHarnesses(dir)).rejects.toThrow(/list of skill folder names/);
  });
});

describe("session options", () => {
  it("defaults to a replace-mode prompt with no delegation or skills", () => {
    const options = buildSessionOptions(harnesses.get("dataset-analyst")![0]!.definition, ["compute_statistics", "submit_result"], "/w/skills");
    expect(options.systemMessage).toEqual({ mode: "replace", content: expect.stringContaining(RESULT_CONTRACT.trim()) });
    expect(options.availableTools).toEqual(["custom:compute_statistics", "custom:submit_result"]);
    expect(options.excludedBuiltinAgents).toEqual(BUILTIN_AGENTS);
    expect(options.customAgents).toBeUndefined();
    expect(options.enableSkills).toBeUndefined();
    expect(options.reasoningEffort).toBeUndefined();
  });

  it("maps customize sections, sub-agents, delegated tools and skills", () => {
    const options = buildSessionOptions(team(), ["compute_statistics", "submit_result"], "/w/skills");
    expect(options.systemMessage).toMatchObject({
      mode: "customize",
      sections: {
        identity: { action: "replace", content: expect.stringContaining("lead analyst") },
        code_change_rules: { action: "remove" },
      },
    });
    expect((options.systemMessage as { content: string }).content).toContain("Result contract");
    expect(options.availableTools).toEqual(["custom:compute_statistics", "custom:submit_result", "builtin:task", "builtin:skill"]);
    expect(options.defaultAgent).toEqual({ excludedTools: ["compute_statistics"] });
    expect(options.customAgents).toEqual([
      expect.objectContaining({ name: "statistician", displayName: "Statistician", tools: ["compute_statistics"], infer: true }),
      expect.objectContaining({ name: "reviewer", tools: [], skills: ["insight-review"] }),
    ]);
    expect(options.reasoningEffort).toBe("medium");
    expect(options.enableSkills).toBe(true);
    expect(options.skillDirectories).toEqual(["/w/skills"]);
  });

  it("maps built-in tool groups without changing existing harness defaults", () => {
    const definition = structuredClone(harnesses.get("dataset-analyst")![0]!.definition);
    definition.builtinTools = ["files", "shell", "web"];
    definition.permissions = { default: "deny", questions: true };
    const options = buildSessionOptions(definition, ["compute_statistics", "submit_result"], "/w/skills");
    expect(options.availableTools).toEqual([
      "custom:compute_statistics",
      "custom:submit_result",
      "builtin:view",
      "builtin:glob",
      "builtin:grep",
      "builtin:create",
      "builtin:edit",
      "builtin:apply_patch",
      "builtin:bash",
      "builtin:read_bash",
      "builtin:write_bash",
      "builtin:stop_bash",
      "builtin:list_bash",
      "builtin:powershell",
      "builtin:read_powershell",
      "builtin:write_powershell",
      "builtin:stop_powershell",
      "builtin:list_powershell",
      "builtin:web_fetch",
      "builtin:ask_user",
    ]);
    expect(options.excludedBuiltinAgents).toEqual(BUILTIN_AGENTS);
    expect(requiredRunnerCapabilities(definition)).toEqual(["builtin-tools", "interactive"]);
  });

  it("enables built-in agents only for the agents tool group", () => {
    const definition = structuredClone(harnesses.get("dataset-analyst")![0]!.definition);
    definition.builtinTools = ["agents"];
    const options = buildSessionOptions(definition, ["compute_statistics", "submit_result"], "/w/skills");
    expect(options.availableTools).toEqual([
      "custom:compute_statistics",
      "custom:submit_result",
      "builtin:task",
      "builtin:read_agent",
      "builtin:list_agents",
      "builtin:write_agent",
    ]);
    expect(options.excludedBuiltinAgents).toEqual([]);
  });
});

describe("admission of harness features", () => {
  const input = { question: "q", dataset: { name: "d", columns: ["x"], rows: [[1], [2]] } };
  const admitWith = (overrides: { policy?: Partial<ExecutionPolicy>; capabilities?: ExecutionProfile["capabilities"] }) => {
    const changedProfiles = new Map(profiles);
    if (overrides.capabilities) {
      changedProfiles.set("node-ts-agent", { ...profiles.get("node-ts-agent")!, capabilities: overrides.capabilities });
    }
    return new Admission({ harnesses, profiles: changedProfiles, policies: { base: { ...policy, ...overrides.policy }, overrides: new Map() } }).admit({
      harness: { name: "insights-team" },
      input,
    } as never);
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof HttpError ? error.code : "unexpected";
    }
    return undefined;
  };

  it("admits the showcase harness on profiles that support its features", () => {
    expect(admitWith({}).profile).toBe("node-ts-agent");
  });

  it("rejects profiles that lack a required feature", () => {
    expect(code(() => admitWith({ capabilities: ["cancel", "structured-result", "prompt-sections", "model-options", "skills"] }))).toBe(
      "policy_rejected",
    );
  });

  it("rejects reasoning effort above the policy cap", () => {
    expect(code(() => admitWith({ policy: { maxReasoningEffort: "low" } }))).toBe("policy_rejected");
  });
});
