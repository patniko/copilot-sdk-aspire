import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { HostedSession, type CapabilityIntrospection, type HarnessSnapshot, type HostLease } from "@copilot-agent/contracts";
import { StoreError } from "./store.js";

interface SessionRow {
  id: string;
  harness: HarnessSnapshot;
  model: string;
  token_budget: number;
  input_tokens: string;
  output_tokens: string;
  closed: boolean;
}

/** One demo host per deployment; its lease also fences all renewable inference grants. */
export class HostStore {
  constructor(private readonly pool: pg.Pool) {}

  async acquire(owner: string, seconds: number, ownerUserId: number, execution: "managed" | "github-native" = "managed"): Promise<HostLease> {
    const result = await this.pool.query<{ epoch: string; compute_id: string; lease_until: Date }>(
      `INSERT INTO demo_host (id, compute_id, owner, epoch, lease_until, owner_user_id, execution)
       VALUES (1, $1, $2, $3, now() + $4 * interval '1 second', $5, $6)
       ON CONFLICT (id) DO UPDATE SET epoch = EXCLUDED.epoch, lease_until = EXCLUDED.lease_until,
         server_key = NULL, environment_id = NULL, execution = EXCLUDED.execution
       WHERE demo_host.lease_until < now() AND demo_host.owner = EXCLUDED.owner
         AND demo_host.owner_user_id = EXCLUDED.owner_user_id
       RETURNING epoch, compute_id, lease_until`,
      [randomUUID(), owner.toLowerCase(), randomUUID(), seconds, ownerUserId, execution],
    );
    const row = result.rows[0];
    if (!row) throw new StoreError("invalid_state", "Another host owns the lease, or the configured owner differs from the durable host.");
    return { epoch: row.epoch, computeId: row.compute_id, expiresAt: row.lease_until.toISOString() };
  }

  async heartbeat(epoch: string, seconds: number, environmentId?: string, serverKey?: { keyId: string; algorithm: string; publicKey: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE demo_host SET lease_until = now() + $2 * interval '1 second',
         environment_id = COALESCE($3, environment_id), server_key = COALESCE($4, server_key)
       WHERE id = 1 AND epoch = $1 AND lease_until > now()`,
      [epoch, seconds, environmentId ?? null, serverKey ? JSON.stringify(serverKey) : null],
    );
    if (!result.rowCount) throw new StoreError("invalid_state", "The demo host lease was lost.");
  }

  async release(epoch: string): Promise<void> {
    await this.pool.query("UPDATE demo_host SET lease_until = now() WHERE id = 1 AND epoch = $1", [epoch]);
  }

  async session(epoch: string, owner: string, id: string, resume: boolean, defaults: {
    harness: HarnessSnapshot; model: string; tokenBudget: number;
  }): Promise<HostedSession> {
    return this.#tx(async (client) => {
      await this.#lease(client, epoch, owner);
      if (!resume) {
        const count = await client.query<{ count: string }>("SELECT count(*) FROM hosted_sessions WHERE owner = $1 AND NOT closed", [owner]);
        if (Number(count.rows[0]!.count) >= 10) throw new StoreError("quota_exceeded", "Close a retained session before creating another (maximum 10).");
        const inserted = await client.query(
          `INSERT INTO hosted_sessions (id, owner, harness, model, token_budget)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id, owner, JSON.stringify(defaults.harness), defaults.model, defaults.tokenBudget],
        );
        if (!inserted.rowCount) throw new StoreError("invalid_state", "The session already exists; resume it instead.");
      }
      const rows = await client.query<SessionRow>("SELECT * FROM hosted_sessions WHERE id = $1 AND owner = $2", [id, owner]);
      const row = rows.rows[0];
      if (!row || row.closed) throw new StoreError("not_found", "The hosted session is missing or closed.");
      return toSession(row);
    });
  }

  async grant(epoch: string, owner: string, id: string): Promise<{ jti: string; session: HostedSession; expiresAt: Date }> {
    return this.#tx(async (client) => {
      await this.#lease(client, epoch, owner);
      const rows = await client.query<SessionRow>("SELECT * FROM hosted_sessions WHERE id = $1 AND owner = $2 FOR UPDATE", [id, owner]);
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

  async introspect(jti: string): Promise<CapabilityIntrospection> {
    const result = await this.pool.query<{
      closed: boolean; valid: boolean; token_budget: number; used: string;
    }>(
      `SELECT s.closed, (h.epoch = g.epoch AND h.lease_until > now() AND g.expires_at > now()) AS valid,
         s.token_budget, (s.input_tokens + s.output_tokens)::text AS used
       FROM hosted_session_grants g JOIN hosted_sessions s ON s.id = g.session_id CROSS JOIN demo_host h
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

  async close(owner: string, id: string): Promise<boolean> {
    const result = await this.pool.query("UPDATE hosted_sessions SET closed = true WHERE id = $1 AND owner = $2", [id, owner]);
    return result.rowCount === 1;
  }

  async list(owner: string): Promise<HostedSession[]> {
    const result = await this.pool.query<SessionRow>("SELECT * FROM hosted_sessions WHERE owner = $1 ORDER BY created_at DESC LIMIT 100", [owner]);
    return result.rows.map(toSession);
  }

  async status(owner: string): Promise<{ online: boolean; execution?: "managed" | "github-native"; environmentId?: string; serverKey?: { keyId: string; algorithm: string; publicKey: string } }> {
    const result = await this.pool.query<{ online: boolean; execution: "managed" | "github-native"; environment_id: string | null; server_key: { keyId: string; algorithm: string; publicKey: string } | null }>(
      "SELECT lease_until > now() AS online, execution, environment_id, server_key FROM demo_host WHERE id = 1 AND owner = $1", [owner],
    );
    const row = result.rows[0];
    return { online: row?.online ?? false, ...(row ? { execution: row.execution } : {}), ...(row?.environment_id ? { environmentId: row.environment_id } : {}),
      ...(row?.server_key ? { serverKey: row.server_key } : {}) };
  }

  async issueConnection(owner: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(token).digest("hex");
    await this.pool.query("DELETE FROM hosted_connection_tickets WHERE expires_at < now()");
    const result = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO hosted_connection_tickets (digest, owner, epoch, expires_at)
       SELECT $1, owner, epoch, now() + interval '60 seconds' FROM demo_host
       WHERE id = 1 AND owner = $2 AND lease_until > now() AND execution = 'managed' AND server_key IS NOT NULL
       RETURNING expires_at`, [digest, owner],
    );
    if (!result.rows[0]) throw new StoreError("invalid_state", "The direct host is not ready for connections.");
    return { token, expiresAt: result.rows[0].expires_at.toISOString() };
  }

  async consumeConnection(epoch: string, owner: string, token: string): Promise<boolean> {
    const digest = createHash("sha256").update(token).digest("hex");
    const result = await this.pool.query(
      `UPDATE hosted_connection_tickets t SET used_at = now() FROM demo_host h
       WHERE h.id = 1 AND h.epoch = $1 AND h.owner = $2 AND h.lease_until > now()
         AND t.epoch = h.epoch AND t.owner = h.owner AND t.digest = $3
         AND t.expires_at > now() AND t.used_at IS NULL RETURNING t.digest`,
      [epoch, owner, digest],
    );
    return result.rowCount === 1;
  }

  async #lease(client: pg.PoolClient, epoch: string, owner: string): Promise<void> {
    const result = await client.query(
      "SELECT id FROM demo_host WHERE id = 1 AND epoch = $1 AND owner = $2 AND lease_until > now() FOR UPDATE",
      [epoch, owner],
    );
    if (!result.rowCount) throw new StoreError("invalid_state", "The demo host lease was lost.");
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
    id: row.id, harness: row.harness, model: row.model, tokenBudget: row.token_budget,
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), closed: row.closed,
  });
}
