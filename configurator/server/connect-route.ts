import type { HarnessHostingView, HostingTransport, SharedConnection } from "@copilot-agent/contracts";
import { applicationSessionExists, ownedOwnerHostOffers } from "./owner-host-client.js";
import { harnessHosting, sessionContainersOffer, sharedConnection } from "./shared-client.js";

/** Where `pnpm host:connect --harness` connects: a conversation through `/v1/sessions`, or the harness's owner host. */
export type HarnessConnectRoute = { kind: "sessions"; placement: "shared" | "container" } | { kind: "owner-host" };

/**
 * Routes a named harness using the service's hosting view for the caller. The view decides whether the transport can
 * reach that harness at all, and its reason is reported when it cannot; a named harness never falls back to the single
 * demo host, which may serve another harness. Shared harnesses open a shared conversation. Isolated harnesses use the
 * caller's own managed owner host when it offers the transport, unless `resume` names one of the caller's application
 * sessions; otherwise a session container when the deployment offers one over the transport; otherwise the owner-host
 * path, whose API errors name what is missing.
 */
export async function harnessConnectRoute(
  api: { apiUrl: string; key: string },
  harness: string,
  hosting: HarnessHostingView,
  transport: HostingTransport,
  resume?: string,
): Promise<HarnessConnectRoute> {
  const offered = hosting.transports.find((entry) => entry.transport === transport);
  if (!offered) throw new Error(`Harness '${harness}' runs as batch jobs and has no client connection.`);
  if (offered.problem) throw new Error(`${offered.problem.code}: ${offered.problem.message}`);
  // Problems such as an unavailable host block new conversations; a retained one can still be resumed.
  if (!resume && hosting.problems[0]) throw new Error(`${hosting.problems[0].code}: ${hosting.problems[0].message}`);
  if (hosting.placement === "shared") return { kind: "sessions", placement: "shared" };
  if (hosting.placement !== "container") throw new Error(`Harness '${harness}' has no client connection.`);
  const resumesSession = resume !== undefined && await applicationSessionExists(api, resume);
  if (!resumesSession && await ownedOwnerHostOffers(api, harness, transport)) return { kind: "owner-host" };
  if (await sessionContainersOffer(api, transport)) return { kind: "sessions", placement: "container" };
  return { kind: "owner-host" };
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
