import { createHash } from "node:crypto";
import type pg from "pg";
import { PlacementRoute, SessionPlacement } from "@copilot-agent/contracts";

/**
 * Placement authority for brokered connections. The connection broker reaches it only through internal dispatcher
 * routes, so it never holds a database credential. Tickets are issued by the placement that activates the session.
 */
export class PlacementStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Atomically consumes a one-use ticket presented for `sessionId` and returns the route to the session's current
   * placement. Expired, used, closed-session, other-session, and older-generation tickets are refused; a `shared`
   * ticket also requires the activation it was issued for to still hold its storage lease.
   */
  async consumeTicket(sessionId: string, ticket: string): Promise<PlacementRoute | undefined> {
    const row = (await this.pool.query<{ placement: string; generation: number; epoch: string }>(
      `UPDATE shared_connection_tickets t SET used_at=clock_timestamp()
       FROM shared_sessions s
       WHERE t.digest=$1 AND t.session_id=$2 AND t.used_at IS NULL AND t.expires_at>clock_timestamp()
         AND s.id=t.session_id AND s.principal=t.principal AND NOT s.closed
         AND s.placement_generation=t.placement_generation
         AND CASE s.placement
           WHEN 'shared' THEN EXISTS (
             SELECT 1 FROM session_file_namespaces n
             WHERE n.id=s.id AND n.principal=s.principal AND n.epoch=t.epoch AND n.lease_until>clock_timestamp())
           ELSE false
         END
       RETURNING s.placement, s.placement_generation AS generation, t.epoch`, [digest(ticket), sessionId])).rows[0];
    return row ? PlacementRoute.parse({ kind: row.placement, sessionId, generation: row.generation, epoch: row.epoch }) : undefined;
  }

  /** Current placements for the given sessions; unknown sessions are omitted. */
  async current(sessionIds: readonly string[]): Promise<SessionPlacement[]> {
    if (!sessionIds.length) return [];
    const rows = (await this.pool.query<{ id: string; placement: string; generation: number }>(
      "SELECT id,placement,placement_generation AS generation FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessionIds])).rows;
    return rows.map((row) => SessionPlacement.parse({ sessionId: row.id, kind: row.placement, generation: row.generation }));
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
