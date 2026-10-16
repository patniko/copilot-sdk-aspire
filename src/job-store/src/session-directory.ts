import type pg from "pg";
import { ContainerSize, type SessionContainerState, type SharedSessionView } from "@copilot-agent/contracts";
import { CURRENT_SEGMENT_COLUMNS, CURRENT_SEGMENT_JOIN, sharedSessionRecord, type SharedSessionRow } from "./shared-store.js";
import { StoreError } from "./store.js";

interface DirectoryRow extends SharedSessionRow {
  online: boolean; size: string | null; resources: ContainerSize | null; activations: number | null;
  allocation_state: string | null; ready_at: Date | null; ingress: unknown;
}
const SELECT = `SELECT s.*,
    EXISTS (SELECT 1 FROM shared_activations a JOIN session_file_namespaces n ON n.id=a.session_id AND n.epoch=a.epoch
      WHERE a.session_id=s.id AND n.principal=s.principal AND n.lease_until>clock_timestamp()) AS online,
    c.size,c.resources,c.activations,e.state AS allocation_state,e.ready_at,e.ingress,${CURRENT_SEGMENT_COLUMNS}
  FROM shared_sessions s LEFT JOIN session_containers c ON c.session_id=s.id
  LEFT JOIN execution_allocations e ON e.session_id=s.id AND e.state<>'retired' ${CURRENT_SEGMENT_JOIN}`;

/**
 * Placement-agnostic application-session views for the API, built by the shared store's view builder. A
 * container-placed session is online while its container is ready, and its view adds the container's status. Rows
 * bound to a GitHub account other than the principal's configured binding are hidden, as the shared worker hides them.
 */
export class SessionDirectory {
  constructor(private readonly pool: pg.Pool) {}

  async list(principal: string, githubUserId: number, limit = 100): Promise<SharedSessionView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError("invalid_request", "Invalid session page size.");
    const conflict = await this.pool.query("SELECT 1 FROM shared_sessions WHERE principal=$1 AND github_user_id<>$2 LIMIT 1", [principal, githubUserId]);
    if (conflict.rowCount) throw new StoreError("invalid_state", "A retained principal cannot be rebound to a different GitHub account.");
    return (await this.pool.query<DirectoryRow>(`${SELECT} WHERE s.principal=$1 ORDER BY s.created_at DESC LIMIT $2`, [principal, limit])).rows.map(view);
  }

  async get(principal: string, githubUserId: number, id: string): Promise<SharedSessionView | undefined> {
    const row = (await this.pool.query<DirectoryRow>(`${SELECT} WHERE s.id=$1 AND s.principal=$2`, [id, principal])).rows[0];
    return row && Number(row.github_user_id) === githubUserId ? view(row) : undefined;
  }
}

function view(row: DirectoryRow): SharedSessionView {
  if (row.placement !== "container") return sharedSessionRecord(row).view;
  const ready = row.allocation_state === "running" && row.ready_at !== null && row.ingress !== null;
  const { view } = sharedSessionRecord({ ...row, online: !row.closed && ready });
  if (row.size === null || row.resources === null) return view;
  const resources = ContainerSize.parse(row.resources);
  const state: SessionContainerState = row.closed ? "closed"
    : row.allocation_state === null ? "dormant"
      : row.allocation_state === "retiring" ? "stopping"
        : ready ? "running" : "starting";
  return {
    ...view,
    container: {
      state, size: row.size, cpus: resources.cpus, memoryMiB: resources.memoryMiB, idleSeconds: view.limits.idleSeconds,
      activations: row.activations ?? 0,
    },
  };
}