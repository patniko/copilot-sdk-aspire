import { createHash } from "node:crypto";
import { chown, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PromotionSnapshotManifest, promotionSnapshotDigestInput } from "@copilot-agent/contracts";

/** Where a snapshot's two areas restore. Both must be absent or empty directories. */
export interface PromotionRestoreTargets {
  /** The runtime's state directory for the session: `<COPILOT_HOME>/session-state/<sessionId>`. */
  state: string;
  /** The container workspace the session resumes in. */
  workspace: string;
}

export interface PromotionRestoreOptions {
  /** The session the snapshot must belong to. */
  sessionId: string;
  /** The digest the ledger recorded for the snapshot (`sha256:<hex>`). */
  digest: string;
  /** Owner of every restored entry, for a root supervisor restoring for an unprivileged runtime. */
  owner?: { uid: number; gid: number };
}

export interface PromotionRestoreResult { files: number; directories: number; bytes: number }

export class PromotionRestoreError extends Error {}

/**
 * Restores a promotion snapshot onto a real filesystem (docs/HOSTING-MODES-PLAN.md, section 7.3). It verifies the
 * manifest against `digest` before writing anything, checks every file's size and SHA-256 before writing it, and
 * creates each entry exclusively inside fresh target directories, so a snapshot cannot write outside its targets or
 * through an existing link. `contents` yields each file's content in manifest order. On failure the partially
 * restored targets are removed.
 */
export async function restorePromotionSnapshot(
  manifestValue: unknown,
  contents: AsyncIterable<{ ordinal: number; content: Buffer }>,
  targets: PromotionRestoreTargets,
  options: PromotionRestoreOptions,
): Promise<PromotionRestoreResult> {
  const parsed = PromotionSnapshotManifest.safeParse(manifestValue);
  if (!parsed.success) throw new PromotionRestoreError("The promotion snapshot manifest is invalid.");
  const manifest = parsed.data;
  if (manifest.sessionId !== options.sessionId) throw new PromotionRestoreError("The promotion snapshot belongs to another session.");
  const digest = `sha256:${createHash("sha256").update(promotionSnapshotDigestInput(manifest)).digest("hex")}`;
  if (digest !== options.digest) throw new PromotionRestoreError("The promotion snapshot manifest does not match its recorded digest.");
  const roots = { state: resolve(targets.state), workspace: resolve(targets.workspace) };
  if (!isAbsolute(targets.state) || !isAbsolute(targets.workspace)
    || roots.state === roots.workspace || roots.state.startsWith(`${roots.workspace}${sep}`) || roots.workspace.startsWith(`${roots.state}${sep}`)) {
    throw new PromotionRestoreError("Promotion restore targets must be separate absolute directories.");
  }
  const created: string[] = [];
  const emptied: string[] = [];
  try {
    for (const root of [roots.state, roots.workspace]) {
      (await fresh(root) ? created : emptied).push(root);
      await own(root, options.owner);
    }
    const iterator = contents[Symbol.asyncIterator]();
    const result: PromotionRestoreResult = { files: 0, directories: 0, bytes: 0 };
    for (const [ordinal, entry] of manifest.entries.entries()) {
      const destination = join(roots[entry.area], ...entry.path.split("/"));
      if (entry.kind === "directory") {
        await mkdir(destination, { mode: 0o700 });
        await own(destination, options.owner);
        result.directories++;
        continue;
      }
      const next = await iterator.next();
      if (next.done || next.value.ordinal !== ordinal) throw new PromotionRestoreError("The promotion snapshot contents are out of order or incomplete.");
      const content = next.value.content;
      if (content.length !== entry.size || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
        throw new PromotionRestoreError("A promotion snapshot file does not match its digest.");
      }
      const handle = await open(destination, "wx", 0o600);
      try {
        await handle.writeFile(content);
        if (options.owner) await handle.chown(options.owner.uid, options.owner.gid);
        await handle.sync();
      } finally { await handle.close(); }
      result.files++;
      result.bytes += content.length;
    }
    if (!(await iterator.next()).done) throw new PromotionRestoreError("The promotion snapshot has more contents than its manifest lists.");
    return result;
  } catch (error) {
    for (const root of created) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    for (const root of emptied) {
      for (const name of await readdir(root).catch(() => [])) await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof PromotionRestoreError) throw error;
    throw new PromotionRestoreError("The promotion snapshot could not be restored.", { cause: error });
  }
}

/** Creates `path` or accepts an existing empty real directory; returns whether it was created. */
async function fresh(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return true;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length) {
    throw new PromotionRestoreError("A promotion restore target must be absent or an empty directory.");
  }
  return false;
}

async function own(path: string, owner: PromotionRestoreOptions["owner"]): Promise<void> {
  if (owner) await chown(path, owner.uid, owner.gid);
}
