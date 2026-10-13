import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ExecutionAllocation } from "@copilot-agent/job-store";

const exec = promisify(execFile);
const Container = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string(), labels: z.record(z.string(), z.string()).nullable(),
  status: z.enum(["created", "running", "paused", "restarting", "removing", "exited", "dead"]),
});
export type ObservedContainer = z.infer<typeof Container>;
const NAME = (allocation: ExecutionAllocation) => `hybrid-${allocation.namespace}-${allocation.id}`;

export class DockerExecutionAdapter {
  constructor(private readonly namespace: string, private readonly signal: AbortSignal) {}

  private async command(args: string[], extraEnv: Record<string, string> = {}, missingAllowed = false): Promise<string | undefined> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TEMP|TMP|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)$/i.test(key)) env[key] = value;
    }
    try {
      return (await exec("docker", args, {
        encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        windowsHide: true, signal: this.signal,
      })).stdout.trim();
    } catch (error) {
      if (missingAllowed && error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        && /No such (object|container|image)/i.test(error.stderr)) return undefined;
      // execFile errors carry argv/environment-adjacent output; never log allocation credentials.
      throw new Error(`Docker ${args[0]} failed${this.signal.aborted ? " after controller ownership ended" : ""}.`);
    }
  }

  async image(reference: string): Promise<string> {
    const endpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
      ? process.env.DOCKER_HOST
      : JSON.parse((await this.command(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]))!);
    if (typeof endpoint !== "string" || !/^(unix|npipe):\/\//.test(endpoint)) throw new Error("The local execution adapter requires a local Docker socket or named pipe.");
    const platform = await this.command(["version", "--format", "{{.Server.Os}}"]);
    if (platform !== "linux") throw new Error("The execution adapter requires Linux containers.");
    const image = await this.command(["image", "inspect", reference, "--format", "{{.Id}}"]);
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Build the approved executor image before starting hybrid execution.");
    return image;
  }

  async inspect(idOrName: string): Promise<ObservedContainer | undefined> {
    const json = await this.command(["container", "inspect", idOrName, "--format",
      '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"status":{{json .State.Status}}}'], {}, true);
    if (json === undefined) return undefined;
    return Container.parse(JSON.parse(json));
  }

  async allocation(allocation: ExecutionAllocation): Promise<ObservedContainer | undefined> {
    const observed = await this.inspect(allocation.containerId ?? NAME(allocation));
    if (observed) this.assertOwned(observed, allocation);
    return observed;
  }

  private assertOwned(container: ObservedContainer, allocation?: ExecutionAllocation): void {
    if (container.labels?.["copilot.hybrid.namespace"] !== this.namespace
      || container.labels?.["copilot.hybrid.managed"] !== "execution"
      || (allocation && (container.labels["copilot.hybrid.allocation"] !== allocation.id
        || container.image !== allocation.image || container.name !== `/${NAME(allocation)}`))) {
      throw new Error("Refusing to operate on a container whose allocation identity does not match.");
    }
  }

  async create(allocation: ExecutionAllocation, token: string, dispatcherUrl: string, gatewayUrl: string): Promise<void> {
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

  async start(container: ObservedContainer, allocation: ExecutionAllocation): Promise<void> {
    this.assertOwned(container, allocation);
    await this.command(["container", "start", container.id]);
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
}

function containerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid container service URL.");
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
  return url.href.replace(/\/$/, "");
}
