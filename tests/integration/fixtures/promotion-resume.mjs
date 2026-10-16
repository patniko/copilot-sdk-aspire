// Runs inside the session-host image as its unprivileged user. Restores a promotion snapshot from /snapshot into a real
// filesystem (runtime state under COPILOT_HOME, workspace at /workspace), resumes the same session ID there, and drives
// one turn whose synthetic model uses the shell on the restored files. Prints one PROMOTION_RESUME_RESULT line.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { restorePromotionSnapshot } from "@copilot-agent/service-defaults";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
const { sessionId, digest, manifest } = JSON.parse(await readFile("/snapshot/snapshot.json", "utf8"));
const marker = process.env.PROMOTION_MARKER;
const home = "/data/promoted-home";
const workspace = "/workspace";
async function* contents() {
  for (const [ordinal, entry] of manifest.entries.entries()) {
    if (entry.kind === "file") yield { ordinal, content: await readFile(join("/snapshot/files", String(ordinal))) };
  }
}
const restored = await restorePromotionSnapshot(manifest, contents(), { state: join(home, "session-state", sessionId), workspace }, { sessionId, digest });

const requests = [];
const upstream = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.once("end", () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    const id = randomUUID();
    // Only this turn counts: history already holds the shared turn's tool call.
    const turn = payload.messages.slice(payload.messages.findLastIndex((message) => message.role === "user") + 1);
    const called = turn.some((message) => message.tool_calls?.length);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = called
      ? { role: "assistant", content: "PROMOTED_TURN_DONE" }
      : { role: "assistant", tool_calls: [{ index: 0, id: `call_${id.slice(0, 8)}`, type: "function", function: { name: "bash", arguments: JSON.stringify({
        command: "pwd && find . -type f | sort && cat Notes/MixedCase.md && echo shell-ok > Notes/created-in-container.txt",
        description: "Inspect the promoted workspace", mode: "sync", initial_wait: 30,
      }) } }] };
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: called ? "stop" : "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const client = new CopilotClient({ connection: RuntimeConnection.forInProcess(), mode: "empty", baseDirectory: home, useLoggedInUser: false, logLevel: "error" });
let host;
let session;
try {
  await client.start();
  session = await client.resumeSession(sessionId, {
    workingDirectory: workspace, continuePendingWork: false, model: "fixture", streaming: true,
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}`, wireApi: "completions", apiKey: "synthetic-unused" },
    availableTools: ["builtin:bash", "builtin:view"], enableConfigDiscovery: false, skipCustomInstructions: true,
    onPermissionRequest: async () => ({ kind: "approve-once" }),
    systemMessage: { mode: "replace", content: "Synthetic promotion qualification agent." },
  });
  const history = JSON.stringify(await session.getEvents());
  const published = session;
  host = await client.startAhpHost({
    computeId: sessionId, workingDirectory: workspace, localServer: { hostname: "127.0.0.1", port: 0 },
    createSession: async () => { throw new Error("Sessions are provisioned by the application."); },
    resumeSession: async ({ sessionId: requested }) => { if (requested !== sessionId) throw new Error("Unknown session."); return published; },
  });
  const publication = await host.publishSession(sessionId);
  const reply = await session.sendAndWait({ prompt: "Continue in the container: inspect the workspace with the shell." }, 90_000);
  const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));
  const toolResults = requests.flatMap((request) => request.messages).filter((message) => message.role === "tool")
    .map((message) => text(message.content)).join("\n");
  console.log(`PROMOTION_RESUME_RESULT ${JSON.stringify({
    restored, historyHasMarker: history.includes(marker), reply: reply?.data.content,
    priorContext: JSON.stringify(requests[0]?.messages ?? []).includes(marker),
    toolResults: toolResults.slice(0, 2000), requests: requests.length, sessionUri: publication.sessionUri,
    workspace: (await readdir(workspace, { recursive: true })).sort(),
    cwd: (await readFile(join(home, "session-state", sessionId, "workspace.yaml"), "utf8")).split("\n").find((line) => line.startsWith("cwd:")),
  })}`);
} finally {
  try { await host?.dispose(); }
  finally {
    try { await session?.disconnect(); }
    finally { assert.deepEqual(await client.stop(), []); upstream.close(); }
  }
}
