import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { expect, it } from "vitest";
import { localRuntimeArtifacts } from "./artifacts.js";

it("binds each host catalog and workspace independently in one runtime", async () => {
  await localRuntimeArtifacts();
  const root = await mkdtemp(join(tmpdir(), "copilot-host-scope-test-"));
  const client = new CopilotClient({
    connection: RuntimeConnection.forInProcess(),
    mode: "empty",
    baseDirectory: join(root, "runtime"),
    useLoggedInUser: false,
    logLevel: "error",
  });
  const hosts: Awaited<ReturnType<CopilotClient["startAhpHost"]>>[] = [];
  const sessions: Awaited<ReturnType<CopilotClient["createSession"]>>[] = [];
  const computeIds = [randomUUID(), randomUUID()];
  try {
    await client.start();
    for (let index = 0; index < 2; index++) {
      const workspace = join(root, `owner-${index}`);
      await mkdir(workspace);
      const session = await client.createSession({
        workingDirectory: workspace,
        model: "qualification-model",
        provider: { type: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-unused", wireApi: "completions" },
        availableTools: [],
        onPermissionRequest: async () => ({ kind: "reject" }),
      });
      sessions.push(session);
      hosts.push(await client.startAhpHost({
        computeId: computeIds[index],
        workingDirectory: workspace,
        expectedOwner: { githubApiUrl: "https://api.github.com", userId: index + 1 },
        localServer: { hostname: "127.0.0.1", port: 0 },
      }));
      const publication = await hosts[index].publishSession(session.sessionId);
      expect((await hosts[index].listSessions()).sessions.map((entry) => entry.resource)).toEqual([publication.sessionUri]);
    }
    await expect(hosts[0].publishSession(sessions[1].sessionId)).rejects.toThrow(/publication/i);
    await expect(hosts[1].publishSession(sessions[0].sessionId)).rejects.toThrow(/publication/i);
    for (const [index, host] of hosts.entries()) {
      expect((await host.listSessions()).sessions.map((entry) => entry.resource)).toEqual([`ahp-session:/${sessions[index].sessionId}`]);
    }
    await hosts[0].dispose();
    const reopen = { computeId: computeIds[0], workingDirectory: join(root, "owner-0"), localServer: { hostname: "127.0.0.1", port: 0 } };
    await expect(client.startAhpHost(reopen)).rejects.toThrow(/requires its expected-owner/);
    await expect(client.startAhpHost({ ...reopen, expectedOwner: { githubApiUrl: "https://api.github.com", userId: 2 } }))
      .rejects.toThrow(/different expected owner/);
    const replacement = await client.startAhpHost({ ...reopen, expectedOwner: { githubApiUrl: "https://api.github.com", userId: 1 } });
    hosts.push(replacement);
    expect((await replacement.listSessions()).sessions).toHaveLength(1);
  } finally {
    try {
      await Promise.all(hosts.map((host) => host.dispose()));
    } finally {
      try {
        await Promise.all(sessions.map((session) => session.disconnect()));
      } finally {
        try {
          expect(await client.stop()).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
});
