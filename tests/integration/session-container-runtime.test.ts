import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, HarnessDefinition, SessionContainerSettings, SharedConnection, SharedSessionView, SharedWorkerLimits,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobEventListener, JobStore, PlacementStore, SessionContainerStore, SessionDirectory, SharedStore, migrate,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, canonicalJson, createLogger, loadPolicySet, loadProfiles, sha256Hex } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { ContainerSessionService } from "../../src/agent-api/src/container-sessions.js";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { DispatcherClient as GatewayClient } from "../../src/inference-gateway/src/dispatcher-client.js";
import { buildGateway } from "../../src/inference-gateway/src/server.js";
import { parseRoutes } from "../../src/inference-gateway/src/routes.js";
import { ExecutionController } from "../../src/execution-controller/src/controller.js";
import { buildBroker } from "../../src/connection-broker/src/broker.js";
import { containerUpstream, DispatcherDirectory, sessionRoutes, sharedUpstream } from "../../src/connection-broker/src/sessions.js";
import { testGitHubAccount } from "../runtime/account.js";
import { QualificationCli } from "../runtime/cli.js";

const enabled = process.env.HYBRID_SESSION_CONTAINER_TESTS === "1";
const image = process.env.HYBRID_SESSION_CONTAINER_IMAGE ?? "copilot-session-container:local";
const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const brokerKey = "synthetic-connection-broker-key-".repeat(2);
/** The HTTP status a WebSocket upgrade receives, without completing it. */
const upgradeStatus = (url: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
  const outgoing = httpRequest(url, { headers: { ...headers, connection: "Upgrade", upgrade: "websocket",
    "sec-websocket-key": "c2Vzc2lvbi1jb250YWluZXI=", "sec-websocket-version": "13" }, timeout: 10_000 });
  outgoing.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 101); });
  outgoing.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); });
  outgoing.on("timeout", () => outgoing.destroy(new Error("The upgrade timed out.")));
  outgoing.on("error", reject);
  outgoing.end();
});
const Message = z.object({ role: z.string(), content: z.unknown().optional(), tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }).passthrough();
const Wire = z.object({
  stream: z.boolean().optional(), messages: z.array(Message),
  tools: z.array(z.object({ function: z.object({ name: z.string(), parameters: z.unknown().optional() }).passthrough() })).default([]),
}).passthrough();
const ALLOWED_ENVIRONMENT = new Set([
  "SESSION_CONTAINER_KEY", "SESSION_CONTAINER_INGRESS_CREDENTIAL", "SESSION_CONTAINER_ALLOCATION_ID", "SESSION_CONTAINER_SESSION_ID", "IMAGE_DIGEST",
  "services__job-dispatcher__http__0", "services__inference-gateway__http__0",
  "PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "COPILOT_CLI_PATH", "SESSION_CONTAINER_DATA",
]);

/** Builds tool arguments from the advertised JSON schema so the gate does not depend on one runtime's optional fields. */
function argumentsFor(schema: unknown, command: string): Record<string, unknown> {
  const parsed = z.object({ properties: z.record(z.string(), z.object({ type: z.unknown().optional() }).passthrough()).default({}), required: z.array(z.string()).default([]) })
    .passthrough().safeParse(schema);
  const properties = parsed.success ? parsed.data.properties : {};
  const args: Record<string, unknown> = { command, description: "Synthetic session container check" };
  for (const name of parsed.success ? parsed.data.required : []) {
    if (name in args) continue;
    const type = properties[name]?.type;
    args[name] = type === "number" || type === "integer" ? 30 : type === "boolean" ? false : "";
  }
  if ("timeout" in properties && !("timeout" in args)) args.timeout = 30_000;
  return args;
}

it.skipIf(!enabled)("runs a mode-1 session in its own container that idles out and resumes from its volume with history and files", async () => {
  const { credential, id: githubUserId } = await testGitHubAccount();
  docker("image", "inspect", image, "--format", "{{.Id}}");
  const root = await mkdtemp(join(tmpdir(), "session-container-gate-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const principal = `gate-${randomUUID()}`;
  const namespace = `session-gate-${randomUUID().slice(0, 12)}`;
  const marker = randomUUID().replaceAll("-", "").slice(0, 16);
  const fileContent = `SESSION_FILE_${marker}`;
  const apiKey = `gate-api-key-${randomUUID()}`;
  const keys = { gateway: "synthetic-gateway-key-".repeat(3), executor: "synthetic-executor-key-".repeat(3), signing: "synthetic-capability-key-".repeat(3) };
  const errors: string[] = [];
  const requests: Array<z.infer<typeof Wire>> = [];
  const apps: FastifyInstance[] = [];
  let controller: ExecutionController | undefined;
  let cli: QualificationCli | undefined;
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") return response.writeHead(404).end();
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.once("end", () => {
      try {
        const payload = Wire.parse(JSON.parse(body));
        requests.push(payload);
        const lastUser = payload.messages.findLastIndex((message) => message.role === "user");
        const prompt = JSON.stringify(payload.messages[lastUser]?.content ?? "");
        const results = payload.messages.slice(lastUser + 1).filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
        const bash = payload.tools.find((tool) => tool.function.name === "bash" || tool.function.name.endsWith("__bash"));
        let content: string | undefined;
        let call: { name: string; arguments: string } | undefined;
        if (prompt.includes("CREATE_NOTE") || prompt.includes("READ_NOTE")) {
          if (!bash) throw new Error(`The bash tool was not advertised: ${payload.tools.map((tool) => tool.function.name).join(",")}`);
          if (results.length === 0) {
            const command = prompt.includes("CREATE_NOTE") ? `printf '%s' ${fileContent} > notes.txt && id -u && pwd` : "cat notes.txt";
            call = { name: bash.function.name, arguments: JSON.stringify(argumentsFor(bash.function.parameters, command)) };
          } else if (prompt.includes("CREATE_NOTE")) {
            content = `NOTE_CREATED_${marker}`;
          } else {
            content = results.some((result) => result.includes(fileContent)) ? `NOTE_READ_${marker}` : `NOTE_MISSING_${marker}`;
          }
        } else content = "SESSION_CONTAINER_OK";
        const toolCall = call ? { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: call } : undefined;
        const base = { id: randomUUID(), model: "grok-4.6", created: Math.floor(Date.now() / 1000) };
        const usage = { prompt_tokens: 50, completion_tokens: 10 };
        if (!payload.stream) {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...base, object: "chat.completion", usage,
            choices: [{ index: 0, message: { role: "assistant", content: content ?? null, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? "tool_calls" : "stop" }] }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant", ...(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content }) };
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Synthetic inference failed.");
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic model contract failed." } }));
      }
    });
  });
  const wait = async (predicate: () => Promise<boolean> | boolean, label: string, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (errors.length) throw new Error(errors.join("\n"));
      if (Date.now() > deadline) throw new Error(`Timed out ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const containers = () => docker("ps", "-aq", "--no-trunc", "--filter", `label=copilot.hybrid.namespace=${namespace}`).split(/\r?\n/).filter(Boolean);
  const volumes = () => docker("volume", "ls", "-q", "--filter", `label=copilot.hybrid.namespace=${namespace}`).split(/\r?\n/).filter(Boolean);
  // Follow each session container's operator logs (identifiers and outcomes only) so a failed start is diagnosable.
  const followed = new Map<string, ChildProcess>();
  const logs: string[] = [];
  const follower = setInterval(() => {
    for (const id of containers()) {
      if (followed.has(id)) continue;
      const child = spawn("docker", ["logs", "-f", id], { stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk: Buffer) => { logs.push(`${id.slice(0, 12)} ${chunk.toString("utf8")}`.slice(0, 4000)); };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      followed.set(id, child);
    }
  }, 300);
  try {
    await migrate(pool);
    const repo = join(import.meta.dirname, "..", "..");
    const profiles = await loadProfiles(repo);
    const base = (await loadPolicySet(join(repo, "examples", "customer-config"))).base;
    const policies = { base: { ...base, allowedModels: ["grok-4.6"], hosting: { defaultSize: "large" } }, overrides: new Map() };
    const definition = HarnessDefinition.parse({
      schemaVersion: "1", name: "session-container-gate", version: "1.0.0", interaction: "conversation",
      description: "Synthetic mode-1 session container qualification.",
      instructions: "Use the shell in the session workspace when asked. Reply briefly.",
      model: { preferred: "grok-4.6", allowed: ["grok-4.6"] }, tools: [], builtinTools: ["files", "shell"],
      permissions: { default: "allow" },
      input: { schema: { type: "object" } }, output: { schema: { type: "object" } },
      limits: { maxDurationSeconds: 600, maxInferenceTokens: 100_000 }, retry: { safeToRetry: false, maxAttempts: 1 },
      runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
    });
    const harness = { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
    const harnesses = new Map([[definition.name, [harness]]]);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    const jobs = new JobStore(pool);
    const shared = new SharedStore(pool);
    const allocations = new AllocationStore(pool, shared);
    const store = new SessionContainerStore(pool, shared);
    const delegations = new DelegationStore(pool, shared, jobs);
    const limits = SharedWorkerLimits.parse({ executionContainers: 2, containersPerPrincipal: 1 });
    const settings = SessionContainerSettings.parse({ image, idleSeconds: 20, heartbeatSeconds: 2, startupSeconds: 180, shutdownSeconds: 20 });
    const dispatcher = buildDispatcher({ store: jobs, policies, executorKey: keys.executor, gatewayKey: keys.gateway, signingKey: keys.signing,
      allocations, delegations, sessionContainers: { allocations, store, policies, heartbeatSeconds: settings.heartbeatSeconds },
      broker: { store: new PlacementStore(pool), key: brokerKey } });
    apps.push(dispatcher);
    await dispatcher.listen({ port: 0, host: "0.0.0.0" });
    // No shared worker runs here; its upstream is never selected because every session is container-placed.
    const { app: broker } = buildBroker({
      families: [sessionRoutes(new DispatcherDirectory(address(dispatcher.server), brokerKey))],
      upstreams: { shared: sharedUpstream(new URL("http://127.0.0.1:9"), brokerKey), container: containerUpstream() },
    });
    apps.push(broker);
    await broker.listen({ port: 0, host: "127.0.0.1" });
    const gatewayClient = new GatewayClient(address(dispatcher.server), keys.gateway, 0);
    const gateway = buildGateway({
      signingKey: keys.signing, routes: parseRoutes(JSON.stringify([{ model: "grok-4.6", deployment: "grok-4.6", baseUrl: address(upstream), auth: "none" }]), true),
      upstreamToken: async () => { throw new Error("No paid model credential is permitted in this test."); },
      introspect: (jti) => gatewayClient.introspect(jti), beginRequest: (jti, id) => gatewayClient.beginRequest(jti, id),
      reportUsage: (usage) => gatewayClient.reportUsage(usage),
    });
    apps.push(gateway);
    await gateway.listen({ port: 0, host: "0.0.0.0" });
    const catalog = { harnesses, profiles, policies, deployment: hostingDeployment({ executor: "on-demand", sharedWorker: false, sessionContainers: true }) };
    const api = buildApi({
      store: jobs, listener: new JobEventListener(pool), admission: new Admission({ harnesses, profiles, policies }), harnesses,
      authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`), maxOpenJobsPerPrincipal: 10, console: false, delegations, hosting: catalog,
      containers: new ContainerSessionService({
        store, allocations, directory: new SessionDirectory(pool), catalog, principals: { [principal]: githubUserId },
        settings, limits, brokerUrl: address(broker.server), connectWaitSeconds: 180,
      }),
    });
    apps.push(api);
    controller = new ExecutionController({
      allocations, jobs, delegations, limits, sessions: settings,
      settings: ExecutionContainerSettings.parse({ namespace, image: process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local" }),
      signingKey: "synthetic-allocation-key-".repeat(3), dispatcherUrl: address(dispatcher.server), gatewayUrl: address(gateway.server),
      logger: createLogger("session-container-gate"),
    });
    await controller.start();
    const headers = { authorization: `Bearer ${apiKey}` };
    const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: definition.name } });
    expect(created.statusCode, created.body).toBe(201);
    const session = SharedSessionView.parse(created.json());
    expect(session.container).toMatchObject({ state: "dormant", size: "large", cpus: 2, memoryMiB: 4096 });
    const connect = async () => {
      const response = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers });
      expect(response.statusCode, response.body).toBe(200);
      return SharedConnection.parse(response.json());
    };

    const first = await connect();
    expect(first).toMatchObject({ sessionId: session.id, destination: "container", transport: "direct", ahpSessionId: session.id });
    expect(first.url).toBe(`ws://127.0.0.1:${(broker.server.address() as AddressInfo).port}/sessions/${session.id}`);
    const [containerId] = containers();
    expect(containers()).toHaveLength(1);
    // The container accepts only connections the broker forwards with its allocation's ingress credential.
    const ingress = `http://${docker("port", containerId!, "8080/tcp").split("\n")[0]!.replace("0.0.0.0", "127.0.0.1")}`;
    expect(await upgradeStatus(`${ingress}/sessions/${session.id}?tkn=${encodeURIComponent(first.token)}`)).toBe(401);
    expect(await upgradeStatus(`${ingress}/sessions/${session.id}`, { "x-internal-key": "not-the-ingress-credential-".repeat(2) })).toBe(401);
    const inspected = z.array(z.object({
      Config: z.object({ Env: z.array(z.string()), Labels: z.record(z.string(), z.string()) }).passthrough(),
      HostConfig: z.object({ Privileged: z.boolean(), CapDrop: z.array(z.string()).nullable(), CapAdd: z.array(z.string()).nullable(),
        SecurityOpt: z.array(z.string()).nullable(), NanoCpus: z.number(), Memory: z.number() }).passthrough(),
      Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() }).passthrough()),
    }).passthrough()).parse(JSON.parse(docker("container", "inspect", containerId!)))[0]!;
    expect(inspected.Config.Env.map((entry) => entry.slice(0, entry.indexOf("="))).filter((name) => !ALLOWED_ENVIRONMENT.has(name))).toEqual([]);
    expect(inspected.Config.Labels).toMatchObject({ "copilot.hybrid.kind": "session", "copilot.hybrid.session": session.id });
    expect(inspected.HostConfig).toMatchObject({ Privileged: false, CapDrop: ["ALL"], NanoCpus: 2_000_000_000, Memory: 4096 * 1024 * 1024 });
    expect(inspected.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(inspected.Mounts.map((mount) => ({ type: mount.Type, name: mount.Name, destination: mount.Destination })))
      .toEqual([{ type: "volume", name: `hybrid-${namespace}-session-${session.id}`, destination: "/data" }]);
    expect(() => docker("exec", "--user", "10001", containerId!, "cat", "/proc/1/environ")).toThrow();

    cli = new QualificationCli(root, credential);
    await cli.connect(first);
    await cli.send("CREATE_NOTE in the session workspace.");
    await cli.waitFor(`NOTE_CREATED_${marker}`, 120_000);
    const created1 = JSON.stringify(requests.findLast((request) => JSON.stringify(request.messages).includes("CREATE_NOTE"))?.messages);
    expect(created1).toContain("10001");
    expect(created1).toContain("/data/execution/workspace");
    expect(docker("exec", containerId!, "cat", "/data/execution/workspace/notes.txt")).toBe(fileContent);
    await cli.stop();
    cli = undefined;

    await wait(async () => containers().length === 0 && (await pool.query(
      "SELECT 1 FROM execution_allocations WHERE session_id=$1 AND state<>'retired'", [session.id])).rowCount === 0, "the idle container to stop", 180_000);
    expect((await pool.query("SELECT state,last_error FROM execution_allocations WHERE session_id=$1", [session.id])).rows)
      .toEqual([{ state: "retired", last_error: "The session was idle." }]);
    expect(volumes()).toEqual([`hybrid-${namespace}-session-${session.id}`]);
    expect(SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json()).container)
      .toMatchObject({ state: "dormant", activations: 1 });

    const second = await connect();
    expect(containers()).toHaveLength(1);
    expect(containers()[0]).not.toBe(containerId);
    cli = new QualificationCli(root, credential);
    await cli.connect(second);
    await cli.waitFor(`NOTE_CREATED_${marker}`, 120_000);
    await cli.send("READ_NOTE from the session workspace.");
    await cli.waitFor(`NOTE_READ_${marker}`, 120_000);
    const resumed = JSON.stringify(requests.at(-1)?.messages);
    expect(resumed).toContain("CREATE_NOTE");
    expect(resumed).toContain(`NOTE_CREATED_${marker}`);
    expect(resumed).toContain(fileContent);
    await cli.stop();
    cli = undefined;

    expect((await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/close`, headers, payload: {} })).json()).toEqual({ closed: true });
    await wait(async () => containers().length === 0 && (await pool.query(
      "SELECT 1 FROM execution_allocations WHERE (namespace=$1 OR namespace IS NULL) AND state<>'retired'", [namespace])).rowCount === 0, "capacity to return to zero", 120_000);
    expect(volumes()).toEqual([`hybrid-${namespace}-session-${session.id}`]);
    const view = SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json());
    expect(view).toMatchObject({ closed: true, container: { state: "closed", activations: 2 } });
    expect(view.budget.usedTokens).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } catch (error) {
    const allocations = await pool.query("SELECT id,state,last_error FROM execution_allocations WHERE namespace=$1 OR namespace IS NULL", [namespace]).catch(() => ({ rows: [] }));
    throw new Error(`Session container qualification failed. ${JSON.stringify({ errors, allocations: allocations.rows })}\n${logs.join("").slice(-8000)}\n${cli?.output.slice(-6000) ?? ""}`, { cause: error });
  } finally {
    clearInterval(follower);
    for (const child of followed.values()) child.kill();
    try { await cli?.stop(); await controller?.stop(); }
    finally {
      try {
        for (const app of apps.reverse()) await app.close();
        if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      } finally {
        for (const id of containers()) docker("rm", "--force", id);
        for (const volume of volumes()) docker("volume", "rm", volume);
        await pool.query("DELETE FROM shared_sessions WHERE principal=$1", [principal]);
        await pool.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
        await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
}, 900_000);
