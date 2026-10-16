import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { expect, inject, it } from "vitest";
import WebSocket from "ws";
import { SharedConnection, SharedSessionDefinition, SharedSessionLimits, SharedSessionView, SharedWorkerLimits } from "@copilot-agent/contracts";
import { JobEventListener, JobStore, migrate, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, loadHarnesses, loadPolicySet, loadProfiles, signSessionCapability } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { SharedSessionService } from "../../src/session-host/src/service.js";
import { buildSharedHost } from "../../src/session-host/src/server.js";
import { buildBroker } from "../../src/connection-broker/src/broker.js";
import { DispatcherDirectory, sessionRoutes, sharedUpstream } from "../../src/connection-broker/src/sessions.js";
import { buildGateway } from "../../src/inference-gateway/src/server.js";
import { parseRoutes } from "../../src/inference-gateway/src/routes.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";

const enabled = process.env.HYBRID_SESSION_RUNTIME_TESTS === "1";
const address = (server: FastifyInstance["server"]) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Opens a brokered AHP connection and reads the authentication key the runtime advertises through it. */
async function brokeredServerKey(connection: SharedConnection): Promise<{ keyId: string; publicKey: string } | number> {
  const socket = new WebSocket(`${connection.url}?tkn=${encodeURIComponent(connection.token)}`);
  try {
    const opened = await new Promise<number | undefined>((resolve, reject) => {
      socket.once("open", () => resolve(undefined));
      socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      socket.once("error", reject);
    });
    if (opened !== undefined) return opened;
    const call = (id: number, method: string, params: object) => new Promise<unknown>((resolve, reject) => {
      const listener = (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: unknown };
        if (message.id !== id) return;
        socket.off("message", listener);
        if (message.error) reject(new Error("The brokered runtime rejected the request."));
        else resolve(message.result);
      };
      socket.on("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    await call(1, "initialize", { channel: "ahp-root://", clientId: `broker-probe-${randomUUID()}`, protocolVersions: ["0.9.0"] });
    const root = await call(2, "subscribe", { channel: "ahp-root://" }) as {
      snapshot: { state: { _meta: { "copilot.encryptionKeys": Array<{ keyId: string; publicKey: string; use: string }> } } };
    };
    return root.snapshot.state._meta["copilot.encryptionKeys"].find((key) => key.use === "auth-token")!;
  } finally {
    socket.terminate();
  }
}

it.skipIf(!enabled)("provisions protected shared sessions, accounts usage, deduplicates continuations, and evicts idle residents", async () => {
  await localRuntimeArtifacts();
  const root = await mkdtemp(join(tmpdir(), "shared-service-test-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const sessions: string[] = [];
  const principal = randomUUID();
  const other = randomUUID();
  const apiKey = "synthetic-shared-api-key-".repeat(2);
  const otherKey = "synthetic-other-api-key-".repeat(2);
  const controlKey = "synthetic-control-key-".repeat(2);
  const brokerKey = "synthetic-connection-broker-key-".repeat(2);
  const signingKey = "synthetic-signing-key-".repeat(3);
  const grants: string[] = [];
  let calls = 0;
  let service: SharedSessionService | undefined;
  let api: FastifyInstance | undefined;
  let host: FastifyInstance | undefined;
  let gateway: FastifyInstance | undefined;
  let dispatcher: FastifyInstance | undefined;
  let broker: FastifyInstance | undefined;
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") return response.writeHead(404).end();
    request.resume();
    request.once("end", () => {
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta: { role: "assistant", content: "SHARED_SERVICE_REPLY" }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]) response.write(`data: ${JSON.stringify({
        id: randomUUID(), object: "chat.completion.chunk", model: "fixture", choices: [choice],
        ...(choice.finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 3 } } : {}),
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  const wait = async (predicate: () => Promise<boolean>, description: string) => {
    const deadline = Date.now() + 20_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out ${description}.`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await migrate(pool);
    const store = new SharedStore(pool);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    gateway = buildGateway({
      signingKey,
      routes: parseRoutes(JSON.stringify([{ model: "fixture", deployment: "fixture", baseUrl: address(upstream), auth: "none" }]), true),
      upstreamToken: async () => { throw new Error("The fixture must not request provider credentials."); },
      introspect: (jti) => store.introspect(jti),
      beginRequest: async (jti, requestId) => { await store.beginInference(jti, requestId); },
      reportUsage: async (report) => {
        if (!report.requestId) throw new Error("Usage must have a stable request identity.");
        expect(await store.recordUsage(report.jti, report.requestId, report.inputTokens, report.outputTokens, report.usageKnown ?? false)).toBe(true);
      },
    });
    await gateway.listen({ port: 0, host: "127.0.0.1" });
    service = new SharedSessionService({
      root, store, files: new SessionFileStore(pool), principals: { [principal]: 1, [other]: 2 },
      definition: SharedSessionDefinition.parse({
        model: "fixture", instructions: "Reply briefly to the synthetic application message.", allowedHarnesses: [],
        limits: SharedSessionLimits.parse({ idleSeconds: 2, tokenBudget: 1000, turnTokenBudget: 400, maxContinuations: 2 }),
      }),
      limits: SharedWorkerLimits.parse({ residentSessions: 1, activeTurns: 1 }),
      gatewayUrl: `${address(gateway.server)}/openai/v1`,
      mintToken: async (lease, turn) => {
        const grant = await store.grant(lease, turn.id);
        const token = await signSessionCapability(signingKey, {
          sub: lease.id, session: lease.id, epoch: lease.epoch, jti: turn.id, prn: lease.principal,
          mdl: [grant.model], tok: grant.tokenBudget, expiresAt: grant.expiresAt,
        });
        grants.push(token);
        return token;
      },
      report: () => {},
    });
    await service.start();
    host = buildSharedHost(service, controlKey, brokerKey);
    await host.listen({ port: 0, host: "127.0.0.1" });
    const repo = join(import.meta.dirname, "..", "..");
    const [harnesses, profiles, policies] = await Promise.all([
      loadHarnesses(join(repo, "examples", "customer-config")), loadProfiles(repo), loadPolicySet(join(repo, "examples", "customer-config")),
    ]);
    dispatcher = buildDispatcher({
      store: new JobStore(pool), policies, executorKey: "unused-executor-key-".repeat(3), gatewayKey: "unused-gateway-key-".repeat(3),
      signingKey, broker: { store: new PlacementStore(pool), key: brokerKey },
    });
    await dispatcher.listen({ port: 0, host: "127.0.0.1" });
    ({ app: broker } = buildBroker({
      families: [sessionRoutes(new DispatcherDirectory(address(dispatcher.server), brokerKey))],
      upstreams: { shared: sharedUpstream(new URL(address(host.server)), brokerKey) },
    }));
    await broker.listen({ port: 0, host: "127.0.0.1" });
    api = buildApi({
      store: new JobStore(pool), listener: new JobEventListener(pool), harnesses,
      admission: new Admission({ harnesses, profiles, policies }), maxOpenJobsPerPrincipal: 10, console: false,
      authenticator: new ApiKeyAuthenticator(`${principal}:${apiKey};${other}:${otherKey}`),
      shared: { url: address(host.server), key: controlKey, brokerUrl: address(broker.server) },
    });
    const headers = { authorization: `Bearer ${apiKey}` };
    expect((await api.inject({ method: "GET", url: "/v1/sessions" })).statusCode).toBe(401);
    expect((await host.inject({ method: "POST", url: "/internal/shared", payload: { operation: "list", principal } })).statusCode).toBe(401);
    const created = await api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { label: "Fixture" } });
    expect(created.statusCode).toBe(201);
    const session = SharedSessionView.parse(created.json());
    sessions.push(session.id);
    expect(service.residentCount).toBe(0);
    expect(calls).toBe(0);
    expect((await api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers: { authorization: `Bearer ${otherKey}` } })).statusCode).toBe(404);
    const connected = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers });
    expect(connected.statusCode).toBe(200);
    expect(connected.headers["cache-control"]).toBe("no-store");
    const connection = SharedConnection.parse(connected.json());
    expect(connection.url).toBe(`${address(broker.server).replace("http:", "ws:")}/sessions/${session.id}`);
    expect(await brokeredServerKey({ ...connection, url: `${address(host.server).replace("http:", "ws:")}/sessions/${session.id}` })).toBe(401);
    expect(await brokeredServerKey(connection)).toMatchObject({ keyId: connection.serverKey.keyId, publicKey: connection.serverKey.publicKey });
    expect(await brokeredServerKey(connection)).toBe(401);
    const notification = randomUUID();
    expect(await service.continueConversation(principal, session.id, notification, "Synthetic completion; summarize briefly.")).toBe("delivered");
    await wait(async () => (await store.get(principal, session.id))?.view.budget.usedTokens === 13 && !service!.busy(session.id), "waiting for durable inference settlement");
    expect(await service.continueConversation(principal, session.id, notification, "Do not replay.")).toBe("already-delivered");
    expect(calls).toBe(1);
    await wait(async () => service!.residentCount === 0, "waiting for idle eviction");
    expect((await store.get(principal, session.id))?.view.closed).toBe(false);
    const reconnected = await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers });
    expect(reconnected.statusCode).toBe(200);
    expect(await service.continueConversation(principal, session.id, notification, "Do not replay after eviction.")).toBe("already-delivered");
    const retained = await pool.query<{ content: Buffer }>("SELECT content FROM session_files WHERE namespace_id=$1 AND content IS NOT NULL", [session.id]);
    expect(grants.some((token) => retained.rows.some((row) => row.content.includes(token)))).toBe(false);
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/close`, headers, payload: {} })).statusCode).toBe(200);
    expect((await api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers })).statusCode).toBe(404);
    expect(service.residentCount).toBe(0);
  } finally {
    try { await api?.close(); await broker?.close(); await host?.close(); if (!host) await service?.stop(); await dispatcher?.close(); await gateway?.close(); }
    finally {
      try {
        if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
      } finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
    }
  }
}, 90_000);
