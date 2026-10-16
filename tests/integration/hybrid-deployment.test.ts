import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expect, inject, it } from "vitest";
import {
  HarnessDefinition, ExecutionContainerSettings, SHARED_WORKER_FEATURES, SharedWorkerLimits, SharedConnection, SharedSessionView,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobEventListener, JobStore, SharedStore, SessionFileStore, migrate,
} from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, createLogger, loadPolicySet, loadProfiles, sha256Hex, canonicalJson } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { DispatcherClient as GatewayClient } from "../../src/inference-gateway/src/dispatcher-client.js";
import { buildGateway } from "../../src/inference-gateway/src/server.js";
import { parseRoutes } from "../../src/inference-gateway/src/routes.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { CompletionPump } from "../../src/session-host/src/completions.js";
import { ExecutionController } from "../../src/execution-controller/src/controller.js";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedAdmission, sharedHarness } from "./fixtures/shared-harness.js";

const enabled = process.env.HYBRID_DEPLOYMENT_TESTS === "1";
const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const wire = z.object({
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_calls: z.array(z.object({
    id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }),
  })).optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string(), parameters: z.unknown().optional() }).passthrough() })).default([]),
}).passthrough();
const fixtureContent = "Selected immutable input for a real container job.\n";
const reportDigest = createHash("sha256").update(fixtureContent).digest("hex");

it.skipIf(!enabled)("drives CLI delegation through actual Linux containers and delivers retained results after teardown", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const root = await mkdtemp(join(tmpdir(), "hybrid-deployment-test-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const principal = randomUUID();
  const namespace = `hybrid-test-${randomUUID().slice(0, 12)}`;
  const key = "synthetic-api-key-".repeat(3);
  const workerKey = "synthetic-worker-key-".repeat(3);
  const gatewayKey = "synthetic-gateway-key-".repeat(3);
  const executorKey = "synthetic-pool-key-".repeat(3);
  const signingKey = "synthetic-inference-key-".repeat(3);
  const sessionIds: string[] = [];
  const jobs = new JobStore(pool);
  const shared = new SharedStore(pool);
  const delegations = new DelegationStore(pool, shared, jobs);
  const allocations = new AllocationStore(pool, shared);
  let controller: ExecutionController | undefined;
  let service: SharedSessionService | undefined;
  let pump: CompletionPump | undefined;
  const apps: FastifyInstance[] = [];
  let cli: QualificationCli | undefined;
  const errors: string[] = [];
  const modelCalls: Array<{ names: string[]; kind: string }> = [];
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") return response.writeHead(404).end();
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.once("end", () => {
      try {
        const payload = wire.parse(JSON.parse(body));
        const messages = JSON.stringify(payload.messages);
        const lastUser = JSON.stringify(payload.messages.findLast((message) => message.role === "user")?.content);
        const names = payload.tools.map((tool) => tool.function.name);
        const tool = (name: string) => {
          const exact = names.find((candidate) => candidate === name || candidate.endsWith(`__${name}`));
          if (!exact) throw new Error(`Missing tool ${name}; advertised: ${names.join(",")}`);
          return exact;
        };
        const invoked = (name: string) => payload.messages.some((message) => message.tool_calls?.some((call) => call.function.name === name || call.function.name.endsWith(`__${name}`)));
        let content: string | undefined;
        let call: { name: string; arguments: string } | undefined;
        const use = (name: string, args: object) => { call = { name: tool(name), arguments: JSON.stringify(args) }; };
        const isCoordinator = names.some((name) => name.includes("delegate_job"));
        if (!isCoordinator) {
          modelCalls.push({ names, kind: "container" });
          if (!invoked("bash")) use("bash", {
            command: messages.includes("slow") ? "sleep 60" : "cat inputs/sample.txt > outputs/report.txt && sleep 2",
            description: "Execute the synthetic container workload", timeout: messages.includes("slow") ? 70000 : 10000,
          });
          else use("submit_result", { summary: "Created outputs/report.txt from the selected input." });
        } else if (lastUser?.includes("[shared-completion:")) {
          modelCalls.push({ names, kind: "completion" });
          content = "HYBRID_JOB_COMPLETE";
        } else if (messages.includes("DELEGATE_NODE_JOB") || messages.includes("DELEGATE_PYTHON_JOB")) {
          modelCalls.push({ names, kind: "delegation" });
          const python = messages.includes("DELEGATE_PYTHON_JOB");
          const priorJobs = payload.messages.flatMap((message) => message.tool_calls ?? []).filter((call) => call.function.name.includes("delegate_job"));
          if (!invoked("write_workspace_file")) use("write_workspace_file", { path: "sample.txt", content: fixtureContent });
          else if (priorJobs.length < (python ? 2 : 1)) use("delegate_job", {
            harness: "hybrid-file-job", input: {}, profile: python ? "python-agent" : "node-ts-agent", files: ["sample.txt"],
          });
          else content = python ? "PYTHON_JOB_QUEUED" : "NODE_JOB_QUEUED";
        } else {
          modelCalls.push({ names, kind: "chat" });
          content = "HYBRID_LIGHTWEIGHT_REPLY";
        }
        const toolCall = call ? { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: call } : undefined;
        const base = { id: randomUUID(), model: "gpt-5.4", created: Math.floor(Date.now() / 1000) };
        const usage = { prompt_tokens: 100, completion_tokens: 20 };
        if (!payload.stream) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: content ?? null, ...(toolCall ? { tool_calls: [toolCall] } : {}) },
            finish_reason: toolCall ? "tool_calls" : "stop" }], usage,
        }));
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
  const wait = async (predicate: () => Promise<boolean>, label: string, timeout = 90_000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (errors.length) throw new Error(errors.join("\n"));
      if (Date.now() > deadline) throw new Error(`Timed out ${label}. Model calls: ${JSON.stringify(modelCalls)}\n${cli?.output.slice(-5000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  try {
    await migrate(pool);
    const repo = join(import.meta.dirname, "..", "..");
    const profiles = await loadProfiles(repo);
    const base = await loadPolicySet(join(repo, "examples", "customer-config"));
    const policies = { base: { ...base.base, allowedModels: ["gpt-5.4"], hosting: { modes: ["isolated" as const, "shared" as const] },
      requirements: { processIsolation: "uid" as const, egress: "none" as const }, acknowledgedGaps: [] }, overrides: new Map() };
    const definition = HarnessDefinition.parse({
      schemaVersion: "1", name: "hybrid-file-job", version: "1.0.0", description: "Synthetic real-filesystem container qualification.",
      instructions: "Create the deliverable using the selected workspace input and submit the structured result.", model: { preferred: "gpt-5.4", allowed: ["gpt-5.4"] },
      tools: [], builtinTools: ["shell"], permissions: { default: "allow" },
      input: { schema: { type: "object", properties: { slow: { type: "boolean" } }, additionalProperties: false } },
      output: { schema: { type: "object", required: ["summary"], additionalProperties: false, properties: { summary: { type: "string" } } } },
      limits: { maxDurationSeconds: 120, maxInferenceTokens: 4000 }, retry: { safeToRetry: false, maxAttempts: 1 },
      runners: { allowedProfiles: ["node-ts-agent", "python-agent"], defaultProfile: "node-ts-agent" },
    });
    const harness = { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
    const delegation = (name: string, binding: string, description: string) => ({ name, kind: "host", binding, description });
    const coordinator = sharedHarness("hybrid-test-coordinator", {
      instructions: "Synthetic shared coordinator; use only the provided application tools.",
      model: { preferred: "gpt-5.4", allowed: ["gpt-5.4"] },
      limits: { maxDurationSeconds: 90, maxInferenceTokens: 500_000 },
      builtinTools: ["files"], permissions: { default: "deny", kinds: { read: "allow", write: "allow" } },
      tools: [
        delegation("delegate_job", "shared:delegate-job", "Queue durable container work and return immediately. Do not poll."),
        delegation("get_job", "shared:get-job", "Read a delegated job's status, bounded result, and artifacts."),
        delegation("read_job_artifact", "shared:read-job-artifact", "Read a bounded portion of a retained output artifact."),
        delegation("import_job_artifact", "shared:import-job-artifact", "Import an output artifact into the workspace."),
      ],
    });
    const harnesses = new Map([[definition.name, [harness]], [coordinator.definition.name, [coordinator]]]);
    const admission = new Admission({ harnesses, profiles, policies });
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    const dispatcher = buildDispatcher({ store: jobs, policies, executorKey, gatewayKey, signingKey,
      shared: { store: shared, key: workerKey }, allocations, delegations });
    apps.push(dispatcher);
    await dispatcher.listen({ port: 0, host: "0.0.0.0" });
    const gatewayClient = new GatewayClient(address(dispatcher.server), gatewayKey, 0);
    const gateway = buildGateway({
      signingKey, routes: parseRoutes(JSON.stringify([{ model: "gpt-5.4", deployment: "gpt-5.4", baseUrl: address(upstream), auth: "none" }]), true),
      upstreamToken: async () => { throw new Error("No paid model credential is permitted in this test."); },
      introspect: (jti) => gatewayClient.introspect(jti), beginRequest: (jti, id) => gatewayClient.beginRequest(jti, id),
      reportUsage: (usage) => gatewayClient.reportUsage(usage),
    });
    apps.push(gateway);
    await gateway.listen({ port: 0, host: "0.0.0.0" });
    const workerLimits = SharedWorkerLimits.parse({ activeTurns: 1, executionContainers: 1 });
    let host: FastifyInstance;
    service = new SharedSessionService({
      root, store: shared, files: new SessionFileStore(pool), principals: { [principal]: githubUserId }, limits: workerLimits,
      admission: sharedAdmission({ harnesses, profiles, policies }, { sessionLimits: { idleSeconds: 300, maxTurnSeconds: 90 }, delegation: [definition.name] }),
      gatewayUrl: `${address(gateway.server)}/openai/v1`, publicUrl: () => address(host.server),
      mintToken: async (lease, turn) => {
        const response = await dispatcher.inject({ method: "POST", url: "/internal/shared/grant",
          headers: { "x-internal-key": workerKey }, payload: { lease, turnId: turn.id } });
        if (response.statusCode !== 200) throw new Error("The shared grant was refused.");
        return z.object({ token: z.string() }).parse(response.json()).token;
      },
      toolkit: { delegation: { admission: async () => admission, profiles: async () => profiles, jobs, delegations, maxOpenJobs: 10 } },
      report: (event) => { if (event.endsWith("_failed")) errors.push(event); },
    });
    await service.start();
    host = buildSharedHost(service, workerKey);
    apps.push(host);
    await host.listen({ port: 0, host: "127.0.0.1" });
    pump = new CompletionPump(service, delegations, jobs, createLogger("hybrid-test-completions"));
    pump.start();
    const api = buildApi({ store: jobs, listener: new JobEventListener(pool), admission, harnesses,
      authenticator: new ApiKeyAuthenticator(`${principal}:${key}`), maxOpenJobsPerPrincipal: 10, console: false,
      shared: { url: address(host.server), key: workerKey }, delegations, execution: "dedicated",
      hosting: { harnesses, profiles, policies, deployment: { executor: "dedicated", isolatedHosts: [], sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] } } } });
    apps.push(api);
    controller = new ExecutionController({
      allocations, jobs, delegations, settings: ExecutionContainerSettings.parse({
        namespace, image: process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local", memoryMiB: 2048,
      }), limits: workerLimits, signingKey: "synthetic-allocation-key-".repeat(3),
      dispatcherUrl: address(dispatcher.server), gatewayUrl: address(gateway.server), logger: createLogger("hybrid-test-controller"),
    });
    await controller.start();
    const headers = { authorization: `Bearer ${key}` };
    const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: coordinator.definition.name } });
    expect(created.statusCode).toBe(201);
    const session = SharedSessionView.parse(created.json());
    sessionIds.push(session.id);
    const response = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers });
    expect(response.statusCode).toBe(200);
    cli = new QualificationCli(root, credential);
    await cli.connect(SharedConnection.parse(response.json()));
    await cli.send("Answer a lightweight question without delegating.");
    await cli.waitFor("HYBRID_LIGHTWEIGHT_REPLY");
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM execution_allocations WHERE namespace=$1", [namespace])).rows[0]!.count).toBe(0);
    await wait(async () => !service!.busy(session.id), "waiting for the lightweight turn to finish");
    for (const [index, profile] of ["node-ts-agent", "python-agent"].entries()) {
      await cli.send(index === 0 ? "DELEGATE_NODE_JOB" : "DELEGATE_PYTHON_JOB");
      await wait(async () => (await delegations.list(principal, session.id)).length === index + 1, "waiting for model-directed job admission");
      const jobId = (await delegations.list(principal, session.id))[index]!.jobId;
      await wait(async () => {
        const job = await jobs.getJob(principal, jobId);
        if (job?.state === "failed" || job?.state === "needs_review") throw new Error(`Container job failed: ${JSON.stringify(job.error)}`);
        return job?.state === "succeeded";
      }, `${profile} container execution`);
      await wait(async () => (await pool.query(
        "SELECT 1 FROM shared_completion_inbox i JOIN shared_delegations d ON d.id=i.delegation_id WHERE d.job_id=$1 AND i.state='delivered'", [jobId])).rowCount === 1, "waiting for durable completion delivery");
      await cli.waitFor("HYBRID_JOB_COMPLETE");
      await wait(async () => !service!.busy(session.id), "waiting for the completion turn");
      await wait(async () => (await pool.query("SELECT 1 FROM execution_allocations WHERE namespace=$1 AND state<>'retired'", [namespace])).rowCount === 0, "waiting for container retirement");
      const artifacts = await delegations.artifacts(principal, jobId);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ path: "report.txt", sha256: reportDigest, size: Buffer.byteLength(fixtureContent) });
      const downloaded = await api.inject({ method: "GET", url: `/v1/jobs/${jobId}/artifacts/${artifacts[0]!.id}`, headers });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.body).toBe(fixtureContent);
      const execution = (await pool.query<{ process_isolation: string; principal: string }>(
        "SELECT executor_capabilities->>'processIsolation' AS process_isolation,$2::text AS principal FROM attempts WHERE job_id=$1", [jobId, principal])).rows[0];
      expect(execution?.process_isolation).toBe("uid");
    }
    expect(await readdir(join(root, "anchors", session.id))).toEqual([]);
    expect(errors).toEqual([]);
    expect(modelCalls.filter((call) => call.kind === "container").length).toBeGreaterThanOrEqual(4);
    expect(modelCalls.filter((call) => call.kind === "completion")).toHaveLength(2);
    const beforeSlow = modelCalls.filter((call) => call.kind === "container").length;
    const slow = await api.inject({ method: "POST", url: "/v1/jobs", headers,
      payload: { harness: { name: definition.name }, input: { slow: true } } });
    expect(slow.statusCode).toBe(202);
    const slowId = z.object({ id: z.string().uuid() }).parse(slow.json()).id;
    await wait(async () => modelCalls.filter((call) => call.kind === "container").length > beforeSlow, "waiting for cancellable container work");
    expect((await api.inject({ method: "POST", url: `/v1/jobs/${slowId}:cancel`, headers })).statusCode).toBe(200);
    await wait(async () => (await jobs.getJob(principal, slowId))?.state === "cancelled", "waiting for running-container cancellation", 60_000);
    expect(await delegations.artifacts(principal, slowId)).toEqual([]);
    await wait(async () => (await pool.query("SELECT 1 FROM execution_allocations WHERE namespace=$1 AND state<>'retired'", [namespace])).rowCount === 0, "waiting for cancelled-container teardown");
    const queued = await api.inject({ method: "POST", url: "/v1/jobs", headers,
      payload: { harness: { name: definition.name }, input: {} } });
    const queuedId = z.object({ id: z.string().uuid() }).parse(queued.json()).id;
    await jobs.requestCancel(principal, queuedId);
    await wait(async () => (await jobs.getJob(principal, queuedId))?.state === "cancelled", "cancelling queued work");
    await wait(async () => (await pool.query("SELECT 1 FROM execution_allocations WHERE namespace=$1 AND state<>'retired'", [namespace])).rowCount === 0, "waiting for queued cancellation cleanup");
    await controller.stop();
    controller = new ExecutionController({
      allocations, jobs, delegations, settings: ExecutionContainerSettings.parse({
        namespace, image: process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local", memoryMiB: 2048,
      }), limits: SharedWorkerLimits.parse({ ...workerLimits, executionContainers: 2 }), signingKey: "synthetic-allocation-key-".repeat(3),
      dispatcherUrl: address(dispatcher.server), gatewayUrl: address(gateway.server), logger: createLogger("hybrid-test-controller"),
    });
    await controller.start();
    const parallelIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await api.inject({ method: "POST", url: "/v1/jobs", headers,
        payload: { harness: { name: definition.name }, input: { slow: true } } });
      expect(response.statusCode).toBe(202);
      parallelIds.push(z.object({ id: z.string().uuid() }).parse(response.json()).id);
    }
    await wait(async () => (await pool.query(
      "SELECT 1 FROM execution_allocations e JOIN jobs j ON j.id=e.job_id WHERE e.namespace=$1 AND e.state='running' AND j.state='running'", [namespace])).rowCount === 2,
    "waiting for the configured two-container spread");
    expect(execFileSync("docker", ["ps", "-q", "--filter", `label=copilot.hybrid.namespace=${namespace}`], { encoding: "utf8" }).trim().split(/\r?\n/)).toHaveLength(2);
    for (const id of parallelIds) await jobs.requestCancel(principal, id);
    await wait(async () => (await Promise.all(parallelIds.map((id) => jobs.getJob(principal, id)))).every((job) => job?.state === "cancelled"), "cancelling parallel jobs", 60_000);
    await wait(async () => (await pool.query("SELECT 1 FROM execution_allocations WHERE namespace=$1 AND state<>'retired'", [namespace])).rowCount === 0, "waiting for parallel teardown");
    const orphan = execFileSync("docker", ["create",
      "--label", `copilot.hybrid.namespace=${namespace}`, "--label", "copilot.hybrid.managed=execution",
      "--label", `copilot.hybrid.allocation=${randomUUID()}`,
      process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local"], { encoding: "utf8" }).trim();
    expect(orphan).toMatch(/^[a-f0-9]{64}$/);
    await wait(async () => execFileSync("docker", ["ps", "-aq", "--filter", `id=${orphan}`], { encoding: "utf8" }).trim() === "", "waiting for orphan cleanup");
    expect(execFileSync("docker", ["ps", "-aq", "--filter", `label=copilot.hybrid.namespace=${namespace}`], { encoding: "utf8" }).trim()).toBe("");
  } catch (error) {
    const states = await pool.query("SELECT id,state,last_error FROM execution_allocations WHERE namespace=$1", [namespace]);
    throw new Error(`Hybrid deployment qualification failed. ${JSON.stringify({ errors, modelCalls, allocations: states.rows })}\n${cli?.output.slice(-8000)}`, { cause: error });
  } finally {
    try { await cli?.stop(); await pump?.stop(); await controller?.stop(); }
    finally {
      try {
        for (const app of apps.reverse()) await app.close();
        if (!apps.some((app) => app.hasRoute({ method: "POST", url: "/internal/shared" }))) await service?.stop();
        if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      } finally {
        await pool.query("DELETE FROM jobs WHERE principal=$1", [principal]);
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessionIds]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessionIds]);
        await pool.query("DELETE FROM execution_controller WHERE namespace=$1", [namespace]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
}, 300_000);
