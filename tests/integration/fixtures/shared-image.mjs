import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { HarnessDefinition, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import { migrate, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { canonicalJson, loadProfiles, sha256Hex } from "@copilot-agent/service-defaults";
import { SharedAdmission } from "./dist/admission.js";
import { SharedConfiguration } from "./dist/configuration.js";
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
  const definition = HarnessDefinition.parse({
    schemaVersion: "1", name: "image-fixture", version: "1.0.0", description: "Synthetic Linux packaged worker.", interaction: "conversation",
    hosting: { mode: "shared" }, instructions: "Synthetic Linux packaged worker.", model: { preferred: "fixture", allowed: ["fixture"] }, tools: [],
    input: { schema: { type: "object" } }, output: { schema: { type: "object" } }, limits: { maxDurationSeconds: 120, maxInferenceTokens: 100000 },
    retry: { safeToRetry: false, maxAttempts: 1 }, runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
  });
  const policy = {
    schemaVersion: "1", allowedProfiles: ["node-ts-agent"], allowedModels: ["fixture"], maxDurationSeconds: 600, maxInferenceTokensPerJob: 100000,
    maxConcurrentAttemptsPerPrincipal: 1, maxQueuedJobsPerPrincipal: 1, retry: { maxAttempts: 1, backoffSeconds: 1 }, leaseSeconds: 30,
    requirements: { processIsolation: "uid", egress: "gateway-only" }, acknowledgedGaps: ["egress-not-enforced"], hosting: { modes: ["shared"] },
  };
  const registry = {
    harnesses: new Map([[definition.name, [{ definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` }]]]),
    profiles: await loadProfiles("/platform"), policies: { base: policy, overrides: new Map() },
  };
  const options = {
    root, store, files: new SessionFileStore(pool), principals: { [principal]: 1 },
    admission: new SharedAdmission({
      configuration: SharedConfiguration.fixed(registry), sessionLimits: SharedSessionLimits.parse({ idleSeconds: 60 }),
      delegationHarnesses: [], permissionHandlers: new Set(),
    }),
    limits: SharedWorkerLimits.parse({}),
    gatewayUrl: `http://127.0.0.1:${upstream.address().port}`,
    publicUrl: () => "http://127.0.0.1:8080",
    mintToken: async (lease, turn) => { await store.grant(lease, turn.id); return "synthetic-unused"; },
    report: (event) => { if (event.endsWith("_failed")) console.error(event); },
  };
  service = new SharedSessionService(options);
  await service.start();
  sessionId = (await service.create(principal, { harness: "image-fixture", label: "image qualification" })).id;
  const connection = await service.connection(principal, sessionId);
  assert.ok(connection.serverKey.publicKey);
  assert.ok(await service.resolveConnection(`/sessions/${sessionId}`, connection.token));
  assert.equal(await service.resolveConnection(`/sessions/${sessionId}`, connection.token), undefined);
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
  console.log("Linux shared image passed: unprivileged in-process worker, PostgreSQL state, one-use ticket, replacement and no replay.");
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
