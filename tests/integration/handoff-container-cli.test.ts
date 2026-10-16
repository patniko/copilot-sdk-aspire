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
  ExecutionContainerSettings, HandoffView, SessionContainerSettings, SharedConnection, SharedSessionLimits, SharedSessionView, SharedWorkerLimits,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, HandoffStore, JobEventListener, JobStore, PlacementStore, PromotionStore, SessionContainerStore,
  SessionDirectory, SessionFileStore, SharedStore, migrate,
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
import { SharedAdmission, sharedWorkerDeployment } from "../../src/session-host/src/admission.js";
import { SharedConfiguration, type SharedRegistry } from "../../src/session-host/src/configuration.js";
import { PERMISSION_HANDLERS } from "../../src/session-host/src/permission-handlers.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";

/**
 * Stage 6 exit gate (docs/HOSTING-MODES-PLAN.md, sections 7.5 and 14): a shared triage harness hands its conversation
 * to an isolated coding harness with summary history, in the same terminal. A transfer to a target the current policy
 * no longer allows fails first, without moving anything. Then the person approves the transfer to the coder in the
 * CLI; the conversation moves into the coder's own session container under the same application session, and the
 * launcher's supervisor reconnects the CLI to the coder's new runtime session, which starts from the summary and sees
 * none of the earlier conversation. Real CLI under the supervisor, the in-process Windows shared worker, a real session
 * container from the local image, the broker, and synthetic inference.
 */
const enabled = process.env.HYBRID_HANDOFF_TESTS === "1" && process.env.HYBRID_CLI_TESTS === "1";
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
  const args: Record<string, unknown> = { command, description: "Synthetic handoff check" };
  for (const name of parsed.success ? parsed.data.required : []) {
    if (name in args) continue;
    const type = properties[name]?.type;
    args[name] = type === "number" || type === "integer" ? 30 : type === "boolean" ? false : "";
  }
  if ("timeout" in properties && !("timeout" in args)) args.timeout = 30_000;
  return args;
}

it.skipIf(!enabled)("hands a shared triage conversation to an isolated coding harness with summary history in the same terminal", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  docker("image", "inspect", image, "--format", "{{.Id}}");
  const root = await mkdtemp(join(tmpdir(), "handoff-container-cli-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const principal = `handoff-cli-${randomUUID()}`;
  const namespace = `handoff-${randomUUID().slice(0, 12)}`;
  const marker = randomUUID().replaceAll("-", "").slice(0, 16);
  const codeword = `CODEWORD_${marker}`;
  const plan = `PLAN_${marker}`;
  const apiKey = `handoff-api-key-${randomUUID()}`;
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
        const placement = request.url === "/chat/completions" ? "shared" : "container";
        requests.push({ placement, payload });
        const system = JSON.stringify(payload.messages.find((message) => message.role === "system")?.content ?? "");
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
        else if (system.includes("TRIAGE_AGENT")) {
          if (prompt.includes("REMEMBER")) {
            // Shared placement: keep a plan in the workspace, which moves with the conversation.
            if (results.length === 0) call = { name: tool("write_workspace_file").name, arguments: JSON.stringify({ path: "Plan.md", content: plan }) };
            else content = `TRIAGE_NOTED_${marker}`;
          } else if (prompt.includes("BUILD_TASK")) {
            if (results.length === 0) {
              call = { name: tool("transfer_to_coder").name, arguments: JSON.stringify({
                reason: "The build needs a shell and a real checkout.", summary: `SUMMARY_FROM_TRIAGE: the codeword is ${codeword}; the plan is in Plan.md.`,
              }) };
            } else content = results.at(-1)!.includes("Handoff accepted") ? `TRIAGE_HANDED_OFF_${marker}` : `TRIAGE_STAYED_${marker}`;
          } else content = "OK";
        } else if (system.includes("CODER_AGENT")) {
          if (prompt.includes("[handoff:")) {
            // The coder's first turn in its container: the plan is a real file, and the shell works.
            const bash = tool("bash");
            if (results.length === 0) call = { name: bash.name, arguments: JSON.stringify(shellArguments(bash.parameters, "cat Plan.md && echo && pwd && id -u")) };
            else content = results.some((result) => result.includes(plan)) ? `CODER_TOOK_OVER_${marker}` : `CODER_MISSING_PLAN_${marker}`;
          } else if (prompt.includes("SHELL_CHECK")) {
            const bash = tool("bash");
            if (results.length === 0) call = { name: bash.name, arguments: JSON.stringify(shellArguments(bash.parameters, `printf '%s' BUILD_${marker} > Build.log && cat Build.log`)) };
            else content = results.some((result) => result.includes(`BUILD_${marker}`)) ? `SHELL_OK_${marker}` : `SHELL_MISSING_${marker}`;
          } else content = "OK";
        } else content = "UNEXPECTED";
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
    const triage = sharedHarness("triage", {
      instructions: "TRIAGE_AGENT: understand the request, keep a plan in the workspace, and hand coding work to the coder.",
      hosting: { mode: "shared", handoffs: [{ harness: "coder", description: "Coding work that needs a shell and a real checkout." }] },
      builtinTools: ["files"], permissions: { default: "allow" },
    });
    const coder = sharedHarness("coder", {
      instructions: "CODER_AGENT: build and test code in your workspace.", hosting: { mode: "isolated" },
      builtinTools: ["files", "shell"], permissions: { default: "allow" },
    });
    const allowed = await sharedRegistry([triage, coder], { hosting: { modes: ["isolated", "shared"] } });
    // The policy as the worker sees it now; the gate narrows it once to show a refused transfer.
    let active: SharedRegistry = allowed;
    const harnesses = new Map(allowed.harnesses);
    const profiles = new Map(allowed.profiles);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    const jobs = new JobStore(pool);
    const shared = new SharedStore(pool);
    const files = new SessionFileStore(pool);
    const allocations = new AllocationStore(pool, shared);
    const containerStore = new SessionContainerStore(pool, shared);
    const promotions = new PromotionStore(pool, shared, allocations);
    const handoffs = new HandoffStore(pool, shared);
    const delegations = new DelegationStore(pool, shared, jobs);
    const limits = SharedWorkerLimits.parse({ executionContainers: 2, containersPerPrincipal: 1 });
    const settings = SessionContainerSettings.parse({ image, idleSeconds: 300, heartbeatSeconds: 2, startupSeconds: 180, shutdownSeconds: 20 });
    const dispatcher = buildDispatcher({
      store: jobs, policies: allowed.policies, executorKey: keys.executor, gatewayKey: keys.gateway, signingKey: keys.signing, allocations, delegations,
      sessionContainers: { allocations, store: containerStore, policies: allowed.policies, heartbeatSeconds: settings.heartbeatSeconds, promotions },
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

    // The shared worker in process on this host, able to move conversations into the same session containers.
    const sessionLimits = SharedSessionLimits.parse({ idleSeconds: 300 });
    service = new SharedSessionService({
      root: join(root, "worker"), store: shared, files, principals: { [principal]: githubUserId },
      admission: new SharedAdmission({
        configuration: new SharedConfiguration(async () => active, () => undefined, 0), sessionLimits, delegationHarnesses: [],
        permissionHandlers: new Set(PERMISSION_HANDLERS.keys()), deployment: sharedWorkerDeployment({ promotion: true }),
        sessionContainers: { idleSeconds: settings.idleSeconds },
      }),
      limits, gatewayUrl: address(upstream),
      mintToken: async (lease, turn) => { await shared.grant(lease, turn.id); return "synthetic-unused-grant"; },
      report: () => {}, promotion: { store: promotions, settings }, handoffs,
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
    const catalog = { harnesses, profiles, policies: allowed.policies, deployment: hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true, promotion: true }) };
    const api = buildApi({
      store: jobs, listener: new JobEventListener(pool), admission: new Admission({ harnesses, profiles, policies: allowed.policies }), harnesses,
      authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`), maxOpenJobsPerPrincipal: 10, console: false, delegations, hosting: catalog, handoffs,
      shared: { url: address(host.server), key: keys.worker, brokerUrl: address(broker.server) },
      containers: new ContainerSessionService({
        store: containerStore, allocations, directory: new SessionDirectory(pool), catalog, principals: { [principal]: githubUserId },
        settings, limits, sessionLimits, brokerUrl: address(broker.server), connectWaitSeconds: 180,
      }),
    });
    apps.push(api);
    await api.listen({ port: 0, host: "127.0.0.1" });
    controller = new ExecutionController({
      allocations, jobs, delegations, limits, sessions: settings,
      settings: ExecutionContainerSettings.parse({ namespace, image: process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local" }),
      signingKey: "synthetic-allocation-key-".repeat(3), dispatcherUrl: address(dispatcher.server), gatewayUrl: address(gateway.server),
      logger: createLogger("handoff-cli-gate"),
    });
    await controller.start();

    const headers = { authorization: `Bearer ${apiKey}` };
    const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "triage", label: "Handoff gate" } });
    expect(created.statusCode, created.body).toBe(201);
    const session = SharedSessionView.parse(created.json());
    expect(session).toMatchObject({ mode: "shared", placement: "shared", segment: { generation: 1 } });
    const connection = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers, payload: {} });
    expect(connection.statusCode, connection.body).toBe(200);
    const first = SharedConnection.parse(connection.json());
    expect(first).toMatchObject({ sessionId: session.id, destination: "shared", ahpSessionId: session.id });

    // One terminal: the launcher's supervisor runs the CLI and stays attached for the whole conversation.
    cli = new QualificationCli(root, credential);
    await cli.supervise(first, { apiUrl: address(api.server), apiKey, harness: "triage" });
    await cli.send(`REMEMBER ${codeword} and keep a plan.`);
    await cli.waitFor(`TRIAGE_NOTED_${marker}`, 120_000);

    // A target the current policy no longer allows: refused before anyone is asked, and nothing moves.
    active = await sharedRegistry([triage, coder], { hosting: { modes: ["isolated", "shared"] } }, { coder: { hosting: { modes: ["shared"] } } });
    await cli.send(`BUILD_TASK ${marker}: build it now.`);
    await cli.waitFor(`TRIAGE_STAYED_${marker}`, 120_000);
    const refusal = requests.filter((entry) => entry.placement === "shared").at(-1)!;
    expect(JSON.stringify(refusal.payload.messages)).toContain("handoff_not_allowed");
    expect((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}/handoffs`, headers })).json()).toEqual({ handoffs: [] });
    expect(SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json()))
      .toMatchObject({ harness: { name: "triage" }, placement: "shared", segment: { generation: 1, ahpSessionId: session.id } });
    expect(containers()).toEqual([]);

    // The policy allows the coder again: the person approves the transfer in the same terminal.
    active = allowed;
    await cli.send(`BUILD_TASK ${marker}: build it in a real workspace.`);
    await cli.waitFor("Approve once", 120_000);
    // The person sees the reason and summary they approve; the rendered screen can lag the raw stream.
    await cli.waitFor(`SUMMARY_FROM_TRIAGE: the codeword is ${codeword}`, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cli.press("\r");

    // The move: committed in the ledger, then the same terminal shows the CLI resumed at the coder's container. The
    // supervisor may replace the CLI before the source's last reply finishes rendering, so the ledger and the model's
    // requests show the hand-off.
    const handoff = await (async () => {
      for (const deadline = Date.now() + 300_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
        const listed = (await api.inject({ method: "GET", url: `/v1/sessions/${session.id}/handoffs`, headers })).json() as { handoffs: unknown[] };
        const [latest] = listed.handoffs.map((entry) => HandoffView.parse(entry));
        if (latest && latest.state !== "accepted") return latest;
        if (errors.length) throw new Error(errors.join("\n"));
        if (Date.now() > deadline) throw new Error("The handoff did not settle.");
      }
    })();
    expect(handoff).toMatchObject({
      state: "committed", approval: "ask", approvedBy: "person", history: "summary", target: { name: "coder", mode: "isolated" },
      from: { generation: 1, placement: "shared" }, to: { generation: 2, placement: "container" },
    });
    expect(handoff.to!.ahpSessionId).not.toBe(session.id);
    const accepted = requests.filter((entry) => entry.placement === "shared").at(-1)!;
    expect(JSON.stringify(accepted.payload.messages.at(-1))).toContain("Handoff accepted");
    await cli.resumed(1, 300_000);
    await cli.waitFor(`CODER_TOOK_OVER_${marker}`, 180_000);
    await cli.send(`SHELL_CHECK ${marker}`);
    await cli.waitFor(`SHELL_OK_${marker}`, 180_000);
    expect(cli.running).toBe(true);
    expect(cli.launcher.filter((line) => line.includes("moved to a new placement"))).toHaveLength(1);
    expect(cli.launcher.filter((line) => line.includes("Resuming session"))).toHaveLength(1);

    // Same application session, now the coder's, container-placed at the next generation.
    const view = SharedSessionView.parse((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json());
    expect(view).toMatchObject({
      id: session.id, harness: { name: "coder" }, mode: "isolated", placement: "container",
      segment: { generation: 2, placement: "container", ahpSessionId: handoff.to!.ahpSessionId, harness: { name: "coder" } },
    });
    expect((await pool.query("SELECT generation,placement,reason,handoff_id FROM session_segments WHERE session_id=$1", [session.id])).rows)
      .toEqual([{ generation: 2, placement: "container", reason: "handoff", handoff_id: handoff.id }]);
    // The coder's first request: the summary as untrusted data, none of the earlier conversation.
    const took = requests.find((entry) => entry.placement === "container" && JSON.stringify(entry.payload.messages).includes("[handoff:"))!;
    const history = JSON.stringify(took.payload.messages);
    expect(history).toContain(`SUMMARY_FROM_TRIAGE: the codeword is ${codeword}`);
    expect(history).not.toContain(`REMEMBER ${codeword}`);
    expect(history).not.toContain(`TRIAGE_NOTED_${marker}`);
    // The workspace moved with the conversation into the coder's own container.
    const [containerId] = containers();
    expect(containers()).toHaveLength(1);
    expect(docker("exec", containerId!, "cat", "/data/execution/workspace/Plan.md")).toBe(plan);
    expect(docker("exec", containerId!, "cat", "/data/execution/workspace/Build.log")).toBe(`BUILD_${marker}`);
    await expect(pool.query("UPDATE shared_sessions SET placement='shared' WHERE id=$1", [session.id])).rejects.toThrow(/cannot return to shared/);
    expect(errors).toEqual([]);
  } catch (error) {
    const allocations = await pool.query("SELECT id,state,last_error FROM execution_allocations WHERE principal=$1", [principal]).catch(() => ({ rows: [] }));
    const moves = await pool.query("SELECT state,error_code,error_message FROM session_promotions WHERE principal=$1", [principal]).catch(() => ({ rows: [] }));
    const recorded = await pool.query("SELECT state,error_code,error_message FROM session_handoffs WHERE principal=$1", [principal]).catch(() => ({ rows: [] }));
    throw new Error(`Handoff gate failed. ${JSON.stringify({ errors, allocations: allocations.rows, moves: moves.rows, handoffs: recorded.rows })}\n${logs.join("").slice(-8000)}\n${cli?.output.slice(-6000) ?? ""}`, { cause: error });
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
