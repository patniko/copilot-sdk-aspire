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
   * ticket also requires the activation it was issued for to still hold its storage lease, and a `container` ticket
   * requires the allocation it was issued for to still run with a ready listener and a published ingress.
   */
  async consumeTicket(sessionId: string, ticket: string): Promise<PlacementRoute | undefined> {
    const row = (await this.pool.query<{
      placement: string; generation: number; epoch: string; ingress: { host: string; port: number } | null; credential: string | null;
    }>(
      `UPDATE shared_connection_tickets t SET used_at=clock_timestamp()
       FROM shared_sessions s
       WHERE t.digest=$1 AND t.session_id=$2 AND t.used_at IS NULL AND t.expires_at>clock_timestamp()
         AND s.id=t.session_id AND s.principal=t.principal AND NOT s.closed
         AND s.placement_generation=t.placement_generation
         AND CASE s.placement
           WHEN 'shared' THEN EXISTS (
             SELECT 1 FROM session_file_namespaces n
             WHERE n.id=s.id AND n.principal=s.principal AND n.epoch=t.epoch AND n.lease_until>clock_timestamp())
           WHEN 'container' THEN EXISTS (
             SELECT 1 FROM execution_allocations e
             WHERE e.id=t.epoch AND e.session_id=s.id AND e.kind='session' AND e.state='running'
               AND e.ready_at IS NOT NULL AND e.ingress IS NOT NULL AND e.expires_at>clock_timestamp())
           ELSE false
         END
       RETURNING s.placement, s.placement_generation AS generation, t.epoch,
         (SELECT e.ingress FROM execution_allocations e WHERE e.id=t.epoch AND s.placement='container') AS ingress,
         (SELECT e.ingress_credential FROM execution_allocations e WHERE e.id=t.epoch AND s.placement='container') AS credential`,
      [digest(ticket), sessionId])).rows[0];
    if (row?.placement === "container") {
      const endpoint = new URL("http://127.0.0.1/");
      endpoint.hostname = row.ingress!.host.includes(":") ? `[${row.ingress!.host}]` : row.ingress!.host;
      endpoint.port = String(row.ingress!.port);
      return PlacementRoute.parse({ kind: "container", sessionId, generation: row.generation, allocationId: row.epoch, endpoint: endpoint.href, credential: row.credential });
    }
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
