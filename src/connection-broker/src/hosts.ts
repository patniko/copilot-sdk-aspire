import { BrokerHostTicketResult, isInternalHttpOrigin, type HostBrokerRoute } from "@copilot-agent/contracts";
import type { AhpUpstream } from "@copilot-agent/service-defaults";
import type { RouteFamily } from "./broker.js";

/** Owner-host ticket exchange. The dispatcher implements it for the deployed broker. */
export interface HostDirectory {
  consume(harness: string, ticket: string): Promise<HostBrokerRoute | undefined>;
}

/** The dispatcher's `/internal/broker/host-connection`, authenticated with the broker's service key. */
export class DispatcherHostDirectory implements HostDirectory {
  constructor(private readonly url: string, private readonly key: string) {}

  async consume(harness: string, ticket: string): Promise<HostBrokerRoute | undefined> {
    const response = await fetch(`${this.url}/internal/broker/host-connection`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": this.key },
      body: JSON.stringify({ harness, ticket }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // A dispatcher that serves no owner hosts has no such route, so no ticket can be valid.
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`The host directory refused a broker request (${response.status}).`);
    const result = BrokerHostTicketResult.parse(await response.json());
    return result.authorized ? result.route : undefined;
  }
}

const HOST_PATH = /^\/hosts\/([a-z][a-z0-9-]{1,62})$/;

/**
 * `/hosts/{harness}`: direct WSS to a harness's single-owner host. An owner host does not move, so live routes are
 * not re-checked; a replaced host's connections close with its process, and clients reconnect with a new ticket.
 */
export function hostRoutes(directory: HostDirectory): RouteFamily<HostBrokerRoute> {
  return {
    name: "host",
    match: (path) => HOST_PATH.exec(path)?.[1],
    authorize: async (harness, ticket) => {
      const route = await directory.consume(harness, ticket);
      return route?.harness === harness ? route : undefined;
    },
  };
}

/** The owner host's own ticket check admits the upstream ticket; the client's ticket never leaves the broker. */
export function hostUpstream(route: HostBrokerRoute): AhpUpstream {
  if (!isInternalHttpOrigin(route.endpoint)) throw new Error("An owner host's broker upstream must be an internal HTTP origin.");
  return { origin: new URL(route.endpoint), path: `/?tkn=${encodeURIComponent(route.upstreamTicket)}` };
}
