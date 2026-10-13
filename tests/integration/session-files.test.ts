import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { migrate, SessionFileStore } from "@copilot-agent/job-store";
import { postgresSessionFilesystem } from "../../src/session-host/src/postgres-filesystem.js";

let pool: pg.Pool;
let store: SessionFileStore;
const namespaces: string[] = [];
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  store = new SessionFileStore(pool);
});
afterAll(async () => {
  try { await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [namespaces]); }
  finally { await pool.end(); }
});
function id() { const value = randomUUID(); namespaces.push(value); return value; }

describe("leased session files in PostgreSQL", () => {
  it("retains bytes across activation replacement and rejects stale or cross-principal operations", async () => {
    const namespace = id();
    const first = await store.acquire(namespace, "alice", "worker-a");
    await store.write(first, "/workspace/item", Buffer.from([0, 255, 1]));
    await expect(store.acquire(namespace, "alice", "worker-b")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(store.read({ ...first, principal: "bob" }, "/workspace/item")).rejects.toMatchObject({ code: "ESTALE" });
    await store.release(first);
    await expect(store.acquire(namespace, "bob", "worker-b")).rejects.toMatchObject({ code: "ESTALE" });
    const second = await store.acquire(namespace, "alice", "worker-b");
    expect(second.epoch).not.toBe(first.epoch);
    expect(await store.read(second, "/workspace/item")).toEqual(Buffer.from([0, 255, 1]));
    await expect(store.write(first, "/workspace/item", Buffer.from("stale"))).rejects.toMatchObject({ code: "ESTALE" });
    await expect(store.heartbeat(first)).rejects.toMatchObject({ code: "ESTALE" });
    await store.release(first);
    await store.heartbeat(second);
  });

  it("appends concurrently without losing data and atomically rolls back storage quota failures", async () => {
    const lease = await store.acquire(id(), "alice", "worker", 30, { bytes: 20, entries: 10 });
    await store.write(lease, "/one", Buffer.from("seed"));
    await Promise.all(Array.from({ length: 8 }, () => store.write(lease, "/one", Buffer.from("x"), true)));
    expect((await store.read(lease, "/one")).toString()).toBe("seedxxxxxxxx");
    await expect(store.write(lease, "/new/directory/file", Buffer.from("too much content"))).rejects.toMatchObject({ code: "EDQUOT" });
    expect(await store.stat(lease, "/new")).toBeUndefined();
    expect((await store.read(lease, "/one")).length).toBe(12);
  });

  it("renames directory trees without prefix collisions and enforces delete semantics", async () => {
    const lease = await store.acquire(id(), "alice", "worker");
    await store.write(lease, "/one/nested/file", Buffer.from("one"));
    await store.write(lease, "/one-other/file", Buffer.from("other"));
    await store.rename(lease, "/one", "/two");
    expect((await store.read(lease, "/two/nested/file")).toString()).toBe("one");
    expect((await store.read(lease, "/one-other/file")).toString()).toBe("other");
    expect((await store.list(lease, "/")).map((entry) => entry.name)).toEqual(["one-other", "two"]);
    await expect(store.remove(lease, "/two", false, false)).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await store.remove(lease, "/two", true, false);
    expect(await store.stat(lease, "/two/nested/file")).toBeUndefined();
    await expect(store.rename(lease, "/one-other", "/one-other/child")).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("rejects expired leases and invalid namespace paths", async () => {
    const lease = await store.acquire(id(), "alice", "worker");
    for (const path of ["relative", "/a/../b", "/a/./b", "/a\\b", "/a\0b"]) {
      await expect(store.write(lease, path, Buffer.from("bad"))).rejects.toMatchObject({ code: "EINVAL" });
    }
    await pool.query("UPDATE session_file_namespaces SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.id]);
    await expect(store.stat(lease, "/")).rejects.toMatchObject({ code: "ESTALE" });
    await expect(store.heartbeat(lease)).rejects.toMatchObject({ code: "ESTALE" });
  });

  it("maps Windows virtual paths into a provider namespace without native filesystem access", async () => {
    const lease = await store.acquire(id(), "alice", "worker");
    const provider = postgresSessionFilesystem(store, lease, "windows");
    await provider.mkdir("C:\\virtual\\workspace", true);
    await provider.writeFile("C:\\virtual\\workspace\\File.TXT", "provider content");
    expect(await provider.readFile("c:\\VIRTUAL\\workspace\\file.txt")).toBe("provider content");
    expect(await provider.readFile("\\\\?\\C:\\virtual\\workspace\\file.txt")).toBe("provider content");
    expect(await provider.readdirWithTypes("C:\\virtual\\workspace")).toEqual([{ name: "file.txt", type: "file" }]);
    await expect(provider.readFile("\\\\remote\\share\\file")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(provider.readFile("C:\\virtual\\..\\other")).rejects.toMatchObject({ code: "EINVAL" });
    const other = await store.acquire(id(), "bob", "worker");
    expect(await store.stat(other, "/c/virtual/workspace/file.txt")).toBeUndefined();
  });

  it("retains admitted storage quotas when an activation resumes", async () => {
    const namespace = id();
    const first = await store.acquire(namespace, "alice", "worker", 30, { bytes: 8, entries: 3 });
    await store.write(first, "/file", Buffer.from("12345678"));
    expect(await store.stat(first, "/file")).toMatchObject({ size: 8, directory: false });
    await store.release(first);
    const second = await store.acquire(namespace, "alice", "other-worker", 30, { bytes: 1000, entries: 100 });
    await expect(store.write(second, "/file", Buffer.from("x"), true)).rejects.toMatchObject({ code: "EDQUOT" });
    expect((await store.read(second, "/file")).toString()).toBe("12345678");
  });
});
