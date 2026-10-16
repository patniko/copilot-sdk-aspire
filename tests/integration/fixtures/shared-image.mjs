import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import { migrate, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { SharedSessionService } from "./dist/service.js";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const root = await mkdtemp("/data/image-check-");
const principal = randomUUID();
const id = randomUUID();
const notice = randomUUID();
let sessionId;
let service;
let requests = 0;
const upstream = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") return response.writeHead(404).end();
  request.resume();
  request.once("end", () => {
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "LINUX_IMAGE_REPLY" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
try {
  await migrate(pool);
  const store = new SharedStore(pool);
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  const options = {
    root, store, files: new SessionFileStore(pool), principals: { [principal]: 1 },
    definition: SharedSessionDefinition.parse({
      model: "fixture", instructions: "Synthetic Linux packaged worker.",
      allowedHarnesses: [], limits: SharedSessionLimits.parse({ idleSeconds: 60 }),
    }),
    limits: SharedWorkerLimits.parse({}),
    gatewayUrl: `http://127.0.0.1:${upstream.address().port}`,
    mintToken: async (lease, turn) => { await store.grant(lease, turn.id); return "synthetic-unused"; },
    report: (event) => { if (event.endsWith("_failed")) console.error(event); },
  };
  service = new SharedSessionService(options);
  await service.start();
  sessionId = (await service.create(principal, "image qualification")).id;
  const connection = await service.connection(principal, sessionId);
  assert.ok(connection.serverKey.publicKey);
  const placements = new PlacementStore(pool);
  const route = await placements.consumeTicket(sessionId, connection.token);
  assert.equal(route?.kind, "shared");
  assert.equal(await placements.consumeTicket(sessionId, connection.token), undefined);
  assert.equal(await service.resolveForwarded(`/sessions/${sessionId}`, randomUUID()), undefined);
  assert.ok(await service.resolveForwarded(`/sessions/${sessionId}`, route.epoch));
  await service.continueConversation(principal, sessionId, notice, "Reply briefly.");
  const deadline = Date.now() + 30_000;
  while (requests === 0 || service.busy(sessionId)) {
    if (Date.now() > deadline) throw new Error("Packaged worker turn did not finish.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(await readdir(join(root, "anchors", sessionId)), []);
  await service.stop();
  service = new SharedSessionService(options);
  await service.start();
  await service.ensure(principal, sessionId);
  assert.equal(await service.continueConversation(principal, sessionId, notice, "Do not replay."), "already-delivered");
  assert.equal(requests, 1);
  console.log("Linux shared image passed: unprivileged in-process worker, PostgreSQL state, one-use brokered ticket, forwarded-only ingress, replacement and no replay.");
} finally {
  try { await service?.stop(); }
  finally {
    try {
      if (upstream.listening) await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      if (sessionId) {
        await pool.query("DELETE FROM shared_sessions WHERE id=$1", [sessionId]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [sessionId]);
      }
    } finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
  }
}
