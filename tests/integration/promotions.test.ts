import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, type PromotionSnapshotManifest } from "@copilot-agent/contracts";
import { AllocationStore, migrate, PromotionStore, SessionFileStore, SharedStore, type PromotionStorageAreas } from "@copilot-agent/job-store";
import { restorePromotionSnapshot } from "@copilot-agent/service-defaults";
import { postgresSessionFilesystem } from "../../src/session-host/src/postgres-filesystem.js";

let pool: pg.Pool;
let shared: SharedStore;
let files: SessionFileStore;
let promotions: PromotionStore;
let allocations: AllocationStore;
const sessions: string[] = [];
const resources = { cpus: 0.5, memoryMiB: 1024 };
const capacity = SharedWorkerLimits.parse({ executionContainers: 32, containersPerPrincipal: 16 });
const areas: PromotionStorageAreas = { state: "/c/worker/session-state", workspace: "/c/worker/anchors/session" };
const definition = SharedSessionDefinition.parse({ model: "fixture", limits: SharedSessionLimits.parse({}), instructions: "Synthetic promotion ledger." });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  shared = new SharedStore(pool);
  files = new SessionFileStore(pool);
  promotions = new PromotionStore(pool, shared);
  allocations = new AllocationStore(pool, shared);
});
afterAll(async () => {
  try {
    await pool.query("DELETE FROM execution_allocations WHERE session_id=ANY($1::uuid[])", [sessions]);
    await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
    await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
  } finally { await pool.end(); }
});

async function session(principal = `promotion-${randomUUID()}`): Promise<{ id: string; principal: string }> {
  const row = await shared.create(principal, 1, "promotion ledger", definition, 100);
  sessions.push(row.id);
  return { id: row.id, principal };
}

/** A conversation whose Windows-convention provider wrote history, workspace files with mixed-case names, and consent files. */
async function populated(): Promise<{ id: string; principal: string }> {
  const owner = await session();
  const lease = await files.acquire(owner.id, owner.principal, "worker");
  const provider = postgresSessionFilesystem(files, lease, "windows");
  await provider.writeFile("C:\\Worker\\session-state\\events.jsonl", "{\"type\":\"session.start\"}\n");
  await provider.writeFile("C:\\Worker\\session-state\\Checkpoints\\Index.md", "# Checkpoints\n");
  for (const consent of ["permissions.json", "Settings.json", "config.json"]) await provider.writeFile(`C:\\Worker\\session-state\\${consent}`, "{}");
  await provider.writeFile("C:\\Worker\\Anchors\\Session\\Notes\\MixedCase.md", "# Notes\n");
  await provider.writeFileBytes!("C:\\Worker\\Anchors\\Session\\Data\\Blob.bin", Buffer.from([0, 1, 2, 255]));
  await provider.mkdir("C:\\Worker\\Anchors\\Session\\Empty Dir", true);
  await provider.writeFile("C:\\Worker\\Outside\\secret.txt", "not part of the snapshot");
  await files.release(lease);
  return owner;
}

async function started(owner: { id: string; principal: string }, requestKey = "tool:call-1") {
  const { promotion } = await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "tool", requestKey, size: "small", resources });
  await promotions.begin(promotion.id);
  const lease = await files.acquire(owner.id, owner.principal, `promotion:${promotion.id}`);
  const captured = await promotions.capture(promotion.id, lease, areas);
  await files.release(lease);
  const allocation = await allocations.request({
    sessionId: owner.id, principal: owner.principal, purpose: "session", size: "small", resources, volumes: [],
    idleSeconds: 300, startupSeconds: 120, maxLifetimeSeconds: 600,
  }, capacity);
  await promotions.attachAllocation(promotion.id, allocation.id);
  return { promotion: captured, allocationId: allocation.id, lease };
}

describe("promotion ledger", () => {
  it("records one promotion per request, joins duplicates to the open one, and refuses sessions it cannot move", async () => {
    const owner = await session();
    const first = await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "tool", requestKey: "tool:a", reason: "Needs a shell", size: "small", resources });
    expect(first).toMatchObject({ created: true, promotion: { state: "requested", source: "tool", fromGeneration: 1, view: { reason: "Needs a shell" } } });
    const again = await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "tool", requestKey: "tool:a", size: "small", resources });
    expect(again).toMatchObject({ created: false, promotion: { id: first.promotion.id } });
    const duplicate = await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "tool", requestKey: "tool:b", size: "small", resources });
    expect(duplicate).toMatchObject({ created: false, promotion: { id: first.promotion.id } });
    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      promotions.request({ principal: owner.principal, sessionId: owner.id, source: "api", requestKey: `api:${index}`, size: "small", resources })));
    expect(new Set(concurrent.map((entry) => entry.promotion.id))).toEqual(new Set([first.promotion.id]));
    await expect(promotions.request({ principal: "someone-else", sessionId: owner.id, source: "api", requestKey: "tool:a", size: "small", resources }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(promotions.request({ principal: owner.principal, sessionId: randomUUID(), source: "api", requestKey: "x", size: "small", resources }))
      .rejects.toMatchObject({ code: "not_found" });
    const closed = await session();
    await shared.close(closed.principal, closed.id, false);
    await expect(promotions.request({ principal: closed.principal, sessionId: closed.id, source: "api", requestKey: "x", size: "small", resources }))
      .rejects.toMatchObject({ code: "not_found" });
    const container = await session();
    await pool.query("UPDATE shared_sessions SET placement='container' WHERE id=$1", [container.id]);
    await expect(promotions.request({ principal: container.principal, sessionId: container.id, source: "api", requestKey: "x", size: "small", resources }))
      .rejects.toMatchObject({ code: "invalid_state" });
  });

  it("captures history and workspace under a fenced lease with kept names, leaving consent files and other paths behind", async () => {
    const owner = await populated();
    const { promotion } = await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "api", requestKey: "api:1", size: "small", resources });
    const early = await files.acquire(owner.id, owner.principal, "promotion");
    await expect(promotions.capture(promotion.id, early, areas)).rejects.toMatchObject({ code: "invalid_state" });
    await files.release(early);
    await promotions.begin(promotion.id);
    const stale = await files.acquire(owner.id, owner.principal, "promotion");
    await files.release(stale);
    const lease = await files.acquire(owner.id, owner.principal, "promotion");
    await expect(promotions.capture(promotion.id, stale, areas)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(promotions.capture(promotion.id, lease, { state: areas.state, workspace: areas.state })).rejects.toMatchObject({ code: "invalid_request" });
    const captured = await promotions.capture(promotion.id, lease, areas);
    expect(captured).toMatchObject({ state: "starting", snapshotEpoch: lease.epoch, snapshotDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    await expect(promotions.capture(promotion.id, lease, areas)).rejects.toMatchObject({ code: "invalid_state" });
    const stored = (await pool.query<{ manifest: PromotionSnapshotManifest; bytes: string; entries: number }>(
      "SELECT manifest,bytes,entries FROM session_promotion_snapshots WHERE promotion_id=$1", [promotion.id])).rows[0]!;
    expect(stored.manifest.entries.map((entry) => `${entry.area}:${entry.kind}:${entry.path}`)).toEqual([
      "state:directory:Checkpoints", "state:file:events.jsonl", "state:file:Checkpoints/Index.md",
      "workspace:directory:Data", "workspace:directory:Empty Dir", "workspace:directory:Notes",
      "workspace:file:Data/Blob.bin", "workspace:file:Notes/MixedCase.md",
    ]);
    const blob = stored.manifest.entries.find((entry) => entry.path === "Data/Blob.bin");
    expect(blob).toMatchObject({ kind: "file", size: 4, sha256: createHash("sha256").update(Buffer.from([0, 1, 2, 255])).digest("hex") });
    expect(Number(stored.bytes)).toBe(Buffer.byteLength("{\"type\":\"session.start\"}\n") + Buffer.byteLength("# Checkpoints\n") + 4 + Buffer.byteLength("# Notes\n"));
    expect(stored.entries).toBe(8);
  });

  it("serves the snapshot only to the allocation started for it, page by page, and restores it digest-checked", async () => {
    const owner = await populated();
    const { promotion, allocationId } = await started(owner);
    const other = await populated();
    const unrelated = await allocations.request({
      sessionId: other.id, principal: other.principal, purpose: "session", size: "small", resources, volumes: [], idleSeconds: 300, startupSeconds: 120, maxLifetimeSeconds: 600,
    }, capacity);
    await expect(promotions.snapshotPage(unrelated.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(promotions.attachAllocation(promotion.id, unrelated.id)).rejects.toMatchObject({ code: "invalid_state" });
    const first = await promotions.snapshotPage(allocationId, 0, 1);
    expect(first).toMatchObject({ promotionId: promotion.id, sessionId: owner.id, digest: promotion.snapshotDigest });
    expect(first.files).toHaveLength(1);
    const pages = [first];
    while (pages.at(-1)!.next !== undefined) pages.push(await promotions.snapshotPage(allocationId, pages.at(-1)!.next, 1));
    const contents = pages.flatMap((page) => page.files);
    expect(contents.map((file) => file.ordinal)).toEqual(first.manifest.entries.flatMap((entry, ordinal) => entry.kind === "file" ? [ordinal] : []));

    const root = await mkdtemp(join(tmpdir(), "promotion-restore-"));
    try {
      const targets = { state: join(root, "home", "session-state", owner.id), workspace: join(root, "workspace") };
      const iterate = async function* (list = contents) { yield* list; };
      await expect(restorePromotionSnapshot(first.manifest, iterate(), targets, { sessionId: owner.id, digest: `sha256:${"0".repeat(64)}` }))
        .rejects.toThrow(/digest/);
      await expect(restorePromotionSnapshot(first.manifest, iterate(), targets, { sessionId: randomUUID(), digest: first.digest }))
        .rejects.toThrow(/another session/);
      const tampered = contents.map((file, index) => index === 0 ? { ...file, content: Buffer.from("tampered") } : file);
      await expect(restorePromotionSnapshot(first.manifest, iterate(tampered), targets, { sessionId: owner.id, digest: first.digest }))
        .rejects.toThrow(/does not match/);
      await expect(readdir(targets.workspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(restorePromotionSnapshot(first.manifest, iterate(contents.slice(1)), targets, { sessionId: owner.id, digest: first.digest }))
        .rejects.toThrow(/out of order or incomplete/);
      const restored = await restorePromotionSnapshot(first.manifest, iterate(), targets, { sessionId: owner.id, digest: first.digest });
      expect(restored).toEqual({ files: 4, directories: 4, bytes: expect.any(Number) });
      expect(await readFile(join(targets.workspace, "Notes", "MixedCase.md"), "utf8")).toBe("# Notes\n");
      expect(await readFile(join(targets.workspace, "Data", "Blob.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
      expect((await readdir(targets.workspace)).sort()).toEqual(["Data", "Empty Dir", "Notes"]);
      expect((await readdir(targets.state)).sort()).toEqual(["Checkpoints", "events.jsonl"]);
      await expect(restorePromotionSnapshot(first.manifest, iterate(), targets, { sessionId: owner.id, digest: first.digest }))
        .rejects.toThrow(/absent or an empty directory/);
      const linked = { state: join(root, "linked-state"), workspace: join(root, "linked-workspace") };
      await mkdir(join(root, "elsewhere"));
      await symlink(join(root, "elsewhere"), linked.workspace, "junction");
      await expect(restorePromotionSnapshot(first.manifest, iterate(), linked, { sessionId: owner.id, digest: first.digest }))
        .rejects.toThrow(/absent or an empty directory/);
      expect(await readdir(join(root, "elsewhere"))).toEqual([]);
      await writeFile(join(root, "elsewhere", "kept"), "x");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("commits the cutover once: container placement, next generation, a new segment, fenced shared storage, and no demotion", async () => {
    const owner = await populated();
    const ticketLease = await files.acquire(owner.id, owner.principal, "shared-worker");
    await shared.publish(ticketLease, { keyId: "k", algorithm: "x25519-sealedbox", publicKey: "p" });
    await shared.issueTicket(owner.principal, owner.id);
    await files.release(ticketLease);
    const { promotion, allocationId, lease } = await started(owner);
    await expect(promotions.commit(promotion.id, randomUUID())).rejects.toMatchObject({ code: "invalid_state" });
    expect(await promotions.commit(promotion.id, allocationId)).toEqual({ generation: 2 });
    const view = (await shared.get(owner.principal, owner.id))!.view;
    expect(view).toMatchObject({ placement: "container", segment: { generation: 2, placement: "container" } });
    expect((await pool.query("SELECT 1 FROM shared_connection_tickets WHERE session_id=$1 AND used_at IS NULL", [owner.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM shared_activations WHERE session_id=$1", [owner.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT generation,placement,reason,ahp_session_id,promotion_id FROM session_segments WHERE session_id=$1", [owner.id])).rows)
      .toEqual([{ generation: 2, placement: "container", reason: "promotion", ahp_session_id: owner.id, promotion_id: promotion.id }]);
    expect(await promotions.byId(promotion.id)).toMatchObject({ state: "committed", view: { committedAt: expect.any(String) } });
    await expect(files.write(lease, "/c/worker/anchors/session/late.txt", Buffer.from("stale"))).rejects.toMatchObject({ code: "ESTALE" });
    await expect(files.acquire(owner.id, owner.principal, "shared-worker")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(promotions.commit(promotion.id, allocationId)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(promotions.fail(promotion.id, "startup_failed", "too late")).rejects.toMatchObject({ code: "invalid_state" });
    await expect(promotions.snapshotPage(allocationId)).rejects.toMatchObject({ code: "not_found" });
    const repeated = await promotions.request({ principal: owner.principal, sessionId: owner.id, source: "api", requestKey: "api:after", size: "small", resources });
    expect(repeated).toMatchObject({ created: false, promotion: { id: promotion.id, state: "committed" } });
    await expect(pool.query("UPDATE shared_sessions SET placement='shared' WHERE id=$1", [owner.id])).rejects.toThrow(/cannot return to shared placement/);
    await expect(pool.query("UPDATE shared_sessions SET placement_generation=1 WHERE id=$1", [owner.id])).rejects.toThrow(/cannot decrease/);
    expect((await shared.get(owner.principal, owner.id))!.view).toMatchObject({ placement: "container", segment: { generation: 2 } });
  });

  it("fails before cutover when storage changed after the snapshot or the session closed, leaving the session shared", async () => {
    const stale = await populated();
    const first = await started(stale);
    const writer = await files.acquire(stale.id, stale.principal, "shared-worker");
    await files.write(writer, "/c/worker/anchors/session/after-snapshot.txt", Buffer.from("written after the snapshot"));
    await files.release(writer);
    await expect(promotions.commit(first.promotion.id, first.allocationId)).rejects.toMatchObject({ code: "invalid_state" });
    expect(await promotions.byId(first.promotion.id)).toMatchObject({ state: "failed", view: { error: { code: "snapshot_stale" } } });
    expect((await shared.get(stale.principal, stale.id))!.view).toMatchObject({ placement: "shared", segment: { generation: 1 } });
    await files.release(await files.acquire(stale.id, stale.principal, "shared-worker"));
    const retry = await promotions.request({ principal: stale.principal, sessionId: stale.id, source: "api", requestKey: "api:retry", size: "small", resources });
    expect(retry).toMatchObject({ created: true, promotion: { state: "requested" } });
    expect(retry.promotion.id).not.toBe(first.promotion.id);

    const closing = await populated();
    const second = await started(closing);
    await shared.close(closing.principal, closing.id, false);
    await expect(promotions.commit(second.promotion.id, second.allocationId)).rejects.toMatchObject({ code: "invalid_state" });
    expect(await promotions.byId(second.promotion.id)).toMatchObject({ state: "failed", view: { error: { code: "session_changed" } } });

    const failing = await populated();
    const third = await started(failing);
    const failed = await promotions.fail(third.promotion.id, "restore_failed", "The container could not restore the snapshot.");
    expect(failed).toMatchObject({ state: "failed", allocationId: third.allocationId, view: { error: { code: "restore_failed" } } });
    expect(await promotions.fail(third.promotion.id, "startup_failed", "ignored")).toMatchObject({ view: { error: { code: "restore_failed" } } });
    await expect(promotions.commit(third.promotion.id, third.allocationId)).rejects.toMatchObject({ code: "invalid_state" });
    expect(await promotions.open(failing.id)).toBeUndefined();
    expect(await promotions.markNotified(third.promotion.id)).toBe(true);
    expect(await promotions.markNotified(third.promotion.id)).toBe(false);
    const lease = await files.acquire(failing.id, failing.principal, "shared-worker");
    await files.write(lease, "/c/worker/anchors/session/accepted.txt", Buffer.from("shared again"));
    await files.release(lease);
  });
});
