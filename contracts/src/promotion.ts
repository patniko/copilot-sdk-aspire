import { z } from "zod";

/**
 * One-way promotion of a `promotable` shared conversation into a dedicated session container
 * (docs/HOSTING-MODES-PLAN.md, section 7.3).
 *
 * - requested: recorded and checked against policy and capacity; the turn that asked for it is ending.
 * - moving: the turn ended; the shared activation is closing and no new turns are admitted.
 * - starting: the snapshot was read under a fenced storage lease; a container is being started from it.
 * - committed: the cutover commit moved the session to `container` placement. Terminal; there is no demotion.
 * - failed: a step before cutover failed. Terminal; the session stays shared and accepts turns again.
 */
export const PROMOTION_STATES = ["requested", "moving", "starting", "committed", "failed"] as const;
export const PromotionState = z.enum(PROMOTION_STATES);
export type PromotionState = z.infer<typeof PromotionState>;

/** Who asked: the agent through `promote_session`, or a caller through `POST /v1/sessions/{id}/promote`. */
export const PromotionSource = z.enum(["tool", "api"]);
export type PromotionSource = z.infer<typeof PromotionSource>;

/** The model-facing name of the promotion tool. */
export const PROMOTE_SESSION_TOOL = "promote_session";

/**
 * Why a promotion did not happen. Errors before cutover leave the session shared:
 * - promotion_not_allowed: the harness is not `promotable`, or policy no longer allows its promotion settings.
 * - promotion_unavailable: this deployment cannot start session containers.
 * - promotion_capacity: no container capacity is available now.
 * - promotion_declined: the person asked to approve the move declined it.
 * - snapshot_failed, snapshot_stale: the snapshot could not be read, or storage changed after it was read.
 * - allocation_failed, startup_failed, restore_failed: the container could not be reserved, started, or restored.
 * - session_changed: the session closed or changed placement while the move was in progress.
 * - promotion_timeout: the container did not report ready in time.
 */
export const PROMOTION_ERROR_CODES = [
  "promotion_not_allowed",
  "promotion_unavailable",
  "promotion_capacity",
  "promotion_declined",
  "snapshot_failed",
  "snapshot_stale",
  "allocation_failed",
  "startup_failed",
  "restore_failed",
  "session_changed",
  "promotion_timeout",
] as const;
export const PromotionErrorCode = z.enum(PROMOTION_ERROR_CODES);
export type PromotionErrorCode = z.infer<typeof PromotionErrorCode>;

/** A promotion as callers and the agent see it. */
export const PromotionView = z.object({
  id: z.string().uuid(),
  state: PromotionState,
  source: PromotionSource,
  reason: z.string().max(500),
  size: z.string(),
  requestedAt: z.iso.datetime(),
  committedAt: z.iso.datetime().optional(),
  failedAt: z.iso.datetime().optional(),
  error: z.object({ code: PromotionErrorCode, message: z.string().max(500) }).strict().optional(),
}).strict();
export type PromotionView = z.infer<typeof PromotionView>;

/** `POST /v1/sessions/{id}/promote`. */
export const PromotionRequestBody = z.object({ reason: z.string().trim().max(500).default("") }).strict();
export type PromotionRequestBody = z.infer<typeof PromotionRequestBody>;

/** A promotion as returned by `POST /v1/sessions/{id}/promote`: the session's promotion and whether this request created it. */
export const PromotionResponse = z.object({ sessionId: z.string().uuid(), created: z.boolean(), promotion: PromotionView }).strict();
export type PromotionResponse = z.infer<typeof PromotionResponse>;

/**
 * Snapshot bounds. They are the session storage limits (eight MiB per file, 64 MiB and 2,048 entries per
 * namespace), so a namespace that fits its storage always fits one snapshot.
 */
export const PROMOTION_SNAPSHOT_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  bytes: 64 * 1024 * 1024,
  entries: 2048,
  depth: 64,
  pathLength: 4096,
  nameLength: 255,
});

/**
 * Files at the root of the runtime's session state that hold provider-scoped consent. A promoted session starts
 * without them: approvals given while the session had no shell or real files do not carry into the container.
 */
export const PROMOTION_EXCLUDED_STATE_FILES = Object.freeze(["permissions.json", "settings.json", "config.json"]);

/**
 * Directories at the root of the runtime's session state that are not carried: `temp` holds spilled tool output the
 * runtime deletes when the session disconnects, so the model re-runs a tool whose output it still needs.
 */
export const PROMOTION_EXCLUDED_STATE_DIRECTORIES = Object.freeze(["temp"]);

/**
 * A path inside one snapshot area: relative, `/`-separated, with no empty, `.`, or `..` component and no NUL,
 * backslash, or control character, so it restores to the same name on any Linux filesystem.
 */
export const PromotionSnapshotPath = z.string().min(1).max(PROMOTION_SNAPSHOT_LIMITS.pathLength).refine((value) => {
  const parts = value.split("/");
  return parts.length <= PROMOTION_SNAPSHOT_LIMITS.depth && parts.every((part) =>
    part.length > 0 && part.length <= PROMOTION_SNAPSHOT_LIMITS.nameLength && part !== "." && part !== ".."
    && !/[\u0000-\u001f\u007f\\]/.test(part));
}, "Snapshot paths are relative, slash-separated names without empty, '.', '..', backslash, or control characters.");

/**
 * One snapshot entry. `state` entries restore into the runtime's session-state directory for the session, flat as
 * the provider stored them; `workspace` entries restore into the container's workspace.
 */
export const PromotionSnapshotEntry = z.discriminatedUnion("kind", [
  z.object({ area: z.enum(["state", "workspace"]), kind: z.literal("directory"), path: PromotionSnapshotPath }).strict(),
  z.object({
    area: z.enum(["state", "workspace"]),
    kind: z.literal("file"),
    path: PromotionSnapshotPath,
    size: z.number().int().nonnegative().max(PROMOTION_SNAPSHOT_LIMITS.fileBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
export type PromotionSnapshotEntry = z.infer<typeof PromotionSnapshotEntry>;

/** Every entry of a snapshot in restore order: parents before their children. File contents travel separately. */
export const PromotionSnapshotManifest = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  entries: z.array(PromotionSnapshotEntry).max(PROMOTION_SNAPSHOT_LIMITS.entries),
}).strict().superRefine((manifest, context) => {
  const seen = new Set<string>();
  let bytes = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    const id = `${entry.area}:${entry.path}`;
    if (seen.has(id)) context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "Snapshot paths are unique within an area." });
    seen.add(id);
    const parent = entry.path.includes("/") ? `${entry.area}:${entry.path.slice(0, entry.path.lastIndexOf("/"))}` : undefined;
    if (parent && !seen.has(parent)) context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "A snapshot entry's parent directory must come first." });
    if (entry.kind === "file") bytes += entry.size;
  }
  if (bytes > PROMOTION_SNAPSHOT_LIMITS.bytes) context.addIssue({ code: "custom", path: ["entries"], message: "The snapshot exceeds the session storage limit." });
});
export type PromotionSnapshotManifest = z.infer<typeof PromotionSnapshotManifest>;

/**
 * The text a snapshot digest is computed over (SHA-256, written `sha256:<hex>`): the session and every entry's
 * area, kind, path, size, and content digest, one per line in manifest order. It binds the whole snapshot.
 */
export function promotionSnapshotDigestInput(manifest: PromotionSnapshotManifest): string {
  return [`promotion-snapshot/${manifest.schemaVersion}`, manifest.sessionId,
    ...manifest.entries.map((entry) => entry.kind === "file"
      ? `${entry.area}\tfile\t${entry.path}\t${entry.size}\t${entry.sha256}`
      : `${entry.area}\tdirectory\t${entry.path}`)].join("\n") + "\n";
}

// Internal protocol between a session container started for a promotion and the dispatcher, authenticated with the
// container's allocation-scoped credential.

/** Request one page of the snapshot, from a manifest ordinal. */
export const PromotionSnapshotPageRequest = z.object({ from: z.number().int().nonnegative().max(PROMOTION_SNAPSHOT_LIMITS.entries).default(0) }).strict();
export type PromotionSnapshotPageRequest = z.infer<typeof PromotionSnapshotPageRequest>;

/** One page of the snapshot: the manifest and its digest, and file contents in ascending ordinal order. */
export const PromotionSnapshotPage = z.object({
  promotionId: z.string().uuid(),
  sessionId: z.string().uuid(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifest: PromotionSnapshotManifest,
  files: z.array(z.object({ ordinal: z.number().int().nonnegative(), content: z.base64() }).strict()).max(PROMOTION_SNAPSHOT_LIMITS.entries),
  next: z.number().int().nonnegative().optional(),
}).strict();
export type PromotionSnapshotPage = z.infer<typeof PromotionSnapshotPage>;

/** The container could not restore or resume the snapshot; the promotion fails and the session stays shared. */
export const PromotionContainerFailure = z.object({
  code: z.enum(["restore_failed", "startup_failed"]),
  message: z.string().min(1).max(500),
}).strict();
export type PromotionContainerFailure = z.infer<typeof PromotionContainerFailure>;

/**
 * The system continuation a promoted conversation receives once, after cutover, so the agent knows where it now runs
 * and continues the work that asked for the move. The runtime keeps history as written, so earlier messages may name
 * the shared worker's workspace path; `previousWorkspace` maps it to the new one. The interrupted turn is not replayed.
 */
export function promotionContinuation(promotionId: string, workspace: string, previousWorkspace?: string): string {
  return [
    `[promotion:${promotionId}]`,
    "This conversation moved from shared placement into its own session container, one way.",
    `The workspace is now a real filesystem at ${workspace}, seeded from the conversation's workspace files,`,
    "and shell and file tools are available.",
    ...(previousWorkspace && previousWorkspace !== workspace
      ? [`Earlier messages refer to the workspace as ${previousWorkspace}; that path is now ${workspace}.`]
      : []),
    "The turn that asked for the move ended before it; nothing was replayed. Continue the task you were working on.",
  ].join("\n");
}
