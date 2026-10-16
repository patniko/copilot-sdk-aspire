// Runs inside the session-host image as its unprivileged user: the Linux shared worker side of a promotion. It runs one
// turn of a shared conversation in the in-process runtime over PostgreSQL-backed sessionFs, whose synthetic model writes
// a mixed-case workspace file through the application workspace tool, closes the activation, and captures the
// promotion snapshot under a fenced storage lease. Prints one PROMOTION_SHARED_RESULT line.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import pg from "pg";
import { PromotionStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { SharedSessionRuntime } from "./dist/runtime.js";
import { workspaceTools } from "./dist/tools.js";

assert.equal(process.platform, "linux");
const { SESSION_ID: sessionId, PRINCIPAL: principal, PROMOTION_ID: promotionId, PROMOTION_MARKER: marker } = process.env;
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const files = new SessionFileStore(pool);
const upstream = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.once("end", () => {
    const payload = JSON.parse(body);
    const id = randomUUID();
    const called = payload.messages.some((message) => message.tool_calls?.length);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = called
      ? { role: "assistant", content: `ACK ${marker}` }
      : { role: "assistant", tool_calls: [{ index: 0, id: `call_${id.slice(0, 8)}`, type: "function", function: {
        name: "write_workspace_file", arguments: JSON.stringify({ path: "Notes/MixedCase.md", content: `# Notes ${marker}\n` }),
      } }] };
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: called ? "stop" : "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
let runtime;
try {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  runtime = new SharedSessionRuntime(await mkdtemp("/data/promotion-worker-"), files, () => {});
  await runtime.start();
  let idle;
  const finished = new Promise((resolve) => { idle = resolve; });
  await runtime.open({
    id: sessionId, principal, githubUserId: 1, model: "fixture", instructions: "Synthetic promotion qualification agent.",
    provider: { type: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}`, wireApi: "completions", apiKey: "synthetic-unused" },
    tools: (context) => workspaceTools(context).map((entry) => entry.tool),
    permissions: () => async () => ({ kind: "approve-once" }),
    onEvent: (_context, event) => { if (event.type === "session.idle" && !event.agentId) idle(); },
  });
  await runtime.sendSystem(sessionId, `Remember the code word ${marker} and keep notes in the workspace.`);
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("The shared turn did not finish.")), 60_000))]);
  const areas = await runtime.storageAreas(sessionId);
  await runtime.close(sessionId);
  const promotions = new PromotionStore(pool, new SharedStore(pool));
  const lease = await files.acquire(sessionId, principal, `promotion:${promotionId}`);
  const captured = await promotions.capture(promotionId, lease, areas);
  await files.release(lease);
  console.log(`PROMOTION_SHARED_RESULT ${JSON.stringify({ areas, state: captured.state, digest: captured.snapshotDigest })}`);
} finally {
  try { await runtime?.stop(); }
  finally { upstream.close(); await pool.end(); }
}
