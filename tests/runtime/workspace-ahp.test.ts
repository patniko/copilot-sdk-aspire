import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import type { ContentEncoding, RootState } from "@microsoft/agent-host-protocol";
import { CopilotClient, RuntimeConnection, type AhpHost } from "@github/copilot-sdk";
import sodium from "libsodium-wrappers";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { SessionWorkspace } from "../../src/session-host/src/workspace.js";
import { fixtureFilesystem } from "./filesystem.js";
import { localRuntimeArtifacts } from "./artifacts.js";

const enabled = process.env.HYBRID_RESOURCE_AUTH_TESTS === "1";

it.skipIf(!enabled)("routes authenticated AHP resources through the local SDK provider without touching anchors", async () => {
  await localRuntimeArtifacts();
  const credential = process.env.HYBRID_USE_GH_ACCOUNT === "1"
    ? execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    : process.env.DEMO_TEST_GITHUB_TOKEN;
  if (!credential) throw new Error("Provide DEMO_TEST_GITHUB_TOKEN or explicitly opt in to HYBRID_USE_GH_ACCOUNT=1.");
  const identityResponse = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!identityResponse.ok) throw new Error(`GitHub identity validation failed (${identityResponse.status}).`);
  const identity: unknown = await identityResponse.json();
  if (!identity || typeof identity !== "object" || !("id" in identity) || typeof identity.id !== "number" || !Number.isSafeInteger(identity.id)) {
    throw new Error("GitHub returned an invalid account identity.");
  }
  const root = await mkdtemp(join(tmpdir(), "copilot-workspace-ahp-"));
  const anchor = join(root, "anchor");
  const storage = fixtureFilesystem(join(root, "provider"), process.platform === "win32" ? "windows" : "posix");
  const lifetime = new AbortController();
  const failures: string[] = [];
  const workspace = new SessionWorkspace(anchor, storage, lifetime.signal, (operation) => failures.push(operation));
  const runtime = new CopilotClient({
    connection: RuntimeConnection.forInProcess(), mode: "empty", baseDirectory: join(root, "runtime"),
    useLoggedInUser: false, logLevel: "error",
    sessionFs: { initialCwd: anchor, sessionStatePath: join(root, "state"), conventions: process.platform === "win32" ? "windows" : "posix", capabilities: { binary: true } },
  });
  let host: AhpHost | undefined;
  let ahp: AhpClient | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(anchor);
    await storage.mkdir(anchor, true);
    await writeFile(join(anchor, "sentinel.txt"), "host-sentinel");
    await storage.writeFile(join(anchor, "sentinel.txt"), "provider-sentinel");
    await runtime.start();
    host = await runtime.startAhpHost({
      computeId: randomUUID(), expectedOwner: { githubApiUrl: "https://api.github.com", userId: identity.id },
      workingDirectory: anchor, localServer: { hostname: "127.0.0.1", port: 0 },
      onWorkspaceResource: workspace.onResource,
      createSession: async () => { throw new Error("Resource-only qualification does not create conversations."); },
      resumeSession: async () => { throw new Error("Resource-only qualification does not resume conversations."); },
    });
    const endpoint = new URL(host.url!);
    endpoint.searchParams.set("tkn", host.token!);
    socket = new WebSocket(endpoint, { handshakeTimeout: 10_000 });
    await once(socket, "open");
    const transport = WebSocketTransport.fromSocket(socket as unknown as Parameters<typeof WebSocketTransport.fromSocket>[0]);
    ahp = new AhpClient(transport, { requestTimeoutMs: 20_000 });
    ahp.connect();
    const initialized = await ahp.request("initialize", { channel: "ahp-root://", clientId: randomUUID(), protocolVersions: ["0.9.0"] });
    const { result } = await ahp.subscribe("ahp-root://");
    const state = result.snapshot!.state as RootState;
    const resource = state.agents.find((agent) => agent.provider === "copilot")!.protectedResources!.find((entry) => entry.resource_name === "GitHub API")!.resource;
    const keys = state._meta!["copilot.encryptionKeys"] as Array<{ keyId: string; use: string; algorithm: string; publicKey: string }>;
    const key = keys.find((entry) => entry.use === "auth-token" && entry.algorithm === "x25519-sealedbox");
    if (!key) throw new Error("The task-owned listener did not advertise a supported authentication key.");
    const challenge = initialized._meta!["copilot.authChallenge"] as { challenge: string };
    const file = pathToFileURL(join(anchor, "sentinel.txt")).href;
    await expect(ahp.request("resourceRead", { channel: "ahp-root://", uri: file })).rejects.toThrow();
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(new TextEncoder().encode(JSON.stringify({
      cty: "text", ctx: { purpose: "auth-token", resource, connection: {
        challenge: challenge.challenge, nonce: randomUUID().replaceAll("-", ""), issuedAt: Math.floor(Date.now() / 1000),
      } }, value: credential,
    })), Buffer.from(key.publicKey, "base64"));
    await ahp.request("authenticate", { channel: "ahp-root://", resource, token: `copilot-sealed.v1.${key.keyId}.${Buffer.from(sealed).toString("base64url")}` });
    expect(await ahp.request("resourceRead", { channel: "ahp-root://", uri: file })).toMatchObject({ data: "provider-sentinel", encoding: "utf-8" });
    await ahp.request("resourceWrite", { channel: "ahp-root://", uri: file, data: "updated-via-ahp", encoding: "utf-8" as ContentEncoding.Utf8 });
    expect(await workspace.sessionFs.readFile(join(anchor, "sentinel.txt"))).toBe("updated-via-ahp");
    expect(await readFile(join(anchor, "sentinel.txt"), "utf8")).toBe("host-sentinel");
    expect(await readdir(anchor)).toEqual(["sentinel.txt"]);
    await expect(ahp.request("resourceRead", { channel: "ahp-root://", uri: pathToFileURL(join(root, "outside")).href })).rejects.toThrow();
    await expect(ahp.request("createResourceWatch", { channel: "ahp-root://", uri: pathToFileURL(anchor).href })).rejects.toThrow();
    await expect(ahp.request("resourceRead", { channel: "ahp-root://", uri: pathToFileURL(join(anchor, "missing")).href })).rejects.toThrow();
    expect(failures).toEqual(["resourceRead", "resourceRead"]);
  } finally {
    try {
      await ahp?.shutdown();
      socket?.terminate();
    } finally {
      try {
        await host?.dispose();
      } finally {
        lifetime.abort();
        try {
          expect(await runtime.stop()).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
}, 90_000);
