// Types shared by the configurator server and UI. Type-only imports keep the UI bundle free of server code.
import type {
  AgentDefinition,
  DemoHostSettings,
  EffectiveHostingPolicy,
  ExecutionPolicy,
  HarnessDefinition,
  HarnessHostingView,
  HarnessPolicyOverride,
  HostingCeilings,
  HostingHostsView,
  HostingMode,
  HostingOverview,
  HostingPlacement,
  HostingProblem,
  HostingStatus,
  HostingTransportView,
  SkillDefinition,
  ToolRequest,
} from "@copilot-agent/contracts";

export type {
  EffectiveHostingPolicy,
  ExecutionPolicy,
  HarnessHostingView,
  HarnessPolicyOverride,
  HostingCeilings,
  HostingHostsView,
  HostingMode,
  HostingOverview,
  HostingPlacement,
  HostingProblem,
  HostingStatus,
  HostingTransportView,
  SkillDefinition,
};

/**
 * harness.json on disk: the harness contract with `instructionsFile` in place of inline instructions
 * and `skills` as folder names under skills/ (each holding a SKILL.md).
 */
export type HarnessManifest = Omit<HarnessDefinition, "instructions" | "skills"> & {
  instructionsFile: string;
  skills?: string[];
};

export interface HarnessDocument {
  /** Folder name under harnesses/. */
  folder: string;
  manifest: HarnessManifest;
  instructions: string;
  /** Skills stored as skills/<name>/SKILL.md. Authoritative: manifest.skills is derived from it on save. */
  skills: SkillDefinition[];
}

export type AuthoringKind = "agent" | "skill" | "tool" | "tool-code";

/** Code proposals are inert text, not installed bindings or executable configurator tasks. */
export interface ToolCodeProposal {
  name: string;
  summary: string;
  files: Array<{ path: string; content: string }>;
  instructions: string;
}

export type AuthoringDraft =
  | { kind: "agent"; agent: AgentDefinition }
  | { kind: "skill"; skill: SkillDefinition }
  | { kind: "tool"; tool: ToolRequest }
  | { kind: "tool-code"; proposal: ToolCodeProposal };

export interface Issue {
  level: "error" | "warning";
  /** Dotted path into the document, e.g. "input.schema" or "runners.allowedProfiles". */
  path: string;
  message: string;
  fix?: "bump-patch";
}

export interface HarnessSummary {
  folder: string;
  name: string;
  version: string;
  description: string;
  latest: boolean;
  /** Differs from the platform example with the same folder name. */
  modified: boolean;
  /** Has no platform example with the same folder name. */
  untracked: boolean;
  /** Set when the harness opts into multi-turn conversations (the demo agent host). */
  interaction?: "conversation";
  errors: number;
  warnings: number;
  /** Content digest the API would assign (absent if invalid). */
  digest?: string;
}

export interface ProfileSummary {
  id: string;
  displayName: string;
  language: string;
  sdk: string;
  sdkVersion: string;
  firstParty: boolean;
  toolBindings: string[];
  capabilities: string[];
  /** Host bindings the profile marks safe to run inside a shared worker's process. */
  inProcessBindings?: string[];
  /** Custom permission handlers the profile provides. */
  permissionHandlers?: string[];
}

export interface BindingInfo {
  id: string;
  kind: "python" | "host" | "mcp-local";
  description: string;
  profiles: string[];
}

export interface WorkspaceInfo {
  /** Customer-authored configuration root. */
  root: string;
  /** Platform source repository used for builds and immutable profiles/tools. */
  platformRoot: string;
  harnesses: HarnessSummary[];
  profiles: ProfileSummary[];
  bindings: BindingInfo[];
  policy: ExecutionPolicy;
  policyIssues: Issue[];
  /** Operator overrides in policy/harnesses/, with the fields they replace. */
  policyOverrides: Array<{ harness: string; fields: string[]; errors: number }>;
  /** Values that apply when optional policy fields are omitted, so the Policy page can show them. */
  policyDefaults: PolicyDefaults;
  changes: { items: string[] };
}

export interface PolicyDefaults {
  /** Hosting ceilings of a policy without a `hosting` block. */
  hosting: EffectiveHostingPolicy;
  /** Approval modes of a policy without `approvalModes`. */
  approvalModes: string[];
}

/** One harness's override and the effective policy it produces (the base policy when there is none). */
export interface PolicyOverrideStatus {
  harness: string;
  override?: HarnessPolicyOverride;
  effective: ExecutionPolicy;
  issues: Issue[];
}

export interface EffectiveLimits {
  maxDurationSeconds: number;
  tokenBudget: number;
  maxAttempts: number;
  model?: string;
}

export interface HarnessDetail {
  document: HarnessDocument;
  issues: Issue[];
  effective: EffectiveLimits;
  /** Policy fields replaced by an operator override for this harness (empty: the base policy applies). */
  policy: { overridden: string[] };
  digest?: string;
  /** Things the author should know or decide: who implements what, what to review, accepted gaps. */
  decisions: Decision[];
  /** Runner capabilities this harness needs beyond the protocol baseline. */
  requiredCapabilities: string[];
  /** What the Hosting section may offer under the effective policy, and where the harness can run. */
  hosting?: HarnessHostingDetail;
}

/** An operator MCP catalog entry as harness authors see it: the server's URL and secret reference stay on the Policy page. */
export interface McpCatalogEntry {
  server: string;
  description?: string;
  tools: string[];
}

/** Another workspace harness (its latest version) as a candidate worker or handoff target. */
export interface HostingTargetSummary {
  name: string;
  version: string;
  description: string;
  interaction: "batch" | "conversation";
  /** The hosting mode the target declares. */
  mode: HostingMode;
  /** Whether the target's effective policy allows its own mode (required for handoff targets). */
  modeAllowed: boolean;
  /** Whether the target's effective policy allows isolated hosting (required for workers). */
  isolatedAllowed: boolean;
}

export interface HarnessHostingDetail {
  /** Effective operator ceilings for this harness (base policy plus its override). */
  ceilings: HostingCeilings;
  /** Catalog servers this harness may request, with their approved tools. */
  mcpCatalog: McpCatalogEntry[];
  /** Models the effective policy approves; judge models must also be among the harness's allowed models. */
  allowedModels: string[];
  /** Custom permission handlers the TypeScript conversation profile provides. */
  profileHandlers: string[];
  /** Other harnesses that can be listed as workers or handoff targets. */
  targets: HostingTargetSummary[];
}

/** Where `pnpm host:connect --harness` connects: a conversation through `/v1/sessions`, or the harness's owner host. */
export type HarnessConnectRoute = { kind: "sessions"; placement: "shared" | "container" } | { kind: "owner-host" };

/** The launcher's decision for one harness and transport: where it connects, or why it refuses. */
export interface HarnessConnectDecision {
  /** Where the launcher connects, decided with its own routing. */
  route?: HarnessConnectRoute;
  /** The service's hosting problem that refuses the transport, in the launcher's order. */
  problem?: HostingProblem;
  /** The launcher's own reason for refusing, such as a target it does not support yet or a failed lookup. */
  refusal?: string;
}

/** How `pnpm host:connect --harness` would connect the configurator's API principal to one conversation harness. */
export interface HarnessConnectInfo {
  /** Whether that principal owns a managed owner host for the harness (`GET /v1/hosts`). */
  ownsHost: boolean;
  transports: Partial<Record<HostingTransportView["transport"], HarnessConnectDecision>>;
}

/** The Hosting page's per-harness view for one deployment target, read from that target's agent-api. */
export interface HostingPageInfo {
  target: TryTarget;
  /** The running agent-api's `GET /v1/hosting` view, when it could be read. */
  overview?: HostingOverview;
  /** Why the view could not be read. */
  problem?: string;
  /** Latest workspace versions the service has not loaded as saved: absent from its view, or loaded with another digest. */
  stale: Array<{ harness: string; version: string; reason: "missing" | "changed" }>;
  /** Per conversation harness, the launcher's decisions for a new conversation on this target. */
  connections?: Record<string, HarnessConnectInfo>;
}

/** One harness version as a target's agent-api hosts it (`GET /v1/hosting/{harness}`). */
export interface HarnessHostingInfo {
  target: TryTarget;
  view?: HarnessHostingView;
  /** Why the view could not be read, for example because the service has not loaded this version. */
  problem?: string;
}

export interface Decision {
  /** host: the platform implements or enforces it; review: the author should check it; gap: not enforced; info: context. */
  kind: "host" | "review" | "gap" | "info";
  title: string;
  detail: string;
  /** Document path the decision relates to, for navigation (same format as Issue.path). */
  path?: string;
}

export interface HarnessChange {
  /** Dotted path, e.g. "model.reasoningEffort", "instructions", "skills.insight-review". */
  path: string;
  change: "added" | "removed" | "changed";
}

export interface HarnessChanges {
  /** False when the folder has never been committed (everything is new). */
  committed: boolean;
  changes: HarnessChange[];
}

export interface TemplateInfo {
  id: "structured-answer" | "data-analysis" | "skill-guided" | "agent-team" | "copilot-coding";
  title: string;
  summary: string;
  bestFor: string;
  promptMode: "replace" | "append" | "customize";
  tools: number;
  agents: number;
  skills: number;
  reasoningEffort?: string;
  /** Built-in Copilot tool groups (files, shell, web, agents). */
  builtinTools: string[];
  /** Short description of how permission requests are handled. */
  permissions: string;
  profiles: string[];
}

export interface ImportReport {
  /** Plan settings carried into the harness. */
  mapped: string[];
  /** Plan settings that need work before they can run (e.g. custom tools need a binding). */
  needsWork: string[];
  /** Plan settings that do not apply to a hosted agent service, with the reason. */
  notApplicable: string[];
}

export interface ImportResult {
  document: HarnessDocument;
  report: ImportReport;
  issues: Issue[];
}

export interface HarnessExport {
  /** The definition exactly as the agent API loads it (instructions and skills inlined). */
  definition: unknown;
  digest: string;
}

export interface LocalSettings {
  demoHost?: DemoHostSettings;
  foundryEndpoint: string;
  foundryDeployments: string[];
  /** Bare Copilot model IDs the gateway exposes as `github/<id>`; empty exposes every usable model. */
  githubInferenceModels: string[];
  npmRegistry: string;
  pipIndexUrl: string;
  /** Replaces nuget.org for Aspire CLI restores (corporate proxies). */
  nugetServiceIndex: string;
}

/** A GitHub Copilot model the stored token can use, as the inference gateway would route it. */
export interface GitHubInferenceModel {
  id: string;
  name: string;
  /** The gateway model name harnesses and policy use: `github/<id>`. */
  routedAs: string;
  policyState?: string;
  /** Premium request multiplier relative to the plan's base rate. */
  multiplier?: number;
}

export interface DeployTarget {
  demoHost?: DemoHostSettings;
  name: string;
  tenantId: string;
  subscriptionId: string;
  location: string;
  resourceGroup: string;
  foundryAccount: string;
  foundryResourceGroup: string;
  foundryEndpoint: string;
  foundryDeployments: string[];
}

export interface SettingsInfo {
  local: LocalSettings;
  targets: DeployTarget[];
  selectedTarget?: string;
  /** Whether the demo host GitHub credential exists. The credential itself is never returned. */
  demoHostCredentialStored: boolean;
  /** Whether the GitHub inference token exists. The token itself is never returned. */
  githubInferenceCredentialStored: boolean;
  /** Where local values are stored (Aspire user secrets file), for display. */
  secretsPath?: string;
}

export type TaskKind =
  | "validate"
  | "test-unit"
  | "test-all"
  | "build"
  | "local-start"
  | "local-stop"
  | "local-restart-api"
  | "publish"
  | "deploy"
  | "az-login";

export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface TaskInfo {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Short command line shown to the user (no secrets). */
  command: string;
}

export interface TaskLine {
  seq: number;
  text: string;
  stream: "stdout" | "stderr" | "system";
}

export interface ToolStatus {
  ok: boolean;
  version?: string;
  detail?: string;
}

export interface EnvironmentStatus {
  node: ToolStatus;
  pnpm: ToolStatus;
  aspire: ToolStatus;
  docker: ToolStatus;
  azure: ToolStatus & { tenantId?: string; subscriptionId?: string; subscriptionName?: string; user?: string };
}

export interface LocalResource {
  name: string;
  type: string;
  state: string;
  health?: string;
  urls: Array<{ name: string; url: string }>;
}

export interface LocalStackStatus {
  running: boolean;
  dashboardUrl?: string;
  apiUrl?: string;
  resources: LocalResource[];
}

export interface AzureApp {
  name: string;
  provisioningState: string;
  runningStatus: string;
  fqdn?: string;
  external: boolean;
}

export interface AzureStatus {
  target: string;
  resourceGroupExists: boolean;
  apps: AzureApp[];
  apiUrl?: string;
  error?: string;
}

export interface AzureSubscription {
  id: string;
  name: string;
  tenantId: string;
  isDefault: boolean;
}

export interface AzureLocation {
  name: string;
  displayName: string;
  geography?: string;
}

export interface AzureResourceGroup {
  name: string;
  location: string;
}

export interface FoundryAccount {
  name: string;
  resourceGroup: string;
  location: string;
  endpoint: string;
  kind: string;
}

export interface FoundryDeployment {
  name: string;
  model: string;
  version: string;
  sku: string;
  capacity?: number;
}

export type TryTarget = "local" | "azure";

// Demos page (configurator/server/demos.ts)

export interface DemoCheck {
  id: "stack" | "inline" | "modes" | "workers" | "model" | "cli";
  label: string;
  ok: boolean;
  detail: string;
  /** What the page can do about it: rewrite the base policy, or start the stack from Local run. */
  fix?: "prepare" | "start";
}

export interface DemoModeInfo {
  mode: "shared" | "isolated" | "promotable" | "orchestrator";
  title: string;
  tagline: string;
  story: string;
  prompts: string[];
  /** The harness definition the launch submits, for the selected model. */
  definition: HarnessDefinition;
  /** Why this mode cannot launch right now; empty when it can. */
  problems: string[];
}

export interface DemosInfo {
  checks: DemoCheck[];
  modes: DemoModeInfo[];
  models: string[];
  model: string;
  cli: { command: string; found: boolean };
}

export interface DemoLaunch {
  session: unknown;
  definition: HarnessDefinition;
  terminal: { opened: boolean; command: string; error?: string };
}
