// Types shared by the configurator server and UI. Type-only imports keep the UI bundle free of server code.
import type { ExecutionPolicy, HarnessDefinition } from "@copilot-agent/contracts";

export type { ExecutionPolicy };

/** harness.json on disk: the harness contract with `instructionsFile` in place of inline instructions. */
export type HarnessManifest = Omit<HarnessDefinition, "instructions"> & { instructionsFile: string };

export interface HarnessDocument {
  /** Folder name under harnesses/. */
  folder: string;
  manifest: HarnessManifest;
  instructions: string;
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
  /** Differs from the committed version in git. */
  modified: boolean;
  /** Not yet committed. */
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
  root: string;
  harnesses: HarnessSummary[];
  profiles: ProfileSummary[];
  bindings: BindingInfo[];
  policy: ExecutionPolicy;
  policyIssues: Issue[];
  git: { branch: string; changedConfig: string[] };
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
  digest?: string;
}

export interface LocalSettings {
  foundryEndpoint: string;
  foundryDeployments: string[];
  npmRegistry: string;
  pipIndexUrl: string;
  /** Replaces nuget.org for Aspire CLI restores (corporate proxies). */
  nugetServiceIndex: string;
}

export interface DeployTarget {
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
