import type pg from "pg";
import {
  ContainerSize, SessionView, SharedSessionDefinition, type HarnessSnapshot, type PlacementKind, type SessionContainerState,
} from "@copilot-agent/contracts";
import { StoreError } from "./store.js";

interface DirectoryRow {
  id: string; principal: string; github_user_id: string; label: string; definition: SharedSessionDefinition; closed: boolean;
  placement: PlacementKind; placement_generation: number; tokens_used: string; tokens_reserved: string; jobs: number; continuations: number;
  created_at: Date; last_activity_at: Date; shared_online: boolean;
  harness: HarnessSnapshot | null; mode: "isolated" | null; size: string | null; resources: ContainerSize | null;
  idle_seconds: number | null; activations: number | null;
  allocation_state: string | null; ready_at: Date | null; ingress: unknown;
}
const SELECT = `SELECT s.id,s.principal,s.github_user_id,s.label,s.definition,s.closed,s.placement,s.placement_generation,s.tokens_used,s.tokens_reserved,
    s.jobs,s.continuations,s.created_at,s.last_activity_at,
    EXISTS (SELECT 1 FROM shared_activations a JOIN session_file_namespaces n ON n.id=a.session_id AND n.epoch=a.epoch
      WHERE a.session_id=s.id AND n.principal=s.principal AND n.lease_until>clock_timestamp()) AS shared_online,
    c.harness,c.mode,c.size,c.resources,c.idle_seconds,c.activations,e.state AS allocation_state,e.ready_at,e.ingress
  FROM shared_sessions s LEFT JOIN session_containers c ON c.session_id=s.id
  LEFT JOIN execution_allocations e ON e.session_id=s.id AND e.state<>'retired'`;

/**
 * Placement-agnostic application-session views for the API. Rows bound to a GitHub account other than the principal's
 * configured binding are hidden, as the shared worker hides them.
 */
export class SessionDirectory {
  constructor(private readonly pool: pg.Pool) {}

  async list(principal: string, githubUserId: number, limit = 100): Promise<SessionView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError("invalid_request", "Invalid session page size.");
    const conflict = await this.pool.query("SELECT 1 FROM shared_sessions WHERE principal=$1 AND github_user_id<>$2 LIMIT 1", [principal, githubUserId]);
    if (conflict.rowCount) throw new StoreError("invalid_state", "A retained principal cannot be rebound to a different GitHub account.");
    return (await this.pool.query<DirectoryRow>(`${SELECT} WHERE s.principal=$1 ORDER BY s.created_at DESC LIMIT $2`, [principal, limit])).rows.map(view);
  }

  async get(principal: string, githubUserId: number, id: string): Promise<SessionView | undefined> {
    const row = (await this.pool.query<DirectoryRow>(`${SELECT} WHERE s.id=$1 AND s.principal=$2`, [id, principal])).rows[0];
    return row && Number(row.github_user_id) === githubUserId ? view(row) : undefined;
  }
}

function view(row: DirectoryRow): SessionView {
  const definition = SharedSessionDefinition.parse(row.definition);
  const usedTokens = Number(row.tokens_used);
  const reservedTokens = Number(row.tokens_reserved);
  const containerOnline = row.allocation_state === "running" && row.ready_at !== null && row.ingress !== null;
  const harness = row.harness && row.placement === "container"
    ? { name: row.harness.definition.name, version: row.harness.definition.version, digest: row.harness.digest } : undefined;
  const base = {
    id: row.id, label: row.label, model: definition.model, closed: row.closed, placement: row.placement,
    mode: row.placement === "container" ? (row.mode ?? "isolated") : "shared",
    online: row.placement === "shared" ? row.shared_online : !row.closed && containerOnline,
    createdAt: row.created_at.toISOString(), lastActivityAt: row.last_activity_at.toISOString(), limits: definition.limits,
    budget: { usedTokens, reservedTokens, remainingTokens: Math.max(0, definition.limits.tokenBudget - usedTokens - reservedTokens) },
    jobs: row.jobs, continuations: row.continuations,
    segment: { generation: row.placement_generation, placement: row.placement, ...(harness ? { harness } : {}), ahpSessionId: row.id, startedAt: row.created_at.toISOString() },
  };
  if (!harness) return SessionView.parse(base);
  const resources = ContainerSize.parse(row.resources);
  const state: SessionContainerState = row.closed ? "closed"
    : row.allocation_state === null ? "dormant"
      : row.allocation_state === "retiring" ? "stopping"
        : containerOnline ? "running" : "starting";
  return SessionView.parse({
    ...base, harness,
    container: { state, size: row.size, cpus: resources.cpus, memoryMiB: resources.memoryMiB, idleSeconds: row.idle_seconds, activations: row.activations },
  });
}
