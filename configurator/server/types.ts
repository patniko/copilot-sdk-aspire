// Types shared by the configurator server and UI. Type-only imports keep the UI bundle free of server code.
import type { DemoHostSettings, ExecutionPolicy, HarnessDefinition, HarnessPolicyOverride, SkillDefinition } from "@copilot-agent/contracts";

export type { ExecutionPolicy, HarnessPolicyOverride, SkillDefinition };

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
  changes: { items: string[] };
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
  npmRegistry: string;
  pipIndexUrl: string;
  /** Replaces nuget.org for Aspire CLI restores (corporate proxies). */
  nugetServiceIndex: string;
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
