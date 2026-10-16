import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  SharedServerKey, SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, type HandoffPayload,
} from "@copilot-agent/contracts";
import {
  HandoffStore, migrate, PlacementStore, PromotionStore, SessionDirectory, SessionFileStore, SharedStore, StoreError, type HandoffRequest,
} from "@copilot-agent/job-store";
import { postgresSessionFilesystem } from "../../src/session-host/src/postgres-filesystem.js";

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let handoffs: HandoffStore;
const sessions: string[] = [];
const limits = SharedWorkerLimits.parse({});
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const source = { name: "triage", version: "1.0.0", digest: digest("a") };
const target = { name: "notes", version: "1.0.0", digest: digest("b"), mode: "shared" as const };
const payload: HandoffPayload = { reason: "The person wants notes kept.", summary: "A summary." };
const areas = { state: "/c/worker/session-state", archive: "/c/worker/segment-history/handoff" };
const definition = (harness: typeof source) => SharedSessionDefinition.parse({
  model: "fixture", limits: SharedSessionLimits.parse({}), harness: { ...harness, mode: "shared" },
});
/** The target's admitted definition; a real worker admits it from the published snapshot. */
const admitted = SharedSessionDefinition.parse({ model: "fixture", limits: SharedSessionLimits.parse({ tokenBudget: 1000 }), harness: { ...target } });
const key = SharedServerKey.parse({ keyId: "key", algorithm: "x25519-sealedbox", publicKey: "public" });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  handoffs = new HandoffStore(pool, shared);
});
afterAll(async () => {
  try {
    await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
    await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
  } finally { await pool.end(); }
});

async function session(principal = `handoff-${randomUUID()}`): Promise<{ id: string; principal: string }> {
  const row = await shared.create(principal, 1, "handoff ledger", definition(source), 100);
  sessions.push(row.id);
  return { id: row.id, principal };
}

const request = (owner: { id: string; principal: string }, overrides: Partial<HandoffRequest> = {}): HandoffRequest => ({
  principal: owner.principal, sessionId: owner.id, requestKey: `call-${randomUUID()}`, fromGeneration: 1, fromPlacement: "shared",
  source, target, toPlacement: "shared", history: "summary", approval: "ask", approvedBy: "person", payload, ...overrides,
});

/** A Windows-convention namespace with runtime state, consent files, and workspace files, as the shared worker writes them. */
async function populate(owner: { id: string; principal: string }): Promise<void> {
  const lease = await files.acquire(owner.id, owner.principal, "worker");
  const provider = postgresSessionFilesystem(files, lease, "windows");
  await provider.writeFile("C:\\Worker\\session-state\\events.jsonl", "{\"type\":\"session.start\"}\n");
  await provider.writeFile("C:\\Worker\\session-state\\application-task-list.json", "{\"tasks\":[]}");
  for (const consent of ["permissions.json", "settings.json", "config.json"]) await provider.writeFile(`C:\\Worker\\session-state\\${consent}`, "{}");
  await provider.writeFile("C:\\Worker\\Anchors\\Session\\Notes.md", "# Notes\n");
  await files.release(lease);
}
const paths = async (id: string) => (await pool.query<{ path: string }>(
  "SELECT path FROM session_files WHERE namespace_id=$1 AND NOT directory ORDER BY path", [id])).rows.map((row) => row.path);

describe("handoff ledger", () => {
  it("records each transfer once per tool call, keeps one open, and refuses while another move is in progress", async () => {
    const owner = await session();
    const first = request(owner);
    const accepted = await handoffs.request(first);
    expect(accepted).toMatchObject({ created: true, handoff: { state: "accepted", fromGeneration: 1, approvedBy: "person", history: "summary" } });
    expect(await handoffs.request(first)).toMatchObject({ created: false, handoff: { id: accepted.handoff.id, state: "accepted" } });
    await expect(handoffs.request({ ...first, principal: "someone-else" })).rejects.toMatchObject({ code: "not_found" });
    const second = await handoffs.request(request(owner));
    expect(second.handoff).toMatchObject({ state: "refused", view: { error: { code: "handoff_busy" } } });
    expect(await handoffs.open(owner.id)).toMatchObject({ id: accepted.handoff.id });
    // No new turn starts while the handoff is open.
    const lease = await files.acquire(owner.id, owner.principal, "worker");
    await expect(shared.enqueueTurn(lease, randomUUID(), "user", limits)).rejects.toMatchObject({ code: "invalid_state" });
    await files.release(lease);
    // A failure before the cutover leaves the source in control and admits turns again.
    expect(await handoffs.fail(accepted.handoff.id, "handoff_unavailable", "The target became unavailable.")).toMatchObject({
      state: "failed", view: { error: { code: "handoff_unavailable" } },
    });
    expect(await handoffs.open(owner.id)).toBeUndefined();
    expect(await handoffs.unnotifiedFailure(owner.id, 1)).toMatchObject({ id: accepted.handoff.id });
    expect(await handoffs.markNotified(accepted.handoff.id)).toBe(true);
    expect(await handoffs.markNotified(accepted.handoff.id)).toBe(false);
    expect(await handoffs.unnotifiedFailure(owner.id, 1)).toBeUndefined();
    const again = await files.acquire(owner.id, owner.principal, "worker");
    expect((await shared.enqueueTurn(again, randomUUID(), "user", limits)).state).toBe("queued");
    await files.release(again);
    // Views list the session's handoffs, newest first, for its owner only.
    expect((await handoffs.list(owner.principal, owner.id)).map((view) => view.state)).toEqual(["refused", "failed"]);
    expect(await handoffs.list("someone-else", owner.id)).toEqual([]);
  });

  it("records refusals, never moves a container back to shared placement, and refuses during a promotion", async () => {
    const owner = await session();
    const refused = await handoffs.request(request(owner, {
      approvedBy: undefined, refusal: { code: "handoff_unavailable", message: "No host.", prerequisite: { kind: "host", name: "session-containers" } },
    }));
    expect(refused.handoff.view).toMatchObject({ state: "refused", error: { code: "handoff_unavailable", prerequisite: { kind: "host", name: "session-containers" } } });
    expect(refused.handoff.view.failedAt).toBeDefined();
    const oneWay = await handoffs.request(request(owner, { fromPlacement: "container" }));
    expect(oneWay.handoff.view.error?.code).toBe("handoff_one_way");
    const moved = await handoffs.request(request(owner, { fromGeneration: 2 }));
    expect(moved.handoff.view.error?.code).toBe("session_changed");
    await expect(handoffs.request(request(owner, { approvedBy: undefined }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(handoffs.request(request(owner, { payload: { reason: "" } }))).rejects.toThrow();
    const promotions = new PromotionStore(pool, shared);
    await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "tool", requestKey: "promote", size: "small", resources: { cpus: 0.5, memoryMiB: 1024 } });
    expect((await handoffs.request(request(owner))).handoff.view.error?.code).toBe("handoff_busy");
    // The ledger itself refuses any return to shared placement.
    await pool.query("UPDATE shared_sessions SET placement='container' WHERE id=$1", [owner.id]);
    await expect(pool.query("UPDATE shared_sessions SET placement='shared' WHERE id=$1", [owner.id])).rejects.toThrow(/cannot return to shared placement/);
  });

  it("commits the target's segment in the ledger, then prepares storage once when the target first activates", async () => {
    for (const history of ["summary", "full"] as const) {
      const owner = await session();
      await populate(owner);
      const lease = await files.acquire(owner.id, owner.principal, "worker");
      await shared.publish(lease, key);
      const ticket = await shared.issueTicket(owner.principal, owner.id);
      const { handoff } = await handoffs.request(request(owner, { history }));
      const runtime = history === "full" ? owner.id : randomUUID();
      // The cutover installs exactly the accepted target, and full history keeps the source's runtime session.
      await expect(handoffs.commitShared(handoff.id, { definition: definition(source), ahpSessionId: runtime })).rejects.toMatchObject({ code: "invalid_request" });
      await expect(handoffs.commitShared(handoff.id, { definition: admitted, ahpSessionId: history === "full" ? randomUUID() : owner.id }))
        .rejects.toMatchObject({ code: "invalid_request" });
      expect(await handoffs.commitShared(handoff.id, { definition: admitted, ahpSessionId: runtime })).toEqual({ generation: 2 });
      await expect(handoffs.commitShared(handoff.id, { definition: admitted, ahpSessionId: runtime })).rejects.toMatchObject({ code: "invalid_state" });
      // Tickets issued for the source's activation are void, even while its storage lease lasts.
      expect(await new PlacementStore(pool).consumeTicket(owner.id, ticket.token)).toBeUndefined();
      await files.release(lease);
      const record = (await shared.get(owner.principal, owner.id))!;
      expect(record.definition.harness).toMatchObject({ name: "notes", digest: target.digest });
      expect(record.view).toMatchObject({
        harness: { name: "notes" }, online: false,
        segment: { generation: 2, placement: "shared", ahpSessionId: runtime, harness: { name: "notes" } },
      });
      expect(await new SessionDirectory(pool).get(owner.principal, 1, owner.id)).toMatchObject({ segment: { generation: 2, ahpSessionId: runtime } });
      expect(await new PlacementStore(pool).current([owner.id])).toEqual([{ sessionId: owner.id, kind: "shared", generation: 2 }]);
      expect(await handoffs.forSegment(owner.id, 2)).toMatchObject({ id: handoff.id, state: "committed", prepared: false, notified: false, ahpSessionId: runtime });
      await expect(handoffs.fail(handoff.id, "handoff_failed", "Too late.")).rejects.toMatchObject({ code: "invalid_state" });
      const before = await paths(owner.id);
      const activation = await files.acquire(owner.id, owner.principal, "worker");
      expect(await handoffs.prepareStorage(handoff.id, activation, areas)).toBe(true);
      expect(await handoffs.prepareStorage(handoff.id, activation, areas)).toBe(false);
      await files.release(activation);
      const after = await paths(owner.id);
      expect(after).toContain("/c/worker/anchors/session/notes.md");
      if (history === "full") {
        // The runtime session continues without the source's session-scoped consent.
        expect(after).toEqual(before.filter((path) => !/\/(permissions|settings|config)\.json$/.test(path)));
      } else {
        // A fresh runtime session: the source's runtime state is retained aside, the state root is empty.
        expect(after.filter((path) => path.startsWith(`${areas.state}/`))).toEqual([]);
        expect(after).toContain(`${areas.archive}/events.jsonl`);
        expect(after).toContain(`${areas.archive}/permissions.json`);
        expect(after.filter((path) => path.startsWith(`${areas.archive}/`))).toHaveLength(before.filter((path) => path.startsWith(`${areas.state}/`)).length);
      }
      expect(await handoffs.markNotified(handoff.id)).toBe(true);
    }
  });

  it("fails the handoff instead of committing when the session closed, and keeps the source in control", async () => {
    const owner = await session();
    const { handoff } = await handoffs.request(request(owner));
    await shared.close(owner.principal, owner.id, false);
    await expect(handoffs.commitShared(handoff.id, { definition: admitted, ahpSessionId: randomUUID() })).rejects.toThrow(StoreError);
    expect(await handoffs.byId(handoff.id)).toMatchObject({ state: "failed", view: { error: { code: "session_changed" } } });
    expect((await shared.get(owner.principal, owner.id))!.view).toMatchObject({ harness: { name: "triage" }, segment: { generation: 1 } });
    expect(await handoffs.pending("shared")).not.toContainEqual(expect.objectContaining({ id: handoff.id }));
  });

  it("settles a move into the target's container only from the promotion that performs it", async () => {
    const promotions = new PromotionStore(pool, shared);
    const coder = { name: "coder", version: "1.0.0", digest: digest("c"), mode: "isolated" as const };
    const resources = { cpus: 0.5, memoryMiB: 1024 };
    // A shared target never takes a move.
    const sharedOwner = await session();
    const sharedHandoff = (await handoffs.request(request(sharedOwner))).handoff;
    const other = await promotions.request({ principal: sharedOwner.principal, sessionId: sharedOwner.id, source: "tool", requestKey: "other", size: "small", resources });
    await expect(handoffs.attachMove(sharedHandoff.id, other.promotion.id)).rejects.toMatchObject({ code: "invalid_state" });
    for (const outcome of ["committed", "failed"] as const) {
      const owner = await session();
      const { handoff } = await handoffs.request(request(owner, { target: coder, toPlacement: "container" }));
      // Only the handoff's own move, recorded under its request key with kind `handoff`, can settle it.
      const stray = await promotions.request({
        principal: owner.principal, sessionId: owner.id, source: "tool", requestKey: "stray", size: "small", resources,
      });
      await expect(handoffs.attachMove(handoff.id, stray.promotion.id)).rejects.toMatchObject({ code: "invalid_state" });
      await promotions.fail(stray.promotion.id, "promotion_not_allowed", "Not this one.");
      const { promotion } = await promotions.request({
        principal: owner.principal, sessionId: owner.id, source: "tool", requestKey: `handoff:${handoff.id}`, size: "small", resources,
        kind: "handoff", history: false,
      });
      expect(await handoffs.attachMove(handoff.id, promotion.id)).toMatchObject({ state: "accepted", promotionId: promotion.id });
      expect(await handoffs.attachMove(handoff.id, promotion.id)).toMatchObject({ promotionId: promotion.id });
      await expect(handoffs.attachMove(handoff.id, other.promotion.id)).rejects.toMatchObject({ code: "invalid_state" });
      // While the move is under way the handoff stays accepted, and nothing but the move decides it.
      expect(await handoffs.settleMove(handoff.id)).toMatchObject({ state: "accepted" });
      await expect(handoffs.fail(handoff.id, "handoff_failed", "Stopped.")).rejects.toMatchObject({ code: "invalid_state" });
      if (outcome === "failed") {
        await promotions.fail(promotion.id, "promotion_capacity", "No session container capacity is available now.");
        const failed = await handoffs.settleMove(handoff.id);
        expect(failed.view).toMatchObject({ state: "failed", error: { code: "handoff_unavailable", message: "No session container capacity is available now." } });
        expect(await handoffs.unnotifiedFailure(owner.id, 1)).toMatchObject({ id: handoff.id });
        expect((await shared.get(owner.principal, owner.id))!.view).toMatchObject({ harness: { name: "triage" }, placement: "shared", segment: { generation: 1 } });
        continue;
      }
      // The promotion's cutover, as PromotionStore.commit records a move of kind 'handoff'.
      const runtime = promotion.runtimeSessionId;
      expect(runtime).not.toBe(owner.id);
      await shared.transaction(async (db) => {
        await db.query("UPDATE shared_sessions SET placement='container',placement_generation=2 WHERE id=$1", [owner.id]);
        await db.query(
          `INSERT INTO session_segments(session_id,generation,placement,reason,harness,ahp_session_id,promotion_id)
           VALUES($1,2,'container','handoff',$2,$3,$4)`,
          [owner.id, JSON.stringify({ name: coder.name, version: coder.version, digest: coder.digest }), runtime, promotion.id]);
        await db.query(
          `UPDATE session_promotions SET state='committed',committed_at=clock_timestamp(),snapshot_epoch=$2,snapshot_digest=$3 WHERE id=$1`,
          [promotion.id, randomUUID(), digest("d")]);
      });
      const committed = await handoffs.settleMove(handoff.id);
      expect(committed.view).toMatchObject({ state: "committed", to: { generation: 2, placement: "container", ahpSessionId: runtime } });
      expect(await handoffs.forSegment(owner.id, 2)).toMatchObject({ id: handoff.id });
      expect((await pool.query("SELECT handoff_id FROM session_segments WHERE session_id=$1", [owner.id])).rows).toEqual([{ handoff_id: handoff.id }]);
      expect(await handoffs.settleMove(handoff.id)).toMatchObject({ state: "committed" });
      await expect(handoffs.fail(handoff.id, "handoff_failed", "Late.")).rejects.toMatchObject({ code: "invalid_state" });
    }
  });
});
