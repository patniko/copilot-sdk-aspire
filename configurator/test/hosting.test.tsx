import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HostingDiagram } from "../src/components/HostingDiagram";
import { hostingObservation, hostingPlacement, hostingTopology, HOSTING_HEIGHT, HOSTING_NODE_HEIGHT, HOSTING_NODE_WIDTH, HOSTING_WIDTH } from "../src/hosting";
import { HostingView } from "../src/views/Hosting";

vi.mock("../src/state", () => ({ useApp: () => ({
  settings: { local: { demoHost: { transport: "github", owner: "synthetic-owner" } }, targets: [] },
  setView: vi.fn(),
}) }));
vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: String }));

describe("hosting topology", () => {
  it("keeps native inference distinct from managed inference", () => {
    const topology = hostingTopology("current", "github");
    expect(topology.edges.some((edge) => edge.from === "container" && edge.to === "copilot")).toBe(true);
    expect(topology.edges.some((edge) => edge.from === "container" && edge.to === "gateway")).toBe(false);
    expect(topology.nodes.some((node) => node.id === "shared")).toBe(false);
  });

  it("labels unimplemented execution rather than presenting a live deployment", () => {
    const topology = hostingTopology("hybrid", "both");
    for (const id of ["shared", "scheduler", "executors", "session-fs"]) {
      const node = topology.nodes.find((entry) => entry.id === id)!;
      expect(node.proposed).toBe(true);
      expect(hostingObservation(node, "local", { running: true, resources: [] })).toBe("Proposed / not implemented");
    }
    expect(topology.edges.some((edge) => edge.from === "container" && edge.to === "gateway")).toBe(true);
  });

  it("distinguishes the implemented local opt-in from the Azure proposal without inventing telemetry", () => {
    const topology = hostingTopology("hybrid", "disabled", true);
    const shared = topology.nodes.find((node) => node.id === "shared")!;
    expect(shared.proposed).toBe(false);
    expect(shared.resource).toBe("session-host");
    expect(hostingObservation(shared, "local", { running: true, resources: [] })).toBe("Not observed");
    expect(topology.nodes.find((node) => node.id === "executors")?.caption).toBe("One-shot Linux containers");
    expect(topology.edges.every((edge) => !edge.proposed)).toBe(true);
  });

  it("keeps every node in bounds and every edge attached to declared nodes", () => {
    for (const mode of ["current", "hybrid"] as const) for (const transport of ["disabled", "direct", "github", "both"] as const) {
      const topology = hostingTopology(mode, transport);
      const ids = new Set(topology.nodes.map((node) => node.id));
      expect(ids.size).toBe(topology.nodes.length);
      for (const node of topology.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.x + HOSTING_NODE_WIDTH).toBeLessThanOrEqual(HOSTING_WIDTH);
        expect(node.y + HOSTING_NODE_HEIGHT).toBeLessThanOrEqual(HOSTING_HEIGHT);
      }
      for (const edge of topology.edges) {
        expect(ids.has(edge.from)).toBe(true);
        expect(ids.has(edge.to)).toBe(true);
      }
    }
  });

  it("does not interpret missing observations as healthy or stopped", () => {
    const node = hostingTopology("current", "disabled").nodes.find((entry) => entry.id === "executors")!;
    expect(hostingObservation(node, "local", { running: false, resources: [] })).toBe("Not observed");
    expect(hostingObservation(node, "azure")).toBe("Not observed");
    expect(hostingObservation(node, "local", { running: true, resources: [{ name: "agent-executor", state: "Starting", type: "container", urls: [] }] })).toBe("Starting");
  });

  it("distinguishes local Node processes from deployed Container Apps", () => {
    const nodes = hostingTopology("current", "github").nodes;
    const api = nodes.find((node) => node.id === "entry")!;
    const container = nodes.find((node) => node.id === "container")!;
    expect(hostingPlacement(api, "local")).toBe("Host Node.js process");
    expect(hostingPlacement(api, "azure")).toBe("Azure Container App");
    expect(hostingPlacement(container, "local")).toBe("Linux container");
  });

  it("provides keyboard buttons, selection state and a text connection map", () => {
    const html = renderToStaticMarkup(<HostingDiagram topology={hostingTopology("hybrid", "github")} selected="shared" onSelect={() => undefined} detailId="inspector" />);
    expect(html).toContain('aria-controls="inspector"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Text connection map");
    expect(html).toContain("Shared coordinator to Execution controller: delegate (proposed)");
    expect(html).toContain("Platform control plane");
    expect(html).toContain("hosting-node-icon");
    expect(html).toContain("hosting-edge-label");
  });

  it("preserves the container launcher and blocks the unqualified shared destination", () => {
    const html = renderToStaticMarkup(<HostingView />);
    expect(html).toContain("Your hosting architecture");
    expect(html).toContain("Copy GitHub CLI launcher");
    expect(html).toContain('disabled="">Shared CLI launcher unavailable');
    expect(html).toContain("not measured here yet");
    expect(html).not.toContain("0 ms");
  });
});
