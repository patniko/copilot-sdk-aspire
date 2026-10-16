import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { BoundVolume, ExecutionAllocation, JobAllocation, SessionAllocation } from "@copilot-agent/job-store";
import {
  SHARED_FILE_READ_LIMIT, SHARED_FILES_SCRIPT, SharedFileError, sharedFileReply, type SharedFileOperation, type SharedFileResult,
} from "./shared-files.js";

const exec = promisify(execFile);
const Container = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string(), labels: z.record(z.string(), z.string()).nullable(),
  status: z.enum(["created", "running", "paused", "restarting", "removing", "exited", "dead"]),
  exitCode: z.number().int().optional(),
});
export type ObservedContainer = z.infer<typeof Container>;
const Ports = z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() }).passthrough()).nullable()).nullable();
const NAME = (allocation: ExecutionAllocation) => `hybrid-${allocation.namespace}-${allocation.id}`;
/** The session container's public ingress inside the container; published only on host loopback. */
export const SESSION_INGRESS_PORT = 8080;

/** What the controller needs from a container platform. Docker locally; an Azure backend is future work. */
export interface ExecutionAdapter {
  image(reference: string): Promise<string>;
  allocation(allocation: ExecutionAllocation): Promise<ObservedContainer | undefined>;
  create(allocation: JobAllocation, token: string, dispatcherUrl: string, gatewayUrl: string): Promise<void>;
  createSession(allocation: SessionAllocation, credentials: { token: string; ingress: string }, dispatcherUrl: string, gatewayUrl: string): Promise<void>;
  start(container: ObservedContainer, allocation: ExecutionAllocation): Promise<void>;
  /** Graceful stop so a session runtime can flush its history to the retained volume. */
  stop(container: ObservedContainer, allocation: ExecutionAllocation, seconds: number): Promise<void>;
  remove(container: ObservedContainer, allocation?: ExecutionAllocation): Promise<void>;
  managed(): Promise<ObservedContainer[]>;
  ingress(container: ObservedContainer): Promise<{ host: string; port: number } | undefined>;
  ensureVolume(volume: BoundVolume, allocation: SessionAllocation): Promise<void>;
  /** Creates a volume the ledger recorded, or checks an existing one's labels. */
  ensureNamedVolume(volume: BoundVolume): Promise<void>;
  /** One bounded operation on a coordinator session's shared worker volume, in a short-lived helper container. */
  sharedFiles(image: string, volume: BoundVolume, operation: SharedFileOperation): Promise<SharedFileResult>;
  /** Names of volumes labeled with this namespace. */
  volumes(): Promise<string[]>;
}

export class DockerExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly namespace: string, private readonly signal: AbortSignal) {}

  private async command(args: string[], extraEnv: Record<string, string> = {}, missingAllowed = false, timeout = 30_000): Promise<string | undefined> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TEMP|TMP|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)$/i.test(key)) env[key] = value;
    }
    try {
      return (await exec("docker", args, {
        encoding: "utf8", env: { ...env, ...extraEnv }, timeout, maxBuffer: 2 * 1024 * 1024,
        windowsHide: true, signal: this.signal,
      })).stdout.trim();
    } catch (error) {
      if (missingAllowed && error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        && /No such (object|container|image|volume)|no such volume/i.test(error.stderr)) return undefined;
      // execFile errors carry argv/environment-adjacent output; never log allocation credentials.
      throw new Error(`Docker ${args.slice(0, 2).join(" ")} failed${this.signal.aborted ? " after controller ownership ended" : ""}.`);
    }
  }

  async image(reference: string): Promise<string> {
    const endpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
      ? process.env.DOCKER_HOST
      : JSON.parse((await this.command(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]))!);
    if (typeof endpoint !== "string" || !/^(unix|npipe):\/\//.test(endpoint)) throw new Error("The local execution adapter requires a local Docker socket or named pipe.");
    const platform = await this.command(["version", "--format", "{{.Server.Os}}"]);
    if (platform !== "linux") throw new Error("The execution adapter requires Linux containers.");
    const image = await this.command(["image", "inspect", reference, "--format", "{{.Id}}"], {}, true);
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Build the approved image '${reference}' before starting hybrid execution.`);
    return image;
  }

  async inspect(idOrName: string): Promise<ObservedContainer | undefined> {
    const json = await this.command(["container", "inspect", idOrName, "--format",
      '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}}}'], {}, true);
    if (json === undefined) return undefined;
    return Container.parse(JSON.parse(json));
  }

  async allocation(allocation: ExecutionAllocation): Promise<ObservedContainer | undefined> {
    if (!allocation.namespace) return undefined;
    const observed = await this.inspect(allocation.containerId ?? NAME(allocation));
    if (observed) this.assertOwned(observed, allocation);
    return observed;
  }

  private assertOwned(container: ObservedContainer, allocation?: ExecutionAllocation): void {
    if (container.labels?.["copilot.hybrid.namespace"] !== this.namespace
      || container.labels?.["copilot.hybrid.managed"] !== "execution"
      || (allocation && (container.labels["copilot.hybrid.allocation"] !== allocation.id
        || container.image !== allocation.image || container.name !== `/${NAME(allocation)}`
        || (allocation.kind === "session" && container.labels["copilot.hybrid.session"] !== allocation.sessionId)
        || (allocation.kind === "session" && (container.labels["copilot.hybrid.worker"] ?? undefined) !== allocation.workerId)))) {
      throw new Error("Refusing to operate on a container whose allocation identity does not match.");
    }
  }

  async create(allocation: JobAllocation, token: string, dispatcherUrl: string, gatewayUrl: string): Promise<void> {
    const env = {
      EXECUTOR_KEY: token, EXECUTOR_ID: allocation.id, EXECUTOR_ALLOCATION_ID: allocation.id,
      EXECUTOR_ALLOCATION_EXPIRES_AT: allocation.expiresAt, EXECUTOR_PARALLELISM: "1",
      EXECUTOR_PROFILES: allocation.profile, IMAGE_DIGEST: allocation.image, JOB_EVENT_DETAIL: "sanitized",
      "services__job-dispatcher__http__0": containerUrl(dispatcherUrl),
      "services__inference-gateway__http__0": containerUrl(gatewayUrl),
    };
    await this.command([
      "container", "create", "--name", NAME(allocation), "--rm",
      "--label", `copilot.hybrid.namespace=${this.namespace}`, "--label", "copilot.hybrid.managed=execution",
      "--label", `copilot.hybrid.allocation=${allocation.id}`,
      "--cpus", String(allocation.settings.cpus), "--memory", `${allocation.settings.memoryMiB}m`, "--pids-limit", "256",
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      ...["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "KILL"].flatMap((capability) => ["--cap-add", capability]),
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      ...Object.keys(env).flatMap((key) => ["--env", key]), allocation.image,
    ], env);
  }

  async createSession(allocation: SessionAllocation, credentials: { token: string; ingress: string }, dispatcherUrl: string, gatewayUrl: string): Promise<void> {
    const { args, env } = sessionContainerArguments(this.namespace, allocation, credentials, dispatcherUrl, gatewayUrl, process.platform);
    await this.command(args, env);
  }

  async start(container: ObservedContainer, allocation: ExecutionAllocation): Promise<void> {
    this.assertOwned(container, allocation);
    await this.command(["container", "start", container.id]);
  }

  async stop(container: ObservedContainer, allocation: ExecutionAllocation, seconds: number): Promise<void> {
    this.assertOwned(container, allocation);
    if (container.status !== "running" && container.status !== "restarting" && container.status !== "paused") return;
    await this.command(["container", "stop", "--time", String(seconds), container.id], {}, true, (seconds + 30) * 1000);
  }

  async remove(container: ObservedContainer, allocation?: ExecutionAllocation): Promise<void> {
    this.assertOwned(container, allocation);
    await this.command(["container", "rm", "--force", container.id], {}, true);
    if (await this.inspect(container.id)) throw new Error("Container removal was not confirmed.");
  }

  async managed(): Promise<ObservedContainer[]> {
    const ids = (await this.command(["container", "ls", "--all", "--quiet", "--no-trunc",
      "--filter", `label=copilot.hybrid.namespace=${this.namespace}`, "--filter", "label=copilot.hybrid.managed=execution"]))!;
    const containers: ObservedContainer[] = [];
    for (const id of ids.split(/\r?\n/).filter(Boolean)) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker returned an invalid container identity.");
      const container = await this.inspect(id);
      if (container) { this.assertOwned(container); containers.push(container); }
    }
    return containers;
  }

  async ingress(container: ObservedContainer): Promise<{ host: string; port: number } | undefined> {
    this.assertOwned(container);
    const json = await this.command(["container", "inspect", container.id, "--format", "{{json .NetworkSettings.Ports}}"], {}, true);
    if (!json) return undefined;
    const binding = Ports.parse(JSON.parse(json))?.[`${SESSION_INGRESS_PORT}/tcp`]?.find((entry) => ["127.0.0.1", "::1"].includes(entry.HostIp));
    const port = Number(binding?.HostPort);
    return binding && Number.isSafeInteger(port) && port > 0 && port < 65_536 ? { host: binding.HostIp, port } : undefined;
  }

  async ensureVolume(volume: BoundVolume, allocation: SessionAllocation): Promise<void> {
    if (!(allocation.volumes as BoundVolume[]).some((entry) => entry.name === volume.name)) throw new Error("The volume is not bound to this allocation.");
    await this.ensureNamedVolume(volume);
  }

  async ensureNamedVolume(volume: BoundVolume): Promise<void> {
    const labels = volumeLabels(this.namespace, volume);
    const read = async () => {
      const json = await this.command(["volume", "inspect", volume.name, "--format", "{{json .Labels}}"], {}, true);
      return json === undefined ? undefined : z.record(z.string(), z.string()).nullable().parse(JSON.parse(json)) ?? {};
    };
    let observed = await read();
    if (!observed) {
      await this.command(["volume", "create", ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), volume.name]);
      observed = await read();
    }
    if (!observed || Object.entries(labels).some(([key, value]) => observed![key] !== value)) {
      throw new Error("Refusing to mount a volume whose namespace or session labels do not match.");
    }
  }

  async sharedFiles(image: string, volume: BoundVolume, operation: SharedFileOperation): Promise<SharedFileResult> {
    const args = sharedFileArguments(this.namespace, image, volume, operation);
    const output = await new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TEMP|TMP|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)$/i.test(key)) env[key] = value;
      }
      const child = spawn("docker", args, { env, windowsHide: true, signal: this.signal, timeout: 60_000, stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > SHARED_FILE_READ_LIMIT * 2) child.kill();
        else chunks.push(chunk);
      });
      child.once("error", () => reject(new SharedFileError("unavailable", "The shared file service could not start its helper.")));
      child.once("close", (code) => {
        if (code !== 0) reject(new SharedFileError("unavailable", "The shared file helper failed."));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.end(operation.kind === "write" ? operation.content : undefined);
    });
    return sharedFileReply(operation, output);
  }

  async volumes(): Promise<string[]> {
    const names = (await this.command(["volume", "ls", "--quiet",
      "--filter", `label=copilot.hybrid.namespace=${this.namespace}`, "--filter", "label=copilot.hybrid.managed=volume"]))!;
    return names.split(/\r?\n/).filter(Boolean);
  }
}

export function volumeLabels(namespace: string, volume: BoundVolume): Record<string, string> {
  return {
    "copilot.hybrid.namespace": namespace, "copilot.hybrid.managed": "volume",
    "copilot.hybrid.session": volume.sessionId, "copilot.hybrid.purpose": volume.purpose,
  };
}

/**
 * The Docker arguments for one session container. Secrets travel only in the Docker CLI's environment (`--env NAME`),
 * never in argv. The container gets its allocation and ingress credentials plus service URLs: no database, Docker,
 * signing, provider or relay credential, and no host bind mounts.
 */
export function sessionContainerArguments(
  namespace: string, allocation: SessionAllocation, credentials: { token: string; ingress: string },
  dispatcherUrl: string, gatewayUrl: string, platform: NodeJS.Platform,
): { args: string[]; env: Record<string, string> } {
  if (!allocation.namespace || !allocation.image || !allocation.settings) throw new Error("Bind the session allocation before creating its container.");
  const volumes = allocation.volumes as BoundVolume[];
  if (volumes.some((volume) => !("name" in volume))) throw new Error("Bind the session allocation's volumes before creating its container.");
  const env = {
    SESSION_CONTAINER_KEY: credentials.token, SESSION_CONTAINER_INGRESS_CREDENTIAL: credentials.ingress,
    SESSION_CONTAINER_ALLOCATION_ID: allocation.id, SESSION_CONTAINER_SESSION_ID: allocation.workerId ?? allocation.sessionId,
    // A worker container runs its worker's session and reports to the worker routes.
    ...(allocation.workerId ? { SESSION_CONTAINER_PURPOSE: "worker" } : {}),
    IMAGE_DIGEST: allocation.image,
    "services__job-dispatcher__http__0": containerUrl(dispatcherUrl),
    "services__inference-gateway__http__0": containerUrl(gatewayUrl),
  };
  const args = [
    // Not --rm: an exited session container stays inspectable (exit status, logs) until the controller retires it.
    "container", "create", "--name", `hybrid-${allocation.namespace}-${allocation.id}`,
    "--label", `copilot.hybrid.namespace=${namespace}`, "--label", "copilot.hybrid.managed=execution",
    "--label", `copilot.hybrid.allocation=${allocation.id}`, "--label", "copilot.hybrid.kind=session",
    "--label", `copilot.hybrid.session=${allocation.sessionId}`,
    ...(allocation.workerId ? ["--label", `copilot.hybrid.worker=${allocation.workerId}`] : []),
    "--cpus", String(allocation.settings.cpus), "--memory", `${allocation.settings.memoryMiB}m`, "--pids-limit", "512",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    ...["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "KILL"].flatMap((capability) => ["--cap-add", capability]),
    "--publish", `127.0.0.1::${SESSION_INGRESS_PORT}`,
    ...volumes.flatMap((volume) => ["--mount", `type=volume,src=${volume.name},dst=${volume.target}${volume.readOnly ? ",readonly" : ""}`]),
    ...(platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
    ...Object.keys(env).flatMap((key) => ["--env", key]), allocation.image,
  ];
  return { args, env };
}

function containerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid container service URL.");
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
  return url.href.replace(/\/$/, "");
}

/**
 * The Docker arguments for one shared-file helper: no network, a read-only image filesystem, every capability
 * dropped except those that hand the volume's root to the execution user before the script drops to it, and only the
 * shared volume mounted (read-only unless writing). Nothing from the controller's environment reaches it.
 */
export function sharedFileArguments(namespace: string, image: string, volume: BoundVolume, operation: SharedFileOperation): string[] {
  if (volume.purpose !== "shared" || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Shared file helpers mount only a shared volume with a resolved image.");
  const write = operation.kind === "write";
  return [
    "container", "run", "--rm", "--interactive", "--network", "none", "--read-only", "--tmpfs", "/tmp:size=1m",
    "--label", `copilot.hybrid.namespace=${namespace}`, "--label", "copilot.hybrid.managed=files",
    "--cpus", "0.5", "--memory", "128m", "--pids-limit", "32", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    ...(write ? ["CHOWN", "SETUID", "SETGID"] : ["SETUID", "SETGID"]).flatMap((capability) => ["--cap-add", capability]),
    "--mount", `type=volume,src=${volume.name},dst=/shared${write ? "" : ",readonly"}`,
    "--entrypoint", "node", image, "-e", SHARED_FILES_SCRIPT, operation.kind, operation.path ?? "",
    ...(write && operation.ifMatch ? [operation.ifMatch] : []),
  ];
}
