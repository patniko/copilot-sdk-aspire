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
  type PolicySet,
  policyFor,
} from "@copilot-agent/contracts";
import type { z } from "zod";
import { compareVersions } from "./repo.js";
import type { HarnessDocument, HarnessHostingDetail, HostingPageInfo, HostingTargetSummary, ProfileSummary } from "./types.js";
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
