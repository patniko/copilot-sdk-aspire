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
import { inputHarness } from "./fixtures/input-harness.js";

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

async function submitInput(ask: unknown): Promise<JobView> {
  const response = await fetch(`${apiUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ harness: { name: "input-fixture" }, input: { ask } }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as JobView;
}

async function waitForPendingInput(jobId: string, seen = new Set<string>()) {
  for (let i = 0; i < 80; i++) {
    const response = await fetch(`${apiUrl}/v1/input-requests?state=pending`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { requests: Array<{ id: string; jobId: string; request: unknown }> };
    const request = page.requests.find((r) => r.jobId === jobId && !seen.has(r.id));
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("input request was not created");
}

async function respondInput(jobId: string, requestId: string, responseBody: unknown) {
  const response = await fetch(`${apiUrl}/v1/jobs/${jobId}/input-requests/${requestId}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(responseBody),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function execute(client: DispatcherClient, shutdown = new AbortController(), draining?: AbortSignal) {
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
    draining,
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
  harnesses.set("input-fixture", [inputHarness(5)]);
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

  it("answers question and permission input requests through the public API", async () => {
    const submitted = await submitInput([
      { kind: "question", question: "Choose a color", choices: ["blue", "green"], allowFreeform: false },
      { kind: "permission", permission: { type: "shell", command: "git status", intention: "Inspect repository status" } },
    ]);
    const running = execute(new DispatcherClient(dispatcherUrl, executorKey));

    const seen = new Set<string>();
    const question = await waitForPendingInput(submitted.id, seen);
    seen.add(question.id);
    expect(question.request).toMatchObject({ kind: "question" });
    await respondInput(submitted.id, question.id, { kind: "question", answer: "blue" });

    const permission = await waitForPendingInput(submitted.id, seen);
    expect(permission.request).toMatchObject({ kind: "permission" });
    await respondInput(submitted.id, permission.id, {
      kind: "permission",
      approved: true,
      scope: "once",
      feedback: "ok",
    });

    const { state, outcome } = await running;
    expect(outcome?.kind).toBe("succeeded");
    expect(state).toBe("succeeded");
    const finished = await job(submitted.id);
    expect(finished.pendingInputs).toBe(0);
    expect(finished.result).toMatchObject({
      responses: [
        { kind: "question", answer: "blue", wasFreeform: false },
        { kind: "permission", approved: true, scope: "once", feedback: "ok" },
      ],
    });

    const all = (await (
      await fetch(`${apiUrl}/v1/jobs/${submitted.id}/input-requests`, { headers: { authorization: `Bearer ${apiKey}` } })
    ).json()) as { requests: Array<{ id: string; state: string }> };
    expect(all.requests.map((r) => r.state)).toEqual(["answered", "answered"]);
    expect(all.requests[0]!.id).toBe(question.id);
  });

  it("expires unanswered input requests and returns expired to the runner", async () => {
    const submitted = await submitInput({
      kind: "question",
      question: "Nobody will answer",
      choices: ["ok"],
      allowFreeform: false,
    });
    const running = execute(new DispatcherClient(dispatcherUrl, executorKey));
    const request = await waitForPendingInput(submitted.id);
    expect(request.request).toMatchObject({ kind: "question" });

    const { state, outcome } = await running;
    expect(outcome?.kind).toBe("succeeded");
    expect(state).toBe("succeeded");
    expect((await job(submitted.id)).result).toMatchObject({ response: { kind: "expired" } });
    const all = (await (
      await fetch(`${apiUrl}/v1/jobs/${submitted.id}/input-requests`, { headers: { authorization: `Bearer ${apiKey}` } })
    ).json()) as { requests: Array<{ state: string }> };
    expect(all.requests[0]?.state).toBe("expired");
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

describe("job console and listing", () => {
  it("serves the console with a restrictive content security policy", async () => {
    const page = await fetch(`${apiUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("/console/app.js");
    const script = await fetch(`${apiUrl}/console/app.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  it("lists only the caller's jobs, newest first, without results", async () => {
    const response = await fetch(`${apiUrl}/v1/jobs?limit=2`, { headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { jobs: JobView[]; next?: string };
    expect(page.jobs.length).toBe(2);
    expect(page.jobs.every((j) => j.result === undefined)).toBe(true);
    expect(new Date(page.jobs[0]!.createdAt) >= new Date(page.jobs[1]!.createdAt)).toBe(true);
    expect(page.next).toBe(page.jobs[1]!.createdAt);
    const older = (await (
      await fetch(`${apiUrl}/v1/jobs?limit=100&before=${encodeURIComponent(page.next!)}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      })
    ).json()) as { jobs: JobView[] };
    expect(older.jobs.every((j) => new Date(j.createdAt) < new Date(page.next!))).toBe(true);
    const unauthenticated = await fetch(`${apiUrl}/v1/jobs`);
    expect(unauthenticated.status).toBe(401);
  });
});

describe("runner exits without a result", () => {
  it("reports a runner fault, and retries read-only work", async () => {
    const submitted = await submit("crash");
    const { outcome, state } = await execute(new DispatcherClient(dispatcherUrl, executorKey));
    expect(outcome).toMatchObject({ kind: "failed", code: "runner_exited", uncertainEffects: true });
    expect(state).toBe("retry_wait");
    await fetch(`${apiUrl}/v1/jobs/${submitted.id}:cancel`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
  });

  it("reports executor loss when the executor is draining", async () => {
    const submitted = await submit("crash");
    const draining = new AbortController();
    draining.abort();
    const { outcome } = await execute(new DispatcherClient(dispatcherUrl, executorKey), new AbortController(), draining.signal);
    expect(outcome).toMatchObject({ kind: "failed", code: "executor_lost", retryable: true, uncertainEffects: true });
    await fetch(`${apiUrl}/v1/jobs/${submitted.id}:cancel`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
  });
});
