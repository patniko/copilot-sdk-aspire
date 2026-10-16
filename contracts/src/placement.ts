import { z } from "zod";
import type { HandoffHistory, HostingMode } from "./harness.js";

/**
 * Where an application session's agent loop runs now. Each session has exactly one current placement, and
 * every placement change increments its generation. Connection tickets bind to a generation, and the connection
 * broker closes routes to an older generation with {@link BROKER_MOVED_CLOSE}.
 *
 * `shared` is the in-process shared worker; `container` is a session's dedicated session container. To add a kind,
 * extend this enum, the ledger's `shared_sessions_placement_kind` constraint, {@link PlacementRoute}, ticket
 * consumption in the job store's `PlacementStore`, and the broker's upstream table.
 */
export const PlacementKind = z.enum(["shared", "container"]);
export type PlacementKind = z.infer<typeof PlacementKind>;

export const PlacementGeneration = z.number().int().positive().safe();

/** Where a harness's sessions start: isolated harnesses in a session container, every other mode on the shared worker. */
export function startingPlacement(mode: HostingMode): PlacementKind {
  return mode === "isolated" ? "container" : "shared";
}

/** Every placement a session of a harness can hold: promotable sessions start shared and may move into a container. */
export function placementsOf(mode: HostingMode): PlacementKind[] {
  return mode === "isolated" ? ["container"] : mode === "promotable" ? ["shared", "container"] : ["shared"];
}

/** The history a handoff passes: the target's policy, or by default `full` within one placement and `summary` across placements. */
export function handoffHistoryFor(history: HandoffHistory | undefined, from: PlacementKind, to: PlacementKind): HandoffHistory {
  return history ?? (from === to ? "full" : "summary");
}

/** Placement is one way: no promotion or handoff moves a session from a container back to shared placement. */
export function placementMoveAllowed(from: PlacementKind, to: PlacementKind): boolean {
  return !(from === "container" && to === "shared");
}

/** A session's current placement, as recorded in the ledger. */
export const SessionPlacement = z.object({
  sessionId: z.string().uuid(),
  kind: PlacementKind,
  generation: PlacementGeneration,
  /**
   * The session is being promoted: its shared activation is closing and no new turns are admitted, so live routes to
   * it should close with "moved" and reconnect once the move completes or fails.
   */
  moving: z.literal(true).optional(),
}).strict();
export type SessionPlacement = z.infer<typeof SessionPlacement>;

/**
 * Where to route one consumed connection ticket: the session's placement plus what the broker needs to reach it.
 * `shared` carries the activation epoch the ticket was issued for; the shared worker accepts the forwarded
 * connection only while that activation is resident. `container` carries the ready allocation's internal ingress
 * origin and its per-allocation ingress credential, which the broker presents as `x-internal-key` on its upstream
 * WebSocket request. The credential is a secret and is valid only while that allocation runs.
 */
export const PlacementRoute = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shared"),
    sessionId: z.string().uuid(),
    generation: PlacementGeneration,
    epoch: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("container"),
    sessionId: z.string().uuid(),
    generation: PlacementGeneration,
    allocationId: z.string().uuid(),
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "http:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    }, "Use an internal HTTP origin."),
    credential: z.string().min(32).max(200),
  }).strict(),
]);
export type PlacementRoute = z.infer<typeof PlacementRoute>;

/** Internal: the broker asks the dispatcher to consume one connection ticket presented on `/sessions/{sessionId}`. */
export const BrokerTicketRequest = z.object({
  sessionId: z.string().uuid(),
  ticket: z.string().min(32).max(200),
}).strict();
export type BrokerTicketRequest = z.infer<typeof BrokerTicketRequest>;

export const BrokerTicketResult = z.union([
  z.object({ authorized: z.literal(false) }).strict(),
  z.object({ authorized: z.literal(true), route: PlacementRoute }).strict(),
]);
export type BrokerTicketResult = z.infer<typeof BrokerTicketResult>;

/** Internal: the broker's periodic check of the placements its live connections route to. Unknown sessions are omitted. */
export const PlacementLookup = z.object({ sessionIds: z.array(z.string().uuid()).min(1).max(500) }).strict();
export type PlacementLookup = z.infer<typeof PlacementLookup>;
export const PlacementLookupResult = z.object({ placements: z.array(SessionPlacement).max(500) }).strict();
export type PlacementLookupResult = z.infer<typeof PlacementLookupResult>;

/**
 * Header carrying the activation epoch on a broker-forwarded connection to the shared worker. The broker also sends
 * its service key in `x-internal-key`; the worker accepts no public ticket.
 */
export const PLACEMENT_EPOCH_HEADER = "x-placement-epoch";

/**
 * WebSocket close the broker sends when an attached session's placement changes. The conversation continues at the
 * new placement: request a new connection for the same session and reconnect to the same URL.
 */
export const BROKER_MOVED_CLOSE = { code: 4301, reason: "moved" } as const;
