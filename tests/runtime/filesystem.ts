import * as fs from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import type { SessionFsProvider } from "@github/copilot-sdk";

/** Disk-backed fixture for exercising virtual paths; not a production storage or isolation implementation. */
export function fixtureFilesystem(root: string, conventions: "posix" | "windows" = "posix"): SessionFsProvider {
  const physical = (virtual: string) => {
    if (conventions === "windows") {
      if (!win32.isAbsolute(virtual) || !/^[A-Za-z]:[\\/]/.test(virtual) || virtual.includes("\0") || virtual.split(/[/\\]/).includes("..")) {
        throw new Error("Invalid virtual filesystem path.");
      }
      return join(root, virtual[0]!.toLowerCase(), ...virtual.slice(3).split(/[/\\]/).filter(Boolean));
    }
    if (!posix.isAbsolute(virtual) || virtual.includes("\\") || virtual.includes("\0") || virtual.split("/").includes("..")) {
      throw new Error("Invalid virtual filesystem path.");
    }
    return join(root, ...virtual.split("/").filter(Boolean));
  };
  const write = async (virtual: string, content: string, append: boolean) => {
    const destination = physical(virtual);
    await fs.mkdir(dirname(destination), { recursive: true });
    if (append) await fs.appendFile(destination, content, "utf8");
    else await fs.writeFile(destination, content, "utf8");
  };
  return {
    readFile: (path) => fs.readFile(physical(path), "utf8"),
    readFileBytes: (path) => fs.readFile(physical(path)),
    writeFileBytes: async (path, content) => {
      const destination = physical(path);
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    },
    writeFile: (path, content) => write(path, content, false),
    appendFile: (path, content) => write(path, content, true),
    exists: async (path) => {
      try {
        await fs.stat(physical(path));
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    stat: async (path) => {
      const info = await fs.stat(physical(path));
      return {
        isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size,
        mtime: info.mtime.toISOString(), birthtime: info.birthtime.toISOString(),
      };
    },
    mkdir: async (path, recursive) => { await fs.mkdir(physical(path), { recursive }); },
    readdir: (path) => fs.readdir(physical(path)),
    readdirWithTypes: async (path) => (await fs.readdir(physical(path), { withFileTypes: true })).map((entry) => ({
      name: entry.name, type: entry.isDirectory() ? "directory" as const : "file" as const,
    })),
    rm: async (path, recursive, force) => {
      try {
        if (!recursive && (await fs.stat(physical(path))).isDirectory()) await fs.rmdir(physical(path));
        else await fs.rm(physical(path), { recursive, force });
      } catch (error) {
        if (force && error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    },
    rename: async (source, destination) => {
      await fs.mkdir(dirname(physical(destination)), { recursive: true });
      await fs.rename(physical(source), physical(destination));
    },
  };
}
