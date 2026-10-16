import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { HostStore, JobStore, migrate, type HostKey } from "@copilot-agent/job-store";
import { loadHarnesses, loadPolicy, loadProfiles } from "@copilot-agent/service-defaults";
import type { ExecutionPolicy, ExecutionProfile, HarnessSnapshot } from "@copilot-agent/contracts";
import { buildDispatcher } from "../../../src/job-dispatcher/src/server.js";
import { buildGateway } from "../../../src/inference-gateway/src/server.js";

const root = join(import.meta.dirname, "..", "..", "..");

export interface OwnerHostSpec {
  harness: string;
  transport: "direct" | "github" | "both";
}
export interface RunningHost {
  container: string;
  /** The host's published HTTP endpoint on loopback. */
  endpoint: string;
  info: { harness: string; transport: string; execution: string; ready: boolean; environmentId?: string; runtimeRevision?: string };
}

/**
 * Synthetic-inference fixture for real per-harness owner hosts in Docker: a disposable configuration with two
 * conversation harnesses, an in-process dispatcher and gateway, and a fake model upstream. Containers, volumes, and
 * Mission Control environments it creates are labeled or recorded so the caller can remove exactly those.
 */
export class OwnerHostFixture {
  readonly run = randomUUID().slice(0, 8);
  readonly keys = new Map<string, string>();
  readonly tokens = new Map<string, string>();
  readonly volumes = new Map<string, string>();
  readonly environments = new Set<string>();
  readonly requests: Array<{ messages: unknown }> = [];
  readonly containers = new Set<string>();
  reply: (messages: unknown) => string = () => "4";
  pool!: pg.Pool;
  store!: HostStore;
  harnesses!: Map<string, HarnessSnapshot[]>;
  policy!: ExecutionPolicy;
  profiles!: Map<string, ExecutionProfile>;
  config!: string;
  dispatcher!: FastifyInstance;
  gateway!: FastifyInstance;
  #upstream?: Server;
  #signingKey = randomUUID().repeat(2);

  constructor(
    readonly databaseUrl: string,
    readonly owner: string,
    readonly githubToken: string,
    readonly image = process.env.DEMO_HOST_TEST_IMAGE ?? "copilot-aspire-agent-host:demo",
  ) {}

  key(harness: string): HostKey {
    return { harness, owner: this.owner.toLowerCase() };
  }

  docker(...args: string[]): string {
    return execFileSync("docker", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DEMO_HOST_GITHUB_TOKEN: this.githubToken },
    }).trim();
  }

  async start(hosts: OwnerHostSpec[]): Promise<void> {
    this.pool = new pg.Pool({ connectionString: this.databaseUrl });
    await migrate(this.pool);
    await this.pool.query("TRUNCATE demo_host, owner_hosts, hosted_sessions, hosted_connection_tickets CASCADE");
    this.store = new HostStore(this.pool);
    // A second conversation harness, so two owner hosts serve different harnesses from one deployment.
    // Docker Desktop bind mounts need the long form of Windows temporary paths.
    this.config = await realpath(await mkdtemp(join(tmpdir(), "owner-host-config-")));
    await cp(join(root, "examples", "customer-config"), this.config, { recursive: true });
    const second = join(this.config, "harnesses", "review-agent");
    await cp(join(this.config, "harnesses", "interactive-demo"), second, { recursive: true });
    const definition = JSON.parse(await readFile(join(second, "harness.json"), "utf8"));
    await writeFile(join(second, "harness.json"), JSON.stringify({ ...definition, name: "review-agent", description: "A second isolated conversation harness." }, null, 2));
    [this.harnesses, this.policy, this.profiles] = await Promise.all([loadHarnesses(this.config), loadPolicy(this.config), loadProfiles(root)]);

    this.#upstream = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.once("end", () => {
        const payload = JSON.parse(body || "{}");
        this.requests.push({ messages: payload.messages });
        const content = this.reply(payload.messages);
        const base = { id: randomUUID(), model: "grok-4.6", created: Math.floor(Date.now() / 1000) };
        if (payload.stream !== true) {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => this.#upstream!.listen(0, "127.0.0.1", resolve));
    for (const host of hosts) {
      this.keys.set(host.harness, randomUUID().repeat(2));
      this.tokens.set(host.harness, randomUUID().repeat(2));
      this.volumes.set(host.harness, `owner-host-test-${host.harness}-${this.run}`);
      this.docker("volume", "create", "--label", `copilot-owner-host-test=${this.run}`, this.volumes.get(host.harness)!);
    }
    this.dispatcher = buildDispatcher({
      store: new JobStore(this.pool), hostStore: this.store, policies: { base: this.policy, overrides: new Map() },
      executorKey: "unused-executor-key".repeat(3), gatewayKey: "unused-gateway-key".repeat(3), signingKey: this.#signingKey,
      host: {
        store: this.store, profiles: this.profiles, signingKey: this.#signingKey,
        hosts: hosts.map((host) => ({
          harness: host.harness, owner: this.owner.toLowerCase(), key: this.keys.get(host.harness)!, transport: host.transport,
          execution: "managed" as const, snapshot: this.harnesses.get(host.harness)![0], policy: this.policy,
        })),
      },
    });
    await this.dispatcher.listen({ host: "0.0.0.0", port: 0 });
    this.gateway = buildGateway({
      signingKey: this.#signingKey,
      routes: { routes: new Map([["grok-4.6", {
        model: "grok-4.6", deployment: "grok-4.6", baseUrl: `http://127.0.0.1:${(this.#upstream.address() as AddressInfo).port}`, auth: "none",
      }]]) },
      upstreamToken: async () => { throw new Error("The test must not use a provider credential."); },
      introspect: (id) => this.store.introspect(id),
      reportUsage: async (report) => {
        if (!report.requestId) throw new Error("Missing idempotent usage identity.");
        await this.store.recordUsage(report.jti, report.requestId, report.inputTokens, report.outputTokens);
      },
    });
    await this.gateway.listen({ host: "0.0.0.0", port: 0 });
  }

  /** Starts (or replaces) the host container for one harness on its retained volume and waits for readiness. */
  async startHost(spec: OwnerHostSpec): Promise<RunningHost> {
    const direct = spec.transport !== "github";
    const container = this.docker("run", "-d", "--label", `copilot-owner-host-test=${this.run}`,
      "--name", `owner-host-test-${spec.harness}-${this.run}-${randomUUID().slice(0, 4)}`,
      "-p", "127.0.0.1::8080", "-v", `${this.volumes.get(spec.harness)}:/data`, "-v", `${this.config}:/config:ro`,
      "--cpus", "1", "--memory", "2048m",
      ...(process.env.DEMO_HOST_TEST_SOURCE === "1" ? ["-v", `${join(root, "src", "agent-host", "dist")}:/app/src/agent-host/dist:ro`] : []),
      "-e", `DEMO_HOST_TRANSPORT=${spec.transport}`, "-e", "DEMO_HOST_EXECUTION=managed", "-e", `DEMO_HOST_OWNER=${this.owner}`,
      "-e", `DEMO_HOST_HARNESS=${spec.harness}`, "-e", `DEMO_HOST_KEY=${this.keys.get(spec.harness)}`,
      ...(direct ? ["-e", `DEMO_HOST_CONNECTION_TOKEN=${this.tokens.get(spec.harness)}`] : []),
      ...(spec.transport !== "direct" ? ["-e", "DEMO_HOST_GITHUB_TOKEN"] : []),
      "-e", `JOB_DISPATCHER_URL=http://host.docker.internal:${(this.dispatcher.server.address() as AddressInfo).port}`,
      "-e", `INFERENCE_GATEWAY_URL=http://host.docker.internal:${(this.gateway.server.address() as AddressInfo).port}`,
      "-e", "LOG_LEVEL=error",
      this.image);
    this.containers.add(container);
    const endpoint = `http://${this.docker("port", container, "8080/tcp").split("\n")[0]}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const response = await fetch(`${endpoint}/health`).catch(() => undefined);
      if (response?.status === 200) break;
      if (this.docker("inspect", "--format", "{{.State.Running}}", container) !== "true") throw new Error(`Host ${spec.harness} stopped before readiness:\n${this.logs(container)}`);
      if (Date.now() > deadline) throw new Error(`Host ${spec.harness} did not become ready:\n${this.logs(container)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const info = await (await fetch(endpoint)).json() as RunningHost["info"];
    if (info.environmentId) this.environments.add(info.environmentId);
    return { container, endpoint, info };
  }

  stopHost(container: string): void {
    this.docker("stop", "--time", "25", container);
    this.docker("rm", container);
    this.containers.delete(container);
  }

  /** Recent container output with every fixture secret redacted. */
  logs(container: string): string {
    const result = spawnSync("docker", ["logs", "--tail", "100", container], { encoding: "utf8" });
    let text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    for (const secret of [this.githubToken, this.#signingKey, ...this.keys.values(), ...this.tokens.values()]) text = text.split(secret).join("[redacted]");
    return text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
  }

  /** Removes only what this fixture created. Mission Control environments are deleted by the caller's client. */
  async close(): Promise<void> {
    for (const container of this.containers) {
      if (process.env.OWNER_HOST_TEST_LOGS === "1") process.stderr.write(`--- host ${container.slice(0, 12)}\n${this.logs(container)}\n`);
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    }
    for (const volume of this.volumes.values()) spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
    await Promise.all([this.gateway?.close(), this.dispatcher?.close()]);
    if (this.#upstream?.listening) await new Promise<void>((resolve) => this.#upstream!.close(() => resolve()));
    await this.pool?.end();
    if (this.config) await rm(this.config, { recursive: true, force: true });
  }
}
