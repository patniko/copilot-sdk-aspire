import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { canonicalSessionId, HostedSession, type CapabilityIntrospection, type HarnessSnapshot, type HostLease } from "@copilot-agent/contracts";
import { StoreError } from "./store.js";

/** One owner host: the harness it serves and the GitHub owner it is bound to. Every operation checks both. */
export interface HostKey {
  harness: string;
  owner: string;
}
export type HostExecutionKind = "managed" | "github-native";
export interface HostServerKey { keyId: string; algorithm: string; publicKey: string }
export interface HostStatus {
  online: boolean;
  execution?: HostExecutionKind;
  environmentId?: string;
  serverKey?: HostServerKey;
}

interface SessionRow {
  id: string;
  ahp_session_id: string | null;
  harness: HarnessSnapshot;
  model: string;
  token_budget: number;
  input_tokens: string;
  output_tokens: string;
  closed: boolean;
}

const MAX_OPEN_SESSIONS = 10;

function keyOf(host: HostKey): [string, string] {
  return [host.harness, host.owner.toLowerCase()];
}

/** Durable per-harness owner hosts; each host's lease also fences its renewable inference grants. */
export class HostStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Starts a new ownership epoch. `computeId` is the identity recorded on the host's own volume: when supplied it
   * must match the durable host, so a volume is never adopted by another host record.
   */
  async acquire(host: HostKey, seconds: number, ownerUserId: number, execution: HostExecutionKind = "managed", computeId?: string): Promise<HostLease> {
    const [harness, owner] = keyOf(host);
    const result = await this.pool.query<{ epoch: string; compute_id: string; lease_until: Date }>(
      `INSERT INTO owner_hosts (harness, owner, owner_user_id, compute_id, epoch, lease_until, execution)
       VALUES ($1, $2, $3, COALESCE($8::uuid, $4::uuid), $5, now() + $6 * interval '1 second', $7)
       ON CONFLICT (harness) DO UPDATE SET epoch = EXCLUDED.epoch, lease_until = EXCLUDED.lease_until,
         server_key = NULL, environment_id = NULL, execution = EXCLUDED.execution
       WHERE owner_hosts.lease_until < now() AND owner_hosts.owner = EXCLUDED.owner
         AND owner_hosts.owner_user_id = EXCLUDED.owner_user_id
         AND ($8::uuid IS NULL OR owner_hosts.compute_id = $8::uuid)
       RETURNING epoch, compute_id, lease_until`,
      [harness, owner, ownerUserId, randomUUID(), randomUUID(), seconds, execution, computeId ?? null],
    );
    const row = result.rows[0];
    if (row) return { epoch: row.epoch, computeId: row.compute_id, expiresAt: row.lease_until.toISOString() };
    const existing = (await this.pool.query<{ owner: string; owner_user_id: string; compute_id: string; leased: boolean }>(
      "SELECT owner, owner_user_id::text, compute_id, lease_until > now() AS leased FROM owner_hosts WHERE harness = $1", [harness],
    )).rows[0];
    if (existing && (existing.owner !== owner || Number(existing.owner_user_id) !== ownerUserId)) {
      throw new StoreError("invalid_state", `The configured owner differs from the durable host for harness '${harness}'.`);
    }
    if (existing && computeId && existing.compute_id !== computeId) {
      throw new StoreError("invalid_state", `The host volume belongs to a different durable host identity than harness '${harness}'.`);
    }
    throw new StoreError("invalid_state", `Another host process owns the lease for harness '${harness}'.`);
  }

  async heartbeat(host: HostKey, epoch: string, seconds: number, environmentId?: string, serverKey?: HostServerKey): Promise<void> {
    const result = await this.pool.query(
      `UPDATE owner_hosts SET lease_until = now() + $4 * interval '1 second',
         environment_id = COALESCE($5, environment_id), server_key = COALESCE($6, server_key)
       WHERE harness = $1 AND owner = $2 AND epoch = $3 AND lease_until > now()`,
      [...keyOf(host), epoch, seconds, environmentId ?? null, serverKey ? JSON.stringify(serverKey) : null],
    );
    if (!result.rowCount) throw new StoreError("invalid_state", "The host lease was lost.");
  }

  async release(host: HostKey, epoch: string): Promise<void> {
    await this.pool.query("UPDATE owner_hosts SET lease_until = now() WHERE harness = $1 AND owner = $2 AND epoch = $3", [...keyOf(host), epoch]);
  }

  /** Admits a new session or reopens a retained one; `id` is the canonical UUID of the host-minted runtime session. */
  async session(host: HostKey, epoch: string, id: string, resume: boolean, defaults: {
    harness: HarnessSnapshot; model: string; tokenBudget: number;
  }): Promise<HostedSession> {
    const [harness, owner] = keyOf(host);
    return this.#tx(async (client) => {
      await this.#lease(client, host, epoch);
      if (!resume) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM hosted_sessions WHERE host_harness = $1 AND owner = $2 AND NOT closed", [harness, owner]);
        if (Number(count.rows[0]!.count) >= MAX_OPEN_SESSIONS) {
          throw new StoreError("quota_exceeded", `Close a retained session before creating another (maximum ${MAX_OPEN_SESSIONS}).`);
        }
        const inserted = await client.query(
          `INSERT INTO hosted_sessions (id, owner, host_harness, harness, model, token_budget)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [id, owner, harness, JSON.stringify(defaults.harness), defaults.model, defaults.tokenBudget],
        );
        if (!inserted.rowCount) throw new StoreError("invalid_state", "The session already exists; resume it instead.");
      }
      const rows = await client.query<SessionRow>(
        "SELECT * FROM hosted_sessions WHERE id = $1 AND owner = $2 AND host_harness = $3", [id, owner, harness]);
      const row = rows.rows[0];
      if (!row || row.closed) throw new StoreError("not_found", "The hosted session is missing or closed.");
      return toSession(row);
    });
  }

  async grant(host: HostKey, epoch: string, id: string): Promise<{ jti: string; session: HostedSession; expiresAt: Date }> {
    const [harness, owner] = keyOf(host);
    return this.#tx(async (client) => {
      await this.#lease(client, host, epoch);
      const rows = await client.query<SessionRow>(
        "SELECT * FROM hosted_sessions WHERE id = $1 AND owner = $2 AND host_harness = $3 FOR UPDATE", [id, owner, harness]);
      const row = rows.rows[0];
      if (!row || row.closed) throw new StoreError("not_found", "The hosted session is missing or closed.");
      if (Number(row.input_tokens) + Number(row.output_tokens) >= row.token_budget) {
        throw new StoreError("quota_exceeded", "The hosted session inference budget is exhausted.");
      }
      const grant = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO hosted_session_grants (id, session_id, epoch, expires_at)
         VALUES ($1,$2,$3,now() + interval '2 minutes')
         ON CONFLICT (session_id, epoch) DO UPDATE SET expires_at = EXCLUDED.expires_at
         RETURNING id, expires_at`,
        [randomUUID(), id, epoch],
      );
      return { jti: grant.rows[0]!.id, session: toSession(row), expiresAt: grant.rows[0]!.expires_at };
    });
  }

  /** A grant is valid only while the session's own host still holds the epoch that issued it. */
  async introspect(jti: string): Promise<CapabilityIntrospection> {
    const result = await this.pool.query<{
      closed: boolean; valid: boolean; token_budget: number; used: string;
    }>(
      `SELECT s.closed, COALESCE(h.epoch = g.epoch AND h.lease_until > now() AND g.expires_at > now(), false) AS valid,
         s.token_budget, (s.input_tokens + s.output_tokens)::text AS used
       FROM hosted_session_grants g JOIN hosted_sessions s ON s.id = g.session_id
       LEFT JOIN owner_hosts h ON h.harness = s.host_harness AND h.owner = s.owner
       WHERE g.id = $1`,
      [jti],
    );
    const row = result.rows[0];
    if (!row) return { active: false, reason: "unknown", remainingTokens: 0 };
    const remainingTokens = Math.max(0, row.token_budget - Number(row.used));
    if (row.closed || !row.valid) return { active: false, reason: "revoked", remainingTokens };
    if (!remainingTokens) return { active: false, reason: "budget_exhausted", remainingTokens };
    return { active: true, remainingTokens };
  }

  async recordUsage(jti: string, requestId: string, input: number, output: number): Promise<boolean> {
    return this.#tx(async (client) => {
      const result = await client.query<{ session_id: string }>("SELECT session_id FROM hosted_session_grants WHERE id = $1", [jti]);
      const grant = result.rows[0];
      if (!grant) return false;
      const report = await client.query(
        `INSERT INTO hosted_usage_reports (id, grant_id, input_tokens, output_tokens) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [requestId, jti, input, output],
      );
      if (report.rowCount) {
        await client.query(
          "UPDATE hosted_sessions SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3 WHERE id = $1",
          [grant.session_id, input, output],
        );
      }
      return true;
    });
  }

  async close(host: HostKey, id: string): Promise<boolean> {
    const [harness, owner] = keyOf(host);
    const result = await this.pool.query(
      "UPDATE hosted_sessions SET closed = true WHERE id = $1 AND owner = $2 AND host_harness = $3", [id, owner, harness]);
    return result.rowCount === 1;
  }

  /**
   * Records the client-visible AHP session ID of a session this host created, once, under the current lease.
   * An ID already attributed to another session of the host is refused.
   */
  async recordCatalogIdentity(host: HostKey, epoch: string, id: string, ahpSessionId: string): Promise<boolean> {
    const [harness, owner] = keyOf(host);
    return this.#tx(async (client) => {
      await this.#lease(client, host, epoch);
      const result = await client.query(
        `UPDATE hosted_sessions SET ahp_session_id = $4
         WHERE id = $1 AND owner = $2 AND host_harness = $3 AND (ahp_session_id IS NULL OR ahp_session_id = $4)
           AND NOT EXISTS (SELECT 1 FROM hosted_sessions other WHERE other.host_harness = $3 AND other.ahp_session_id = $4 AND other.id <> $1)`,
        [id, owner, harness, ahpSessionId],
      );
      return result.rowCount === 1;
    });
  }

  /** A session of this host by its ledger ID (either UUID spelling) or by its client-visible AHP session ID. */
  async find(host: HostKey, idOrAhpSessionId: string): Promise<HostedSession | undefined> {
    const [harness, owner] = keyOf(host);
    const canonical = canonicalSessionId(idOrAhpSessionId);
    const result = await this.pool.query<SessionRow>(
      `SELECT * FROM hosted_sessions WHERE owner = $2 AND host_harness = $3 AND (ahp_session_id = $1 OR id = $4::uuid)
       ORDER BY (ahp_session_id = $1) DESC NULLS LAST LIMIT 1`, [idOrAhpSessionId, owner, harness, canonical ?? null]);
    return result.rows[0] ? toSession(result.rows[0]) : undefined;
  }

  async list(host: HostKey): Promise<HostedSession[]> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM hosted_sessions WHERE host_harness = $1 AND owner = $2 ORDER BY created_at DESC LIMIT 100", keyOf(host));
    return result.rows.map(toSession);
  }

  async status(host: HostKey): Promise<HostStatus> {
    const result = await this.pool.query<{ online: boolean; execution: HostExecutionKind; environment_id: string | null; server_key: HostServerKey | null }>(
      "SELECT lease_until > now() AS online, execution, environment_id, server_key FROM owner_hosts WHERE harness = $1 AND owner = $2", keyOf(host),
    );
    const row = result.rows[0];
    return { online: row?.online ?? false, ...(row ? { execution: row.execution } : {}), ...(row?.environment_id ? { environmentId: row.environment_id } : {}),
      ...(row?.server_key ? { serverKey: row.server_key } : {}) };
  }

  /** Issues a 60-second, single-use direct ticket bound to the host's harness, owner, and current epoch. */
  async issueConnection(host: HostKey): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(token).digest("hex");
    await this.pool.query("DELETE FROM hosted_connection_tickets WHERE expires_at < now()");
    const result = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO hosted_connection_tickets (digest, harness, owner, epoch, expires_at)
       SELECT $1, harness, owner, epoch, now() + interval '60 seconds' FROM owner_hosts
       WHERE harness = $2 AND owner = $3 AND lease_until > now() AND execution = 'managed' AND server_key IS NOT NULL
       RETURNING expires_at`, [digest, ...keyOf(host)],
    );
    if (!result.rows[0]) throw new StoreError("invalid_state", "The direct host is not ready for connections.");
    return { token, expiresAt: result.rows[0].expires_at.toISOString() };
  }

  async consumeConnection(host: HostKey, epoch: string, token: string): Promise<boolean> {
    const digest = createHash("sha256").update(token).digest("hex");
    const result = await this.pool.query(
      `UPDATE hosted_connection_tickets t SET used_at = now() FROM owner_hosts h
       WHERE h.harness = $1 AND h.owner = $2 AND h.epoch = $3 AND h.lease_until > now()
         AND t.harness = h.harness AND t.owner = h.owner AND t.epoch = h.epoch AND t.digest = $4
         AND t.expires_at > now() AND t.used_at IS NULL RETURNING t.digest`,
      [...keyOf(host), epoch, digest],
    );
    return result.rowCount === 1;
  }

  /**
   * The connection broker's half of a brokered direct connection: consumes a client's ticket for the harness's managed
   * host and, in the same transaction, issues the 30-second, one-use upstream ticket the broker presents to that host.
   * Both bind to the host's current epoch, so neither opens a host that was replaced after the client's ticket was issued.
   */
  async exchangeBrokerTicket(harness: string, token: string): Promise<{ epoch: string; token: string } | undefined> {
    const digest = createHash("sha256").update(token).digest("hex");
    return this.#tx(async (client) => {
      const consumed = await client.query<{ owner: string; epoch: string }>(
        `UPDATE hosted_connection_tickets t SET used_at = now() FROM owner_hosts h
         WHERE h.harness = $1 AND h.lease_until > now() AND h.execution = 'managed'
           AND t.harness = h.harness AND t.owner = h.owner AND t.epoch = h.epoch AND t.digest = $2
           AND t.expires_at > now() AND t.used_at IS NULL RETURNING h.owner, h.epoch`,
        [harness, digest],
      );
      const row = consumed.rows[0];
      if (!row) return undefined;
      const upstream = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO hosted_connection_tickets (digest, harness, owner, epoch, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 seconds')`,
        [createHash("sha256").update(upstream).digest("hex"), harness, row.owner, row.epoch],
      );
      return { epoch: row.epoch, token: upstream };
    });
  }

  /**
   * Adopts the pre-010 singleton `demo_host` row as the host for the configured legacy harness, with its owner,
   * pinned account, compute identity, and retained sessions. Returns false when there is nothing to adopt, or when
   * that harness already has a durable host (the legacy row is then left untouched for an operator to review).
   */
  async adoptLegacyHost(harness: string): Promise<boolean> {
    return this.#tx(async (client) => {
      const legacy = await client.query<{ owner: string }>("SELECT owner FROM demo_host WHERE id = 1 FOR UPDATE");
      if (!legacy.rows[0]) return false;
      const adopted = await client.query(
        `INSERT INTO owner_hosts (harness, owner, owner_user_id, compute_id, epoch, lease_until, execution, environment_id, server_key)
         SELECT $1, lower(owner), owner_user_id, compute_id, epoch, lease_until, execution, environment_id, server_key
         FROM demo_host WHERE id = 1
         ON CONFLICT (harness) DO NOTHING`,
        [harness],
      );
      if (!adopted.rowCount) return false;
      await client.query("UPDATE hosted_sessions SET host_harness = $1 WHERE host_harness IS NULL AND owner = lower($2)", [harness, legacy.rows[0].owner]);
      await client.query("DELETE FROM demo_host WHERE id = 1");
      return true;
    });
  }

  async #lease(client: pg.PoolClient, host: HostKey, epoch: string): Promise<void> {
    const result = await client.query(
      "SELECT harness FROM owner_hosts WHERE harness = $1 AND owner = $2 AND epoch = $3 AND lease_until > now() FOR UPDATE",
      [...keyOf(host), epoch],
    );
    if (!result.rowCount) throw new StoreError("invalid_state", "The host lease was lost.");
  }

  async #tx<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await action(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }
}

function toSession(row: SessionRow): HostedSession {
  return HostedSession.parse({
    id: row.id, ...(row.ahp_session_id ? { ahpSessionId: row.ahp_session_id } : {}), harness: row.harness, model: row.model, tokenBudget: row.token_budget,
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), closed: row.closed,
  });
}
