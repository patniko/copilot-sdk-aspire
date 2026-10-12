import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { fixtureFilesystem } from "./filesystem.ts";

assert.equal(process.platform, "linux");
const root = await mkdtemp(join(tmpdir(), "hybrid-linux-"));
const requests = [];
const upstream = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") return response.writeHead(404).end();
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.once("end", () => {
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "LINUX_SHARED_REPLY" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) response.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
const client = new CopilotClient({
  connection: RuntimeConnection.forInProcess(), mode: "empty", baseDirectory: join(root, "runtime"),
  useLoggedInUser: false, logLevel: "error",
  sessionFs: { initialCwd: join(root, "anchors"), sessionStatePath: "/session-state", conventions: "posix" },
});
const hosts = [];
try {
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  await mkdir(join(root, "anchors"));
  await client.start();
  const markers = [randomUUID(), randomUUID()];
  const sessions = [];
  for (const index of [0, 1]) {
    const id = randomUUID();
    const anchor = join(root, "anchors", id);
    await mkdir(anchor);
    const storage = fixtureFilesystem(join(root, "providers", id));
    await storage.mkdir(anchor, true);
    const session = await client.createSession({
      sessionId: id, workingDirectory: anchor, model: "fixture", streaming: true, availableTools: [],
      enableConfigDiscovery: false, skipCustomInstructions: true,
      provider: { type: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "synthetic", wireApi: "completions" },
      onPermissionRequest: async () => ({ kind: "reject" }), createSessionFsProvider: () => storage,
    });
    sessions.push(session);
    const host = await client.startAhpHost({
      computeId: id, workingDirectory: anchor, expectedOwner: { githubApiUrl: "https://api.github.com", userId: index + 1 },
      localServer: { hostname: "127.0.0.1", port: 0 }, createSession: async () => session, resumeSession: async () => session,
      onWorkspaceResource: async () => { throw new Error("This packaging probe does not authorize workspace resource calls."); },
    });
    hosts.push(host);
    assert.equal((await host.publishSession(id)).sessionUri, `ahp-session:/${id}`);
    assert.deepEqual(await readdir(anchor), []);
  }
  const replies = await Promise.all(sessions.map((session, index) => session.sendAndWait({ prompt: markers[index] }, 30_000)));
  assert.ok(replies.every((reply) => reply?.data.content === "LINUX_SHARED_REPLY"));
  assert.notEqual(hosts[0].url, hosts[1].url);
  assert.ok(markers.every((marker) => requests.some((body) => body.includes(marker))));
  assert.ok(requests.every((body) => !(body.includes(markers[0]) && body.includes(markers[1]))));
  for (const session of sessions) assert.deepEqual(await readdir(join(root, "anchors", session.sessionId)), []);
  await assert.rejects(hosts[0].publishSession(sessions[1].sessionId));
  console.log(`Qualified Linux ${process.arch}: one in-process owner, independent session files, scoped provider-mode hosts, synthetic inference.`);
} finally {
  try { for (const host of hosts) await host.dispose(); }
  finally {
    try { assert.deepEqual(await client.stop(), []); }
    finally {
      try { if (upstream.listening) await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}
