import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessHostingView, HostingHostsView } from "../server/types";
import { HostingDiagram } from "../src/components/HostingDiagram";
import { harnessHostRow, hostingObservation, hostingPlacement, hostingTopology, HOSTING_HEIGHT, HOSTING_NODE_HEIGHT, HOSTING_NODE_WIDTH, HOSTING_WIDTH } from "../src/hosting";
import { HostingView } from "../src/views/Hosting";
import { HarnessHostingRows } from "../src/views/HostingHarnesses";

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

function view(overrides: Partial<HarnessHostingView>): HarnessHostingView {
  return {
    harness: "chat",
    version: "1.0.0",
    digest: `sha256:${"0".repeat(64)}`,
    interaction: "conversation",
    mode: "isolated",
    placement: "container",
    status: "ready",
    problems: [],
    transports: [
      { transport: "direct", allowed: true, available: true },
      { transport: "github", allowed: true, available: true },
    ],
    effective: { mode: "isolated", declared: false, approvalMode: "manual", handoffs: [], mcpServers: [] },
    ceilings: {
      modes: ["isolated"], transports: ["direct", "github"], approvalModes: ["manual"], permissionHandlers: [],
      sizes: { small: { cpus: 0.5, memoryMiB: 1024 } }, defaultSize: "small",
      workers: { maxConcurrentPerSession: 4, maxPerSession: 16, maxPerPrincipal: 8, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: false, allowCoordinatorAnswers: false },
      promotion: { approval: ["ask"] }, craftingTemplates: [], mcpServers: [],
    },
    ...overrides,
  };
}

const sharedWorker: HostingHostsView = { executor: "pool", isolatedHosts: [], sharedWorker: { transports: ["direct"], features: [] } };
const transportUnsupported = {
  transport: "github" as const,
  allowed: false,
  available: false,
  problem: { code: "transport_unsupported" as const, message: "Shared hosting supports direct WSS only; the GitHub relay serves isolated hosts." },
};

describe("per-harness hosting rows", () => {
  it("connects to an owner host with the per-harness launcher and notes its always-on cost", () => {
    const hosts: HostingHostsView = { executor: "pool", isolatedHosts: [{ harness: "chat", transports: ["direct", "github"], features: [] }] };
    const row = harnessHostRow(view({}), hosts, "local");
    expect(row.host).toBe("Owner host");
    expect(row.costNote).toContain("Always on");
    expect(row.connections.map((connection) => connection.command)).toEqual([
      "pnpm host:connect --harness chat --target local --transport direct",
      "pnpm host:connect --harness chat --target local --transport github",
    ]);
  });

  it("connects to shared harnesses over direct WSS locally, and says why not over the relay or in Azure", () => {
    const shared = view({ mode: "shared", placement: "shared", transports: [{ transport: "direct", allowed: true, available: true }, transportUnsupported] });
    const local = harnessHostRow(shared, sharedWorker, "local");
    expect(local.host).toBe("Shared worker");
    expect(local.costNote).toContain("a session itself starts no container");
    expect(local.connections[0]).toEqual({ transport: "direct", label: "Direct WSS", command: "pnpm host:connect --harness chat --target local --transport direct" });
    expect(local.connections[1]?.disabledReason).toBe("Shared hosting supports direct WSS only; the GitHub relay serves isolated hosts.");
    expect(harnessHostRow(shared, sharedWorker, "azure").connections[0]?.disabledReason).toContain("locally only");
  });

  it("names the missing host instead of offering a connection", () => {
    const problem = { code: "hosting_unavailable" as const, message: "Shared hosting needs the shared worker.", prerequisite: { kind: "host" as const, name: "shared-worker" as const } };
    const row = harnessHostRow(
      view({ mode: "shared", placement: "shared", status: "unavailable", problems: [problem], transports: [{ transport: "direct", allowed: true, available: false, problem }, transportUnsupported] }),
      { executor: "pool", isolatedHosts: [] },
      "local",
    );
    expect(row.host).toBe("No shared worker");
    expect(row.connections[0]?.disabledReason).toBe("Shared hosting needs the shared worker. Needs the harness-driven shared worker.");
    expect(row.connections.every((connection) => !connection.command)).toBe(true);
    const sessions = harnessHostRow(view({}), { executor: "pool", isolatedHosts: [], sessionContainers: { transports: ["direct"], features: [] } }, "local");
    expect(sessions.host).toBe("Session containers");
    expect(sessions.connections[0]?.disabledReason).toBe("The launcher cannot connect to per-session containers yet.");
  });

  it("runs batch harnesses as jobs without client transports", () => {
    const row = harnessHostRow(view({ interaction: "batch", placement: "executor", transports: [] }), sharedWorker, "local");
    expect(row).toEqual({ host: "Executor pool", hostDetail: "Runs as jobs through the jobs API, with no client transport.", connections: [] });
  });

  it("asks for the local stack before reading the service's view", () => {
    const html = renderToStaticMarkup(<HarnessHostingRows target="local" />);
    expect(html).toContain("Harness hosting");
    expect(html).toContain("Start the local stack to see how the service hosts each harness.");
  });
});
