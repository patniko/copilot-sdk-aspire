import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessDefinition } from "@copilot-agent/contracts";
import sample from "../../examples/customer-config/harnesses/copilot-coding-agent/harness.json";
import type { HarnessDocument } from "../server/types";
import { HarnessTab, type Tab } from "../src/views/harness/tabs";

const state = vi.hoisted(() => ({
  workspace: {
    policy: { builtinTools: ["files", "shell", "web", "agents"], allowedModels: ["grok-4.6"] },
    bindings: [],
  },
}));

vi.mock("../src/state", () => ({ useApp: () => state }));

function codingHarness(): HarnessDocument {
  const { instructionsFile, ...definition } = sample;
  const { instructions, skills, ...manifest } = HarnessDefinition.parse({ ...definition, instructions: "Complete the coding task." });
  return {
    folder: manifest.name,
    manifest: { ...manifest, instructionsFile },
    instructions,
    skills: skills ?? [],
  };
}

function render(tab: Tab, draft = codingHarness()): string {
  return renderToStaticMarkup(<HarnessTab tab={tab} draft={draft} update={() => undefined} issues={[]} />);
}

beforeEach(() => {
  state.workspace.policy.builtinTools = ["files", "shell", "web", "agents"];
});

describe("managed coding harness display", () => {
  it("orders allowed models and uses segmented controls for model options", () => {
    const draft = codingHarness();
    draft.manifest.model = { preferred: "grok-4.6", allowed: ["grok-4.6", "legacy-model"] };
    const html = render("model", draft);
    expect(html).toContain('aria-label="Allowed models"');
    expect(html).toContain("Move grok-4.6 down");
    expect(html).toContain("not approved");
    expect(html).toContain('role="radiogroup" aria-label="Reasoning effort"');
    expect(html).toContain('role="radiogroup" aria-label="Context tier"');
  });
  it("distinguishes custom counts from enabled built-ins in the overview", () => {
    const html = render("overview");
    expect(html).toContain("Custom tools");
    expect(html).toContain("0 + submit_result");
    expect(html).toContain("files, shell, web, agents");
    expect(html).toContain("0 custom + built-ins");
  });

  it("shows built-in tools even when the custom binding list is empty", () => {
    const html = render("tools");
    expect(html).toContain("Built-in Copilot tools");
    expect(html).toContain("apply_patch");
    expect(html).toContain("No custom harness tools.");
    expect(html).not.toContain("No tools.");
  });

  it("shows runtime-provided agents without requiring custom definitions", () => {
    const html = render("agents");
    expect(html).toContain("Built-in Copilot agents");
    expect(html).toContain(">Enabled<");
    expect(html).toContain("runtime-provided agents, such as explore and general-purpose");
    expect(html).toContain("No custom sub-agents.");
    expect(html).not.toContain("Built-in SDK agents stay disabled");
    expect(html).not.toContain("coordinator does all the work itself");
  });

  it("shows built-in and custom agents together", () => {
    const draft = codingHarness();
    draft.manifest.agents = [{ name: "reviewer", displayName: "Custom reviewer", description: "Review the answer", instructions: "Review.", tools: [] }];
    expect(render("overview", draft)).toContain("1 custom + built-ins");
    const html = render("agents", draft);
    expect(html).toContain(">Enabled<");
    expect(html).toContain("Custom reviewer");
    expect(html).not.toContain("No custom sub-agents.");
  });

  it("does not claim built-in delegation when the group is disabled", () => {
    const draft = codingHarness();
    delete draft.manifest.builtinTools;
    const html = render("agents", draft);
    expect(html).toContain(">Disabled<");
    expect(html).toContain("No custom or built-in sub-agents are enabled.");
    expect(render("overview", draft)).not.toContain("+ built-ins");
  });

  it("keeps custom delegation visible when built-in agents are disabled", () => {
    const draft = codingHarness();
    delete draft.manifest.builtinTools;
    draft.manifest.agents = [{ name: "reviewer", description: "Review the answer", instructions: "Review.", tools: [] }];
    const html = render("agents", draft);
    expect(html).toContain(">Disabled<");
    expect(html).toContain("reviewer");
    expect(html).not.toContain("coordinator works without delegation");
    expect(render("overview", draft)).toContain("1 custom");
  });

  it("distinguishes a policy-blocked group from an enabled group", () => {
    state.workspace.policy.builtinTools = ["files"];
    const html = render("agents");
    expect(html).toContain("Not allowed by policy");
    expect(html).not.toContain(">Enabled<");
  });
});
