import { posix, win32 } from "node:path";
import { SessionFileError, type SessionFileLease, type SessionFileStore } from "@copilot-agent/job-store";
import type { SessionFsProvider } from "@github/copilot-sdk";

/** Map virtual paths to one principal-bound, leased PostgreSQL namespace; no native file I/O. */
export function postgresSessionFilesystem(
  store: SessionFileStore,
  lease: SessionFileLease,
  conventions: "windows" | "posix",
): SessionFsProvider {
  const key = (path: string): string => {
    const normalized = conventions === "windows" ? path.replace(/^\\\\\?\\/, "") : path;
    if (normalized.includes("\0") || normalized.split(/[/\\]/).some((part) => part === ".." || part === ".")) {
      throw new SessionFileError("EINVAL", "Invalid provider path.");
    }
    if (conventions === "windows") {
      if (!/^[a-z]:[/\\]/i.test(normalized) || !win32.isAbsolute(normalized) || /[:]/.test(normalized.slice(2))) {
        throw new SessionFileError("EINVAL", "Provider path must be an absolute Windows path.");
      }
      return `/${normalized[0]!.toLowerCase()}/${normalized.slice(3).replaceAll("\\", "/").toLowerCase()}`;
    }
    if (!posix.isAbsolute(normalized) || normalized.includes("\\")) throw new SessionFileError("EINVAL", "Provider path must be absolute.");
    return normalized;
  };
  return {
    readFile: async (path) => new TextDecoder("utf-8", { fatal: true }).decode(await store.read(lease, key(path))),
    readFileBytes: (path) => store.read(lease, key(path)),
    writeFile: (path, content) => store.write(lease, key(path), Buffer.from(content, "utf8")),
    writeFileBytes: (path, bytes) => store.write(lease, key(path), bytes),
    appendFile: (path, content) => store.write(lease, key(path), Buffer.from(content, "utf8"), true),
    exists: async (path) => (await store.stat(lease, key(path))) !== undefined,
    stat: async (path) => {
      const entry = await store.stat(lease, key(path));
      if (!entry) throw new SessionFileError("ENOENT", "Provider resource not found.");
      return { isFile: !entry.directory, isDirectory: entry.directory, size: entry.size, mtime: entry.updatedAt, birthtime: entry.createdAt };
    },
    mkdir: (path, recursive) => store.mkdir(lease, key(path), recursive),
    readdir: async (path) => (await store.list(lease, key(path))).map((entry) => entry.name),
    readdirWithTypes: async (path) => (await store.list(lease, key(path))).map((entry) => ({ name: entry.name, type: entry.directory ? "directory" : "file" })),
    rm: (path, recursive, force) => store.remove(lease, key(path), recursive, force),
    rename: (source, destination) => store.rename(lease, key(source), key(destination)),
  };
}
