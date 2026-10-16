// Plain-language descriptions of hosting modes, approval modes and transports, shared by the harness editor, the
// Policy page and the Hosting page. Keyed records make TypeScript flag a mode the contracts add but this copy lacks.
import type { ExecutionPolicy, HostingMode, HostingPlacement, HostingProblem, HostingStatus } from "../server/types";
import type { Tone } from "./components/ui";

export type ApprovalMode = NonNullable<ExecutionPolicy["approvalModes"]>[number];
export type HostingTransport = NonNullable<NonNullable<ExecutionPolicy["hosting"]>["transports"]>[number];

export const STATUS_BADGES: Record<HostingStatus, { tone: Tone; label: string }> = {
  ready: { tone: "green", label: "Ready" },
  unavailable: { tone: "amber", label: "Unavailable" },
  rejected: { tone: "red", label: "Rejected by policy" },
  not_allowed: { tone: "red", label: "Mode not allowed" },
};

export const PLACEMENT_LABELS: Record<HostingPlacement, string> = {
  executor: "Batch jobs on the executor",
  container: "A dedicated container",
  shared: "The shared worker",
};

export const MODE_INFO: Record<HostingMode, { label: string; summary: string; gains: string; costs: string }> = {
  isolated: {
    label: "Isolated container",
    summary: "The whole agent loop runs in a dedicated Linux container with a real filesystem.",
    gains: "Any tool, including shell and Python; the strongest separation between sessions.",
    costs: "A container per host or session: always-on compute for an owner host, cold starts for per-session containers.",
  },
  shared: {
    label: "Shared runtime",
    summary: "Many sessions share one in-process runtime, with virtual files stored in PostgreSQL.",
    gains: "No containers: fast to start and cheap to keep. Web access and remote MCP servers still work.",
    costs: "No shell, Python, or local MCP tools. Sessions are separated by application checks, not an operating-system boundary.",
  },
  promotable: {
    label: "Shared, then promotable",
    summary: "Starts on the shared runtime and can move one way into its own container mid-conversation.",
    gains: "A cheap start with an escape hatch to real files, a shell, or more time.",
    costs: "One container after promotion; a person approves promotion unless policy allows automatic promotion.",
  },
  orchestrator: {
    label: "Orchestrator",
    summary: "A coordinator on the shared runtime starts worker harnesses in their own sized containers.",
    gains: "Parallel or mixed work with low-cost coordination and an optional shared session volume.",
    costs: "Container time per worker. Workers' permission requests go to a person, never to the coordinator.",
  },
};
export const HOSTING_MODE_ORDER = Object.keys(MODE_INFO) as HostingMode[];

export const APPROVAL_INFO: Record<ApprovalMode, { label: string; detail: string }> = {
  manual: {
    label: "Manual",
    detail: "A person decides, through the attached client or the request queue.",
  },
  assisted: {
    label: "Assisted",
    detail:
      "The Copilot runtime's safety judge approves a request or sends it to a person. It reduces prompts but is not a security boundary: only the person's own messages grant authority.",
  },
  "allow-all": {
    label: "Allow all",
    detail: "Requests that would ask a person are approved automatically. Per-kind deny rules still apply.",
  },
  custom: {
    label: "Custom handler",
    detail: "Reviewed integrator code, registered in an execution profile, approves, denies, or asks a person.",
  },
};
export const APPROVAL_ORDER = Object.keys(APPROVAL_INFO) as ApprovalMode[];

export const TRANSPORT_INFO: Record<HostingTransport, { label: string; detail: string }> = {
  direct: { label: "Direct WSS", detail: "Copilot CLI connects straight to the host with a one-use ticket and a pinned server key." },
  github: { label: "GitHub relay", detail: "Copilot CLI attaches through Mission Control. Isolated hosts only, for their owner." },
};

const PREREQUISITES: Record<string, string> = {
  "host:executor": "the batch executor",
  "host:isolated-host": "an isolated host for this harness",
  "host:session-containers": "session containers",
  "host:shared-worker": "the harness-driven shared worker",
  "host:worker-containers": "worker containers",
  "transport:direct": "direct WSS on its host",
  "transport:github": "the GitHub relay on its host",
  "feature:remote-mcp": "remote MCP support in its host",
  "feature:approval-modes": "approval-mode support in its host",
  "feature:custom-approval": "custom permission handlers in its host",
  "feature:handoffs": "handoff support",
  "feature:promotion": "promotion support",
  "feature:crafted-workers": "crafted workers",
  "feature:inherited-authority": "inherited human authority",
  "feature:shared-storage": "shared session storage",
};

/** What a deployment lacks, in words, for problems that name a prerequisite. */
export function prerequisiteLabel(problem: Pick<HostingProblem, "prerequisite">): string | undefined {
  const prerequisite = problem.prerequisite;
  return prerequisite ? (PREREQUISITES[`${prerequisite.kind}:${prerequisite.name}`] ?? prerequisite.name) : undefined;
}

/** A problem's message followed by the prerequisite it names, if any. */
export function describeProblem(problem: Pick<HostingProblem, "message" | "prerequisite">): string {
  const needs = prerequisiteLabel(problem);
  return needs ? `${problem.message} Needs ${needs}.` : problem.message;
}
