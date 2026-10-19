import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessDefinition, SharedSessionView, WorkerView } from "@copilot-agent/contracts";
import type { DemoModeInfo } from "../server/types";
import { CodeBlock, DemosView, ModeCard, Stepper, Topology } from "../src/views/Demos";

vi.mock("../src/state", () => ({ useApp: () => ({ runTask: vi.fn(), toast: vi.fn(), setView: vi.fn() }) }));
vi.mock("../src/api", () => ({ api: vi.fn(() => new Promise(() => undefined)), errorMessage: (error: unknown) => String(error) }));

const definition = {
  schemaVersion: "1", name: "promotable-coder", version: "0.1.0", description: "Demo.", interaction: "conversation",
  hosting: { mode: "promotable", promotion: { size: "small", approval: "ask" } },
  instructions: "Promote when you need a shell.", model: { preferred: "github/claude-sonnet-5.5", allowed: ["github/claude-sonnet-5.5"] },
  tools: [], builtinTools: ["files", "shell"], permissions: { default: "deny" },
  input: { schema: { type: "object" } }, output: { schema: { type: "object" } },
  limits: { maxDurationSeconds: 300, maxInferenceTokens: 200_000 }, retry: { safeToRetry: false, maxAttempts: 1 },
  runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
} as HarnessDefinition;

function session(overrides: Partial<SharedSessionView> = {}): SharedSessionView {
  return {
    id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", mode: "promotable", placement: "shared", online: true, model: "github/claude-sonnet-5.5",
    segment: { generation: 1 }, budget: { usedTokens: 1000, reservedTokens: 0, remainingTokens: 199_000 }, ...overrides,
  } as SharedSessionView;
}

describe("Demos page", () => {
  it("renders the hero and checks the stack before showing the modes", () => {
    const html = renderToStaticMarkup(<DemosView />);
    expect(html).toContain("Define an agent in code. Run it four ways.");
    expect(html).toContain("Checking the local stack");
  });

  it("shows a mode's problems and disables its launch", () => {
    const demo: DemoModeInfo = {
      mode: "promotable", title: "Promotable", tagline: "Starts shared.", story: "Story.", prompts: [], definition,
      problems: ["The base policy does not allow promotable hosting."],
    };
    const html = renderToStaticMarkup(<ModeCard demo={demo} busy={false} disabled={false} selected={false} onLaunch={() => undefined} />);
    expect(html).toContain("promotable-coder");
    expect(html).toContain("does not allow promotable hosting");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Launch promotable/);
  });

  it("places the session on the shared worker, then in its container after promotion", () => {
    expect(renderToStaticMarkup(<Topology mode="promotable" live={{ session: session() }} />)).toContain("Ask for a shell");
    const moving = renderToStaticMarkup(<Topology mode="promotable" live={{ session: session({ promotion: { state: "starting", size: "small" } as SharedSessionView["promotion"] }) }} />);
    expect(moving).toContain("Moving here");
    expect(moving).toContain("demo-topology moving");
    const moved = renderToStaticMarkup(<Topology mode="promotable" live={{
      session: session({ placement: "container", segment: { generation: 2 } as SharedSessionView["segment"], container: { state: "running", size: "small" } as SharedSessionView["container"] }),
    }} />);
    expect(moved).toContain("generation 2");
    expect(moved).toContain("small · running");
  });

  it("shows an orchestrator's workers, including one waiting for a person", () => {
    const workers = [
      { id: "w1", name: "builder", size: "small", approvalMode: "manual", state: "needs_input", usage: { tokensUsed: 1200 }, capacityReleased: false },
      { id: "w2", name: "reviewer", size: "medium", approvalMode: "assisted", state: "stopped", stopReason: "archived", usage: { tokensUsed: 900 }, capacityReleased: true },
    ] as unknown as WorkerView[];
    const html = renderToStaticMarkup(<Topology mode="orchestrator" live={{ session: session({ mode: "orchestrator" }), workers }} />);
    expect(html).toContain("coordinator");
    expect(html).toContain("needs you");
    expect(html).toContain("stopped (archived)");
    expect(html).toContain("released");
  });

  it("renders the stepper and the agent as a defineAgent call", () => {
    expect(renderToStaticMarkup(<Stepper stage="cli" />)).toMatch(/class="current".*CLI attached/);
    const code = renderToStaticMarkup(<CodeBlock definition={definition} />);
    expect(code).toContain("defineAgent");
    expect(code).toContain("promotable-coder");
    expect(code).toContain("createSession");
  });
});
