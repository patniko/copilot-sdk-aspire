import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import sodium from "libsodium-wrappers";
import WebSocket from "ws";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import type { ActionType, MessageKind, ChatState, RootState, SessionState } from "@microsoft/agent-host-protocol";
import { describe, expect, inject, it } from "vitest";
import { HostStore, JobStore, migrate } from "@copilot-agent/job-store";
import { loadHarnesses, loadPolicy, loadProfiles } from "@copilot-agent/service-defaults";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";
import { buildGateway } from "../../src/inference-gateway/src/server.js";

const enabled = process.env.DEMO_HOST_RUNTIME_TESTS === "1";

describe.skipIf(!enabled)("real managed AHP host in Docker", () => {
  it("authenticates, routes through the gateway, and resumes after container replacement", async () => {
    const githubToken = process.env.DEMO_TEST_GITHUB_TOKEN;
    const owner = process.env.DEMO_TEST_GITHUB_OWNER;
    if (!githubToken || !owner) throw new Error("Set DEMO_TEST_GITHUB_TOKEN and DEMO_TEST_GITHUB_OWNER explicitly for this opt-in test.");
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
    await migrate(pool);
    await pool.query("TRUNCATE demo_host, hosted_sessions CASCADE");
    const root = join(import.meta.dirname, "..", "..");
    const customerConfigRoot = join(root, "examples", "customer-config");
    const [harnesses, policy, profiles] = await Promise.all([
      loadHarnesses(customerConfigRoot),
      loadPolicy(customerConfigRoot),
      loadProfiles(root),
    ]);
    const store = new HostStore(pool);
    const key = randomUUID().repeat(2);
    const hostKey = randomUUID().repeat(2);
    const connectionToken = randomUUID().repeat(2);
    const dispatcher = buildDispatcher({
      store: new JobStore(pool), hostStore: store, policy, executorKey: "unused".repeat(8),
      gatewayKey: "unused-gateway".repeat(4), signingKey: key,
      host: { store, key: hostKey, owner, harness: harnesses.get("interactive-demo")![0]!, profiles, policy, signingKey: key },
    });
    await dispatcher.listen({ host: "0.0.0.0", port: 0 });
    let calls = 0;
    const upstream = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        calls++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: `test-${calls}`, object: "chat.completion.chunk", model: "grok-4.6",
          choices: [{ index: 0, delta: { role: "assistant", content: "4" }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: `test-${calls}`, object: "chat.completion.chunk", model: "grok-4.6",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const gateway = buildGateway({
      signingKey: key,
      routes: { routes: new Map([["grok-4.6", {
        model: "grok-4.6", deployment: "grok-4.6",
        baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, auth: "none",
      }]]) },
      upstreamToken: async () => { throw new Error("The test must not use a provider credential."); },
      introspect: (id) => store.introspect(id),
      reportUsage: async (report) => {
        if (!report.requestId) throw new Error("Missing idempotent usage identity.");
        await store.recordUsage(report.jti, report.requestId, report.inputTokens, report.outputTokens);
      },
    });
    await gateway.listen({ host: "0.0.0.0", port: 0 });
    const volume = `copilot-host-test-${randomUUID()}`;
    docker("volume", "create", volume);
    let container: string | undefined;
    let client: AhpClient | undefined;
    async function startContainer(): Promise<string> {
      container = docker("run", "-d", "-p", "127.0.0.1::8080", "-v", `${volume}:/data`,
        ...(process.env.DEMO_HOST_TEST_SOURCE === "1" ? ["-v", `${join(root, "src", "agent-host", "dist")}:/app/src/agent-host/dist:ro`] : []),
        "-e", "DEMO_HOST_TRANSPORT=direct", "-e", `DEMO_HOST_OWNER=${owner}`,
        "-e", `DEMO_HOST_KEY=${hostKey}`, "-e", `DEMO_HOST_CONNECTION_TOKEN=${connectionToken}`,
        "-e", `JOB_DISPATCHER_URL=http://host.docker.internal:${(dispatcher.server.address() as AddressInfo).port}`,
        "-e", `INFERENCE_GATEWAY_URL=http://host.docker.internal:${(gateway.server.address() as AddressInfo).port}`,
        process.env.DEMO_HOST_TEST_IMAGE ?? "copilot-aspire-agent-host:demo");
      const endpoint = `http://${docker("port", container, "8080/tcp").split("\n")[0]}`;
      await expect.poll(async () => {
        const result = await fetch(`${endpoint}/health`).catch(() => undefined);
        if (!result?.ok && docker("inspect", "--format", "{{.State.Running}}", container!) !== "true") {
          throw new Error(`Host stopped before readiness: ${docker("logs", container!)}`);
        }
        return result?.status;
      }, { timeout: 90_000, interval: 500 }).toBe(200);
      return endpoint;
    }
    async function connect(endpoint: string) {
      const socket = new WebSocket(`${endpoint.replace(/^http/, "ws")}/?tkn=${encodeURIComponent(connectionToken)}`, {
        headers: { authorization: `Bearer ${githubToken}` },
      });
      await once(socket, "open");
      // The AHP adapter uses the browser socket subset that ws implements.
      const transport = WebSocketTransport.fromSocket(socket as unknown as Parameters<typeof WebSocketTransport.fromSocket>[0]);
      client = new AhpClient(transport, { requestTimeoutMs: 30_000 });
      client.connect();
      const clientId = randomUUID();
      const initialized = await client.request("initialize", { channel: "ahp-root://", clientId, protocolVersions: ["0.9.0"] });
      const { result } = await client.subscribe("ahp-root://");
      const state = result.snapshot!.state as RootState;
      const resource = state.agents.find((agent) => agent.provider === "copilot")!.protectedResources!.find((entry) => entry.resource_name === "GitHub API")!.resource;
      const keys = state._meta!["copilot.encryptionKeys"] as Array<{ keyId: string; use: string; algorithm: string; publicKey: string }>;
      const encryptionKey = keys.find((entry) => entry.use === "auth-token" && entry.algorithm === "x25519-sealedbox")!;
      const challenge = initialized._meta!["copilot.authChallenge"] as { challenge: string };
      await sodium.ready;
      const sealed = sodium.crypto_box_seal(new TextEncoder().encode(JSON.stringify({
        cty: "text",
        ctx: { purpose: "auth-token", resource, connection: {
          challenge: challenge.challenge, nonce: randomUUID().replaceAll("-", ""), issuedAt: Math.floor(Date.now() / 1000),
        } },
        value: githubToken,
      })), Buffer.from(encryptionKey.publicKey, "base64"));
      await client.request("authenticate", { channel: "ahp-root://", resource,
        token: `copilot-sealed.v1.${encryptionKey.keyId}.${Buffer.from(sealed).toString("base64url")}` });
      return clientId;
    }
    async function send(sessionUri: string) {
      const { result } = await client!.subscribe(sessionUri);
      const chatUri = (result.snapshot!.state as SessionState).defaultChat!;
      await client!.subscribe(chatUri);
      client!.dispatch(chatUri, {
        type: "chat/turnStarted" as ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
        message: { text: "What is 2+2?", origin: { kind: "user" as MessageKind.User }, model: { id: "grok-4.6" } },
      });
      await expect.poll(async () => {
        const { result: current } = await client!.subscribe(chatUri);
        return JSON.stringify(current.snapshot!.state as ChatState);
      }, { timeout: 60_000, interval: 1000 }).toContain('"content":"4"');
    }
    try {
      let endpoint = await startContainer();
      const clientId = await connect(endpoint);
      const sessionUri = `ahp-session:/${randomUUID()}`;
      await client!.request("createSession", {
        channel: sessionUri, provider: "copilot",
        workingDirectories: ["file:///data/execution/workspace"],
        activeClient: { clientId, displayName: "Managed host integration", tools: [] },
      });
      await send(sessionUri);
      expect(calls).toBeGreaterThan(0);
      docker("exec", "-u", "10001", container!, "node", "-e",
        "require('node:fs').writeFileSync('/data/execution/workspace/retained.txt','durable-fixture')");
      await client!.shutdown();
      client = undefined;
      docker("stop", "--time", "25", container!);
      docker("rm", container!);
      container = undefined;
      endpoint = await startContainer();
      await connect(endpoint);
      expect(docker("exec", "-u", "10001", container!, "node", "-e",
        "process.stdout.write(require('node:fs').readFileSync('/data/execution/workspace/retained.txt','utf8'))")).toBe("durable-fixture");
      const previous = calls;
      await send(sessionUri);
      await expect.poll(() => calls).toBeGreaterThan(previous);
      const sessions = await store.list(owner);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.inputTokens).toBeGreaterThan(0);
    } catch (error) {
      if (container) {
        let logs = docker("logs", "--tail", "100", container);
        for (const secret of [githubToken, hostKey, connectionToken, key]) logs = logs.split(secret).join("[redacted]");
        process.stderr.write(`${logs}\n`);
      }
      throw error;
    } finally {
      await client?.shutdown();
      if (container) {
        docker("stop", "--time", "25", container);
        docker("rm", container);
      }
      docker("volume", "rm", volume);
      await gateway.close();
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      await pool.end();
    }
  }, 240_000);
});
