import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type pg from "pg";

export interface SessionFileLease { id: string; principal: string; epoch: string }
export interface SessionFileInfo { directory: boolean; size: number; createdAt: string; updatedAt: string }
interface Entry {
  path: string;
  directory: boolean;
  content: Buffer | null;
  /** The entry's own name as first created, when the provider folds the key's case. */
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
  size?: number;
}
export class SessionFileError extends Error {
  constructor(readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL" | "ESTALE" | "EDQUOT", message: string) {
    super(message);
  }
}

/**
 * Bounded durable namespaces. Every operation checks and locks the active principal-bound lease.
 *
 * A provider that folds key case (Windows conventions) passes the caller's `spelling` of a created path: the same
 * path in its original case. Entries keep the name they were created with, so listings and promotion snapshots
 * return it, while lookups stay case-insensitive. Overwriting an entry keeps its name; renaming gives it the new one.
 */
export class SessionFileStore {
  constructor(private readonly pool: pg.Pool) {}

  async acquire(id: string, principal: string, worker: string, seconds = 30, limits = { bytes: 64 * 1024 * 1024, entries: 2048 }): Promise<SessionFileLease> {
    if (!principal || !worker || !Number.isInteger(seconds) || seconds < 10 || seconds > 300
      || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(limits.entries) || limits.entries < 1 || limits.entries > 2048) {
      throw new SessionFileError("EINVAL", "Invalid session storage lease or limits.");
    }
    const epoch = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO session_file_namespaces (id,principal,worker,epoch,lease_until,max_bytes,max_entries)
       VALUES ($1,$2,$3,$4,clock_timestamp()+$5*interval '1 second',$6,$7)
       ON CONFLICT (id) DO UPDATE SET worker=EXCLUDED.worker,epoch=EXCLUDED.epoch,lease_until=EXCLUDED.lease_until
       WHERE session_file_namespaces.principal=EXCLUDED.principal AND session_file_namespaces.lease_until < clock_timestamp()
       RETURNING id`,
      [id, principal, worker, epoch, seconds, limits.bytes, limits.entries],
    );
    if (!result.rowCount) throw new SessionFileError("ESTALE", "Session storage is owned by another activation or principal.");
    return { id, principal, epoch };
  }

  async heartbeat(lease: SessionFileLease, seconds = 30): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) throw new SessionFileError("EINVAL", "Invalid lease duration.");
    const result = await this.pool.query(
      `UPDATE session_file_namespaces SET lease_until=clock_timestamp()+$4*interval '1 second'
       WHERE id=$1 AND principal=$2 AND epoch=$3 AND lease_until>clock_timestamp()`,
      [lease.id, lease.principal, lease.epoch, seconds],
    );
    if (!result.rowCount) throw new SessionFileError("ESTALE", "Session storage lease is no longer active.");
  }

  async release(lease: SessionFileLease): Promise<void> {
    await this.pool.query("UPDATE session_file_namespaces SET lease_until=clock_timestamp() WHERE id=$1 AND principal=$2 AND epoch=$3",
      [lease.id, lease.principal, lease.epoch]);
  }

  async read(lease: SessionFileLease, path: string): Promise<Buffer> {
    return this.#tx(lease, async (db) => {
      const entry = await this.#required(db, lease.id, key(path));
      if (entry.directory) throw new SessionFileError("EISDIR", "Expected a file.");
      return entry.content!;
    });
  }

  async stat(lease: SessionFileLease, path: string): Promise<SessionFileInfo | undefined> {
    return this.#tx(lease, async (db) => {
      const entry = await this.#entry(db, lease.id, key(path), true);
      return entry ? info(entry) : undefined;
    });
  }

  async list(lease: SessionFileLease, path: string): Promise<Array<SessionFileInfo & { name: string }>> {
    return this.#tx(lease, async (db) => {
      const normalized = key(path);
      if (!(await this.#required(db, lease.id, normalized)).directory) throw new SessionFileError("ENOTDIR", "Expected a directory.");
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const result = await db.query<Entry>("SELECT path,directory,NULL::bytea AS content,display_name,octet_length(content) AS size,created_at,updated_at FROM session_files WHERE namespace_id=$1 AND starts_with(path,$2) AND path<>$3 ORDER BY path",
        [lease.id, prefix, normalized]);
      return result.rows.filter((entry) => !entry.path.slice(prefix.length).includes("/"))
        .map((entry) => ({ name: entry.display_name ?? entry.path.slice(prefix.length), ...info(entry) }));
    });
  }

  async write(lease: SessionFileLease, path: string, bytes: Uint8Array, append = false, spelling?: string): Promise<void> {
    if (bytes.byteLength > 8 * 1024 * 1024) throw new SessionFileError("EDQUOT", "Session file exceeds eight MiB.");
    await this.#tx(lease, async (db) => {
      const normalized = key(path);
      if (normalized === "/") throw new SessionFileError("EISDIR", "Cannot write the namespace root.");
      const spelled = spellingOf(normalized, spelling);
      await this.#mkdir(db, lease.id, posix.dirname(normalized), true, spelled && posix.dirname(spelled));
      const current = await this.#entry(db, lease.id, normalized);
      if (current?.directory) throw new SessionFileError("EISDIR", "Cannot replace a directory with file content.");
      const content = append && current ? Buffer.concat([current.content!, bytes]) : Buffer.from(bytes);
      if (content.byteLength > 8 * 1024 * 1024) throw new SessionFileError("EDQUOT", "Session file exceeds eight MiB.");
      await db.query(
        `INSERT INTO session_files(namespace_id,path,directory,content,display_name) VALUES($1,$2,false,$3,$4)
         ON CONFLICT(namespace_id,path) DO UPDATE SET content=EXCLUDED.content,updated_at=clock_timestamp()`,
        [lease.id, normalized, content, displayName(normalized, spelled)]);
    }, true);
  }

  async mkdir(lease: SessionFileLease, path: string, recursive: boolean, spelling?: string): Promise<void> {
    await this.#tx(lease, (db) => {
      const normalized = key(path);
      return this.#mkdir(db, lease.id, normalized, recursive, spellingOf(normalized, spelling));
    }, true);
  }

  async remove(lease: SessionFileLease, path: string, recursive: boolean, force: boolean): Promise<void> {
    await this.#tx(lease, async (db) => {
      const normalized = key(path);
      if (normalized === "/") throw new SessionFileError("EINVAL", "Cannot delete the namespace root.");
      const existing = await this.#entry(db, lease.id, normalized);
      if (!existing) {
        if (force) return;
        throw new SessionFileError("ENOENT", "Session file does not exist.");
      }
      if (existing.directory && !recursive) {
        const children = await db.query("SELECT 1 FROM session_files WHERE namespace_id=$1 AND starts_with(path,$2) LIMIT 1", [lease.id, `${normalized}/`]);
        if (children.rowCount) throw new SessionFileError("ENOTEMPTY", "Session directory is not empty.");
      }
      await db.query("DELETE FROM session_files WHERE namespace_id=$1 AND (path=$2 OR starts_with(path,$3))", [lease.id, normalized, `${normalized}/`]);
    });
  }

  async rename(lease: SessionFileLease, source: string, destination: string, spelling?: string): Promise<void> {
    await this.#tx(lease, async (db) => {
      const from = key(source);
      const to = key(destination);
      if (from === "/" || to === "/" || to.startsWith(`${from}/`)) throw new SessionFileError("EINVAL", "Invalid namespace rename.");
      const spelled = spellingOf(to, spelling);
      const current = await this.#required(db, lease.id, from);
      if (from === to) {
        // A case-only rename on a folding provider changes only the entry's name.
        if (spelled) await db.query("UPDATE session_files SET display_name=$3 WHERE namespace_id=$1 AND path=$2", [lease.id, to, displayName(to, spelled)]);
        return;
      }
      if (!(await this.#required(db, lease.id, posix.dirname(to))).directory) throw new SessionFileError("ENOTDIR", "Destination parent is not a directory.");
      const target = await this.#entry(db, lease.id, to);
      if (target) {
        if (target.directory !== current.directory) throw new SessionFileError("EINVAL", "Source and destination types differ.");
        const children = await db.query("SELECT 1 FROM session_files WHERE namespace_id=$1 AND starts_with(path,$2) LIMIT 1", [lease.id, `${to}/`]);
        if (children.rowCount) throw new SessionFileError("ENOTEMPTY", "Destination directory is not empty.");
        await db.query("DELETE FROM session_files WHERE namespace_id=$1 AND path=$2", [lease.id, to]);
      }
      await db.query(
        `UPDATE session_files SET path=$3 || substring(path from length($2)+1),updated_at=clock_timestamp(),
           display_name=CASE WHEN path=$2 THEN $5 ELSE display_name END
         WHERE namespace_id=$1 AND (path=$2 OR starts_with(path,$4))`,
        [lease.id, from, to, `${from}/`, displayName(to, spelled)]);
    }, true);
  }

  async #entry(db: pg.PoolClient, id: string, path: string, metadataOnly = false): Promise<Entry | undefined> {
    const fields = metadataOnly ? "path,directory,NULL::bytea AS content,display_name,octet_length(content) AS size,created_at,updated_at" : "*";
    return (await db.query<Entry>(`SELECT ${fields} FROM session_files WHERE namespace_id=$1 AND path=$2`, [id, path])).rows[0];
  }
  async #required(db: pg.PoolClient, id: string, path: string): Promise<Entry> {
    const entry = await this.#entry(db, id, path);
    if (!entry) throw new SessionFileError("ENOENT", "Session resource does not exist.");
    return entry;
  }
  async #mkdir(db: pg.PoolClient, id: string, path: string, recursive: boolean, spelled?: string): Promise<void> {
    const current = await this.#entry(db, id, path);
    if (current) {
      if (!current.directory) throw new SessionFileError("EEXIST", "A file occupies the directory path.");
      return;
    }
    if (path !== "/") {
      const parent = posix.dirname(path);
      if (recursive) await this.#mkdir(db, id, parent, true, spelled && posix.dirname(spelled));
      else if (!(await this.#required(db, id, parent)).directory) throw new SessionFileError("ENOTDIR", "Expected a directory parent.");
    }
    await db.query("INSERT INTO session_files(namespace_id,path,directory,display_name) VALUES($1,$2,true,$3)", [id, path, displayName(path, spelled)]);
  }

  async #tx<T>(lease: SessionFileLease, action: (db: pg.PoolClient) => Promise<T>, checkQuota = false): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      try {
        await db.query("SET LOCAL statement_timeout='5s'");
        const result = await db.query<{ max_bytes: number; max_entries: number }>(
          "SELECT max_bytes,max_entries FROM session_file_namespaces WHERE id=$1 AND principal=$2 AND epoch=$3 AND lease_until>clock_timestamp() FOR UPDATE",
          [lease.id, lease.principal, lease.epoch]);
        if (!result.rows[0]) throw new SessionFileError("ESTALE", "Session storage lease is no longer active.");
        const value = await action(db);
        if (checkQuota) {
          const usage = await db.query<{ bytes: string; entries: string }>(
            "SELECT COALESCE(sum(octet_length(content)),0)::text AS bytes,count(*)::text AS entries FROM session_files WHERE namespace_id=$1", [lease.id]);
          if (Number(usage.rows[0]!.bytes) > result.rows[0].max_bytes || Number(usage.rows[0]!.entries) > result.rows[0].max_entries) {
            throw new SessionFileError("EDQUOT", "Session storage quota exceeded.");
          }
        }
        await db.query("COMMIT");
        return value;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    } finally { db.release(); }
  }
}

function key(path: string): string {
  if (!path.startsWith("/") || path.length > 4096 || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === ".")) {
    throw new SessionFileError("EINVAL", "Invalid session resource key.");
  }
  const normalized = posix.normalize(path);
  if (normalized.split("/").length > 64) throw new SessionFileError("EINVAL", "Session path is too deep.");
  return normalized === "/" ? normalized : normalized.replace(/\/$/, "");
}
/** Validates a caller's original-case spelling of `normalized`; undefined when the caller passed none. */
function spellingOf(normalized: string, spelling: string | undefined): string | undefined {
  if (spelling === undefined) return undefined;
  const spelled = key(spelling);
  if (spelled.toLowerCase() !== normalized.toLowerCase() || spelled.split("/").length !== normalized.split("/").length) {
    throw new SessionFileError("EINVAL", "A path's spelling must differ from its key only in letter case.");
  }
  return spelled;
}
/** The name to keep for an entry: its spelled name when that differs from the key's own name. */
function displayName(normalized: string, spelled: string | undefined): string | null {
  if (!spelled || normalized === "/") return null;
  const name = posix.basename(spelled);
  return name === posix.basename(normalized) ? null : name;
}
function info(entry: Entry): SessionFileInfo {
  return { directory: entry.directory, size: entry.size ?? entry.content?.length ?? 0, createdAt: entry.created_at.toISOString(), updatedAt: entry.updated_at.toISOString() };
}
