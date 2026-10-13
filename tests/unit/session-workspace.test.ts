import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../../src/session-host/src/workspace.js";
import { fixtureFilesystem } from "../runtime/filesystem.js";

let root: string;
let anchor: string;
let workspace: SessionWorkspace;
let lifetime: AbortController;
const report = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "session-workspace-test-"));
  anchor = join(root, "anchor");
  await mkdir(anchor);
  const storage = fixtureFilesystem(join(root, "storage"), process.platform === "win32" ? "windows" : "posix");
  await storage.mkdir(anchor, true);
  lifetime = new AbortController();
  report.mockClear();
  workspace = new SessionWorkspace(anchor, storage, lifetime.signal, report);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const uri = (name: string) => pathToFileURL(join(anchor, name)).href;
const call = (operation: Parameters<typeof workspace.onResource>[0]["operation"], params: Record<string, unknown>) =>
  workspace.onResource({ hostId: "bound-by-runtime", operation, params: { channel: "ahp-root://", ...params } }, { signal: lifetime.signal });
const put = (name: string, data: string, options: Record<string, unknown> = {}) =>
  call("resourceWrite", { uri: uri(name), data, encoding: "utf-8", ...options });

describe("one activation's AHP and SDK filesystem bridge", () => {
  it("shares content with SDK tools without reading or writing native anchors", async () => {
    await writeFile(join(anchor, "sentinel.txt"), "host-only");
    expect(await put("sentinel.txt", "provider-only")).toEqual({ kind: "success", result: {} });
    expect(await workspace.sessionFs.readFile(join(anchor, "sentinel.txt"))).toBe("provider-only");
    await workspace.sessionFs.appendFile(join(anchor, "sentinel.txt"), "-sdk");
    expect(await call("resourceRead", { uri: uri("sentinel.txt") })).toMatchObject({
      kind: "success", result: { data: "provider-only-sdk", encoding: "utf-8" },
    });
    expect(await readFile(join(anchor, "sentinel.txt"), "utf8")).toBe("host-only");
  });

  it("rejects outside paths and non-local URI forms", async () => {
    for (const requested of [
      pathToFileURL(join(root, "outside")).href, pathToFileURL(join(root, "anchor-other", "item")).href,
    ]) expect(await call("resourceRead", { uri: requested })).toMatchObject({ kind: "failure", code: "permissionDenied" });
    for (const requested of ["https://example.invalid", "file://remote/share/item", `${uri("item")}?token=ignored`, `${uri("item")}#fragment`]) {
      expect(await call("resourceRead", { uri: requested })).toMatchObject({ kind: "failure", code: "invalidParams" });
    }
    expect(await call("resourceDelete", { uri: uri("") })).toMatchObject({ kind: "failure", code: "permissionDenied" });
  });

  it("serializes create-only and etag writes with SDK mutations", async () => {
    const created = await Promise.all([put("one", "first", { createOnly: true }), put("one", "second", { createOnly: true })]);
    expect(created.map((entry) => entry.kind)).toEqual(["success", "failure"]);
    expect(created[1]).toMatchObject({ code: "alreadyExists" });
    const metadata = await call("resourceResolve", { uri: uri("one") });
    if (metadata.kind !== "success") throw new Error("Expected file metadata");
    const etag = metadata.result.etag;
    await workspace.sessionFs.writeFile(join(anchor, "one"), "changed by SDK");
    expect(await put("one", "stale write", { ifMatch: etag })).toMatchObject({ kind: "failure", code: "conflict" });
    expect(await workspace.sessionFs.readFile(join(anchor, "one"))).toBe("changed by SDK");
  });

  it("implements byte-position writes and exact binary content", async () => {
    await put("one", "abcd");
    await put("one", "X", { mode: "insert", position: 2 });
    await put("one", "Y", { mode: "append", position: 1 });
    expect(await workspace.sessionFs.readFile(join(anchor, "one"))).toBe("abXcYd");
    await put("one", "Z", { position: 2 });
    expect(await workspace.sessionFs.readFile(join(anchor, "one"))).toBe("abZ");
    expect(await put("one", "no", { position: 100 })).toMatchObject({ kind: "failure", code: "invalidParams" });
    expect(await call("resourceWrite", { uri: uri("binary"), data: "/wA=", encoding: "base64" })).toMatchObject({ kind: "success" });
    expect(await call("resourceRead", { uri: uri("binary"), encoding: "utf-8" })).toMatchObject({
      kind: "success", result: { data: "/wA=", encoding: "base64" },
    });
    expect(await call("resourceWrite", { uri: uri("binary"), data: "not base64", encoding: "base64" })).toMatchObject({ kind: "failure", code: "invalidParams" });
  });

  it("keeps listing, move, copy and delete in the provider", async () => {
    expect(await call("resourceMkdir", { uri: uri("folder") })).toMatchObject({ kind: "success" });
    await put("folder/a", "content");
    expect(await call("resourceCopy", { source: uri("folder/a"), destination: uri("folder/b") })).toMatchObject({ kind: "success" });
    expect(await call("resourceMove", { source: uri("folder/b"), destination: uri("folder/c") })).toMatchObject({ kind: "success" });
    expect(await call("resourceList", { uri: uri("folder") })).toMatchObject({ kind: "success", result: { entries: [{ name: "a", type: "file" }, { name: "c", type: "file" }] } });
    expect(await call("resourceDelete", { uri: uri("folder"), recursive: false })).toMatchObject({ kind: "failure", code: "conflict" });
    expect(await call("resourceDelete", { uri: uri("folder"), recursive: true })).toMatchObject({ kind: "success" });
    expect(await call("resourceResolve", { uri: uri("folder") })).toMatchObject({ kind: "failure", code: "notFound" });
  });

  it("fails after activation loss and never turns missing data into an empty success", async () => {
    expect(await call("resourceRead", { uri: uri("missing") })).toMatchObject({ kind: "failure", code: "notFound" });
    expect(await call("resourceRequest", { uri: uri("missing"), write: true })).toMatchObject({ kind: "success" });
    expect(await call("resourceRequest", { uri: uri("missing") })).toMatchObject({ kind: "failure", code: "notFound" });
    lifetime.abort();
    expect(await put("item", "must not write")).toMatchObject({ kind: "failure", code: "internal" });
    expect(report).toHaveBeenCalled();
  });

  it("rejects missing binary support rather than silently corrupting bytes", () => {
    const storage = fixtureFilesystem(join(root, "other"));
    expect(() => new SessionWorkspace(anchor, { ...storage, readFileBytes: undefined }, lifetime.signal, report)).toThrow(/binary/);
  });

  it("enforces the bridge size limit without modifying an existing file", async () => {
    await put("bounded", "original");
    expect(await put("bounded", "x".repeat(1024 * 1024 + 1))).toMatchObject({ kind: "failure", code: "invalidParams" });
    expect(await workspace.sessionFs.readFile(join(anchor, "bounded"))).toBe("original");
  });
});
