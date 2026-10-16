import { z } from "zod";
import type { SharedFileService } from "./worker-tools.js";

const Entries = z.object({ entries: z.array(z.object({ name: z.string(), type: z.enum(["file", "directory"]), size: z.number().int().nonnegative().optional() }).strict()) }).strict();
const Content = z.object({ content: z.string() }).strict();
const Written = z.object({ size: z.number().int().nonnegative(), etag: z.string() }).strict();
const Failure = z.object({ error: z.object({ message: z.string() }).passthrough() }).passthrough();

/**
 * The shared worker's client for the execution controller's shared file service (decision D10). The controller alone
 * has Docker authority; this process never mounts a volume.
 */
export class ControllerSharedFiles implements SharedFileService {
  constructor(private readonly url: string, private readonly key: string) {}

  async #call<T>(operation: "list" | "read" | "write", body: object, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await fetch(`${this.url}/internal/shared-files/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-key": this.key },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    const text = await response.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
    if (!response.ok) {
      const failure = Failure.safeParse(value);
      throw new Error(failure.success && response.status < 500 ? failure.data.error.message : "The shared file service is unavailable.");
    }
    return schema.parse(value);
  }

  async list(sessionId: string, path: string | undefined, signal: AbortSignal) {
    return (await this.#call("list", { sessionId, ...(path ? { path } : {}) }, Entries, signal)).entries;
  }

  async read(sessionId: string, path: string, signal: AbortSignal): Promise<Buffer> {
    return Buffer.from((await this.#call("read", { sessionId, path }, Content, signal)).content, "base64");
  }

  async write(sessionId: string, path: string, content: Buffer, ifMatch: string | undefined, signal: AbortSignal) {
    return this.#call("write", { sessionId, path, content: content.toString("base64"), ...(ifMatch ? { ifMatch } : {}) }, Written, signal);
  }
}
