// Hosting data for the configurator (docs/HOSTING-MODES-PLAN.md, sections 3 and 4): what a harness may request under
// its effective policy, and the running agent-api's own read-only hosting views (`GET /v1/hosting[/{harness}]`).
import {
  CONVERSATION_PROFILE,
  effectiveHostingPolicy,
  type ExecutionPolicy,
  HostingConfig,
  hostingCeilingsOf,
  hostingModeOf,
  type HostingOverview,
  type HostingTarget,
  OwnerHostView,
  type PolicySet,
  policyFor,
} from "@copilot-agent/contracts";
import { z } from "zod";
import { connectProblem, routeFor, routeTargetProblem } from "./connect-route.js";
import { ownedManagedHostOffers } from "./owner-host-client.js";
import { compareVersions } from "./repo.js";
import { sessionContainersIn } from "./shared-client.js";
import type {
  HarnessConnectDecision,
  HarnessConnectInfo,
  HarnessDocument,
  HarnessHostingDetail,
  HostingPageInfo,
  HostingTargetSummary,
  ProfileSummary,
  TryTarget,
} from "./types.js";
import { harnessDigest } from "./validate.js";

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

/** What the Hosting section may offer one harness under its effective policy. Reads no deployment or service state. */
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

/**
 * Reads one of the agent-api's hosting views. The view is used only when it matches the contract; otherwise the
 * result says why, so the page can show it instead of guessing.
 */
export async function readServiceView<T>(
  fetchView: () => Promise<{ status: number; body: unknown }>,
  schema: z.ZodType<T>,
  notFound: string,
): Promise<{ value: T; problem?: undefined } | { value?: undefined; problem: string }> {
  try {
    const response = await fetchView();
    if (response.status === 404) return { problem: notFound };
    if (response.status !== 200) {
      const error = (response.body as { error?: { message?: unknown } } | undefined)?.error;
      return { problem: typeof error?.message === "string" ? error.message : `The agent-api answered with HTTP ${response.status}.` };
    }
    const parsed = schema.safeParse(response.body);
    return parsed.success ? { value: parsed.data } : { problem: "The agent-api returned a hosting view this configurator does not recognize." };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : "The agent-api could not be reached." };
  }
}

/** Latest workspace versions the service has not loaded as saved: absent from its view, or loaded with another digest. */
export function staleVersions(documents: HarnessDocument[], overview: HostingOverview): HostingPageInfo["stale"] {
  const loaded = new Map(overview.harnesses.map((view) => [view.harness, view]));
  return latestDocuments(documents).flatMap((document): HostingPageInfo["stale"] => {
    const { name, version } = document.manifest;
    const view = loaded.get(name);
    if (!view || view.version !== version) return [{ harness: name, version, reason: "missing" as const }];
    const digest = harnessDigest(document);
    return digest && digest !== view.digest ? [{ harness: name, version, reason: "changed" as const }] : [];
  });
}

const OwnerHostList = z.object({ hosts: z.array(OwnerHostView) });
export type OwnerHosts = { hosts: OwnerHostView[] } | { error: string };

/**
 * The caller's view of each deployed owner host (`GET /v1/hosts`), as the launcher looks it up per harness. A service
 * without owner hosts has no such route, which means the caller owns none.
 */
export async function readOwnerHosts(fetchHosts: () => Promise<{ status: number; body: unknown }>): Promise<OwnerHosts> {
  try {
    const response = await fetchHosts();
    if (response.status === 404) return { hosts: [] };
    if (response.status !== 200) return { error: `The owner host lookup failed (${response.status}).` };
    const parsed = OwnerHostList.safeParse(response.body);
    return parsed.success ? { hosts: parsed.data.hosts } : { error: "The agent-api returned owner hosts this configurator does not recognize." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The owner hosts could not be read." };
  }
}

/**
 * How `pnpm host:connect --harness` would connect the caller to each conversation harness over each transport on
 * `target`, decided with the launcher's own refusal check, routing order, and target rule, from the same facts it looks
 * up: the target's hosting view and the caller's owner hosts.
 */
export async function harnessConnections(overview: HostingOverview, owners: OwnerHosts, target: TryTarget): Promise<Record<string, HarnessConnectInfo>> {
  const connections: Record<string, HarnessConnectInfo> = {};
  for (const view of overview.harnesses) {
    if (view.interaction !== "conversation") continue;
    const placement = view.placement;
    const hosts = "hosts" in owners ? owners.hosts.filter((host) => host.harness === view.harness) : [];
    // Only a deployed managed host can be the caller's own, so harnesses without one need no lookup.
    const deployed = overview.hosts.isolatedHosts.some((host) => host.harness === view.harness);
    const transports: HarnessConnectInfo["transports"] = {};
    for (const { transport } of view.transports) {
      const problem = connectProblem(view, transport, false);
      if (problem) {
        transports[transport] = { problem };
        continue;
      }
      if (placement !== "shared" && placement !== "container") continue;
      let decision: HarnessConnectDecision;
      try {
        const route = await routeFor(placement, {
          ownedOwnerHost: async () => {
            if (!deployed) return false;
            if ("error" in owners) throw new Error(owners.error);
            return hosts.some((host) => ownedManagedHostOffers(host, transport));
          },
          sessionContainers: async () => sessionContainersIn(overview.hosts, transport),
        });
        const refusal = routeTargetProblem(route, target);
        decision = refusal ? { route, refusal } : { route };
      } catch (error) {
        decision = { refusal: error instanceof Error ? error.message : "The launcher could not route this connection." };
      }
      transports[transport] = decision;
    }
    connections[view.harness] = { ownsHost: hosts.some((host) => host.owned && host.execution === "managed"), transports };
  }
  return connections;
}
