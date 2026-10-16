import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import WebSocket from "ws";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import type { ActionType, MessageKind, ChatState, RootState, SessionState } from "@microsoft/agent-host-protocol";
import { CopilotClient } from "@github/copilot-sdk";
import { describe, expect, inject, it } from "vitest";
import { testGitHubAccount } from "../runtime/account.js";
import { OwnerHostFixture, type OwnerHostSpec } from "./fixtures/owner-host-runtime.js";

const enabled = process.env.DEMO_HOST_RUNTIME_TESTS === "1";

describe.skipIf(!enabled)("real managed per-harness AHP hosts in Docker", () => {
  it("serves two harnesses from their own hosts and environments, routes through the gateway, and resumes after replacement", async () => {
    const { credential: githubToken, login: owner } = await testGitHubAccount();
    const fixture = new OwnerHostFixture(inject("databaseUrl"), owner, githubToken);
    const managementHome = await mkdtemp(join(tmpdir(), "owner-host-management-"));
    const management = new CopilotClient({
      mode: "empty", gitHubToken: githubToken, useLoggedInUser: false,
      baseDirectory: managementHome, workingDirectory: managementHome, logLevel: "error",
    });
    const clients: AhpClient[] = [];
    const demo: OwnerHostSpec = { harness: "interactive-demo", transport: "both" };
    const review: OwnerHostSpec = { harness: "review-agent", transport: "both" };

    async function connect(endpoint: string, harness: string): Promise<{ client: AhpClient; clientId: string }> {
      const ticket = await fixture.store.issueConnection(fixture.key(harness));
      const socket = new WebSocket(`${endpoint.replace(/^http/, "ws")}/?tkn=${encodeURIComponent(ticket.token)}`);
      await once(socket, "open");
      // The AHP adapter uses the browser socket subset that ws implements.
      const transport = WebSocketTransport.fromSocket(socket as unknown as Parameters<typeof WebSocketTransport.fromSocket>[0]);
      const client = new AhpClient(transport, { requestTimeoutMs: 30_000 });
      clients.push(client);
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
      return { client, clientId };
    }
    async function create(client: AhpClient, clientId: string, harness: string): Promise<string> {
      const sessionUri = `ahp-session:/${randomUUID()}`;
      await client.request("createSession", {
        channel: sessionUri, provider: "copilot", workingDirectories: ["file:///data/execution/workspace"],
        activeClient: { clientId, displayName: `Owner host integration (${harness})`, tools: [] },
      });
      return sessionUri;
    }
    async function send(client: AhpClient, sessionUri: string, marker: string) {
      fixture.reply = () => marker;
      const { result } = await client.subscribe(sessionUri);
      const chatUri = (result.snapshot!.state as SessionState).defaultChat!;
      await client.subscribe(chatUri);
      client.dispatch(chatUri, {
        type: "chat/turnStarted" as ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
        message: { text: `Reply with ${marker}.`, origin: { kind: "user" as MessageKind.User }, model: { id: "grok-4.6" } },
      });
      await expect.poll(async () => {
        const { result: chat } = await client.subscribe(chatUri);
        return JSON.stringify(chat.snapshot!.state as ChatState);
      }, { timeout: 90_000, interval: 1000 }).toContain(`"content":"${marker}"`);
    }

    try {
      await fixture.start([demo, review]);
      let demoHost = await fixture.startHost(demo);
      const reviewHost = await fixture.startHost(review);
      expect(demoHost.info).toMatchObject({ harness: "interactive-demo", transport: "both", execution: "managed", ready: true });
      expect(reviewHost.info).toMatchObject({ harness: "review-agent", transport: "both", execution: "managed", ready: true });
      const firstEnvironment = demoHost.info.environmentId!;
      expect(firstEnvironment).toBeTruthy();
      expect(reviewHost.info.environmentId).toBeTruthy();
      expect(reviewHost.info.environmentId).not.toBe(firstEnvironment);
      if (process.env.OWNER_HOST_EXPECT_RUNTIME) expect(demoHost.info.runtimeRevision).toBe(process.env.OWNER_HOST_EXPECT_RUNTIME);
      await management.start();
      for (const [environmentId, harness] of [[firstEnvironment, "interactive-demo"], [reviewHost.info.environmentId!, "review-agent"]] as const) {
        const { environment } = await management.rpc.environments.get({ environmentId });
        expect(environment.id).toBe(environmentId);
        expect(JSON.stringify(environment)).toContain(`Aspire ${harness} (${owner})`);
      }
      const identities = await fixture.pool.query<{ harness: string; compute_id: string }>("SELECT harness, compute_id FROM owner_hosts ORDER BY harness");
      expect(identities.rows.map((row) => row.harness)).toEqual(["interactive-demo", "review-agent"]);
      expect(identities.rows[0]!.compute_id).not.toBe(identities.rows[1]!.compute_id);
      expect(await fixture.store.status(fixture.key("interactive-demo"))).toMatchObject({ online: true, environmentId: firstEnvironment });

      // A ticket is bound to its harness host: the other host's proxy refuses it, and its own host accepts it.
      const reviewTicket = await fixture.store.issueConnection(fixture.key("review-agent"));
      const refused = new WebSocket(`${demoHost.endpoint.replace(/^http/, "ws")}/?tkn=${encodeURIComponent(reviewTicket.token)}`);
      refused.on("error", () => undefined);
      const [, response] = await once(refused, "unexpected-response") as [unknown, { statusCode: number }];
      expect(response.statusCode).toBe(401);

      const demoClient = await connect(demoHost.endpoint, "interactive-demo");
      const demoSession = await create(demoClient.client, demoClient.clientId, "interactive-demo");
      await send(demoClient.client, demoSession, "DEMO_HOST_ONE");
      const reviewClient = await connect(reviewHost.endpoint, "review-agent");
      const reviewSession = await create(reviewClient.client, reviewClient.clientId, "review-agent");
      await send(reviewClient.client, reviewSession, "REVIEW_HOST_ONE");
      const demoSessions = await fixture.store.list(fixture.key("interactive-demo"));
      const reviewSessions = await fixture.store.list(fixture.key("review-agent"));
      expect(demoSessions.map((session) => session.harness.definition.name)).toEqual(["interactive-demo"]);
      expect(reviewSessions.map((session) => session.harness.definition.name)).toEqual(["review-agent"]);
      expect(demoSessions[0]!.id).not.toBe(reviewSessions[0]!.id);
      // Each host attributes the client's AHP session URI to the session it created, so clients can resume by it.
      for (const [harness, uri] of [["interactive-demo", demoSession], ["review-agent", reviewSession]] as const) {
        await expect.poll(async () => (await fixture.store.list(fixture.key(harness)))[0]?.ahpSessionId, { timeout: 20_000 })
          .toBe(uri.replace("ahp-session:/", ""));
      }

      fixture.docker("exec", "-u", "10001", demoHost.container, "node", "-e",
        "require('node:fs').writeFileSync('/data/execution/workspace/retained.txt','durable-fixture')");
      await demoClient.client.shutdown();
      fixture.stopHost(demoHost.container);
      demoHost = await fixture.startHost(demo);
      expect(demoHost.info.environmentId).toBe(firstEnvironment);
      expect(fixture.docker("exec", "-u", "10001", demoHost.container, "node", "-e",
        "process.stdout.write(require('node:fs').readFileSync('/data/execution/workspace/retained.txt','utf8'))")).toBe("durable-fixture");
      const resumed = await connect(demoHost.endpoint, "interactive-demo");
      const previous = fixture.requests.length;
      await send(resumed.client, demoSession, "DEMO_HOST_TWO");
      expect(fixture.requests.length).toBeGreaterThan(previous);
      expect(JSON.stringify(fixture.requests.at(-1))).toContain("Reply with DEMO_HOST_ONE.");
      const retained = await fixture.store.list(fixture.key("interactive-demo"));
      expect(retained).toHaveLength(1);
      expect(retained[0]!.inputTokens).toBeGreaterThan(0);
    } catch (error) {
      for (const container of fixture.containers) process.stderr.write(`--- ${container.slice(0, 12)}\n${fixture.logs(container)}\n`);
      throw error;
    } finally {
      for (const client of clients) await client.shutdown().catch(() => undefined);
      try {
        await fixture.close();
      } finally {
        if (fixture.environments.size) {
          await management.start();
          for (const environmentId of fixture.environments) await management.rpc.environments.delete({ environmentId });
        }
        await management.stop();
        await rm(managementHome, { recursive: true, force: true });
      }
    }
  }, 900_000);
});
