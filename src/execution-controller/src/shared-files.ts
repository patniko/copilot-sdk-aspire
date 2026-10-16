import { z } from "zod";
import { ArtifactPath } from "@copilot-agent/contracts";
import { StoreError } from "@copilot-agent/job-store";
import { HttpError, requireInternalKey, type createService } from "@copilot-agent/service-defaults";

type ServiceApp = ReturnType<typeof createService>;

/** The largest file the shared file service reads, and the largest it writes. */
export const SHARED_FILE_READ_LIMIT = 4 * 1024 * 1024;
export const SHARED_FILE_WRITE_LIMIT = 32 * 1024;
/** The most entries one directory listing returns. */
export const SHARED_FILE_LIST_LIMIT = 500;

export type SharedFileOperation =
  | { kind: "list"; path?: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: Buffer; ifMatch?: string };
export interface SharedFileEntry { name: string; type: "file" | "directory"; size?: number }
export type SharedFileResult = { entries: SharedFileEntry[] } | { content: Buffer } | { size: number; etag: string };

/** A refused shared-file operation, with the reason the coordinator's tool reports to the model. */
export class SharedFileError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid" | "too_large" | "unavailable", message: string) { super(message); }
}

/**
 * The script a helper container runs (as root only to hand the volume's root to the execution user, then as that
 * user). Paths stay inside the volume and never follow symbolic links. Writes are atomic renames; replacing a file
 * needs its current etag (SHA-256, base64url).
 */
export const SHARED_FILES_SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = "/shared", UID = 10001, [op, rel = "", ifMatch = ""] = process.argv.slice(1);
const done = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const refuse = (code, message) => done({ ok: false, code, message });
try {
  if (process.getuid() === 0) {
    if (op === "write" && fs.statSync(ROOT).uid !== UID) fs.chownSync(ROOT, UID, UID);
    process.setgid(UID); process.setuid(UID);
  }
  const target = path.resolve(ROOT, rel);
  if (target !== ROOT && !target.startsWith(ROOT + "/")) refuse("invalid", "The path is outside the shared volume.");
  let current = ROOT;
  for (const part of path.relative(ROOT, target).split("/").filter(Boolean)) {
    current = path.join(current, part);
    let stat; try { stat = fs.lstatSync(current); } catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (stat.isSymbolicLink()) refuse("invalid", "The path contains a symbolic link.");
  }
  const etag = (data) => crypto.createHash("sha256").update(data).digest("base64url");
  if (op === "list") {
    let entries; try { entries = fs.readdirSync(target, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT" && target === ROOT) done({ ok: true, entries: [] }); if (error.code === "ENOENT" || error.code === "ENOTDIR") refuse("not_found", "The directory was not found."); throw error; }
    const listed = [];
    for (const entry of entries.slice(0, ${SHARED_FILE_LIST_LIMIT})) {
      if (entry.isDirectory()) listed.push({ name: entry.name, type: "directory" });
      else if (entry.isFile()) listed.push({ name: entry.name, type: "file", size: fs.lstatSync(path.join(target, entry.name)).size });
    }
    done({ ok: true, entries: listed, truncated: entries.length > ${SHARED_FILE_LIST_LIMIT} });
  }
  if (op === "read") {
    let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") refuse("not_found", "The file was not found."); throw error; }
    if (!stat.isFile()) refuse("not_found", "The path is not a file.");
    if (stat.size > ${SHARED_FILE_READ_LIMIT}) refuse("too_large", "The file is larger than 4 MiB; ask a worker to summarize it.");
    done({ ok: true, content: fs.readFileSync(target).toString("base64") });
  }
  if (op === "write") {
    if (target === ROOT) refuse("invalid", "Name a file to write.");
    const chunks = []; let size = 0;
    for (;;) { const buffer = Buffer.alloc(65536); let read; try { read = fs.readSync(0, buffer, 0, buffer.length, null); } catch (error) { if (error.code === "EAGAIN") continue; if (error.code === "EOF") break; throw error; } if (!read) break; size += read; if (size > ${SHARED_FILE_WRITE_LIMIT}) refuse("too_large", "The content is larger than 32 KiB."); chunks.push(buffer.subarray(0, read)); }
    const content = Buffer.concat(chunks);
    let existing; try { const stat = fs.lstatSync(target); if (!stat.isFile()) refuse("conflict", "The path is not a file."); existing = fs.readFileSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing !== undefined && ifMatch !== etag(existing)) refuse("conflict", ifMatch ? "The file changed since it was read; read it again." : "The file exists; read it first and pass its etag to replace it.");
    if (existing === undefined && ifMatch) refuse("conflict", "The file no longer exists.");
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const temporary = path.join(path.dirname(target), "." + path.basename(target) + "." + crypto.randomUUID() + ".tmp");
    fs.writeFileSync(temporary, content, { mode: 0o644, flag: "wx" });
    fs.renameSync(temporary, target);
    done({ ok: true, size: content.length, etag: etag(content) });
  }
  refuse("invalid", "Unknown shared file operation.");
} catch (error) { done({ ok: false, code: "unavailable", message: "The shared volume could not be accessed." }); }
`;

const Reply = z.union([
  z.object({ ok: z.literal(false), code: z.enum(["not_found", "conflict", "invalid", "too_large", "unavailable"]), message: z.string().max(500) }).strict(),
  z.object({ ok: z.literal(true), entries: z.array(z.object({ name: z.string(), type: z.enum(["file", "directory"]), size: z.number().int().nonnegative().optional() }).strict()), truncated: z.boolean() }).strict(),
  z.object({ ok: z.literal(true), content: z.string() }).strict(),
  z.object({ ok: z.literal(true), size: z.number().int().nonnegative(), etag: z.string() }).strict(),
]);

/** Interprets a helper container's output for `operation`. */
export function sharedFileReply(operation: SharedFileOperation, output: string): SharedFileResult {
  const parsed = Reply.safeParse(JSON.parse(output || "null"));
  if (!parsed.success) throw new SharedFileError("unavailable", "The shared file service returned an invalid reply.");
  const reply = parsed.data;
  if (!reply.ok) throw new SharedFileError(reply.code, reply.message);
  if (operation.kind === "list" && "entries" in reply) return { entries: reply.entries };
  if (operation.kind === "read" && "content" in reply) return { content: Buffer.from(reply.content, "base64") };
  if (operation.kind === "write" && "etag" in reply) return { size: reply.size, etag: reply.etag };
  throw new SharedFileError("unavailable", "The shared file service returned an invalid reply.");
}

const Session = z.string().uuid();
const List = z.object({ sessionId: Session, path: ArtifactPath.optional() }).strict();
const Read = z.object({ sessionId: Session, path: ArtifactPath }).strict();
const Write = z.object({
  sessionId: Session, path: ArtifactPath, content: z.string().max(Math.ceil(SHARED_FILE_WRITE_LIMIT / 3) * 4).base64(), ifMatch: z.string().max(200).optional(),
}).strict();

/**
 * The controller-side shared file service (docs/HOSTING-MODES-PLAN.md, decision D10). Only the shared worker calls it,
 * with its own key, for an open orchestrator conversation; the coordinator has no filesystem of its own.
 */
export function registerSharedFileRoutes(
  app: ServiceApp,
  service: { sharedFiles(sessionId: string, operation: SharedFileOperation): Promise<SharedFileResult> },
  key: string,
): void {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid shared file request.");
    return parsed.data;
  };
  const perform = async (sessionId: string, operation: SharedFileOperation): Promise<SharedFileResult> => {
    try { return await service.sharedFiles(sessionId, operation); }
    catch (error) {
      if (error instanceof SharedFileError) {
        const status = { not_found: 404, conflict: 409, invalid: 400, too_large: 413, unavailable: 503 }[error.code];
        throw new HttpError(status, error.code, error.message);
      }
      if (error instanceof StoreError) {
        throw new HttpError({ not_found: 404, quota_exceeded: 429, invalid_request: 400, invalid_state: 409, idempotency_conflict: 409 }[error.code], error.code, error.message);
      }
      throw error;
    }
  };
  app.post("/internal/shared-files/list", async (request) => {
    requireInternalKey(request, key);
    const body = parse(List, request.body);
    return perform(body.sessionId, { kind: "list", ...(body.path ? { path: body.path } : {}) });
  });
  app.post("/internal/shared-files/read", async (request, reply) => {
    requireInternalKey(request, key);
    const body = parse(Read, request.body);
    const result = await perform(body.sessionId, { kind: "read", path: body.path });
    reply.header("cache-control", "no-store");
    return { content: "content" in result ? result.content.toString("base64") : "" };
  });
  app.post("/internal/shared-files/write", async (request) => {
    requireInternalKey(request, key);
    const body = parse(Write, request.body);
    const content = Buffer.from(body.content, "base64");
    if (content.length > SHARED_FILE_WRITE_LIMIT) throw new HttpError(413, "too_large", "The content is larger than 32 KiB.");
    return perform(body.sessionId, { kind: "write", path: body.path, content, ...(body.ifMatch ? { ifMatch: body.ifMatch } : {}) });
  });
}
