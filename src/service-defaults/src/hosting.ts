import {
  evaluateHosting,
  type ExecutionProfile,
  type HarnessHostingView,
  type HarnessSnapshot,
  HOSTING_ERROR_STATUS,
  hostingCeilingsOf,
  type HostingDeployment,
  type HostingFeature,
  hostingHostsOf,
  type HostingOverview,
  type HostingProblem,
  type HostingTarget,
  type PolicySet,
  policyFor,
} from "@copilot-agent/contracts";
import { HttpError } from "./http.js";

/** Harness hosting features the demo host (agent-host) implements. A harness that needs others is unavailable there. */
export const DEMO_HOST_FEATURES: readonly HostingFeature[] = [];

/** Maps a hosting problem to an HTTP error. `policyCode` replaces `policy_rejected` where a route keeps its own code. */
export function hostingError(problem: HostingProblem, policyCode?: string): HttpError {
  const code = problem.code === "policy_rejected" && policyCode ? policyCode : problem.code;
  const details = {
    ...(problem.path ? { path: problem.path } : {}),
    ...(problem.prerequisite ? { prerequisite: problem.prerequisite } : {}),
  };
  return new HttpError(HOSTING_ERROR_STATUS[problem.code], code, problem.message, Object.keys(details).length ? details : undefined);
}

/** Everything the hosting view needs: published harnesses, approved profiles, policies, and the deployment. */
export interface HostingCatalog {
  harnesses: ReadonlyMap<string, HarnessSnapshot[]>;
  profiles: ReadonlyMap<string, ExecutionProfile>;
  policies: PolicySet;
  deployment: HostingDeployment;
}

function lookupIn(catalog: HostingCatalog): (harness: string) => HostingTarget | undefined {
  return (harness) => {
    const latest = catalog.harnesses.get(harness)?.[0];
    return latest ? { definition: latest.definition, policy: policyFor(catalog.policies, harness) } : undefined;
  };
}

/** The read-only hosting view of one published harness version, with transports evaluated for `principal`. */
export function harnessHostingView(catalog: HostingCatalog, snapshot: HarnessSnapshot, principal?: string): HarnessHostingView {
  const { definition } = snapshot;
  const policy = policyFor(catalog.policies, definition.name);
  const evaluation = evaluateHosting({
    definition,
    policy,
    profiles: catalog.profiles,
    deployment: catalog.deployment,
    lookup: lookupIn(catalog),
    ...(principal === undefined ? {} : { principal }),
  });
  return {
    harness: definition.name,
    version: definition.version,
    digest: snapshot.digest,
    interaction: evaluation.interaction,
    mode: evaluation.mode,
    placement: evaluation.placement,
    status: evaluation.status,
    problems: evaluation.problems,
    transports: evaluation.transports,
    effective: evaluation.effective,
    ceilings: hostingCeilingsOf(policy),
  };
}

/** The deployment's hosts and the latest version of every published harness. */
export function hostingOverview(catalog: HostingCatalog, principal?: string): HostingOverview {
  const harnesses = [...catalog.harnesses.values()]
    .flatMap((versions) => (versions[0] ? [harnessHostingView(catalog, versions[0], principal)] : []))
    .sort((a, b) => (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0));
  return { hosts: hostingHostsOf(catalog.deployment), harnesses };
}
