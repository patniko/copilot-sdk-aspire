// Hosting views for the configurator (docs/HOSTING-MODES-PLAN.md, sections 3 and 4): what a harness may request under
// its effective policy, and where it can run in the deployment that Local run or Deploy settings describe.
import {
  CONVERSATION_PROFILE,
  type DemoHostSettings,
  effectiveHostingPolicy,
  evaluateHosting,
  type ExecutionPolicy,
  type ExecutionProfile,
  HarnessDefinition,
  type HarnessHostingView,
  HostingConfig,
  type HostingDeployment,
  type HostingMode,
  hostingCeilingsOf,
  hostingHostsOf,
  hostingModeOf,
  HOSTING_MODES,
  HostingOverview,
  type HostingTarget,
  type HostingTransport,
  type PolicySet,
  policyFor,
} from "@copilot-agent/contracts";
import { compareVersions } from "./repo.js";
import type {
  HarnessDocument,
  HarnessHostingDetail,
  HostingAvailability,
  HostingPageInfo,
  HostingTargetSummary,
  ProfileSummary,
  TryTarget,
} from "./types.js";
import { definitionOf, executionProfiles, harnessDigest } from "./validate.js";

/** A deployment the configurator can describe: Local run or the selected Azure target. */
export interface ConfiguredDeployment {
  target: TryTarget;
  label: string;
  deployment: HostingDeployment;
}

const PRINCIPAL = /^[A-Za-z0-9._@-]{1,128}$/;

/**
 * The hosting a deployment provides, as far as its Local run or Deploy settings say. Today that is the batch executor
 * pool and, when the demo agent host runs a managed harness, an isolated host for that one harness with none of the
 * new hosting features. GitHub-native hosting runs Copilot's own configuration rather than a harness, and the local
 * hybrid session host runs a fixed coordinator rather than harnesses, so neither serves a harness here. Session
 * containers, the harness-driven shared worker and worker containers arrive in later stages; the running agent-api's
 * own hosting view supersedes this evaluation once it reports one.
 */
export function configuredDeployment(host: DemoHostSettings | undefined): HostingDeployment {
  const transports: HostingTransport[] = host?.transport === "both" ? ["direct", "github"] : host?.transport === "direct" ? ["direct"] : [];
  const isolatedHosts = transports.length > 0 && host
    ? [{ harness: host.harness, owner: PRINCIPAL.test(host.owner) ? host.owner : "owner", transports, features: [] }]
    : [];
  return { executor: "pool", isolatedHosts };
}

/** The highest version of each harness name, which callers get when they do not pin a version. */
export function latestDocuments(documents: HarnessDocument[]): HarnessDocument[] {
  const latest = new Map<string, HarnessDocument>();
  for (const document of documents) {
    const { name, version } = document.manifest;
    if (typeof name !== "string" || typeof version !== "string") continue;
    const current = latest.get(name);
    if (!current || compareVersions(version, current.manifest.version) > 0) latest.set(name, document);
  }
  return [...latest.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** The fields worker and handoff checks read from a target; a malformed hosting block reads as the default. */
function targetShape(document: HarnessDocument): HostingTarget["definition"] {
  const hosting = document.manifest.hosting === undefined ? undefined : HostingConfig.safeParse(document.manifest.hosting);
  return {
    ...(document.manifest.interaction === "conversation" ? { interaction: "conversation" as const } : {}),
    ...(hosting?.success ? { hosting: hosting.data } : {}),
  };
}

/** Resolves worker and handoff targets to their latest workspace version and effective policy. */
export function hostingLookup(documents: HarnessDocument[], policies: PolicySet): (harness: string) => HostingTarget | undefined {
  const latest = new Map(latestDocuments(documents).map((document) => [document.manifest.name, document]));
  return (harness) => {
    const document = latest.get(harness);
    return document ? { definition: targetShape(document), policy: policyFor(policies, harness) } : undefined;
  };
}

export function hostingTargets(documents: HarnessDocument[], policies: PolicySet, self: string): HostingTargetSummary[] {
  return latestDocuments(documents)
    .filter((document) => document.manifest.name !== self)
    .map((document) => {
      const shape = targetShape(document);
      const mode = hostingModeOf(shape);
      const modes = effectiveHostingPolicy(policyFor(policies, document.manifest.name)).modes;
      return {
        name: document.manifest.name,
        version: document.manifest.version,
        description: typeof document.manifest.description === "string" ? document.manifest.description : "",
        interaction: shape.interaction === "conversation" ? "conversation" : "batch",
        mode,
        modeAllowed: modes.includes(mode),
        isolatedAllowed: modes.includes("isolated"),
      };
    });
}

/** What the Hosting section may offer one harness under its effective policy. Needs no deployment settings. */
export function harnessHostingDetail(input: {
  name: string;
  policy: ExecutionPolicy;
  profiles: ProfileSummary[];
  documents: HarnessDocument[];
  policies: PolicySet;
}): HarnessHostingDetail {
  const { policy } = input;
  const conversation = input.profiles.find((profile) => profile.id === CONVERSATION_PROFILE);
  return {
    ceilings: hostingCeilingsOf(policy),
    mcpCatalog: Object.entries(policy.mcpServers ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([server, entry]) => ({ server, ...(entry.description ? { description: entry.description } : {}), tools: [...entry.tools] })),
    allowedModels: [...policy.allowedModels],
    profileHandlers: [...(conversation?.permissionHandlers ?? [])],
    targets: hostingTargets(input.documents, input.policies, input.name),
  };
}

/** The harness with another hosting mode, keeping only the settings that mode accepts. */
function withMode(definition: HarnessDefinition, mode: HostingMode): HarnessDefinition {
  const hosting = definition.hosting;
  return {
    ...definition,
    hosting: {
      mode,
      ...(mode === "promotable" && hosting?.promotion ? { promotion: hosting.promotion } : {}),
      ...(mode === "orchestrator" && hosting?.workers ? { workers: hosting.workers } : {}),
      ...(hosting?.handoffs ? { handoffs: hosting.handoffs } : {}),
    },
  };
}

/**
 * Evaluates a harness against each configured deployment with the contract's admission order: policy first, then the
 * hosts, transports and features the deployment lacks. For conversations it also lists what each other mode would lack.
 */
export function hostingAvailability(input: {
  definition: HarnessDefinition;
  policy: ExecutionPolicy;
  profiles: ProfileSummary[];
  lookup?: (harness: string) => HostingTarget | undefined;
  deployments: ConfiguredDeployment[];
}): HostingAvailability[] {
  const { definition, policy, lookup } = input;
  const profiles: ReadonlyMap<string, ExecutionProfile> = executionProfiles(input.profiles);
  return input.deployments.map(({ target, label, deployment }) => {
    const evaluation = evaluateHosting({ definition, policy, profiles, deployment, ...(lookup ? { lookup } : {}) });
    const modes = definition.interaction === "conversation"
      ? HOSTING_MODES.map((mode) => ({
          mode,
          missing: evaluateHosting({ definition: withMode(definition, mode), policy, profiles, deployment }).problems.filter(
            (problem) => problem.code === "hosting_unavailable",
          ),
        }))
      : [];
    return {
      target,
      label,
      status: evaluation.status,
      placement: evaluation.placement,
      problems: evaluation.problems,
      transports: evaluation.transports,
      modes,
    };
  });
}

/** Per-harness views of the latest workspace versions for one configured deployment, in `GET /v1/hosting` shape. */
export function configuredOverview(input: {
  documents: HarnessDocument[];
  policies: PolicySet;
  profiles: ProfileSummary[];
  deployment: HostingDeployment;
}): Pick<HostingPageInfo, "overview" | "invalid"> {
  const lookup = hostingLookup(input.documents, input.policies);
  const profiles = executionProfiles(input.profiles);
  const harnesses: HarnessHostingView[] = [];
  const invalid: HostingPageInfo["invalid"] = [];
  for (const document of latestDocuments(input.documents)) {
    const parsed = HarnessDefinition.safeParse(definitionOf(document));
    if (!parsed.success) {
      invalid.push({ harness: document.manifest.name, version: document.manifest.version, folder: document.folder });
      continue;
    }
    const definition = parsed.data;
    const policy = policyFor(input.policies, definition.name);
    const evaluation = evaluateHosting({ definition, policy, profiles, deployment: input.deployment, lookup });
    harnesses.push({
      harness: definition.name,
      version: definition.version,
      digest: harnessDigest(document)!,
      interaction: evaluation.interaction,
      mode: evaluation.mode,
      placement: evaluation.placement,
      status: evaluation.status,
      problems: evaluation.problems,
      transports: evaluation.transports,
      effective: evaluation.effective,
      ceilings: hostingCeilingsOf(policy),
    });
  }
  return { overview: { hosts: hostingHostsOf(input.deployment), harnesses }, invalid };
}

/**
 * Reads the running agent-api's own hosting view. Any failure leaves the configured evaluation in place, with a note
 * that says why; the service's view is used only when it matches the contract.
 */
export async function serviceOverview(
  fetchView: () => Promise<{ status: number; body: unknown }>,
): Promise<{ overview: HostingOverview; note?: undefined } | { overview?: undefined; note: string }> {
  try {
    const response = await fetchView();
    if (response.status === 404) {
      return { note: "The running agent-api does not report hosting yet, so this view is evaluated from your configuration." };
    }
    if (response.status !== 200) {
      return { note: `The running agent-api answered its hosting view with HTTP ${response.status}; showing the configured evaluation.` };
    }
    const parsed = HostingOverview.safeParse(response.body);
    if (!parsed.success) {
      return { note: "The running agent-api returned a hosting view this configurator does not recognize; showing the configured evaluation." };
    }
    return { overview: parsed.data };
  } catch (error) {
    return { note: `Could not read the running agent-api's hosting view (${error instanceof Error ? error.message : "unknown error"}); showing the configured evaluation.` };
  }
}
