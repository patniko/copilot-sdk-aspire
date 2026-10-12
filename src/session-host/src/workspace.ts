import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AhpHostOptions, SessionFsProvider } from "@github/copilot-sdk";
import { z } from "zod";

type Callback = NonNullable<AhpHostOptions["onWorkspaceResource"]>;
type Result = Awaited<ReturnType<Callback>>;
type FailureCode = Extract<Result, { kind: "failure" }>["code"];
const MAX_BYTES = 1024 * 1024;
const MAX_PENDING = 32;
const base = z.object({ uri: z.string().max(8192) });
const read = base.extend({ encoding: z.enum(["utf-8", "base64"]).optional() });
const write = base.extend({
  data: z.string().max(Math.ceil(MAX_BYTES / 3) * 4),
  encoding: z.enum(["utf-8", "base64"]),
  createOnly: z.boolean().optional(),
  mode: z.enum(["truncate", "append", "insert"]).default("truncate"),
  position: z.number().int().nonnegative().max(MAX_BYTES).default(0),
  ifMatch: z.string().max(200).optional(),
});
const transfer = z.object({
  source: z.string().max(8192), destination: z.string().max(8192),
  failIfExists: z.boolean().optional(),
});

class WorkspaceError extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}

/**
 * One activation's SDK and AHP views over the same provider. The caller owns durable storage,
 * activation fencing, and exclusive worker ownership; this lane serializes only this process.
 * The backing provider must not resolve symlinks or aliases outside its own session namespace.
 */
export class SessionWorkspace {
  readonly sessionFs: SessionFsProvider;
  readonly onResource: Callback;
  readonly anchor: string;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(
    anchor: string,
    private readonly storage: SessionFsProvider,
    private readonly active: AbortSignal,
    private readonly reportFailure: (operation: string) => void,
  ) {
    if (!isAbsolute(anchor)) throw new Error("A session workspace anchor must be absolute.");
    this.anchor = resolve(anchor);
    if (!storage.readFileBytes || !storage.writeFileBytes) {
      throw new Error("The workspace bridge requires exact binary read/write operations.");
    }
    this.sessionFs = {
      readFile: (path) => this.#run("readFile", () => storage.readFile(path)),
      writeFile: (path, content, mode) => this.#run("writeFile", () => storage.writeFile(path, content, mode)),
      appendFile: (path, content, mode) => this.#run("appendFile", () => storage.appendFile(path, content, mode)),
      readFileBytes: (path) => this.#run("readFileBytes", () => storage.readFileBytes!(path)),
      writeFileBytes: (path, content, mode) => this.#run("writeFileBytes", () => storage.writeFileBytes!(path, content, mode)),
      exists: (path) => this.#run("exists", () => storage.exists(path)),
      stat: (path) => this.#run("stat", () => storage.stat(path)),
      mkdir: (path, recursive, mode) => this.#run("mkdir", () => storage.mkdir(path, recursive, mode)),
      readdir: (path) => this.#run("readdir", () => storage.readdir(path)),
      readdirWithTypes: (path) => this.#run("readdirWithTypes", () => storage.readdirWithTypes(path)),
      rm: (path, recursive, force) => this.#run("rm", () => storage.rm(path, recursive, force)),
      rename: (source, destination) => this.#run("rename", () => storage.rename(source, destination)),
    };
    if (storage.sqlite) throw new Error("Session SQLite is not supported by this workspace bridge.");
    this.onResource = async (request, { signal }) => {
      try {
        return await this.#run(request.operation, () => this.#resource(request.operation, request.params), signal);
      } catch (error) {
        if (error instanceof WorkspaceError) return { kind: "failure", code: error.code, message: error.message };
        if (error instanceof z.ZodError) return { kind: "failure", code: "invalidParams", message: "Invalid workspace resource parameters." };
        if (error instanceof Error && "code" in error) {
          if (error.code === "ENOENT") return { kind: "failure", code: "notFound", message: "Workspace resource not found." };
          if (error.code === "EEXIST") return { kind: "failure", code: "alreadyExists", message: "Workspace resource already exists." };
          if (error.code === "ENOTEMPTY") return { kind: "failure", code: "conflict", message: "The directory is not empty." };
        }
        return { kind: "failure", code: "internal", message: "Workspace storage failed or activation ended; mutation outcome may be unknown." };
      }
    };
  }

  #run<T>(operation: string, action: () => Promise<T>, signal = this.active): Promise<T> {
    if (this.#pending >= MAX_PENDING) return Promise.reject(new WorkspaceError("conflict", "Workspace operation capacity is exhausted."));
    this.#pending++;
    const work = this.#tail.then(async () => {
      try {
        this.active.throwIfAborted();
        signal.throwIfAborted();
        const result = await action();
        this.active.throwIfAborted();
        signal.throwIfAborted();
        return result;
      } catch (error) {
        this.reportFailure(operation);
        throw error;
      }
    }).finally(() => { this.#pending--; });
    this.#tail = work.then(() => undefined, () => undefined);
    return work;
  }

  #path(uri: string): string {
    let path: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:" || parsed.hostname || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error("Not a local file URI");
      }
      path = fileURLToPath(parsed);
    } catch {
      throw new WorkspaceError("invalidParams", "Use a local file URI for this workspace.");
    }
    const suffix = relative(this.anchor, path);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
      throw new WorkspaceError("permissionDenied", "Resource is outside this session workspace.");
    }
    if (suffix.split(sep).some((part) => part.includes("\0") || (process.platform === "win32" && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))))) {
      throw new WorkspaceError("invalidParams", "Invalid workspace path.");
    }
    return resolve(this.anchor, suffix);
  }

  async #bytes(path: string): Promise<Buffer> {
    const info = await this.storage.stat(path);
    if (!info.isFile || !Number.isSafeInteger(info.size) || info.size! < 0) {
      throw new WorkspaceError("invalidParams", "Expected a file with valid metadata.");
    }
    if (info.size! > MAX_BYTES) throw new WorkspaceError("invalidParams", "Resource exceeds the one MiB bridge limit.");
    const bytes = Buffer.from(await this.storage.readFileBytes!(path));
    if (bytes.length > MAX_BYTES) throw new WorkspaceError("invalidParams", "Resource exceeds the one MiB bridge limit.");
    return bytes;
  }

  async #resource(operation: Parameters<Callback>[0]["operation"], params: Parameters<Callback>[0]["params"]): Promise<Result> {
    const ok = (result: Record<string, unknown> = {}): Result => ({ kind: "success", result });
    if (operation === "resourceCopy" || operation === "resourceMove") {
      const parsed = transfer.parse(params);
      const source = this.#path(parsed.source);
      const destination = this.#path(parsed.destination);
      this.#mutable(source);
      this.#mutable(destination);
      await this.#parent(destination);
      const exists = await this.storage.exists(destination);
      if (exists && parsed.failIfExists) throw new WorkspaceError("alreadyExists", "Destination already exists.");
      if (exists && (await this.storage.stat(destination)).isDirectory) throw new WorkspaceError("unsupported", "Directory replacement is not supported.");
      if ((await this.storage.stat(source)).isDirectory) throw new WorkspaceError("unsupported", "Directory transfers are not supported by this bridge.");
      const bytes = await this.#bytes(source);
      if (source === destination) return ok();
      if (operation === "resourceMove") await this.storage.rename(source, destination);
      else await this.storage.writeFileBytes!(destination, bytes);
      return ok();
    }
    const path = this.#path(base.parse(params).uri);
    switch (operation) {
      case "resourceRead": {
        const { encoding } = read.parse(params);
        const bytes = await this.#bytes(path);
        if (encoding === "base64") return ok({ data: bytes.toString("base64"), encoding });
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return ok({ data: bytes.toString("base64"), encoding: "base64" }); }
        return ok({ data: text, encoding: "utf-8" });
      }
      case "resourceResolve": {
        base.extend({ followSymlinks: z.boolean().optional() }).parse(params);
        const info = await this.storage.stat(path);
        if ((info.isDirectory !== true && info.isFile !== true) || (info.isDirectory === true && info.isFile === true)) throw new WorkspaceError("internal", "Invalid workspace metadata.");
        return ok({
          uri: pathToFileURL(path).href, type: info.isDirectory ? "directory" : "file",
          ...(info.isFile ? { size: info.size, etag: hash(await this.#bytes(path)) } : {}),
          ...(info.mtime ? { mtime: info.mtime } : {}),
          ...(info.birthtime ? { ctime: info.birthtime } : {}),
        });
      }
      case "resourceList": {
        if (!(await this.storage.stat(path)).isDirectory) throw new WorkspaceError("invalidParams", "Expected a directory.");
        const entries = await this.storage.readdirWithTypes(path);
        if (entries.length > 1000) throw new WorkspaceError("invalidParams", "Directory exceeds the bridge listing limit.");
        return ok({ entries: [...entries].sort((a, b) => a.name.localeCompare(b.name)) });
      }
      case "resourceMkdir":
        if (await this.storage.exists(path) && !(await this.storage.stat(path)).isDirectory) throw new WorkspaceError("alreadyExists", "The resource is not a directory.");
        await this.storage.mkdir(path, true);
        return ok();
      case "resourceDelete": {
        this.#mutable(path);
        const { recursive } = base.extend({ recursive: z.boolean().default(false) }).parse(params);
        await this.storage.rm(path, recursive, false);
        return ok();
      }
      case "resourceRequest": {
        const access = base.extend({ read: z.boolean().optional(), write: z.boolean().optional() }).parse(params);
        if (access.read || !access.write) await this.storage.stat(path);
        if (access.write && !(await this.storage.exists(path))) {
          if (!(await this.storage.stat(dirname(path))).isDirectory) throw new WorkspaceError("invalidParams", "Parent must be a workspace directory.");
        }
        return ok();
      }
      case "resourceWrite": {
        this.#mutable(path);
        await this.#parent(path);
        const input = write.parse(params);
        if (input.createOnly && (input.ifMatch !== undefined || input.mode !== "truncate" || input.position !== 0)) throw new WorkspaceError("invalidParams", "Create-only cannot be combined with position, mode, or etag preconditions.");
        const exists = await this.storage.exists(path);
        if (input.createOnly && exists) throw new WorkspaceError("alreadyExists", "The file already exists.");
        const previous = exists ? await this.#bytes(path) : Buffer.alloc(0);
        if (input.ifMatch !== undefined && (!exists || hash(previous) !== input.ifMatch)) throw new WorkspaceError("conflict", "The workspace file changed.");
        if (input.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new WorkspaceError("invalidParams", "Malformed base64 content.");
        const bytes = Buffer.from(input.data, input.encoding === "utf-8" ? "utf8" : "base64");
        if (bytes.length > MAX_BYTES) throw new WorkspaceError("invalidParams", "Resource exceeds the one MiB bridge limit.");
        const offset = input.mode === "append" ? previous.length - input.position : input.position;
        if (offset < 0 || offset > previous.length) throw new WorkspaceError("invalidParams", "Position exceeds the file size.");
        const tail = input.mode === "truncate" ? Buffer.alloc(0) : previous.subarray(offset);
        if (offset + bytes.length + tail.length > MAX_BYTES) throw new WorkspaceError("invalidParams", "Result exceeds the one MiB bridge limit.");
        await this.storage.writeFileBytes!(path, Buffer.concat([previous.subarray(0, offset), bytes, tail]));
        return ok();
      }
    }
  }

  #mutable(path: string): void {
    if (relative(this.anchor, path) === "") throw new WorkspaceError("permissionDenied", "The workspace root cannot be replaced, moved, or removed.");
  }

  async #parent(path: string): Promise<void> {
    if (!(await this.storage.stat(dirname(path))).isDirectory) throw new WorkspaceError("invalidParams", "Parent must be a workspace directory.");
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}
