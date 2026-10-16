import { posix, win32 } from "node:path";
import { SessionFileError, type SessionFileLease, type SessionFileStore } from "@copilot-agent/job-store";
import type { SessionFsProvider } from "@github/copilot-sdk";

/**
 * A provider path's namespace key and its spelling. Windows keys are case-folded, like the filesystem the runtime
 * expects; the spelling keeps the caller's letter case so created entries keep their names.
 */
export function providerKey(path: string, conventions: "windows" | "posix"): { key: string; spelling?: string } {
  const normalized = conventions === "windows" ? path.replace(/^\\\\\?\\/, "") : path;
  if (normalized.includes("\0") || normalized.split(/[/\\]/).some((part) => part === ".." || part === ".")) {
    throw new SessionFileError("EINVAL", "Invalid provider path.");
  }
  if (conventions === "windows") {
    if (!/^[a-z]:[/\\]/i.test(normalized) || !win32.isAbsolute(normalized) || /[:]/.test(normalized.slice(2))) {
      throw new SessionFileError("EINVAL", "Provider path must be an absolute Windows path.");
    }
    const spelling = `/${normalized[0]!.toLowerCase()}/${normalized.slice(3).replaceAll("\\", "/")}`;
    return { key: spelling.toLowerCase(), spelling };
  }
  if (!posix.isAbsolute(normalized) || normalized.includes("\\")) throw new SessionFileError("EINVAL", "Provider path must be absolute.");
  return { key: normalized };
}

/** Map virtual paths to one principal-bound, leased PostgreSQL namespace; no native file I/O. */
export function postgresSessionFilesystem(
  store: SessionFileStore,
  lease: SessionFileLease,
  conventions: "windows" | "posix",
): SessionFsProvider {
  const key = (path: string): string => providerKey(path, conventions).key;
  const spelled = (path: string) => providerKey(path, conventions);
  const write = (path: string, bytes: Uint8Array, append = false) => {
    const target = spelled(path);
    return store.write(lease, target.key, bytes, append, target.spelling);
  };
  return {
    readFile: async (path) => new TextDecoder("utf-8", { fatal: true }).decode(await store.read(lease, key(path))),
    readFileBytes: (path) => store.read(lease, key(path)),
    writeFile: (path, content) => write(path, Buffer.from(content, "utf8")),
    writeFileBytes: (path, bytes) => write(path, bytes),
    appendFile: (path, content) => write(path, Buffer.from(content, "utf8"), true),
    exists: async (path) => (await store.stat(lease, key(path))) !== undefined,
    stat: async (path) => {
      const entry = await store.stat(lease, key(path));
      if (!entry) throw new SessionFileError("ENOENT", "Provider resource not found.");
      return { isFile: !entry.directory, isDirectory: entry.directory, size: entry.size, mtime: entry.updatedAt, birthtime: entry.createdAt };
    },
    mkdir: (path, recursive) => {
      const target = spelled(path);
      return store.mkdir(lease, target.key, recursive, target.spelling);
    },
    readdir: async (path) => (await store.list(lease, key(path))).map((entry) => entry.name),
    readdirWithTypes: async (path) => (await store.list(lease, key(path))).map((entry) => ({ name: entry.name, type: entry.directory ? "directory" : "file" })),
    rm: (path, recursive, force) => store.remove(lease, key(path), recursive, force),
    rename: (source, destination) => {
      const target = spelled(destination);
      return store.rename(lease, key(source), target.key, target.spelling);
    },
  };
}
