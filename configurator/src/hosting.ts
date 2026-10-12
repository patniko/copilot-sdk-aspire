import type { DemoHostSettings } from "@copilot-agent/contracts";
import type { AzureStatus, LocalStackStatus, TryTarget } from "../server/types";

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

export const HOSTING_WIDTH = 1190;
export const HOSTING_HEIGHT = 770;
export const HOSTING_NODE_WIDTH = 190;
export const HOSTING_NODE_HEIGHT = 95;

export function hostingTopology(architecture: HostingArchitecture, transport: DemoHostSettings["transport"]): HostingTopology {
  const hybrid = architecture === "hybrid";
  const native = transport === "github";
  const hostEnabled = transport !== "disabled";
  const nodes: HostingNode[] = [
    { id: "cli", title: "Clients", caption: "Copilot CLI / job API", x: 40, y: 110,
      purpose: "Copilot CLI uses the configured interactive host. API clients submit batch jobs. The proposal adds a shared coordinator as another CLI destination.",
      limitation: "Shared-host attachment is a qualification gate, not an available launcher yet." },
    { id: "entry", title: "Agent API", caption: "Admission & provisioning", x: 270, y: 110, resource: "agent-api",
      purpose: "Authenticate callers, admit jobs, and provision protected connection material for the configured host.",
      limitation: "Connection provisioning is not a public SDK port or permission to access another principal's sessions." },
    { id: "executors", title: hybrid ? "Job containers" : "Executor pool", caption: hybrid ? "On demand (proposed)" : "Linux / runner slots", x: 960, y: 110, proposed: hybrid, resource: hybrid ? undefined : "agent-executor",
      purpose: hybrid ? "Allocate real container executions only when an admitted delegation needs them; return results and retire unused capacity." : "A running Linux container polls for jobs and launches UID-isolated runners in private attempt workspaces.",
      limitation: hybrid ? "Zero-to-many-to-zero provisioning is not implemented. Starting a runner process is not starting a container." : "The current pool remains allocated when idle. Attempt files are ephemeral; attempts are bounded to one hour." },
    { id: "transport", title: native ? "GitHub relay" : transport === "both" ? "WSS / GitHub relay" : "Direct WSS", caption: hostEnabled ? "Configured transport" : "Host not configured", x: 40, y: 385,
      purpose: native ? "The configured GitHub-native host uses outbound Mission Control connections for CLI attachment." : "The managed host's configured transport carries AHP traffic; direct connections use provisioned keys and one-time tickets.",
      limitation: hostEnabled ? "Transport choice is independent of execution destination. Managed transports still require a qualified runtime/client pair." : "Enable a container host in Local run or Deploy before using a CLI launcher." },
    { id: "container", title: "Container agent", caption: hostEnabled ? native ? "GitHub-native session" : "Managed conversation" : "Optional / disabled", x: 270, y: 385, resource: "agent-host",
      purpose: "Preserve the directly attachable, retained container conversation without first entering the shared coordinator.",
      limitation: "This host is separate from batch attempts. A running batch job is not automatically a CLI-attachable session." },
    { id: "ledger", title: "PostgreSQL", caption: "Jobs, leases & events", x: 730, y: 385, resource: "postgres",
      purpose: hybrid ? "Keep jobs authoritative and add session ownership, activation leases, delegation identities, and completion delivery." : "Persist caller-scoped jobs, attempts, capabilities, approvals, and events independently of worker processes.",
      limitation: hybrid ? "The session/delegation records in the hybrid design are proposed extensions, not existing job behavior." : "Durable job records do not restore an ended SDK conversation or its workspace." },
    { id: "gateway", title: "Inference gateway", caption: "Managed model access", x: 960, y: 385, resource: "inference-gateway",
      purpose: "Validate session or job inference grants and attach the gateway-owned provider credential.",
      limitation: "Gateway routing does not establish enforced network egress. Usage reporting is asynchronous, not exact billing reservation." },
    { id: "foundry", title: "Foundry", caption: "Configured deployments", x: 960, y: 620,
      purpose: "Serve the approved model deployments for managed sessions and jobs.",
      limitation: "Model latency and provider quota remain part of the result; more containers do not increase model quota." },
  ];
  const dispatcher: HostingNode = hybrid
    ? { id: "scheduler", title: "Execution controller", caption: "Allocation (proposed)", x: 730, y: 110, proposed: true,
      purpose: "Turn admitted delegations into bounded container allocations, reconcile failures, and deliver completion notifications.",
      limitation: "Infrastructure permissions belong here, not in the model-facing runtime. Polling alone cannot wake a zero-replica pool." }
    : { id: "dispatcher", title: "Job dispatcher", caption: "Claims & capabilities", x: 730, y: 110, resource: "job-dispatcher",
      purpose: "Match jobs to eligible executors, fence attempt ownership, issue inference capabilities, and recover expired leases.",
      limitation: "The current dispatcher schedules attempt slots; it does not provision containers per job." };
  nodes.push(dispatcher);
  const edges: HostingEdge[] = [
    { from: "cli", to: "entry", label: "Provision / API jobs", points: [[230, 157], [270, 157]], labelAt: [250, 220] },
    { from: "cli", to: "transport", label: "Selected transport", points: [[135, 205], [135, 385]], labelAt: [135, 294] },
    { from: "transport", to: "container", label: "Container session", points: [[230, 432], [270, 432]], labelAt: [250, 530] },
    { from: dispatcher.id, to: "executors", label: hybrid ? "Allocate" : "Claim / heartbeat", points: [[920, 157], [960, 157]], labelAt: [940, 245], proposed: hybrid },
    { from: dispatcher.id, to: "ledger", label: "Durable ownership", points: [[825, 205], [825, 385]], labelAt: [825, 294], support: true },
    { from: "executors", to: "gateway", label: "Inference grant", points: [[1055, 205], [1055, 385]], labelAt: [1055, 294] },
    { from: "gateway", to: "foundry", label: "Gateway identity", points: [[1055, 480], [1055, 620]], labelAt: [1055, 551] },
  ];
  if (hybrid) {
    nodes.push(
      { id: "shared", title: "Shared coordinator", caption: "In process (proposed)", x: 500, y: 110, proposed: true,
        purpose: "Run many tenant sessions on one worker. Answer lightweight prompts without allocating an execution container, and let the model delegate expensive work.",
        limitation: "Distinct CLI identities, virtual-workspace publication, owner-scoped catalogs, and recovery still require qualification." },
      { id: "session-fs", title: "Session FS", caption: "Scoped state (proposed)", x: 500, y: 385, proposed: true,
        purpose: "Keep runtime state and lightweight workspace files in tenant/session-scoped storage independently of runtime residency.",
        limitation: "Session FS is not an OS sandbox. Container inputs and outputs cross an explicit immutable artifact boundary." },
    );
    edges.push(
      { from: "entry", to: "shared", label: "Shared admission", points: [[460, 157], [500, 157]], labelAt: [480, 220], proposed: true },
      { from: "shared", to: "scheduler", label: "Delegate job", points: [[690, 157], [730, 157]], labelAt: [710, 220], proposed: true },
      { from: "shared", to: "session-fs", label: "Session state", points: [[595, 205], [595, 385]], labelAt: [595, 294], support: true, proposed: true },
      { from: "shared", to: "gateway", label: "Managed inference", points: [[660, 205], [660, 265], [980, 265], [980, 385]], labelAt: [720, 265], proposed: true },
    );
  } else {
    edges.push({ from: "entry", to: "dispatcher", label: "Admitted jobs", points: [[460, 157], [730, 157]], labelAt: [595, 140] });
  }
  if (hostEnabled && native) {
    nodes.push({ id: "copilot", title: "GitHub Copilot", caption: "Native model access", x: 270, y: 620,
      purpose: "Native container-host conversations use Copilot inference and the connected account's entitlement.",
      limitation: "This is a different provider/billing path from Foundry. Do not present it as a same-model architecture benchmark." });
    edges.push({ from: "container", to: "copilot", label: "Native inference", points: [[365, 480], [365, 620]], labelAt: [365, 579] });
  } else if (hostEnabled) {
    edges.push({ from: "container", to: "gateway", label: "Managed conversation grant", points: [[365, 480], [365, 565], [1010, 565], [1010, 480]], labelAt: [690, 565] });
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
  if (node.id === "container" || node.id === "executors") return target === "local" ? "Linux container" : "Azure Container App";
  if (node.resource) return target === "local" ? "Host Node.js process" : "Azure Container App";
  if (node.id === "cli") return "User's machine or API caller";
  if (node.id === "transport") return "Configured AHP connection path";
  return "External model service";
}
