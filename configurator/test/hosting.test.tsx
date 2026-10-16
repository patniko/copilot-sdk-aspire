import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessHostingView, HostingHostsView } from "../server/types";
import { HostingDiagram } from "../src/components/HostingDiagram";
import { harnessHostRow, hostingObservation, hostingPlacement, hostingTopology, HOSTING_HEIGHT, HOSTING_NODE_HEIGHT, HOSTING_NODE_WIDTH, HOSTING_WIDTH } from "../src/hosting";
import { HostingView } from "../src/views/Hosting";
import { HarnessHostingRow, HarnessHostingRows } from "../src/views/HostingHarnesses";

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
      promotion: { approval: ["ask"] }, handoffs: { approval: ["ask"], history: ["full", "summary", "none"] }, craftingTemplates: [], mcpServers: [],
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
/** Session containers as agent-api reports them, and the relay view `evaluateHosting` gives an isolated harness they serve alone. */
const sessionContainers: HostingHostsView = { executor: "pool", isolatedHosts: [], sessionContainers: { transports: ["direct"], features: [] } };
const noRelay = {
  transport: "github" as const,
  allowed: true,
  available: false,
  problem: {
    code: "hosting_unavailable" as const,
    message: "No host for 'chat' offers the GitHub relay.",
    prerequisite: { kind: "transport" as const, name: "github" as const },
  },
};

describe("per-harness hosting rows", () => {
  const owner = { kind: "owner-host" } as const;
  const container = { kind: "sessions", placement: "container" } as const;
  const sharedRoute = { kind: "sessions", placement: "shared" } as const;
  const ownerHostBoth = { harness: "chat", transports: ["direct", "github"] as Array<"direct" | "github">, features: [] };
  const command = (transport: "direct" | "github", target: "local" | "azure" = "local") => `pnpm host:connect --harness chat --target ${target} --transport ${transport}`;

  it("connects an owner to their own owner host and notes its always-on cost", () => {
    const hosts: HostingHostsView = { executor: "pool", isolatedHosts: [ownerHostBoth] };
    const row = harnessHostRow(view({}), hosts, "local", { ownsHost: true, transports: { direct: { route: owner }, github: { route: owner } } });
    expect(row.host).toBe("Your owner host");
    expect(row.hostDetail).toBe("A dedicated container for this harness that only you can connect to.");
    expect(row.costNote).toContain("Always on");
    expect(row.connections).toEqual([
      { transport: "direct", label: "Direct WSS", command: command("direct") },
      { transport: "github", label: "GitHub relay", command: command("github") },
    ]);
  });

  it("sends an owner to their own owner host before session containers, as the launcher does", () => {
    const hosts: HostingHostsView = { ...sessionContainers, isolatedHosts: [ownerHostBoth] };
    const row = harnessHostRow(view({}), hosts, "local", { ownsHost: true, transports: { direct: { route: owner }, github: { route: owner } } });
    expect(row.host).toBe("Your owner host and session containers");
    expect(row.hostDetail).toBe(
      "You connect to your own dedicated container for this harness over the transports it offers, otherwise to a container per session; other callers always get a container per session.",
    );
    expect(row.costNote).toContain("Always on");
    expect(row.costNote).toContain("stops after an idle period");
    expect(row.connections).toEqual([
      { transport: "direct", label: "Direct WSS", command: command("direct") },
      { transport: "github", label: "GitHub relay", command: command("github") },
    ]);
  });

  it("sends other callers to session containers and names why the owner's relay is not theirs", () => {
    const hosts: HostingHostsView = { ...sessionContainers, isolatedHosts: [ownerHostBoth] };
    const relayOwnerOnly = { code: "relay_owner_only" as const, message: "Only the owner of the isolated host for 'chat' can use the GitHub relay." };
    const row = harnessHostRow(
      view({ transports: [{ transport: "direct", allowed: true, available: true }, { transport: "github", allowed: true, available: false, problem: relayOwnerOnly }] }),
      hosts,
      "local",
      { ownsHost: false, transports: { direct: { route: container }, github: { problem: relayOwnerOnly } } },
    );
    expect(row.host).toBe("Session containers");
    expect(row.hostDetail).toBe("A container per session, stopped when idle and resumed from its volume. This harness's owner host serves only its owner.");
    expect(row.costNote).toContain("Always on");
    expect(row.connections).toEqual([
      { transport: "direct", label: "Direct WSS", command: command("direct"), createsSession: true },
      { transport: "github", label: "GitHub relay", disabledReason: "Only the owner of the isolated host for 'chat' can use the GitHub relay." },
    ]);
  });

  it("connects to shared harnesses over direct WSS locally, and says why not over the relay or in Azure", () => {
    const shared = view({ mode: "shared", placement: "shared", transports: [{ transport: "direct", allowed: true, available: true }, transportUnsupported] });
    const github = { problem: transportUnsupported.problem };
    const local = harnessHostRow(shared, sharedWorker, "local", { ownsHost: false, transports: { direct: { route: sharedRoute }, github } });
    expect(local.host).toBe("Shared worker");
    expect(local.costNote).toContain("a session itself starts no container");
    expect(local.connections[0]).toEqual({ transport: "direct", label: "Direct WSS", command: command("direct"), createsSession: true });
    expect(local.connections[1]?.disabledReason).toBe("Shared hosting supports direct WSS only; the GitHub relay serves isolated hosts.");
    const refusal = "The shared conversation path currently supports local connections only. Azure qualification remains open.";
    const azure = harnessHostRow(shared, sharedWorker, "azure", { ownsHost: false, transports: { direct: { route: sharedRoute, refusal }, github } });
    expect(azure.connections[0]).toEqual({ transport: "direct", label: "Direct WSS", disabledReason: refusal });
  });

  it("names the missing host instead of offering a connection", () => {
    const problem = { code: "hosting_unavailable" as const, message: "Shared hosting needs the shared worker.", prerequisite: { kind: "host" as const, name: "shared-worker" as const } };
    const row = harnessHostRow(
      view({ mode: "shared", placement: "shared", status: "unavailable", problems: [problem], transports: [{ transport: "direct", allowed: true, available: false, problem }, transportUnsupported] }),
      { executor: "pool", isolatedHosts: [] },
      "local",
      { ownsHost: false, transports: { direct: { problem }, github: { problem: transportUnsupported.problem } } },
    );
    expect(row.host).toBe("No shared worker");
    expect(row.connections[0]?.disabledReason).toBe("Shared hosting needs the shared worker. Needs the harness-driven shared worker.");
    expect(row.connections.every((connection) => !connection.command)).toBe(true);
  });

  it("connects to session containers over direct WSS locally, and keeps the relay disabled with its reason", () => {
    const isolated = view({ transports: [{ transport: "direct", allowed: true, available: true }, noRelay] });
    const github = { problem: noRelay.problem };
    const local = harnessHostRow(isolated, sessionContainers, "local", { ownsHost: false, transports: { direct: { route: container }, github } });
    expect(local.host).toBe("Session containers");
    expect(local.costNote).toBe(
      "Each session's container stops after an idle period and keeps its volume; a new or resumed session waits for its container to start.",
    );
    expect(local.connections).toEqual([
      { transport: "direct", label: "Direct WSS", command: command("direct"), createsSession: true },
      { transport: "github", label: "GitHub relay", disabledReason: "No host for 'chat' offers the GitHub relay. Needs the GitHub relay on its host." },
    ]);
    const refusal = "The session container path currently supports local connections only. Azure qualification remains open.";
    expect(harnessHostRow(isolated, sessionContainers, "azure", { ownsHost: false, transports: { direct: { route: container, refusal }, github } }).connections[0])
      .toEqual({ transport: "direct", label: "Direct WSS", disabledReason: refusal });
  });

  it("disables owner-host connections on Azure with the launcher's reason", () => {
    const refusal = "Per-harness owner hosts are local-only until the Azure stage; use --destination container for the deployed demo host.";
    const row = harnessHostRow(view({}), { executor: "pool", isolatedHosts: [ownerHostBoth] }, "azure", {
      ownsHost: true,
      transports: { direct: { route: owner, refusal }, github: { route: owner, refusal } },
    });
    expect(row.connections.map((connection) => connection.disabledReason)).toEqual([refusal, refusal]);
    expect(row.connections.every((connection) => !connection.command)).toBe(true);
  });

  it("refuses in the launcher's order: a transport's own problem before the harness's", () => {
    const problem = {
      code: "hosting_unavailable" as const,
      path: "mcpServers",
      message: "No isolated host for 'chat' supports remote MCP servers yet.",
      prerequisite: { kind: "feature" as const, name: "remote-mcp" as const },
    };
    const row = harnessHostRow(
      view({ status: "unavailable", problems: [problem], transports: [{ transport: "direct", allowed: true, available: true }, noRelay] }),
      sessionContainers,
      "local",
      { ownsHost: false, transports: { direct: { problem }, github: { problem: noRelay.problem } } },
    );
    expect(row.host).toBe("Session containers");
    expect(row.connections.every((connection) => !connection.command)).toBe(true);
    expect(row.connections.map((connection) => connection.disabledReason)).toEqual([
      "No isolated host for 'chat' supports remote MCP servers yet. Needs remote MCP support in its host.",
      "No host for 'chat' offers the GitHub relay. Needs the GitHub relay on its host.",
    ]);
  });

  it("offers no launcher when the configurator could not learn the launcher's decision", () => {
    const row = harnessHostRow(view({ transports: [{ transport: "direct", allowed: true, available: true }, noRelay] }), sessionContainers, "local");
    expect(row.connections).toEqual([
      { transport: "direct", label: "Direct WSS", disabledReason: "The configurator could not tell where the launcher connects over Direct WSS." },
      { transport: "github", label: "GitHub relay", disabledReason: "No host for 'chat' offers the GitHub relay. Needs the GitHub relay on its host." },
    ]);
  });

  it("renders the session launcher with how to resume, and the relay's reason", () => {
    const html = renderToStaticMarkup(
      <HarnessHostingRow
        view={view({ transports: [{ transport: "direct", allowed: true, available: true }, noRelay] })}
        hosts={sessionContainers}
        target="local"
        connect={{ ownsHost: false, transports: { direct: { route: container }, github: { problem: noRelay.problem } } }}
      />,
    );
    expect(html).toContain("Copy Direct WSS launcher");
    expect(html).toContain('disabled="" title="No host for &#x27;chat&#x27; offers the GitHub relay. Needs the GitHub relay on its host.">Connect over GitHub relay');
    expect(html).toContain("The Direct WSS launcher starts a new conversation and prints the --resume command for returning to it.");
    expect(html).toContain("Add --cli &lt;path&gt; to run a Copilot CLI that matches the hosting runtime.");
    const ownerRow = renderToStaticMarkup(
      <HarnessHostingRow
        view={view({})}
        hosts={{ ...sessionContainers, isolatedHosts: [ownerHostBoth] }}
        target="local"
        connect={{ ownsHost: true, transports: { direct: { route: owner }, github: { route: owner } } }}
      />,
    );
    expect(ownerRow).toContain("Your owner host and session containers.");
    expect(ownerRow).toContain("Copy Direct WSS launcher");
    expect(ownerRow).toContain("Copy GitHub relay launcher");
    expect(ownerRow).not.toContain("--resume");
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
