import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { ExecutionPolicy, ExecutionProfile, ExecutorCapabilities, JobView } from "@copilot-agent/contracts";
import { JobEventListener, JobStore, migrate } from "@copilot-agent/job-store";
import { ApiKeyAuthenticator, createLogger, loadHarnesses, loadPolicy, loadProfiles } from "@copilot-agent/service-defaults";
import type { FastifyInstance } from "fastify";
import { Admission } from "../../src/agent-api/src/admission.js";
import { buildApi } from "../../src/agent-api/src/server.js";
import { runAttempt } from "../../src/agent-executor/src/attempt.js";
import { DispatcherClient, NotEligibleError } from "../../src/agent-executor/src/dispatcher-client.js";
import { DispatcherClient as GatewayDispatcherClient } from "../../src/inference-gateway/src/dispatcher-client.js";
import { buildGateway } from "../../src/inference-gateway/src/server.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";

const root = join(import.meta.dirname, "..", "..");
const apiKey = "alice-key-0123456789abcdefghijklmnop";
const executorKey = "executor-key-0123456789abcdefghijkl";
const gatewayKey = "gateway-key-0123456789abcdefghijklm";
const signingKey = "signing-key-".padEnd(64, "x");

let pool: pg.Pool;
let listener: JobEventListener;
let policy: ExecutionPolicy;
let api: FastifyInstance;
let dispatcherApp: FastifyInstance;
let gateway: FastifyInstance;
let upstream: Server;
let apiUrl = "";
let dispatcherUrl = "";
let gatewayUrl = "";
const upstreamHeaders: IncomingHttpHeaders[] = [];
let profile: ExecutionProfile;

const address = (server: Server | FastifyInstance["server"]) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const capabilities = (overrides: Partial<ExecutorCapabilities> = {}): ExecutorCapabilities => ({
  executorId: "e2e",
  profiles: ["node-ts-agent"],
  processIsolation: "none",
  egress: "none",
  platform: `${process.platform}-${process.arch}`,
  ...overrides,
});

async function submit(question: string): Promise<JobView> {
  const response = await fetch(`${apiUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      harness: { name: "dataset-analyst" },
      input: { question, dataset: { name: "d", columns: ["x"], rows: [[1], [2]] } },
    }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as JobView;
}

async function job(id: string): Promise<JobView> {
  return (await (await fetch(`${apiUrl}/v1/jobs/${id}`, { headers: { authorization: `Bearer ${apiKey}` } })).json()) as JobView;
}

async function execute(client: DispatcherClient, shutdown = new AbortController()) {
  const claim = await client.claim(capabilities());
  expect(claim).toBeDefined();
  const outcome = await runAttempt({
    claim: claim!,
    profile,
    dispatcher: client,
    isolation: { processIsolation: "none", egress: "none" },
    configRoot: root,
    workspaceRoot: join(tmpdir(), "agent-e2e"),
    gatewayBaseUrl: `${gatewayUrl}/openai/v1/`,
    logger: createLogger("e2e"),
    shutdown: shutdown.signal,
  });
  return { claim: claim!, outcome, state: outcome ? await client.complete(claim!.attempt.id, claim!.attempt.leaseToken, outcome) : undefined };
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  await pool.query("TRUNCATE jobs CASCADE");
  const store = new JobStore(pool);
  listener = new JobEventListener(pool);
  await listener.start();

  const [harnesses, profiles, basePolicy] = await Promise.all([loadHarnesses(root), loadProfiles(root), loadPolicy(root)]);
  // Host test runs cannot switch users, so this policy acknowledges both gaps explicitly.
  policy = { ...basePolicy, leaseSeconds: 10, acknowledgedGaps: ["egress-not-enforced", "process-isolation-not-enforced"] };
  profile = {
    ...profiles.get("node-ts-agent")!,
    entrypoint: { command: process.execPath, args: ["tests/fakes/fake-runner.mjs"], directory: ".", env: {} },
  };

  upstream = createServer((req, res) => {
    upstreamHeaders.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "fake completion" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  dispatcherApp = buildDispatcher({ store, policy, executorKey, gatewayKey, signingKey });
  await dispatcherApp.listen({ port: 0, host: "127.0.0.1" });
  dispatcherUrl = address(dispatcherApp.server);

  const gatewayDispatcher = new GatewayDispatcherClient(dispatcherUrl, gatewayKey, 0);
  gateway = buildGateway({
    signingKey,
    routes: { routes: new Map([["grok-4.6", { model: "grok-4.6", baseUrl: `${address(upstream)}/openai/v1`, deployment: "grok-4.6", auth: "entra" }]]) },
    upstreamToken: async () => "upstream-entra-token",
    introspect: (jti) => gatewayDispatcher.introspect(jti),
    reportUsage: (report) => gatewayDispatcher.reportUsage(report),
  });
  await gateway.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = address(gateway.server);

  api = buildApi({
    store,
    listener,
    admission: new Admission({ harnesses, profiles, policy }),
    authenticator: new ApiKeyAuthenticator(`alice:${apiKey}`),
    harnesses,
    maxOpenJobsPerPrincipal: 100,
  });
  await api.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = address(api.server);
});

afterAll(async () => {
  await Promise.all([api?.close(), gateway?.close(), dispatcherApp?.close()]);
  upstream?.close();
  await listener?.stop();
  await pool?.end();
});

describe("end-to-end job execution", () => {
  it("refuses executors with unacknowledged security gaps", async () => {
    const strict = buildDispatcher({
      store: new JobStore(pool),
      policy: { ...policy, acknowledgedGaps: ["egress-not-enforced"] },
      executorKey,
      gatewayKey,
      signingKey,
    });
    await strict.listen({ port: 0, host: "127.0.0.1" });
    try {
      const client = new DispatcherClient(address(strict.server), executorKey);
      await expect(client.claim(capabilities())).rejects.toBeInstanceOf(NotEligibleError);
      await expect(new DispatcherClient(address(strict.server), "wrong-key").claim(capabilities())).rejects.toThrow(/401/);
    } finally {
      await strict.close();
    }
  });

  it("runs a job through the gateway without exposing credentials to the runner", async () => {
    const submitted = await submit("hello");
    const { state, outcome } = await execute(new DispatcherClient(dispatcherUrl, executorKey));
    expect(outcome?.kind).toBe("succeeded");
    expect(state).toBe("succeeded");

    const finished = await job(submitted.id);
    const answer = (finished.result as { answer: string }).answer;
    expect(answer).toBe("fake completion|status=200|leaked=");
    expect(upstreamHeaders.at(-1)?.authorization).toBe("Bearer upstream-entra-token");
    expect([...finished.acknowledgedGaps].sort()).toEqual(["egress-not-enforced", "process-isolation-not-enforced"]);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await job(submitted.id)).usage).toEqual({ inputTokens: 11, outputTokens: 3, requests: 1 });

    const stream = await fetch(`${apiUrl}/v1/jobs/${submitted.id}/events`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "text/event-stream" },
    });
    const text = await stream.text();
    expect(text).toContain("event: job.queued");
    expect(text).toContain("event: job.runner_event");
    expect(text.trim().split("\n\n").at(-1)).toContain("event: job.succeeded");

    const resumed = await fetch(`${apiUrl}/v1/jobs/${submitted.id}/events?after=2`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const page = (await resumed.json()) as { events: Array<{ seq: number }> };
    expect(page.events.every((e) => e.seq > 2)).toBe(true);
  });

  it("rejects results that do not match the harness output schema", async () => {
    const submitted = await submit("invalid");
    const { state } = await execute(new DispatcherClient(dispatcherUrl, executorKey));
    expect(state).toBe("failed");
    expect((await job(submitted.id)).error?.code).toBe("invalid_output");
  });

  it("propagates cancellation to a running attempt", async () => {
    const submitted = await submit("hang");
    const running = execute(new DispatcherClient(dispatcherUrl, executorKey));
    for (let i = 0; i < 50 && (await job(submitted.id)).state !== "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cancel = await fetch(`${apiUrl}/v1/jobs/${submitted.id}:cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(((await cancel.json()) as JobView).state).toBe("cancel_requested");
    const { state } = await running;
    expect(state).toBe("cancelled");
  });

  it("rejects unauthenticated callers", async () => {
    const submitted = await submit("hello");
    const response = await fetch(`${apiUrl}/v1/jobs/${submitted.id}`, {
      headers: { authorization: "Bearer not-a-valid-key-000000000000000" },
    });
    expect(response.status).toBe(401);
    await fetch(`${apiUrl}/v1/jobs/${submitted.id}:cancel`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
  });
});
