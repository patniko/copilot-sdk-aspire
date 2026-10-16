import { createHash } from "node:crypto";
import type { BoundVolume, ExecutionAllocation, JobAllocation, SessionAllocation } from "@copilot-agent/job-store";
import type { ExecutionAdapter, ObservedContainer } from "../../../src/execution-controller/src/docker.js";
import {
  SharedFileError, type SharedFileEntry, type SharedFileOperation, type SharedFileResult,
} from "../../../src/execution-controller/src/shared-files.js";

interface FakeContainer extends ObservedContainer {
  allocation: string;
  kind: "job" | "session";
  ingress?: { host: string; port: number };
  token: string;
}

/**
 * An in-memory container platform for controller tests. Containers behave like `--rm` Docker containers: stopping one
 * removes it. Volumes are never removed. The credentials a container would receive are kept so tests can act as it.
 */
export class FakeAdapter implements ExecutionAdapter {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumeLabels = new Map<string, Record<string, string>>();
  readonly operations: string[] = [];
  readonly images: Record<string, string>;
  #port = 41_000;
  #sequence = 0;

  constructor(readonly namespace: string, images: Record<string, string> = {}) {
    this.images = images;
  }

  async image(reference: string): Promise<string> {
    const image = this.images[reference];
    if (!image) throw new Error(`Build the approved image '${reference}' before starting hybrid execution.`);
    return image;
  }

  async allocation(allocation: ExecutionAllocation): Promise<ObservedContainer | undefined> {
    if (!allocation.namespace) return undefined;
    const name = `/hybrid-${allocation.namespace}-${allocation.id}`;
    return [...this.containers.values()].find((container) => container.id === allocation.containerId || container.name === name);
  }

  #add(allocation: ExecutionAllocation, kind: "job" | "session", token: string, labels: Record<string, string>): void {
    const id = createHash("sha256").update(`container-${++this.#sequence}`).digest("hex");
    this.containers.set(id, {
      id, image: allocation.image!, name: `/hybrid-${allocation.namespace}-${allocation.id}`, status: "created", allocation: allocation.id, kind, token,
      labels: { "copilot.hybrid.namespace": this.namespace, "copilot.hybrid.managed": "execution", "copilot.hybrid.allocation": allocation.id, ...labels },
    });
  }

  async create(allocation: JobAllocation, token: string): Promise<void> {
    this.operations.push(`create:${allocation.id}`);
    this.#add(allocation, "job", token, {});
  }

  async createSession(allocation: SessionAllocation, credentials: { token: string; ingress: string }): Promise<void> {
    this.operations.push(`create-session:${allocation.id}`);
    for (const volume of allocation.volumes as BoundVolume[]) {
      if (!this.volumeLabels.has(volume.name)) throw new Error("A session container was created before its volume.");
    }
    this.#add(allocation, "session", credentials.token, {
      "copilot.hybrid.kind": "session", "copilot.hybrid.session": allocation.sessionId,
      ...(allocation.workerId ? { "copilot.hybrid.worker": allocation.workerId } : {}),
    });
  }

  async start(container: ObservedContainer): Promise<void> {
    const entry = this.containers.get(container.id)!;
    entry.status = "running";
    if (entry.kind === "session") entry.ingress = { host: "127.0.0.1", port: ++this.#port };
    this.operations.push(`start:${entry.allocation}`);
  }

  async stop(container: ObservedContainer): Promise<void> {
    const entry = this.containers.get(container.id);
    if (!entry) return;
    this.operations.push(`stop:${entry.allocation}`);
    this.containers.delete(container.id);
  }

  async remove(container: ObservedContainer): Promise<void> {
    const entry = this.containers.get(container.id);
    if (entry) this.operations.push(`remove:${entry.allocation}`);
    this.containers.delete(container.id);
  }

  async managed(): Promise<ObservedContainer[]> {
    return [...this.containers.values()].filter((container) => container.labels?.["copilot.hybrid.namespace"] === this.namespace);
  }

  async ingress(container: ObservedContainer): Promise<{ host: string; port: number } | undefined> {
    return this.containers.get(container.id)?.ingress;
  }

  async ensureVolume(volume: BoundVolume): Promise<void> {
    await this.ensureNamedVolume(volume);
  }

  async ensureNamedVolume(volume: BoundVolume): Promise<void> {
    if (!this.volumeLabels.has(volume.name)) {
      this.operations.push(`volume:${volume.name}`);
      this.volumeLabels.set(volume.name, { "copilot.hybrid.namespace": this.namespace, "copilot.hybrid.session": volume.sessionId, "copilot.hybrid.purpose": volume.purpose });
    }
  }

  /** Shared-volume contents by volume name, as the helper container would see them. */
  readonly files = new Map<string, Map<string, Buffer>>();

  async sharedFiles(image: string, volume: BoundVolume, operation: SharedFileOperation): Promise<SharedFileResult> {
    if (!Object.values(this.images).includes(image) || !this.volumeLabels.has(volume.name)) throw new Error("The helper needs a resolved image and an existing volume.");
    this.operations.push(`files:${operation.kind}:${volume.name}`);
    const files = this.files.get(volume.name) ?? new Map<string, Buffer>();
    this.files.set(volume.name, files);
    const etag = (content: Buffer) => createHash("sha256").update(content).digest("base64url");
    if (operation.kind === "list") {
      const prefix = operation.path ? `${operation.path}/` : "";
      const names = new Map<string, SharedFileEntry>();
      for (const [path, content] of files) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split("/");
        names.set(first!, rest.length ? { name: first!, type: "directory" } : { name: first!, type: "file", size: content.length });
      }
      if (operation.path && !names.size) throw new SharedFileError("not_found", "The directory was not found.");
      return { entries: [...names.values()] };
    }
    const existing = files.get(operation.path);
    if (operation.kind === "read") {
      if (!existing) throw new SharedFileError("not_found", "The file was not found.");
      return { content: existing };
    }
    if (existing && operation.ifMatch !== etag(existing)) throw new SharedFileError("conflict", "The file exists; read it first and pass its etag to replace it.");
    files.set(operation.path, operation.content);
    return { size: operation.content.length, etag: etag(operation.content) };
  }

  async volumes(): Promise<string[]> {
    return [...this.volumeLabels.entries()].filter(([, labels]) => labels["copilot.hybrid.namespace"] === this.namespace).map(([name]) => name);
  }

  /** A running session container for the session, as the container itself would see it. */
  session(sessionId: string): FakeContainer | undefined {
    return [...this.containers.values()].find((container) => container.kind === "session" && container.labels?.["copilot.hybrid.session"] === sessionId);
  }

  /** Inserts a labeled container that no ledger allocation owns. */
  orphan(image: string): string {
    const id = createHash("sha256").update(`orphan-${++this.#sequence}`).digest("hex");
    this.containers.set(id, {
      id, image, name: `/hybrid-${this.namespace}-orphan`, status: "running", allocation: "orphan", kind: "session", token: "",
      labels: { "copilot.hybrid.namespace": this.namespace, "copilot.hybrid.managed": "execution", "copilot.hybrid.allocation": "00000000-0000-4000-8000-000000000000" },
    });
    return id;
  }
}
