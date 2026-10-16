import { chown, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { PromotionSnapshotPage, type SessionContainerSpec } from "@copilot-agent/contracts";
import { restorePromotionSnapshot, type PromotionRestoreResult } from "@copilot-agent/service-defaults";
import { EXECUTION_UID } from "./protocol.js";

type Post = <T>(operation: string, body: unknown, schema: z.ZodType<T>) => Promise<T>;

/**
 * Seeds the session volume from a move's snapshot (docs/HOSTING-MODES-PLAN.md, section 7.3) at the layout the owner
 * starts from: the runtime's state under `copilot-home/session-state/<runtime session>`, the workspace under
 * `workspace`, and, when the history moved, the volume marker that makes the owner resume that runtime session.
 * Without history only the workspace is restored and the owner creates the runtime session fresh. Pages come from the
 * dispatcher through this allocation's credential; the manifest is checked against the digest the ledger recorded,
 * and every file against its own. Before the cutover the volume is not authoritative, so whatever an earlier, failed
 * attempt left there is replaced.
 */
export async function restorePromotion(spec: SessionContainerSpec, execution: string, post: Post): Promise<PromotionRestoreResult> {
  const promotion = spec.promotion;
  if (!promotion) throw new Error("This allocation was not started for a promotion.");
  const home = join(execution, "copilot-home");
  const workspace = join(execution, "workspace");
  const marker = join(execution, "session.json");
  for (const path of [home, workspace, marker]) await rm(path, { recursive: true, force: true });
  await mkdir(join(home, "session-state"), { recursive: true, mode: 0o700 });
  for (const path of [home, join(home, "session-state")]) await chown(path, EXECUTION_UID, EXECUTION_UID);
  const page = async (from: number) => {
    const result = await post("promotion-snapshot", { from }, PromotionSnapshotPage);
    if (result.promotionId !== promotion.id || result.sessionId !== spec.sessionId || result.digest !== promotion.digest) {
      throw new Error("The dispatcher returned another promotion's snapshot.");
    }
    return result;
  };
  const first = await page(0);
  if (!promotion.history && first.manifest.entries.some((entry) => entry.area === "state")) {
    throw new Error("A move without history carried runtime state.");
  }
  async function* contents(): AsyncGenerator<{ ordinal: number; content: Buffer }> {
    let current: PromotionSnapshotPage | undefined = first;
    while (current) {
      for (const file of current.files) yield { ordinal: file.ordinal, content: Buffer.from(file.content, "base64") };
      current = current.next === undefined ? undefined : await page(current.next);
    }
  }
  const state = join(home, "session-state", promotion.runtimeSessionId);
  const restored = await restorePromotionSnapshot(first.manifest, contents(), { state, workspace }, {
    sessionId: spec.sessionId, digest: promotion.digest, owner: { uid: EXECUTION_UID, gid: EXECUTION_UID },
  });
  if (!promotion.history) {
    // The owner creates the runtime session fresh; leave no state directory for it to collide with.
    await rm(state, { recursive: true, force: true });
    return restored;
  }
  // The owner resumes a volume whose marker names this session, its runtime session, and its harness snapshot.
  await writeFile(marker, JSON.stringify({ sessionId: spec.sessionId, runtimeSessionId: promotion.runtimeSessionId, digest: spec.harness.digest }), { mode: 0o600 });
  await chown(marker, EXECUTION_UID, EXECUTION_UID);
  return restored;
}
