import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROMOTE_SESSION_TOOL, PromotionSnapshotManifest, promotionContinuation, promotionSnapshotDigestInput, SHARED_WORKER_FEATURES,
  type PromotionSnapshotEntry, type PromotionView,
} from "@copilot-agent/contracts";
import { closeCode, PromotionRestoreError, restorePromotionSnapshot } from "@copilot-agent/service-defaults";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { SHARED_WORKER_DEPLOYMENT, sharedWorkerDeployment } from "../../src/session-host/src/admission.js";
import { promotionTool } from "../../src/session-host/src/promotion/tool.js";

const sessionId = randomUUID();
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "promotion-unit-"));
  directories.push(directory);
  return directory;
}

/** A snapshot of `items` (a directory when content is undefined), its recorded digest, and its contents in order. */
function snapshot(items: Array<[PromotionSnapshotEntry["area"], string, string?]>, session = sessionId) {
  const entries: PromotionSnapshotEntry[] = items.map(([area, path, content]) => content === undefined
    ? { area, kind: "directory", path }
    : { area, kind: "file", path, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });
  const manifest = PromotionSnapshotManifest.parse({ schemaVersion: 1, sessionId: session, entries });
  const digest = `sha256:${createHash("sha256").update(promotionSnapshotDigestInput(manifest)).digest("hex")}`;
  const files = items.flatMap(([, , content], ordinal) => content === undefined ? [] : [{ ordinal, content: Buffer.from(content) }]);
  return { manifest, digest, files };
}
async function* yielding(files: Array<{ ordinal: number; content: Buffer }>) { for (const file of files) yield file; }

describe("promotion snapshot restore", () => {
  it("restores runtime history and workspace files with their names, bound to the recorded digest", async () => {
    const root = await scratch();
    const { manifest, digest, files } = snapshot([
      ["state", "events.jsonl", "{\"type\":\"session.start\"}\n"], ["state", "checkpoints"], ["state", "checkpoints/index.md", "# Checkpoints\n"],
      ["workspace", "Notes"], ["workspace", "Notes/MixedCase.md", "# Notes\n"], ["workspace", "empty.txt", ""],
    ]);
    const targets = { state: join(root, "home", "session-state", sessionId), workspace: join(root, "workspace") };
    const bytes = files.reduce((sum, file) => sum + file.content.length, 0);
    expect(await restorePromotionSnapshot(manifest, yielding(files), targets, { sessionId, digest })).toEqual({ files: 4, directories: 2, bytes });
    expect(await readFile(join(targets.workspace, "Notes", "MixedCase.md"), "utf8")).toBe("# Notes\n");
    expect((await readdir(targets.state)).sort()).toEqual(["checkpoints", "events.jsonl"]);
    expect(await readFile(join(targets.workspace, "empty.txt"), "utf8")).toBe("");
  });

  it("refuses another session's snapshot, a manifest that is not the recorded one, and tampered or misordered contents, leaving nothing", async () => {
    const root = await scratch();
    const targets = { state: join(root, "state"), workspace: join(root, "workspace") };
    const { manifest, digest, files } = snapshot([["workspace", "a.txt", "alpha"], ["workspace", "b.txt", "beta"]]);
    const attempts: Array<[unknown, Array<{ ordinal: number; content: Buffer }>, string, string]> = [
      [manifest, files, randomUUID(), digest],
      [manifest, files, sessionId, `sha256:${"0".repeat(64)}`],
      [{ ...manifest, entries: [...manifest.entries].reverse() }, files, sessionId, digest],
      [manifest, [{ ordinal: 0, content: Buffer.from("alphA") }, files[1]!], sessionId, digest],
      [manifest, [files[1]!, files[0]!], sessionId, digest],
      [manifest, files.slice(0, 1), sessionId, digest],
      [manifest, [...files, { ordinal: 2, content: Buffer.from("extra") }], sessionId, digest],
    ];
    for (const [value, contents, session, recorded] of attempts) {
      await expect(restorePromotionSnapshot(value, yielding(contents), targets, { sessionId: session, digest: recorded })).rejects.toBeInstanceOf(PromotionRestoreError);
      expect(await readdir(root)).toEqual([]);
    }
  });

  it("refuses paths that could leave their area, duplicates, and children listed before their parents", () => {
    const file = { kind: "file", size: 0, sha256: "0".repeat(64) } as const;
    for (const path of ["../escape", "a/../../escape", "/absolute", "a\\b", "a//b", ".", "a/./b", "line\nbreak", ""]) {
      expect(PromotionSnapshotManifest.safeParse({ schemaVersion: 1, sessionId, entries: [{ area: "workspace", path, ...file }] }).success, path).toBe(false);
    }
    expect(PromotionSnapshotManifest.safeParse({ schemaVersion: 1, sessionId, entries: [
      { area: "workspace", path: "a.txt", ...file }, { area: "workspace", path: "a.txt", ...file }] }).success).toBe(false);
    expect(PromotionSnapshotManifest.safeParse({ schemaVersion: 1, sessionId, entries: [
      { area: "workspace", path: "dir/a.txt", ...file }, { area: "workspace", kind: "directory", path: "dir" }] }).success).toBe(false);
  });

  it("restores only into separate, absent or empty real directories, and fails safely under a file", async () => {
    const root = await scratch();
    const { manifest, digest, files } = snapshot([["workspace", "a.txt", "alpha"]]);
    await mkdir(join(root, "busy"));
    await writeFile(join(root, "busy", "kept.txt"), "kept");
    const busy = { state: join(root, "state"), workspace: join(root, "busy") };
    await expect(restorePromotionSnapshot(manifest, yielding(files), busy, { sessionId, digest })).rejects.toBeInstanceOf(PromotionRestoreError);
    expect(await readFile(join(root, "busy", "kept.txt"), "utf8")).toBe("kept");
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const linked = { state: join(root, "state"), workspace: join(root, "linked") };
    await expect(restorePromotionSnapshot(manifest, yielding(files), linked, { sessionId, digest })).rejects.toBeInstanceOf(PromotionRestoreError);
    expect(await readdir(join(root, "elsewhere"))).toEqual([]);
    const nested = { state: join(root, "same"), workspace: join(root, "same", "workspace") };
    await expect(restorePromotionSnapshot(manifest, yielding(files), nested, { sessionId, digest })).rejects.toBeInstanceOf(PromotionRestoreError);
    // A file listed as another file's parent passes the manifest but cannot restore; nothing is left behind.
    const underFile = snapshot([["workspace", "a", "file"], ["workspace", "a/b", "child"]]);
    const fresh = { state: join(root, "fresh-state"), workspace: join(root, "fresh-workspace") };
    await expect(restorePromotionSnapshot(underFile.manifest, yielding(underFile.files), fresh, { sessionId, digest: underFile.digest }))
      .rejects.toBeInstanceOf(PromotionRestoreError);
    expect((await readdir(root)).sort()).toEqual(["busy", "elsewhere", "linked"]);
  });
});

describe("promote_session", () => {
  const view: PromotionView = {
    id: randomUUID(), state: "requested", source: "tool", reason: "Needs a shell", size: "small", requestedAt: new Date().toISOString(),
  } as PromotionView;

  it("asks the attached person under ask approval and runs without a prompt under allow", () => {
    const request = async () => ({ promotion: view, created: true });
    expect(promotionTool("ask", request)).toMatchObject({ rule: { person: true }, tool: { name: PROMOTE_SESSION_TOOL } });
    expect(promotionTool("allow", request).rule).toEqual({});
  });

  it("records each tool call once and tells the agent to end its reply", async () => {
    const calls: Array<[string, string]> = [];
    let created = true;
    const tool = promotionTool("allow", async (key, reason) => { calls.push([key, reason]); return { promotion: view, created }; }).tool;
    const handler = tool.handler as (args: unknown, invocation: { toolCallId: string }) => Promise<Record<string, unknown>>;
    expect(await handler({ reason: "  Needs a shell  " }, { toolCallId: "call-1" })).toMatchObject({ promotion: view.id, state: "requested", size: "small" });
    created = false;
    expect(await handler({}, { toolCallId: "call-2" })).toMatchObject({ note: expect.stringContaining("already moving") });
    expect(calls).toEqual([["tool:call-1", "Needs a shell"], ["tool:call-2", ""]]);
    await expect(handler({ reason: "x", extra: true }, { toolCallId: "call-3" })).rejects.toThrow();
  });

  it("tells the moved conversation where its workspace is now, once per promotion", () => {
    const id = randomUUID();
    const moved = promotionContinuation(id, "/data/execution/workspace", "C:\\shared\\anchors\\session");
    expect(moved.split("\n")[0]).toBe(`[promotion:${id}]`);
    expect(moved).toContain("Earlier messages refer to the workspace as C:\\shared\\anchors\\session; that path is now /data/execution/workspace.");
    expect(promotionContinuation(id, "/workspace", "/workspace")).not.toContain("Earlier messages");
  });
});

describe("promotion hosting offer", () => {
  it("adds the promotion feature and its session-container host only when the worker can promote", () => {
    expect(sharedWorkerDeployment()).toBe(SHARED_WORKER_DEPLOYMENT);
    expect(sharedWorkerDeployment({ promotion: true })).toMatchObject({
      sharedWorker: { features: [...SHARED_WORKER_FEATURES, "promotion"] }, sessionContainers: { transports: ["direct"] },
    });
    const workers = sharedWorkerDeployment({ workerContainers: true });
    expect(workers.sharedWorker?.features).toEqual([...SHARED_WORKER_FEATURES]);
    expect(workers.sessionContainers).toBeUndefined();
    expect(workers.workerContainers).toBeDefined();
    const both = { executor: "on-demand" as const, sharedWorker: true, sessionContainers: true };
    expect(hostingDeployment({ ...both, promotion: true }).sharedWorker?.features).toContain("promotion");
    expect(hostingDeployment({ ...both, sessionContainers: false, promotion: true }).sharedWorker?.features).not.toContain("promotion");
  });
});

describe("broker close codes", () => {
  it("reads the moved close from masked and unmasked frames", () => {
    const payload = Buffer.from([0x10, 0xcd, 0x6d, 0x6f, 0x76, 0x65, 0x64]);
    expect(closeCode(Buffer.concat([Buffer.from([0x88, payload.length]), payload]))).toBe(4301);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
    expect(closeCode(Buffer.concat([Buffer.from([0x88, 0x80 | payload.length]), mask, masked]))).toBe(4301);
    expect(closeCode(Buffer.from([0x88, 0x00]))).toBeUndefined();
    expect(closeCode(Buffer.from([0x81, 0x02, 0x10, 0xcd]))).toBeUndefined();
  });
});
