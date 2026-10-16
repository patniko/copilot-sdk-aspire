import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { expect, inject, it } from "vitest";
import { SHARED_WORKER_FEATURES, SharedConnection, SharedSessionView, SharedWorkerLimits } from "@copilot-agent/contracts";
import { JobEventListener, JobStore, migrate, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { buildBroker } from "../../src/connection-broker/src/broker.js";
import { DispatcherDirectory, sessionRoutes, sharedUpstream } from "../../src/connection-broker/src/sessions.js";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";

const enabled = process.env.HYBRID_CLI_TESTS === "1";
const address = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

it.skipIf(!enabled)("answers through the real CLI via the broker, survives an API restart, and retains the conversation across runtime replacement", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const root = await mkdtemp(join(tmpdir(), "shared-cli-test-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const principal = `cli-${randomUUID()}`;
  const apiKey = "synthetic-cli-api-key-".repeat(2);
  const workerKey = "synthetic-cli-worker-key-".repeat(2);
  const brokerKey = "synthetic-connection-broker-key-".repeat(2);
  const marker = `SHARED_CLI_REPLY_${randomUUID().replaceAll("-", "")}`;
  const restartMarker = `API_RESTART_REPLY_${randomUUID().replaceAll("-", "")}`;
  const resumedMarker = `RESUMED_CLI_REPLY_${randomUUID().replaceAll("-", "")}`;
  const question = "Confirm that this shared conversation can answer a question.";
  const duringRestart = "Confirm that this connection still works after the API restarted.";
  const followUp = "Confirm that the previous conversation is available after reconnecting.";
  const requests: unknown[] = [];
  const sessions: string[] = [];
  const secrets = new Set<string>([credential]);
  let cli: QualificationCli | undefined;
  let host: FastifyInstance | undefined;
  let api: FastifyInstance | undefined;
  let broker: FastifyInstance | undefined;
  let dispatcher: FastifyInstance | undefined;
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") { response.writeHead(404).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (data: string) => { body += data; });
    request.once("end", () => {
      const payload = JSON.parse(body) as { stream?: boolean; messages: Array<{ role: string; content?: unknown }> };
      requests.push(payload.messages);
      const last = JSON.stringify(payload.messages.findLast((message) => message.role === "user")?.content ?? "");
      const reply = last.includes(followUp) ? resumedMarker : last.includes(duringRestart) ? restartMarker : marker;
      const base = { id: randomUUID(), model: "gpt-5.4", created: Math.floor(Date.now() / 1000) };
      if (payload.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  try {
    await migrate(pool);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    const store = new SharedStore(pool);
    const harness = sharedHarness("cli-qualification", { instructions: "You are a synthetic shared-host qualification agent. Reply briefly." });
    const registry = await sharedRegistry([harness]);
    const harnesses = new Map(registry.harnesses);
    const profiles = new Map(registry.profiles);
    const jobs = new JobStore(pool);
    dispatcher = buildDispatcher({
      store: jobs, policies: registry.policies, executorKey: "unused-executor-key-".repeat(3), gatewayKey: "unused-gateway-key-".repeat(3),
      signingKey: "unused-signing-key-".repeat(4), broker: { store: new PlacementStore(pool), key: brokerKey },
    });
    await dispatcher.listen({ port: 0, host: "127.0.0.1" });
    const startHost = async (port = 0) => {
      const service = new SharedSessionService({
        root, store, files: new SessionFileStore(pool), principals: { [principal]: githubUserId },
        admission: sharedAdmission(registry, { sessionLimits: { idleSeconds: 300 } }),
        limits: SharedWorkerLimits.parse({}),
        gatewayUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        mintToken: async (lease, turn) => { await store.grant(lease, turn.id); return "synthetic-unused-grant"; },
        report: () => {},
      });
      await service.start();
      host = buildSharedHost(service, workerKey, brokerKey);
      await host.listen({ port, host: "127.0.0.1" });
      return host;
    };
    const sharedPort = (await startHost()).server.address() as AddressInfo;
    ({ app: broker } = buildBroker({
      families: [sessionRoutes(new DispatcherDirectory(address(dispatcher), brokerKey))],
      upstreams: { shared: sharedUpstream(new URL(`http://127.0.0.1:${sharedPort.port}`), brokerKey) },
    }));
    await broker.listen({ port: 0, host: "127.0.0.1" });
    const listener = new JobEventListener(pool);
    const startApi = async (port = 0) => {
      api = buildApi({
        store: jobs, listener, harnesses, admission: new Admission({ harnesses, profiles, policies: registry.policies }), maxOpenJobsPerPrincipal: 10,
        console: false, authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey}`),
        shared: { url: address(host!), key: workerKey, brokerUrl: address(broker!) },
        hosting: {
          harnesses, profiles, policies: registry.policies,
          deployment: { isolatedHosts: [], sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] } },
        },
      });
      await api.listen({ port, host: "127.0.0.1" });
      return address(api);
    };
    const post = async (base: string, path: string, body: object = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Provisioning failed (${response.status}).`);
      return response.json();
    };
    const attach = async (base: string, sessionId: string) => {
      const connection = SharedConnection.parse(await post(base, `/v1/sessions/${sessionId}/connection`));
      secrets.add(connection.token);
      expect(connection.url).toBe(`${address(broker!).replace("http:", "ws:")}/sessions/${sessionId}`);
      cli = new QualificationCli(root, credential);
      await cli.connect(connection);
    };

    let apiUrl = await startApi();
    const session = SharedSessionView.parse(await post(apiUrl, "/v1/sessions", { harness: harness.definition.name, label: "CLI qualification" }));
    sessions.push(session.id);
    await attach(apiUrl, session.id);
    await cli!.send(question);
    await cli!.waitFor(marker);
    expect(requests.some((messages) => JSON.stringify(messages)?.includes(question))).toBe(true);
    expect(await readdir(join(root, "anchors", session.id))).toEqual([]);

    const apiPort = (api!.server.address() as AddressInfo).port;
    await api!.close();
    api = undefined;
    await expect(fetch(`${apiUrl}/health`)).rejects.toThrow();
    await cli!.send(duringRestart);
    await cli!.waitFor(restartMarker);
    apiUrl = await startApi(apiPort);

    await cli!.stop();
    await host!.close();
    await startHost(sharedPort.port);
    const retained = await pool.query<{ content: Buffer }>(
      "SELECT content FROM session_files WHERE namespace_id=$1 AND content IS NOT NULL", [session.id]);
    expect(retained.rows.some((row) => row.content.includes(marker))).toBe(true);
    expect(retained.rows.some((row) => row.content.includes(credential))).toBe(false);
    await attach(apiUrl, session.id);
    await cli!.waitFor(marker);
    await cli!.send(followUp);
    await cli!.waitFor(resumedMarker);
    const resumedRequest = JSON.stringify(requests.at(-1));
    expect(resumedRequest).toContain(question);
    expect(resumedRequest).toContain(marker);
    expect(resumedRequest).toContain(restartMarker);
    expect(resumedRequest).toContain(followUp);
    expect(await readdir(join(root, "anchors", session.id))).toEqual([]);
  } catch (error) {
    let diagnostic = cli?.output ?? "";
    const logs = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".log")).slice(0, 5);
    for (const file of logs) diagnostic += `\n${file}:\n${(await readFile(join(root, file), "utf8")).slice(-3000)}`;
    for (const value of secrets) if (value) diagnostic = diagnostic.split(value).join("[redacted]");
    throw new Error(`CLI qualification failed. Terminal tail:\n${diagnostic.slice(-6000)}`, { cause: error });
  } finally {
    try { await cli?.stop(); }
    finally {
      try { await api?.close(); await broker?.close(); await host?.close(); await dispatcher?.close(); }
      finally {
        try {
          if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
          await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
          await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
        } finally {
          try { await pool.end(); }
          finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
        }
      }
    }
  }
}, 240_000);
