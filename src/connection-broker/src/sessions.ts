import {
  BrokerTicketResult, PLACEMENT_EPOCH_HEADER, PlacementLookupResult, type PlacementRoute, type SessionPlacement,
} from "@copilot-agent/contracts";
import type { AhpUpstream } from "@copilot-agent/service-defaults";
import type { RouteFamily } from "./broker.js";
import type { RouteStatus } from "./connection.js";

/** Session ticket consumption and placement lookup. The dispatcher implements it for the deployed broker. */
export interface PlacementDirectory {
  consume(sessionId: string, ticket: string): Promise<PlacementRoute | undefined>;
  lookup(sessionIds: readonly string[], timeoutMilliseconds: number): Promise<SessionPlacement[]>;
}

/** The dispatcher's internal broker routes, authenticated with the broker's service key. */
export class DispatcherDirectory implements PlacementDirectory {
  constructor(private readonly url: string, private readonly key: string) {}

  async consume(sessionId: string, ticket: string): Promise<PlacementRoute | undefined> {
    const result = BrokerTicketResult.parse(await this.#post("/internal/broker/connection", { sessionId, ticket }, 10_000));
    return result.authorized ? result.route : undefined;
  }

  async lookup(sessionIds: readonly string[], timeoutMilliseconds: number): Promise<SessionPlacement[]> {
    return PlacementLookupResult.parse(await this.#post("/internal/broker/placements", { sessionIds }, timeoutMilliseconds)).placements;
  }

  async #post(path: string, body: object, timeoutMilliseconds: number): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": this.key },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (!response.ok) throw new Error(`The placement directory refused a broker request (${response.status}).`);
    return response.json();
  }
}

const SESSION_PATH = /^\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const LOOKUP_BATCH = 500;

/**
 * `/sessions/{id}`: one stable path per application session, routed to the session's current placement. A route
 * whose placement kind or generation changed is closed with "moved"; one whose session no longer exists is dropped.
 */
export function sessionRoutes(directory: PlacementDirectory): RouteFamily<PlacementRoute> {
  return {
    name: "session",
    match: (path) => SESSION_PATH.exec(path)?.[1]?.toLowerCase(),
    authorize: async (sessionId, ticket) => {
      const route = await directory.consume(sessionId, ticket);
      return route?.sessionId === sessionId ? route : undefined;
    },
    check: async (routes, timeoutMilliseconds) => {
      const ids = [...new Set(routes.map((route) => route.sessionId))];
      const current = new Map<string, SessionPlacement>();
      for (let index = 0; index < ids.length; index += LOOKUP_BATCH) {
        for (const placement of await directory.lookup(ids.slice(index, index + LOOKUP_BATCH), timeoutMilliseconds)) {
          current.set(placement.sessionId, placement);
        }
      }
      return routes.map((route): RouteStatus => {
        const placement = current.get(route.sessionId);
        if (!placement) return "gone";
        return placement.kind === route.kind && placement.generation === route.generation ? "current" : "moved";
      });
    },
  };
}

/**
 * The shared worker's brokered ingress. It accepts only connections forwarded with the broker key, for the activation
 * epoch the consumed ticket was issued for; the client's ticket never leaves the broker.
 */
export function sharedUpstream(origin: URL, key: string): (route: Extract<PlacementRoute, { kind: "shared" }>) => AhpUpstream {
  if (origin.protocol !== "http:" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("The shared worker's broker upstream must be an internal HTTP origin without credentials.");
  }
  return (route) => ({
    origin, path: `/sessions/${route.sessionId}`,
    headers: { "x-internal-key": key, [PLACEMENT_EPOCH_HEADER]: route.epoch },
  });
}
