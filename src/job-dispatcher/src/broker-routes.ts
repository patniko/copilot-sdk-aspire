import type { FastifyInstance } from "fastify";
import { BrokerTicketRequest, PlacementLookup, type BrokerTicketResult, type PlacementLookupResult } from "@copilot-agent/contracts";
import type { PlacementStore } from "@copilot-agent/job-store";
import { HttpError, requireInternalKey } from "@copilot-agent/service-defaults";

export interface BrokerDispatcherDependencies { store: PlacementStore; key: string }

/**
 * Internal routes for the connection broker. Its key authorizes only ticket consumption and placement lookup, so the
 * broker routes connections without database, signing, caller, or worker-control credentials.
 */
export function registerBrokerRoutes(app: FastifyInstance, deps: BrokerDispatcherDependencies): void {
  app.post("/internal/broker/connection", async (request, reply): Promise<BrokerTicketResult> => {
    requireInternalKey(request, deps.key);
    reply.header("cache-control", "no-store");
    const parsed = BrokerTicketRequest.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid broker connection request.");
    const route = await deps.store.consumeTicket(parsed.data.sessionId.toLowerCase(), parsed.data.ticket);
    return route ? { authorized: true, route } : { authorized: false };
  });
  app.post("/internal/broker/placements", async (request, reply): Promise<PlacementLookupResult> => {
    requireInternalKey(request, deps.key);
    reply.header("cache-control", "no-store");
    const parsed = PlacementLookup.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid placement lookup.");
    return { placements: await deps.store.current([...new Set(parsed.data.sessionIds.map((id) => id.toLowerCase()))]) };
  });
}
