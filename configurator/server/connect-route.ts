import type { HarnessHostingView, HostingProblem, HostingTransport, SharedConnection } from "@copilot-agent/contracts";
import { applicationSessionExists, ownedOwnerHostOffers } from "./owner-host-client.js";
import { harnessHosting, sessionContainersOffer, sharedConnection } from "./shared-client.js";
import type { HarnessConnectRoute } from "./types.js";

export type { HarnessConnectRoute };

/** The lookups routing needs for one harness and transport; each is made only when the decision reaches it. */
export interface ConnectRouteProbes {
  /** Whether `--resume` names one of the caller's application sessions; absent when not resuming. */
  resumesSession?: () => Promise<boolean>;
  /** Whether the caller's own managed owner host for the harness offers the transport. */
  ownedOwnerHost: () => Promise<boolean>;
  /** Whether the deployment's session containers offer the transport. */
  sessionContainers: () => Promise<boolean>;
}

/**
 * The problem from the service's hosting view that refuses `transport`, in the launcher's order: the transport's own
 * problem, then the harness's first problem, which blocks new conversations but not resuming a retained one.
 */
export function connectProblem(hosting: HarnessHostingView, transport: HostingTransport, resuming: boolean): HostingProblem | undefined {
  return hosting.transports.find((entry) => entry.transport === transport)?.problem ?? (resuming ? undefined : hosting.problems[0]);
}

/**
 * Where a harness whose hosting view allows the transport connects. Shared harnesses open a shared conversation.
 * Isolated harnesses use the caller's own managed owner host when it offers the transport, unless resuming one of the
 * caller's application sessions; otherwise a session container when the deployment offers one over the transport;
 * otherwise the owner-host path, whose API errors name what is missing. The Hosting page decides with this too.
 */
export async function routeFor(placement: "shared" | "container", probes: ConnectRouteProbes): Promise<HarnessConnectRoute> {
  if (placement === "shared") return { kind: "sessions", placement: "shared" };
  const resumesSession = (await probes.resumesSession?.()) ?? false;
  if (!resumesSession && await probes.ownedOwnerHost()) return { kind: "owner-host" };
  if (await probes.sessionContainers()) return { kind: "sessions", placement: "container" };
  return { kind: "owner-host" };
}

/** Why the launcher refuses `route` on `target`: every `--harness` connection is local-only until Azure is qualified. */
export function routeTargetProblem(route: HarnessConnectRoute, target: "local" | "azure"): string | undefined {
  if (target === "local") return undefined;
  if (route.kind === "owner-host") {
    return "Per-harness owner hosts are local-only until the Azure stage; use --destination container for the deployed demo host.";
  }
  const kind = route.placement === "shared" ? "shared conversation" : "session container";
  return `The ${kind} path currently supports local connections only. Azure qualification remains open.`;
}

/**
 * Routes a named harness using the service's hosting view for the caller. The view decides whether the transport can
 * reach that harness at all, and its reason is reported when it cannot; a named harness never falls back to the single
 * demo host, which may serve another harness. {@link routeFor} decides where the connection goes.
 */
export async function harnessConnectRoute(
  api: { apiUrl: string; key: string },
  harness: string,
  hosting: HarnessHostingView,
  transport: HostingTransport,
  resume?: string,
): Promise<HarnessConnectRoute> {
  if (!hosting.transports.some((entry) => entry.transport === transport)) throw new Error(`Harness '${harness}' runs as batch jobs and has no client connection.`);
  const problem = connectProblem(hosting, transport, Boolean(resume));
  if (problem) throw new Error(`${problem.code}: ${problem.message}`);
  if (hosting.placement !== "shared" && hosting.placement !== "container") throw new Error(`Harness '${harness}' has no client connection.`);
  return routeFor(hosting.placement, {
    ...(resume !== undefined ? { resumesSession: () => applicationSessionExists(api, resume) } : {}),
    ownedOwnerHost: () => ownedOwnerHostOffers(api, harness, transport),
    sessionContainers: () => sessionContainersOffer(api, transport),
  });
}

/** Re-provisioning reached a route that cannot serve the same application session; retrying will not help. */
export class SessionRouteChanged extends Error {
  readonly permanent = true;
}

/**
 * Provisions one application session again through the same routing, as the launcher's supervisor does after the
 * connection broker closes the CLI's connection with "moved" (for example after promotion): the harness is routed for
 * the caller with the session as `resume`, which keeps an application session on the `/v1/sessions` path, and the API
 * issues a new one-use ticket at the session's current placement. A route that no longer leads there raises
 * {@link SessionRouteChanged}.
 */
export async function reprovisionSession(
  api: { apiUrl: string; key: string },
  harness: string,
  transport: HostingTransport,
  sessionId: string,
): Promise<SharedConnection> {
  const route = await harnessConnectRoute(api, harness, await harnessHosting(api, harness), transport, sessionId);
  if (route.kind !== "sessions") {
    throw new SessionRouteChanged(`Session ${sessionId} is no longer served through /v1/sessions; reconnect with pnpm host:connect.`);
  }
  return sharedConnection(api, { harness, transport, resume: sessionId });
}
