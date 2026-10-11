import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureFilesystem } from "./filesystem.js";

describe("shared runtime primitives (real runtime, synthetic inference, no CLI identity qualification)", () => {
  let root: string;
  let client: CopilotClient;
  let providerUrl: string;
  const requests: string[] = [];
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.once("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const id = randomUUID();
      response.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", model: "qualification-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "QUALIFICATION_REPLY" }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", model: "qualification-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });

  const sessionConfig = (): SessionConfig => ({
    model: "qualification-model",
    streaming: true,
    provider: { type: "openai", baseUrl: providerUrl, wireApi: "completions", apiKey: "synthetic-local-provider" },
    availableTools: [],
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    onPermissionRequest: async () => ({ kind: "reject", feedback: "The qualification fixture does not execute tools." }),
    createSessionFsProvider: (session) => fixtureFilesystem(join(root, "providers", session.sessionId)),
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "copilot-shared-runtime-test-"));
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    providerUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    client = new CopilotClient({
      connection: RuntimeConnection.forInProcess(),
      mode: "empty",
      baseDirectory: join(root, "runtime"),
      useLoggedInUser: false,
      logLevel: "error",
      sessionFs: { initialCwd: "/workspace", sessionStatePath: "/session-state", conventions: "posix" },
    });
    await client.start();
  });

  afterAll(async () => {
    try {
      if (client) expect(await client.stop()).toEqual([]);
    } finally {
      try {
        if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("keeps independent session namespaces while sharing one in-process client", async () => {
    const sessions: CopilotSession[] = [];
    try {
      for (let index = 0; index < 2; index++) sessions.push(await client.createSession(sessionConfig()));
      const [first, second] = sessions;
      const markers = [randomUUID(), randomUUID()];
      const before = requests.length;
      const replies = await Promise.all(sessions.map((session, index) => session.sendAndWait({
        prompt: `This session's synthetic marker is ${markers[index]}. Reply briefly.`,
      }, 30_000)));
      for (const reply of replies) expect(reply?.data.content).toBe("QUALIFICATION_REPLY");
      const calls = requests.slice(before);
      expect(calls.some((body) => body.includes(markers[0]))).toBe(true);
      expect(calls.some((body) => body.includes(markers[1]))).toBe(true);
      expect(calls.some((body) => body.includes(markers[0]) && body.includes(markers[1]))).toBe(false);
      await Promise.all(sessions.map((session) => session.disconnect()));
      for (const [index, session] of sessions.entries()) {
        const events = await readFile(join(root, "providers", session.sessionId, "session-state", "events.jsonl"), "utf8");
        expect(events).toContain(markers[index]);
        expect(events).not.toContain(markers[1 - index]);
      }
      const resumed = await client.resumeSession(first.sessionId, { ...sessionConfig(), continuePendingWork: false });
      sessions.push(resumed);
      const events = await resumed.getEvents();
      expect(JSON.stringify(events)).toContain(markers[0]);
      expect(JSON.stringify(events)).not.toContain(markers[1]);
      expect(second.sessionId).not.toBe(resumed.sessionId);
    } finally {
      await Promise.all(sessions.map((session) => session.disconnect()));
    }
  });

  it("publishes a local-filesystem session as a control for the virtual-workspace gate", async () => {
    const control = new CopilotClient({
      connection: RuntimeConnection.forInProcess(),
      mode: "empty",
      baseDirectory: join(root, "local-control"),
      useLoggedInUser: false,
      logLevel: "error",
    });
    try {
      await control.start();
      const session = await control.createSession({ ...sessionConfig(), createSessionFsProvider: undefined });
      try {
        const host = await control.startAhpHost({ computeId: randomUUID(), localServer: { hostname: "127.0.0.1", port: 0 } });
        try {
          const publication = await host.publishSession(session.sessionId);
          expect((await host.listSessions()).sessions.map((entry) => entry.resource)).toEqual([publication.sessionUri]);
        } finally {
          await host.dispose();
        }
      } finally {
        await session.disconnect();
      }
    } finally {
      expect(await control.stop()).toEqual([]);
    }
  });

  it("starts separate compute-scoped AHP listeners on one shared runtime", async () => {
    const hosts: Awaited<ReturnType<CopilotClient["startAhpHost"]>>[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        hosts.push(await client.startAhpHost({
          computeId: randomUUID(),
          localServer: { hostname: "127.0.0.1", port: 0 },
        }));
      }
      expect(hosts[0].url).toMatch(/^ws:/);
      expect(hosts[1].url).toMatch(/^ws:/);
      expect(hosts[0].url).not.toBe(hosts[1].url);
      expect((await hosts[0].listSessions()).sessions).toEqual([]);
      expect((await hosts[1].listSessions()).sessions).toEqual([]);
    } finally {
      await Promise.all(hosts.reverse().map((host) => host.dispose()));
    }
  });

  it("requires virtual-workspace publication into separate AHP catalogs before enabling shared CLI hosting", async () => {
    const sessions: CopilotSession[] = [];
    const hosts: Awaited<ReturnType<CopilotClient["startAhpHost"]>>[] = [];
    const publications: string[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const session = await client.createSession(sessionConfig());
        sessions.push(session);
        const host = await client.startAhpHost({
          computeId: randomUUID(),
          localServer: { hostname: "127.0.0.1", port: 0 },
          createSession: async () => { throw new Error("Create sessions through the application qualification fixture."); },
          resumeSession: async () => { throw new Error("Resume sessions through the application qualification fixture."); },
        });
        hosts.push(host);
        publications.push((await host.publishSession(session.sessionId)).sessionUri);
      }
      expect(hosts[0].url).not.toBe(hosts[1].url);
      for (const [index, host] of hosts.entries()) {
        expect((await host.listSessions()).sessions.map((entry) => entry.resource)).toEqual([publications[index]]);
      }
    } finally {
      try {
        await Promise.all(hosts.reverse().map((host) => host.dispose()));
      } finally {
        await Promise.all(sessions.map((session) => session.disconnect()));
      }
    }
  });
});
