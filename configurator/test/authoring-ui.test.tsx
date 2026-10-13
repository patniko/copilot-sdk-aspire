// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessDefinition } from "@copilot-agent/contracts";
import sample from "../../examples/customer-config/harnesses/copilot-coding-agent/harness.json";
import type { AuthoringDraft, HarnessDocument } from "../server/types";
import { api } from "../src/api";
import { AuthoringDialog, CodeProposal, CreateWithCopilot } from "../src/views/harness/authoring";
import { HarnessTab, type Tab } from "../src/views/harness/tabs";

vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: (error: Error) => error.message }));
vi.mock("../src/state", () => ({
  useApp: () => ({
    workspace: {
      policy: { builtinTools: ["files", "shell", "web", "agents"], allowedModels: ["grok-4.6"] },
      bindings: [{ id: "python:stats", kind: "python", description: "Statistics", profiles: ["node-ts-agent", "python-agent"] }],
    },
  }),
}));
const agent: AuthoringDraft = {
  kind: "agent", agent: { name: "evidence-reviewer", description: "Checks the evidence", instructions: "Review assumptions.", tools: [] },
};
let container: HTMLDivElement;
let root: Root;

function harness(): HarnessDocument {
  const { instructionsFile, ...definition } = sample;
  const { instructions, skills, ...manifest } = HarnessDefinition.parse({ ...definition, instructions: "Complete the task." });
  return { folder: manifest.name, manifest: { ...manifest, instructionsFile }, instructions, skills: skills ?? [] };
}
function Editor({ tab, initial = harness() }: { tab: Tab; initial?: HarnessDocument }) {
  const [draft, setDraft] = useState(initial);
  return <HarnessTab tab={tab} draft={draft} issues={[]} update={(mutate) => setDraft((previous) => {
    const next = structuredClone(previous);
    mutate(next);
    return next;
  })} />;
}
async function render(node: ReactNode) { await act(async () => root.render(node)); }
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function describeDraft(text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label^='Describe your']")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("description-first authoring", () => {
  it("opens a description instead of immediately adding a sub-agent; manual mode still opens all fields", async () => {
    await render(<Editor tab="agents" />);
    await click("Add custom sub-agent");
    expect(container.querySelector("[role=dialog]")?.textContent).toContain("Describe your custom sub-agent");
    expect(container.querySelector("[role=dialog]")?.textContent).toContain("not the harness's Foundry model");
    expect(button("Generate draft").disabled).toBe(true);
    expect(container.textContent).not.toContain("Remove sub-agent specialist");
    expect(api).not.toHaveBeenCalled();
    await click("Show full form");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(container.querySelector('[aria-label="Remove sub-agent specialist"]')).not.toBeNull();
    expect(container.textContent).toContain("Instructions");
    expect(container.textContent).toContain("Preloaded skills");
    expect(api).not.toHaveBeenCalled();
  });

  it("adds generated configuration to the editable unsaved draft, not a save endpoint", async () => {
    vi.mocked(api).mockResolvedValue(agent);
    await render(<Editor tab="agents" />);
    await click("Add custom sub-agent");
    await describeDraft("Check conclusions against the evidence.");
    await click("Generate draft");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(container.querySelector('[aria-label="Remove sub-agent evidence-reviewer"]')).not.toBeNull();
    expect([...container.querySelectorAll("textarea")].some((input) => input.value === "Review assumptions.")).toBe(true);
    expect(api).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith("/api/authoring/draft", expect.objectContaining({
      method: "POST", body: expect.objectContaining({ kind: "agent", description: "Check conclusions against the evidence." }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("shows actionable errors, preserves the description, and permits retry or the manual form", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Sign in with GitHub Copilot")).mockResolvedValue(agent);
    await render(<Editor tab="agents" />);
    await click("Add custom sub-agent");
    await describeDraft("Review evidence.");
    await click("Generate draft");
    expect(container.textContent).toContain("Sign in with GitHub Copilot");
    expect(container.querySelector("textarea")?.value).toBe("Review evidence.");
    expect(button("Show full form").disabled).toBe(false);
    await click("Generate draft");
    expect(container.querySelector('[aria-label="Remove sub-agent evidence-reviewer"]')).not.toBeNull();
  });

  it("cancels generation when taking the manual path and ignores a late response", async () => {
    let finish!: (value: AuthoringDraft) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(<Editor tab="agents" />);
    await click("Add custom sub-agent");
    await describeDraft("Review evidence.");
    await click("Generate draft");
    expect(container.textContent).toContain("up to 90 seconds");
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    await click("Show full form");
    expect(signal.aborted).toBe(true);
    await act(async () => finish(agent));
    expect(container.querySelector('[aria-label="Remove sub-agent specialist"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Remove sub-agent evidence-reviewer"]')).toBeNull();
  });

  it("aborts when the dialog closes and keeps edits out of another harness", async () => {
    vi.mocked(api).mockImplementation(() => new Promise(() => undefined));
    const draft = harness();
    await render(<CreateWithCopilot kind="agent" draft={draft} update={() => undefined} />);
    await click("Add custom sub-agent");
    await describeDraft("Review evidence.");
    await click("Generate draft");
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    await render(<CreateWithCopilot kind="agent" draft={{ ...draft, folder: "another-harness" }} update={() => undefined} />);
    expect(signal.aborted).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("rejects stale results when the current harness draft changes during generation", async () => {
    let finish!: (value: AuthoringDraft) => void;
    vi.mocked(api).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onAdd = vi.fn();
    const draft = harness();
    await render(<AuthoringDialog kind="agent" draft={draft} onClose={() => undefined} onAdd={onAdd} />);
    await describeDraft("Review evidence.");
    await click("Generate draft");
    await render(<AuthoringDialog kind="agent" draft={{ ...draft, instructions: "Changed." }} onClose={() => undefined} onAdd={onAdd} />);
    await act(async () => finish(agent));
    expect(onAdd).not.toHaveBeenCalled();
    expect(container.textContent).toContain("harness changed");
  });

  it("offers the same workflow for skills and preserves the manual path", async () => {
    vi.mocked(api).mockResolvedValue({ kind: "skill", skill: { name: "review", description: "Review evidence", content: "# Review" } });
    await render(<Editor tab="skills" />);
    await click("Add skill");
    await describeDraft("Review procedure.");
    await click("Generate draft");
    expect(container.querySelector('[aria-label="Remove skill review"]')).not.toBeNull();
    await click("Add skill");
    await click("Show full form");
    expect(container.querySelector('[aria-label="Remove skill new-skill"]')).not.toBeNull();
  });

  it("configures existing tool bindings without generating or installing code", async () => {
    vi.mocked(api).mockResolvedValue({
      kind: "tool", tool: { name: "compute_stats", kind: "python", binding: "python:stats", description: "Statistics" },
    });
    await render(<Editor tab="tools" />);
    await click("Add custom tool");
    await describeDraft("Compute statistics.");
    await click("Generate draft");
    expect(container.querySelector('[aria-label="Remove tool compute_stats"]')).not.toBeNull();
    expect(container.querySelector("select")?.value).toBe("python:stats");
    expect(api).toHaveBeenCalledOnce();
  });

  it("honors the custom-agent count limit before generation", async () => {
    const initial = harness();
    initial.manifest.agents = Array.from({ length: 8 }, (_, index) => ({
      name: `agent-${index}`, description: "Review", instructions: "Review.", tools: [],
    }));
    await render(<Editor tab="agents" initial={initial} />);
    expect(button("Add custom sub-agent").disabled).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("review-only tool code", () => {
  const proposal = {
    name: "normalize", summary: "Review before use.",
    files: [{ path: "tools/python/normalize.py", content: "<script>mustNotExecute()</script>" }],
    instructions: "Integrate both runners, update profiles, test, rebuild and redeploy.",
  };

  it("shows a proposal instead of adding a tool or executing generated text", async () => {
    vi.mocked(api).mockResolvedValue({ kind: "tool-code", proposal });
    await render(<Editor tab="tools" />);
    await click("Add custom tool");
    await click("New tool code proposal");
    await describeDraft("Normalize a numeric series.");
    await click("Generate draft");
    expect(container.textContent).toContain("review-only proposal");
    expect(container.textContent).toContain("Nothing is installed, executed, or added");
    expect(container.querySelector('[aria-label="Remove tool normalize"]')).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const code = container.querySelector<HTMLTextAreaElement>('[aria-label="tools/python/normalize.py"]')!;
    expect(code.value).toBe(proposal.files[0]!.content);
    expect(code.readOnly).toBe(true);
    expect(api).toHaveBeenCalledOnce();
    expect(vi.mocked(api).mock.calls[0]![1]!.body).toMatchObject({ kind: "tool-code" });
  });

  it("downloads an inert JSON proposal, not individual generated paths", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:proposal");
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    await render(<CodeProposal proposal={proposal} />);
    await click("Download proposal JSON");
    const blob = createUrl.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toEqual({ kind: "tool-code", proposal });
    expect(filename).toBe("normalize-proposal.json");
    expect(api).not.toHaveBeenCalled();
  });
});
