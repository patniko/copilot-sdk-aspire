import type { DemoHostSettings } from "@copilot-agent/contracts";
import type { AzureStatus, HarnessHostingView, HostingHostsView, LocalStackStatus, TryTarget } from "../server/types";
import { describeProblem, TRANSPORT_INFO } from "./hostingText";

export type HostingArchitecture = "current" | "hybrid";
export type HostingNodeId = "cli" | "entry" | "shared" | "dispatcher" | "scheduler" | "executors" | "transport" | "container" | "session-fs" | "ledger" | "gateway" | "foundry" | "copilot";
export interface HostingNode {
  id: HostingNodeId;
  title: string;
  caption: string;
  purpose: string;
  limitation: string;
  x: number;
  y: number;
  proposed?: boolean;
  resource?: string;
}
export interface HostingEdge {
  from: HostingNodeId;
  to: HostingNodeId;
  label: string;
  points: Array<[number, number]>;
  labelAt: [number, number];
  support?: boolean;
  proposed?: boolean;
}
export interface HostingTopology {
  nodes: HostingNode[];
  edges: HostingEdge[];
}

export const HOSTING_WIDTH = 1320;
export const HOSTING_HEIGHT = 840;
export const HOSTING_NODE_WIDTH = 190;
export const HOSTING_NODE_HEIGHT = 112;

export function hostingTopology(architecture: HostingArchitecture, transport: DemoHostSettings["transport"], localHybrid = false): HostingTopology {
  const hybrid = architecture === "hybrid";
  const native = transport === "github";
  const hostEnabled = transport !== "disabled";
  const nodes: HostingNode[] = [
    { id: "cli", title: "Clients", caption: "Copilot CLI / job API", x: 40, y: 140,
      purpose: "Copilot CLI uses the configured interactive host. API clients submit batch jobs. The hybrid architecture adds a shared coordinator as another CLI destination.",
      limitation: "Shared attachment is an experimental local path; Azure and two-real-account qualification remain open." },
    { id: "entry", title: "Agent API", caption: "Admission & provisioning", x: 310, y: 140, resource: "agent-api",
      purpose: "Authenticate callers, admit jobs, and provision protected connection material for the configured host.",
      limitation: "Connection provisioning is not a public SDK port or permission to access another principal's sessions." },
    { id: "executors", title: hybrid ? "Job containers" : "Executor pool", caption: hybrid ? "On demand (proposed)" : "Linux / runner slots", x: 1062, y: 140, proposed: hybrid, resource: hybrid ? undefined : "agent-executor",
      purpose: hybrid ? "Allocate real container executions only when an admitted delegation needs them; return results and retire unused capacity." : "A running Linux container polls for jobs and launches UID-isolated runners in private attempt workspaces.",
      limitation: hybrid ? "Zero-to-many-to-zero provisioning is not implemented. Starting a runner process is not starting a container." : "The current pool remains allocated when idle. Attempt files are ephemeral; attempts are bounded to one hour." },
    { id: "transport", title: native ? "GitHub relay" : transport === "both" ? "WSS / GitHub relay" : "Direct WSS", caption: hostEnabled ? "Configured transport" : "Host not configured", x: 40, y: 455,
      purpose: native ? "The configured GitHub-native host uses outbound Mission Control connections for CLI attachment." : "The managed host's configured transport carries AHP traffic; direct connections use provisioned keys and one-time tickets.",
      limitation: hostEnabled ? "Transport choice is independent of execution destination. Managed transports still require a qualified runtime/client pair." : "Enable a container host in Local run or Deploy before using a CLI launcher." },
    { id: "container", title: "Container agent", caption: hostEnabled ? native ? "GitHub-native session" : "Managed conversation" : "Optional / disabled", x: 310, y: 455, resource: "agent-host",
      purpose: "Preserve the directly attachable, retained container conversation without first entering the shared coordinator.",
      limitation: "This host is separate from batch attempts. A running batch job is not automatically a CLI-attachable session." },
    { id: "ledger", title: "PostgreSQL", caption: "Jobs, leases & events", x: 812, y: 455, resource: "postgres",
      purpose: hybrid ? "Keep jobs authoritative and add session ownership, activation leases, delegation identities, and completion delivery." : "Persist caller-scoped jobs, attempts, capabilities, approvals, and events independently of worker processes.",
      limitation: hybrid ? "The session/delegation records in the hybrid design are proposed extensions, not existing job behavior." : "Durable job records do not restore an ended SDK conversation or its workspace." },
    { id: "gateway", title: "Inference gateway", caption: "Managed model access", x: 1062, y: 455, resource: "inference-gateway",
      purpose: "Validate session or job inference grants and attach the gateway-owned provider credential.",
      limitation: "Gateway routing does not establish enforced network egress. Usage reporting is asynchronous, not exact billing reservation." },
    { id: "foundry", title: "Foundry", caption: "Configured deployments", x: 1062, y: 690,
      purpose: "Serve the approved model deployments for managed sessions and jobs.",
      limitation: "Model latency and provider quota remain part of the result; more containers do not increase model quota." },
  ];
  const dispatcher: HostingNode = hybrid
    ? { id: "scheduler", title: "Execution controller", caption: "Allocation (proposed)", x: 812, y: 140, proposed: true,
      purpose: "Turn admitted delegations into bounded container allocations, reconcile failures, and deliver completion notifications.",
      limitation: "Infrastructure permissions belong here, not in the model-facing runtime. Polling alone cannot wake a zero-replica pool." }
    : { id: "dispatcher", title: "Job dispatcher", caption: "Claims & capabilities", x: 812, y: 140, resource: "job-dispatcher",
      purpose: "Match jobs to eligible executors, fence attempt ownership, issue inference capabilities, and recover expired leases.",
      limitation: "The current dispatcher schedules attempt slots; it does not provision containers per job." };
  nodes.push(dispatcher);
  const edges: HostingEdge[] = [
    { from: "cli", to: "entry", label: "admit", points: [[258, 196], [310, 196]], labelAt: [284, 196] },
    { from: "cli", to: "transport", label: "connect", points: [[149, 252], [149, 455]], labelAt: [149, 350] },
    { from: "transport", to: "container", label: "session", points: [[258, 511], [310, 511]], labelAt: [284, 511] },
    { from: dispatcher.id, to: "executors", label: hybrid ? "allocate" : "claim", points: [[1030, 196], [1062, 196]], labelAt: [1046, 196], proposed: hybrid },
    { from: dispatcher.id, to: "ledger", label: "state", points: [[921, 252], [921, 455]], labelAt: [921, 350], support: true },
    { from: "executors", to: "gateway", label: "grant", points: [[1171, 252], [1171, 455]], labelAt: [1171, 350] },
    { from: "gateway", to: "foundry", label: "models", points: [[1171, 567], [1171, 690]], labelAt: [1171, 628] },
  ];
  if (hybrid) {
    nodes.push(
      { id: "shared", title: "Shared coordinator", caption: "In process (proposed)", x: 561, y: 140, proposed: true,
        purpose: "Run many tenant sessions on one worker. Answer lightweight prompts without allocating an execution container, and let the model delegate expensive work.",
        limitation: "Distinct CLI identities, virtual-workspace publication, owner-scoped catalogs, and recovery still require qualification." },
      { id: "session-fs", title: "Session FS", caption: "Scoped state (proposed)", x: 561, y: 455, proposed: true,
        purpose: "Keep runtime state and lightweight workspace files in tenant/session-scoped storage independently of runtime residency.",
        limitation: "Session FS is not an OS sandbox. Container inputs and outputs cross an explicit immutable artifact boundary." },
    );
    edges.push(
      { from: "entry", to: "shared", label: "route", points: [[528, 196], [561, 196]], labelAt: [544, 196], proposed: true },
      { from: "shared", to: "scheduler", label: "delegate", points: [[779, 196], [812, 196]], labelAt: [795, 196], proposed: true },
      { from: "shared", to: "session-fs", label: "session state", points: [[670, 252], [670, 455]], labelAt: [670, 350], support: true, proposed: true },
      { from: "shared", to: "gateway", label: "managed inference", points: [[740, 252], [740, 305], [1100, 305], [1100, 455]], labelAt: [905, 305], proposed: true },
    );
  } else {
    edges.push({ from: "entry", to: "dispatcher", label: "admitted jobs", points: [[528, 196], [812, 196]], labelAt: [670, 196] });
  }
  if (hostEnabled && native) {
    nodes.push({ id: "copilot", title: "GitHub Copilot", caption: "Native model access", x: 310, y: 690,
      purpose: "Native container-host conversations use Copilot inference and the connected account's entitlement.",
      limitation: "This is a different provider/billing path from Foundry. Do not present it as a same-model architecture benchmark." });
    edges.push({ from: "container", to: "copilot", label: "native inference", points: [[419, 567], [419, 690]], labelAt: [419, 628] });
  } else if (hostEnabled) {
    edges.push({ from: "container", to: "gateway", label: "managed conversation", points: [[419, 567], [419, 620], [1100, 620], [1100, 567]], labelAt: [760, 620] });
  }
  if (hybrid && localHybrid) {
    for (const node of nodes) {
      if (["shared", "scheduler", "executors", "session-fs"].includes(node.id)) node.proposed = false;
      if (node.id === "shared") Object.assign(node, {
        caption: "Local / in process", resource: "session-host",
        purpose: "Share one in-process runtime across provider-backed conversations, with protected CLI tickets, budgets, turn scheduling and idle eviction.",
        limitation: "One real-account CLI path is qualified. This is not two-account or hostile cross-customer isolation.",
      });
      if (node.id === "scheduler") Object.assign(node, {
        caption: "Local Docker lifecycle", resource: "execution-controller",
        purpose: "Admit actual one-shot containers under global, principal and conversation limits; reconcile starts and teardown using durable allocations.",
        limitation: "Docker authority belongs only to this operator-owned process. The Azure adapter is not qualified.",
      });
      if (node.id === "executors") Object.assign(node, {
        caption: "One-shot Linux containers",
        limitation: "No idle pool in local hybrid mode. Allocation counts are not live telemetry on this page; inspect the controller and ledger.",
      });
      if (node.id === "session-fs") Object.assign(node, {
        caption: "PostgreSQL / leased files",
        limitation: "Empty native anchors carry paths, not file contents. Selected input snapshots and explicit output imports do not share writable files with jobs.",
      });
      if (node.id === "ledger") Object.assign(node, {
        caption: "Sessions, jobs & artifacts",
        limitation: "State is principal/epoch fenced. Retention is operator-managed; a closed conversation is not deleted.",
      });
    }
    for (const edge of edges) edge.proposed = false;
  }
  return { nodes, edges };
}

export function hostingObservation(node: HostingNode, target: TryTarget, local?: LocalStackStatus, azure?: AzureStatus): string {
  if (node.proposed) return "Proposed / not implemented";
  if (!node.resource) return "No service observation";
  if (target === "local") return local?.resources.find((resource) => resource.name === node.resource)?.state || "Not observed";
  return azure?.apps.find((app) => app.name === node.resource)?.runningStatus || "Not observed";
}

export function hostingPlacement(node: HostingNode, target: TryTarget): string {
  if (node.proposed) return "Proposed; no deployed resource";
  if (node.id === "ledger") return target === "local" ? "Local PostgreSQL container" : "Azure Database for PostgreSQL";
  if (node.id === "session-fs") return "Scoped files in PostgreSQL; empty native path anchors";
  if (node.id === "container" || node.id === "executors") return target === "local" ? "Linux container" : "Azure Container App";
  if (node.resource) return target === "local" ? "Host Node.js process" : "Azure Container App";
  if (node.id === "cli") return "User's machine or API caller";
  if (node.id === "transport") return "Configured AHP connection path";
  return "External model service";
}

/** One way to connect Copilot CLI to a harness: a copyable launcher command, or the reason it is unavailable. */
export interface HarnessConnection {
  transport: "direct" | "github";
  label: string;
  command?: string;
  disabledReason?: string;
}

/** What hosts a harness in one deployment, what keeps costing while idle, and how Copilot CLI connects. */
export interface HarnessHostRow {
  host: string;
  hostDetail: string;
  costNote?: string;
  connections: HarnessConnection[];
}

/** The launcher command for one harness: `pnpm host:connect --harness`, which routes by the service's placement. */
export function launcherCommand(harness: string, target: TryTarget, transport: "direct" | "github"): string {
  return `pnpm host:connect --harness ${harness} --target ${target} --transport ${transport}`;
}

export function harnessHostRow(view: HarnessHostingView, hosts: HostingHostsView, target: TryTarget): HarnessHostRow {
  if (view.interaction === "batch") {
    return {
      host: hosts.executor ? "Executor pool" : "No executor",
      hostDetail: "Runs as jobs through the jobs API, with no client transport.",
      connections: [],
    };
  }
  let host: string;
  let hostDetail: string;
  let costNote: string | undefined;
  const ownerHost = hosts.isolatedHosts.find((entry) => entry.harness === view.harness);
  if (view.placement === "container") {
    if (ownerHost) {
      host = "Owner host";
      hostDetail = "A dedicated container for this harness, connectable by its owner only.";
      costNote = "Always on: an owner host runs, and costs compute, for as long as it is deployed, whether or not anyone is connected.";
    } else if (hosts.sessionContainers) {
      host = "Session containers";
      hostDetail = "A container per session, stopped when idle and resumed from its volume.";
      costNote = "No idle compute; each new or resumed session waits for a container to start.";
    } else {
      host = "No host";
      hostDetail = "No isolated host or session containers serve this harness here.";
    }
  } else if (hosts.sharedWorker) {
    host = "Shared worker";
    hostDetail = "One in-process runtime shared with other harnesses' sessions.";
    costNote =
      view.mode === "promotable"
        ? "The shared worker is always on; a promoted session adds one container."
        : view.mode === "orchestrator"
          ? "The shared worker is always on; each worker adds container time."
          : "The shared worker is always on and shared by many sessions; a session itself starts no container.";
  } else {
    host = "No shared worker";
    hostDetail = "This deployment has no harness-driven shared worker.";
  }
  const blocking = view.problems[0];
  const connections = view.transports.map((transport): HarnessConnection => {
    const label = TRANSPORT_INFO[transport.transport].label;
    const problem = blocking ?? transport.problem;
    if (problem || !transport.available) {
      return { transport: transport.transport, label, disabledReason: problem ? describeProblem(problem) : `${label} is not available.` };
    }
    if (view.placement === "shared") {
      return target === "local"
        ? { transport: transport.transport, label, command: launcherCommand(view.harness, target, transport.transport) }
        : { transport: transport.transport, label, disabledReason: "The launcher connects to shared hosting locally only; Azure qualification remains open." };
    }
    if (ownerHost) return { transport: transport.transport, label, command: launcherCommand(view.harness, target, transport.transport) };
    return { transport: transport.transport, label, disabledReason: "The launcher cannot connect to per-session containers yet." };
  });
  return { host, hostDetail, ...(costNote ? { costNote } : {}), connections };
}
