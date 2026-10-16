import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewView } from "../src/views/Overview";

const setView = vi.fn();
const state: Record<string, unknown> = {};

vi.mock("../src/state", () => ({ useApp: () => state }));

function readyState() {
  Object.assign(state, {
    setView,
    refreshEnvironment: vi.fn(),
    workspace: {
      harnesses: [{ name: "coding", errors: 0 }, { name: "coding", errors: 0 }],
      policyIssues: [],
      policy: {
        allowedProfiles: ["node-ts-agent"],
        allowedModels: ["grok-4.6"],
        maxDurationSeconds: 600,
        maxInferenceTokensPerJob: 10000,
        retry: { maxAttempts: 1 },
        requirements: { processIsolation: "uid", egress: "gateway-only" },
        acknowledgedGaps: ["egress-not-enforced"],
      },
    },
    environment: {
      node: { ok: true, version: "24" },
      pnpm: { ok: true, version: "10" },
      aspire: { ok: true, version: "13" },
      docker: { ok: true, version: "28" },
      azure: { ok: true, user: "operator", subscriptionName: "Development" },
    },
    local: { running: true, resources: [{ name: "agent-api" }, { name: "postgres" }] },
    settings: {
      selectedTarget: "dev",
      targets: [{ name: "dev", resourceGroup: "agents-dev" }],
    },
    azure: { resourceGroupExists: true },
    tasks: [{ id: "task-1", title: "Build services", command: "pnpm build", status: "succeeded" }],
  });
}

describe("overview", () => {
  beforeEach(() => {
    for (const key of Object.keys(state)) delete state[key];
    setView.mockReset();
    readyState();
  });

  it("summarizes readiness, accepted gaps, and recent activity", () => {
    const html = renderToStaticMarkup(<OverviewView />);
    expect(html).toContain("3/3 active");
    expect(html).toContain("2 version(s) across 1 harness(es) pass validation.");
    expect(html).toContain("Accepted execution gaps:");
    expect(html).toContain("they do not enforce the missing control");
    expect(html).toContain("Build services");
    expect(html).toContain("succeeded");
  });

  it("makes configuration errors the primary next action", () => {
    state.workspace = {
      ...(state.workspace as object),
      harnesses: [{ name: "coding", errors: 2 }],
      policyIssues: [{ level: "error", path: "allowedModels", message: "Select a model." }],
    };
    const html = renderToStaticMarkup(<OverviewView />);
    expect(html).toContain("Fix configuration");
    expect(html).toContain("2 harness and 1 policy error(s) must be fixed.");
    expect(html).toContain("3 configuration error(s)");
  });

  it("does not present a configured but stopped local stack as active", () => {
    state.local = { running: false, resources: [] };
    const html = renderToStaticMarkup(<OverviewView />);
    expect(html).toContain("Ready to start");
    expect(html).toContain("Prerequisites are ready; the stack is not running.");
    expect(html).toContain("2/3 active");
  });
});
