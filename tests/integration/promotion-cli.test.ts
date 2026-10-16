import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expect, inject, it } from "vitest";
import {
  ExecutionContainerSettings, SessionContainerSettings, SharedConnection, SharedSessionView, SharedWorkerLimits,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobEventListener, JobStore, PlacementStore, PromotionStore, SessionContainerStore, SessionDirectory,
  SessionFileStore, SharedStore, migrate,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, createLogger } from "@copilot-agent/service-defaults";
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
import { sharedWorkerDeployment } from "../../src/session-host/src/admission.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";

/**
 * Stage 5 exit gate (docs/HOSTING-MODES-PLAN.md, sections 7.3 and 14): a shared conversation of a `promotable` harness
 * promotes itself mid-task and continues with shell and files under the same application session, in the same
 * terminal, without the person rerunning the launcher. Real CLI under the launcher's supervisor, the in-process
 * Windows shared worker, a real session container from the local image, the broker, and synthetic inference.
 */
const enabled = process.env.HYBRID_PROMOTION_TESTS === "1" && process.env.HYBRID_CLI_TESTS === "1";
const image = process.env.HYBRID_SESSION_CONTAINER_IMAGE ?? "copilot-session-container:local";
const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const Message = z.object({ role: z.string(), content: z.unknown().optional() }).passthrough();
const Wire = z.object({
  stream: z.boolean().optional(), messages: z.array(Message),
  tools: z.array(z.object({ function: z.object({ name: z.string(), parameters: z.unknown().optional() }).passthrough() })).default([]),
}).passthrough();

/** Shell tool arguments built from the advertised schema, so the gate does not depend on one runtime's optional fields. */
function shellArguments(schema: unknown, command: string): Record<string, unknown> {
  const parsed = z.object({ properties: z.record(z.string(), z.object({ type: z.unknown().optional() }).passthrough()).default({}), required: z.array(z.string()).default([]) })
    .passthrough().safeParse(schema);
  const properties = parsed.success ? parsed.data.properties : {};
  const args: Record<string, unknown> = { command, description: "Synthetic promotion check" };
  for (const name of parsed.success ? parsed.data.required : []) {
    if (name in args) continue;
    const type = properties[name]?.type;
    args[name] = type === "number" || type === "integer" ? 30 : type === "boolean" ? false : "";
  }
  if ("timeout" in properties && !("timeout" in args)) args.timeout = 30_000;
  return args;
}

it.skipIf(!enabled)("promotes a shared conversation mid-task and continues with shell and files in the same terminal", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  docker("image", "inspect", image, "--format", "{{.Id}}");
  const root = await mkdtemp(join(tmpdir(), "promotion-cli-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const principal = `promotion-cli-${randomUUID()}`;
  const namespace = `promotion-${randomUUID().slice(0, 12)}`;
  const marker = randomUUID().replaceAll("-", "").slice(0, 16);
  const note = `MIXED_CASE_${marker}`;
  const apiKey = `promotion-api-key-${randomUUID()}`;
  const keys = {
    gateway: "synthetic-gateway-key-".repeat(3), executor: "synthetic-executor-key-".repeat(3), signing: "synthetic-capability-key-".repeat(3),
    worker: "synthetic-shared-worker-key-".repeat(2), broker: "synthetic-connection-broker-key-".repeat(2),
  };
  const errors: string[] = [];
  const requests: Array<{ placement: "shared" | "container"; payload: z.infer<typeof Wire> }> = [];
  const apps: FastifyInstance[] = [];
  let controller: ExecutionController | undefined;
  let service: SharedSessionService | undefined;
  let cli: QualificationCli | undefined;
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) return response.writeHead(404).end();
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.once("end", () => {
      try {
        const payload = Wire.parse(JSON.parse(body));
        // The shared worker calls this model directly; session containers reach it through the inference gateway.
        requests.push({ placement: request.url === "/chat/completions" ? "shared" : "container", payload });
        const lastUser = payload.messages.findLastIndex((message) => message.role === "user");
        const prompt = JSON.stringify(payload.messages[lastUser]?.content ?? "");
        const results = payload.messages.slice(lastUser + 1).filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
        const tool = (name: string) => {
          const found = payload.tools.find((entry) => entry.function.name === name || entry.function.name.endsWith(`__${name}`));
          if (!found) throw new Error(`The ${name} tool was not advertised: ${payload.tools.map((entry) => entry.function.name).join(",")}`);
          return found.function;
        };
        let content: string | undefined;
        let call: { name: string; arguments: string } | undefined;
        if (payload.tools.length === 0) content = "OK";
        else if (prompt.includes("BUILD_TASK")) {
          // Shared placement: keep notes in the workspace, then ask to move for the build, then end the turn.
          if (results.length === 0) call = { name: tool("write_workspace_file").name, arguments: JSON.stringify({ path: "Notes/MixedCase.md", content: note }) };
          else if (results.length === 1) call = { name: tool("promote_session").name, arguments: JSON.stringify({ reason: "The build needs a shell and a real filesystem." }) };
          else content = `MOVING_${marker}`;
        } else if (prompt.includes("[promotion:")) {
          // The container's continuation: the notes are real files now, and the shell works.
          const bash = tool("bash");
          if (results.length === 0) call = { name: bash.name, arguments: JSON.stringify(shellArguments(bash.parameters, "cat Notes/MixedCase.md && echo && pwd && id -u")) };
          else content = results.some((result) => result.includes(note)) ? `CONTINUED_${marker}` : `CONTINUED_MISSING_${marker}`;
        } else if (prompt.includes("SHELL_CHECK")) {
          const bash = tool("bash");
          if (results.length === 0) {
            call = { name: bash.name, arguments: JSON.stringify(shellArguments(bash.parameters, `printf '%s' BUILD_${marker} > Build.log && ls Notes && cat Build.log`)) };
          } else content = results.some((result) => result.includes(`BUILD_${marker}`) && result.includes("MixedCase.md")) ? `SHELL_OK_${marker}` : `SHELL_MISSING_${marker}`;
        } else if (prompt.includes("AFTER_CRASH")) {
          // A replacement container resumed from the session volume: the files written before the crash are there.
          const bash = tool("bash");
          if (results.length === 0) call = { name: bash.name, arguments: JSON.stringify(shellArguments(bash.parameters, "cat Notes/MixedCase.md Build.log")) };
          else content = results.some((result) => result.includes(note) && result.includes(`BUILD_${marker}`)) ? `AFTER_CRASH_OK_${marker}` : `AFTER_CRASH_MISSING_${marker}`;
        } else content = "OK";
        const toolCall = call ? { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: call } : undefined;
        const base = { id: randomUUID(), model: "fixture", created: Math.floor(Date.now() / 1000) };
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
  const wait = async (predicate: () => Promise<boolean> | boolean, label: string, timeout = 180_000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (errors.length) throw new Error(errors.join("\n"));
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const containers = () => docker("ps", "-aq", "--no-trunc", "--filter", `label=copilot.hybrid.namespace=${namespace}`).split(/\r?\n/).filter(Boolean);
  const volumes = () => docker("volume", "ls", "-q", "--filter", `label=copilot.hybrid.namespace=${namespace}`).split(/\r?\n/).filter(Boolean);
  // Follow the session container's operator logs (identifiers and outcomes only) so a failed start is diagnosable.
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
  }, 500);
  try {
    await migrate(pool);
    const harness = sharedHarness("promotion-cli", {
      instructions: "Keep notes in the workspace. When the work needs a shell or a real filesystem, call promote_session.",
      hosting: { mode: "promotable", promotion: { approval: "allow" } }, builtinTools: ["files", "shell"], permissions: { default: "allow" },
    });
    const registry = await sharedRegistry([harness], {
      hosting: { modes: ["isolated", "shared", "promotable"], promotion: { approval: ["allow"] } },
    });
    const harnesses = new Map(registry.harnesses);
    const profiles = new Map(registry.profiles);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    const jobs = new JobStore(pool);
    const shared = new SharedStore(pool);
    const files = new SessionFileStore(pool);
    const allocations = new AllocationStore(pool, shared);
    const containerStore = new SessionContainerStore(pool, shared);
    const promotions = new PromotionStore(pool, shared, allocations);
    const delegations = new DelegationStore(pool, shared, jobs);
    const limits = SharedWorkerLimits.parse({ executionContainers: 2, containersPerPrincipal: 1 });
    const settings = SessionContainerSettings.parse({ image, idleSeconds: 300, heartbeatSeconds: 2, startupSeconds: 180, shutdownSeconds: 20 });
    const dispatcher = buildDispatcher({
      store: jobs, policies: registry.policies, executorKey: keys.executor, gatewayKey: keys.gateway, signingKey: keys.signing, allocations, delegations,
      sessionContainers: { allocations, store: containerStore, policies: registry.policies, heartbeatSeconds: settings.heartbeatSeconds, promotions },
      broker: { store: new PlacementStore(pool), key: keys.broker },
    });
    apps.push(dispatcher);
    await dispatcher.listen({ port: 0, host: "0.0.0.0" });
    const gatewayClient = new GatewayClient(address(dispatcher.server), keys.gateway, 0);
    const gateway = buildGateway({
      signingKey: keys.signing,
      routes: parseRoutes(JSON.stringify([{ model: "fixture", deployment: "fixture", baseUrl: `${address(upstream)}/container`, auth: "none" }]), true),
      upstreamToken: async () => { throw new Error("No paid model credential is permitted in this test."); },
      introspect: (jti) => gatewayClient.introspect(jti), beginRequest: (jti, id) => gatewayClient.beginRequest(jti, id),
      reportUsage: (usage) => gatewayClient.reportUsage(usage),
    });
    apps.push(gateway);
    await gateway.listen({ port: 0, host: "0.0.0.0" });

    // The shared worker in process on this host, able to promote into the same session containers.
    service = new SharedSessionService({
      root: join(root, "worker"), store: shared, files, principals: { [principal]: githubUserId },
      admission: sharedAdmission(registry, { sessionLimits: { idleSeconds: 300 }, deployment: sharedWorkerDeployment({ promotion: true }) }),
      limits, gatewayUrl: address(upstream),
      mintToken: async (lease, turn) => { await shared.grant(lease, turn.id); return "synthetic-unused-grant"; },
      report: () => {}, promotion: { store: promotions, settings },
    });
    await service.start();
    const host = buildSharedHost(service, keys.worker, keys.broker);
    apps.push(host);
    await host.listen({ port: 0, host: "127.0.0.1" });
    const { app: broker } = buildBroker({
      families: [sessionRoutes(new DispatcherDirectory(address(dispatcher.server), keys.broker))],
      upstreams: { shared: sharedUpstream(new URL(address(host.server)), keys.broker), container: containerUpstream() },
    });
    apps.push(broker);
    await broker.listen({ port: 0, host: "127.0.0.1" });
    const catalog = { harnesses, profiles, policies: registry.policies, deployment: hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true, promotion: true }) };
    const api = buildApi({
      store: jobs, listener: new JobEventListener(pool), admission: new Admission({ harnesses, profiles, policies: registry.policies }), harnesses,
      authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`), maxOpenJobsPerPrincipal: 10, console: false, delegations, hosting: catalog,
      shared: { url: address(host.server), key: keys.worker, brokerUrl: address(broker.server) },
      containers: new ContainerSessionService({
        store: containerStore, allocations, directory: new SessionDirectory(pool), catalog, principals: { [principal]: githubUserId },
        settings, limits, brokerUrl: address(broker.server), connectWaitSeconds: 180,
      }),
    });
    apps.push(api);
    await api.listen({ port: 0, host: "127.0.0.1" });
    controller = new ExecutionController({
      allocations, jobs, delegations, limits, sessions: settings,
      settings: ExecutionContainerSettings.parse({ namespace, image: process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local" }),
      signingKey: "synthetic-allocation-key-".repeat(3), dispatcherUrl: address(dispatcher.server), gatewayUrl: address(gateway.server),
      logger: createLogger("promotion-cli-gate"),
    });
    await controller.start();

    const headers = { authorization: `Bearer ${apiKey}` };
    const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: harness.definition.name, label: "Promotion gate" } });
    expect(created.statusCode, created.body).toBe(201);
    const session = SharedSessionView.parse(created.json());
    expect(session).toMatchObject({ mode: "promotable", placement: "shared", segment: { generation: 1 } });
    const connection = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers, payload: {} });
    expect(connection.statusCode, connection.body).toBe(200);
    const first = SharedConnection.parse(connection.json());
    expect(first).toMatchObject({ sessionId: session.id, destination: "shared", ahpSessionId: session.id });

    // One terminal: the launcher's supervisor runs the CLI and stays attached for the whole conversation.
    cli = new QualificationCli(root, credential);
    await cli.supervise(first, { apiUrl: address(api.server), apiKey, harness: harness.definition.name });
    await cli.send(`BUILD_TASK ${marker}: keep notes, then build in a real workspace.`);
    await cli.waitFor(`MOVING_${marker}`, 120_000);
    const shellAdvertised = requests.filter((entry) => entry.placement === "shared")
      .some((entry) => entry.payload.tools.some((tool) => tool.function.name === "bash" || tool.function.name.endsWith("__bash")));
    expect(shellAdvertised).toBe(false);

    // The move: committed in the ledger, then the same terminal shows the CLI resumed at the container.
    await wait(async () => (await promotions.latest(principal, session.id))?.state === "committed", "the promotion to commit", 300_000);
    await cli.resumed(1, 300_000);
    await cli.waitFor(`CONTINUED_${marker}`, 180_000);
    await cli.send(`SHELL_CHECK ${marker}`);
    await cli.waitFor(`SHELL_OK_${marker}`, 180_000);
    expect(cli.running).toBe(true);
    expect(cli.launcher.filter((line) => line.includes("moved to a new placement"))).toHaveLength(1);
    expect(cli.launcher.filter((line) => line.includes("Resuming session"))).toHaveLength(1);
    expect((await pool.query("SELECT 1 FROM execution_allocations WHERE session_id=$1", [session.id])).rowCount).toBe(1);

    // Same application session, now container-placed at the next generation, with a recorded promotion segment.
    const view = SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json());
    expect(view).toMatchObject({
      id: session.id, mode: "promotable", placement: "container", segment: { generation: 2, placement: "container", ahpSessionId: session.id },
      promotion: { state: "committed", source: "tool", reason: "The build needs a shell and a real filesystem." },
    });
    expect((await pool.query("SELECT generation,placement,reason FROM session_segments WHERE session_id=$1", [session.id])).rows)
      .toEqual([{ generation: 2, placement: "container", reason: "promotion" }]);
    // The container resumed the conversation's history: its first request carried the shared turn and the move notice.
    const continued = requests.find((entry) => entry.placement === "container" && JSON.stringify(entry.payload.messages).includes("[promotion:"));
    expect(continued).toBeDefined();
    const history = JSON.stringify(continued!.payload.messages);
    expect(history).toContain(`BUILD_TASK ${marker}`);
    expect(history).toContain(`MOVING_${marker}`);
    expect(history).toContain("/data/execution/workspace");
    // Real files with their original names, in the container's workspace on the session volume.
    const [containerId] = containers();
    expect(containers()).toHaveLength(1);
    expect(docker("exec", containerId!, "ls", "/data/execution/workspace/Notes")).toBe("MixedCase.md");
    expect(docker("exec", containerId!, "cat", "/data/execution/workspace/Notes/MixedCase.md")).toBe(note);
    expect(docker("exec", containerId!, "cat", "/data/execution/workspace/Build.log")).toBe(`BUILD_${marker}`);

    // A crash after cutover: the container is authoritative, so the next connection starts a replacement from the
    // session volume; the launcher notices the replacement's new server key and restarts the CLI in the same terminal.
    docker("kill", containerId!);
    await wait(() => { const ids = containers(); return ids.length === 1 && ids[0] !== containerId; }, "a replacement container from the session volume", 300_000);
    await cli.resumed(2, 300_000);
    await cli.send(`AFTER_CRASH ${marker}`);
    await cli.waitFor(`AFTER_CRASH_OK_${marker}`, 180_000);
    expect(cli.running).toBe(true);
    expect(cli.launcher.filter((line) => line.includes("Resuming session"))).toHaveLength(2);
    const afterCrash = JSON.stringify(requests.findLast((entry) => entry.placement === "container" && JSON.stringify(entry.payload.messages).includes("AFTER_CRASH"))?.payload.messages);
    expect(afterCrash).toContain(`SHELL_OK_${marker}`);
    expect(SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json()))
      .toMatchObject({ placement: "container", segment: { generation: 2 }, promotion: { state: "committed" } });
    expect((await pool.query("SELECT state FROM execution_allocations WHERE session_id=$1 ORDER BY created_at", [session.id])).rows.map((row) => row.state))
      .toEqual(["retired", "running"]);
    // One way: no demotion route, and the ledger refuses a return to shared placement.
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/demote`, headers, payload: {} })).statusCode).toBe(404);
    await expect(pool.query("UPDATE shared_sessions SET placement='shared' WHERE id=$1", [session.id])).rejects.toThrow(/cannot return to shared/);
    expect(errors).toEqual([]);
  } catch (error) {
    const allocations = await pool.query("SELECT id,state,last_error FROM execution_allocations WHERE namespace=$1 OR namespace IS NULL", [namespace]).catch(() => ({ rows: [] }));
    const promotion = await pool.query("SELECT state,error_code,error_message FROM session_promotions WHERE principal=$1", [principal]).catch(() => ({ rows: [] }));
    throw new Error(`Promotion gate failed. ${JSON.stringify({ errors, allocations: allocations.rows, promotion: promotion.rows, launcher: cli?.launcher })}\n${logs.join("").slice(-8000)}\n${cli?.output.slice(-6000) ?? ""}`, { cause: error });
  } finally {
    clearInterval(follower);
    for (const child of followed.values()) child.kill();
    try { await cli?.stop(); await controller?.stop(); await service?.stop(); }
    finally {
      try {
        for (const app of apps.reverse()) await app.close();
        if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      } finally {
        for (const id of containers()) docker("rm", "--force", id);
        for (const volume of volumes()) docker("volume", "rm", volume);
        await pool.query("DELETE FROM execution_allocations WHERE principal=$1", [principal]);
        await pool.query("DELETE FROM shared_sessions WHERE principal=$1", [principal]);
        await pool.query("DELETE FROM session_file_namespaces WHERE principal=$1", [principal]);
        await pool.query("DELETE FROM execution_volumes WHERE namespace=$1", [namespace]);
        await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
}, 1_200_000);
