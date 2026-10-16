import type { EffectiveHostingPolicy, ExecutionPolicy, Issue } from "../../../server/types";

/** Policy cards and the fields a harness override replaces when that card is overridden. */
export const GROUPS = {
  agents: ["allowedProfiles", "allowedModels"],
  limits: ["maxDurationSeconds", "maxInferenceTokensPerJob", "retry"],
  tools: ["builtinTools", "permissionModes"],
  approvals: ["approvalModes", "permissionHandlers"],
  mcp: ["mcpServers"],
  model: ["maxReasoningEffort", "allowLongContext"],
  hosting: ["hosting"],
  controls: ["requirements", "acknowledgedGaps"],
} as const satisfies Record<string, ReadonlyArray<keyof ExecutionPolicy>>;
export type Group = keyof typeof GROUPS;
export type Overrides = Partial<ExecutionPolicy>;

/** Fields that only the base policy sets. They are shown on the limits card. */
export const GLOBAL_FIELDS = ["leaseSeconds", "maxConcurrentAttemptsPerPrincipal", "maxQueuedJobsPerPrincipal"] as const;

/** What the page edits: the policy plus, in harness scope, the overridden cards. Serializable for drafts. */
export interface PolicyDraft {
  policy: ExecutionPolicy;
  groups: Group[];
}

const ORDER = Object.keys(GROUPS) as Group[];

export function overriddenGroups(overrides: Overrides | undefined): Group[] {
  const keys = new Set(Object.keys(overrides ?? {}));
  return ORDER.filter((group) => GROUPS[group].some((field) => keys.has(field)));
}

export function withGroup(groups: Group[], group: Group, on: boolean): Group[] {
  return ORDER.filter((g) => (g === group ? on : groups.includes(g)));
}

/** The override document for the overridden cards. Optional fields get explicit values so they do not inherit. */
export function overridesFrom(policy: ExecutionPolicy, groups: Group[]): Overrides {
  const result: Record<string, unknown> = {};
  for (const group of groups) {
    for (const field of GROUPS[group]) result[field] = structuredClone(policy[field]);
  }
  if (groups.includes("tools")) {
    result.builtinTools ??= [];
    result.permissionModes ??= [];
  }
  if (groups.includes("approvals")) {
    result.approvalModes ??= ["manual"];
    result.permissionHandlers ??= [];
  }
  if (groups.includes("mcp")) {
    result.mcpServers ??= {};
  }
  if (groups.includes("model")) {
    result.maxReasoningEffort ??= "xhigh";
    result.allowLongContext ??= false;
  }
  // `hosting` is replaced whole, so an empty block means the documented defaults, not the base policy's values.
  if (groups.includes("hosting")) {
    result.hosting ??= {};
  }
  return result as Overrides;
}

/** JSON with sorted object keys, for comparing documents regardless of key order. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/** Whether `draft` would write something different from `saved`. In harness scope only the override file matters. */
export function isDirty(draft: PolicyDraft, saved: PolicyDraft, harnessScope: boolean): boolean {
  return harnessScope
    ? stable(overridesFrom(draft.policy, draft.groups)) !== stable(overridesFrom(saved.policy, saved.groups))
    : stable(draft.policy) !== stable(saved.policy);
}

/** The card an issue belongs to, from the first segment of its path; undefined for document-level issues. */
export function issueGroup(issue: Issue): Group | undefined {
  const field = issue.path.split(".")[0] ?? "";
  if ((GLOBAL_FIELDS as readonly string[]).includes(field)) return "limits";
  return ORDER.find((group) => (GROUPS[group] as readonly string[]).includes(field));
}

export function countIssues(issues: Issue[]): { errors: number; warnings: number } {
  const errors = issues.filter((i) => i.level === "error").length;
  return { errors, warnings: issues.length - errors };
}

export const FIELD_LABELS: Record<keyof ExecutionPolicy, string> = {
  schemaVersion: "Schema version",
  allowedProfiles: "Agents",
  allowedModels: "Models",
  maxDurationSeconds: "Max duration",
  maxInferenceTokensPerJob: "Max tokens",
  maxConcurrentAttemptsPerPrincipal: "Concurrent attempts per caller",
  maxQueuedJobsPerPrincipal: "Open jobs per caller",
  retry: "Retry",
  leaseSeconds: "Lease",
  requirements: "Requirements",
  acknowledgedGaps: "Acknowledged gaps",
  maxReasoningEffort: "Reasoning cap",
  allowLongContext: "Long context",
  builtinTools: "Tool groups",
  permissionModes: "Permission modes",
  approvalModes: "Approval modes",
  permissionHandlers: "Permission handlers",
  mcpServers: "MCP servers",
  hosting: "Hosting",
};

/** A short, human-readable rendering of one policy value. */
export function formatPolicyValue(field: keyof ExecutionPolicy, value: unknown): string {
  if (value === undefined) {
    if (field === "maxReasoningEffort") return "no cap";
    if (field === "allowLongContext") return "no";
    if (field === "approvalModes") return "manual";
    if (field === "hosting") return "defaults (isolated only)";
    return "none";
  }
  if (field === "mcpServers" && value && typeof value === "object") return Object.keys(value).sort().join(", ") || "none";
  if (field === "hosting" && value && typeof value === "object") return hostingSummary(value as HostingPolicy);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (field === "maxDurationSeconds") return `${value as number}s`;
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ");
  }
  return String(value);
}

export type HostingPolicy = NonNullable<ExecutionPolicy["hosting"]>;
export type ContainerSize = NonNullable<HostingPolicy["sizes"]>[string];
export type CraftingTemplate = NonNullable<HostingPolicy["crafting"]>["templates"][string];
export type McpServerPolicy = NonNullable<ExecutionPolicy["mcpServers"]>[string];

function hostingSummary(hosting: HostingPolicy): string {
  const parts = [
    `modes ${(hosting.modes ?? ["isolated"]).join(", ")}`,
    hosting.transports && `transports ${hosting.transports.join(", ")}`,
    hosting.sizes && `sizes ${Object.keys(hosting.sizes).join(", ")}`,
    hosting.defaultSize && `default size ${hosting.defaultSize}`,
    hosting.workers && `worker limits ${Object.entries(hosting.workers).map(([k, v]) => `${k} ${String(v)}`).join(", ")}`,
    hosting.promotion?.approval && `promotion ${hosting.promotion.approval.join(", ")}`,
    hosting.crafting && `templates ${Object.keys(hosting.crafting.templates).join(", ") || "none"}`,
  ];
  return parts.filter(Boolean).join("; ");
}

/** The smallest size by memory, then CPUs, then name: the catalog default when the policy names none. */
export function smallestSize(sizes: Readonly<Record<string, ContainerSize>>): string {
  const order = Object.entries(sizes).sort(
    ([nameA, a], [nameB, b]) => a.memoryMiB - b.memoryMiB || a.cpus - b.cpus || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0),
  );
  return order[0]?.[0] ?? "";
}

/** Hosting ceilings with the documented defaults for omitted fields, for display and editing. */
export function effectiveHosting(hosting: HostingPolicy | undefined, defaults: EffectiveHostingPolicy): EffectiveHostingPolicy {
  const sizes = hosting?.sizes ?? defaults.sizes;
  return {
    modes: hosting?.modes ?? defaults.modes,
    transports: hosting?.transports ?? defaults.transports,
    sizes,
    defaultSize: hosting?.defaultSize ?? smallestSize(sizes),
    workers: { ...defaults.workers, ...hosting?.workers } as EffectiveHostingPolicy["workers"],
    promotion: { approval: hosting?.promotion?.approval ?? defaults.promotion.approval },
    crafting: { templates: hosting?.crafting?.templates ?? {} },
  };
}

/** Renames a record key in place of its old position, so cards keep their order. */
export function renameKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key === from ? to : key, value]));
}

/** The first `${base}`, `${base}-2`, ... name not in use. */
export function freeName(base: string, used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index++;
  return `${base}-${index}`;
}

/** Fields of a card whose effective value differs from the base policy. */
export function differencesFromBase(
  group: Group,
  policy: ExecutionPolicy,
  base: ExecutionPolicy,
): Array<{ field: keyof ExecutionPolicy; label: string; base: string; value: string }> {
  return GROUPS[group]
    .filter((field) => stable(policy[field] ?? null) !== stable(base[field] ?? null))
    .map((field) => ({
      field,
      label: FIELD_LABELS[field],
      base: formatPolicyValue(field, base[field]),
      value: formatPolicyValue(field, policy[field]),
    }));
}

/** The browser-draft key for a scope; harness names are slugs, so they cannot collide with the base key. */
export function draftKey(scope: string): string {
  return scope ? `policy:harness:${scope}` : "policy:base";
}
