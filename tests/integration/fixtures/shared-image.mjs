import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { HarnessDefinition, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import { migrate, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { canonicalJson, loadProfiles, sha256Hex } from "@copilot-agent/service-defaults";
import { SharedAdmission } from "./dist/admission.js";
import { SharedConfiguration } from "./dist/configuration.js";
import { SharedSessionService } from "./dist/service.js";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
// The image must not depend on the runtime feature flags a Copilot host application injects into its child processes.
assert.equal(process.env.AUTO_APPROVAL, undefined);
assert.equal(process.env.COPILOT_CLI_ENABLED_FEATURE_FLAGS, undefined);
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const root = await mkdtemp("/data/image-check-");
const principal = randomUUID();
const id = randomUUID();
const notice = randomUUID();
let sessionId;
let assistedId;
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
  const assisted = HarnessDefinition.parse({
    ...definition, name: "image-assisted", description: "Synthetic Linux packaged worker in assisted approval mode.",
    permissions: { default: "deny", approvalMode: "assisted" },
  });
  const policy = {
    schemaVersion: "1", allowedProfiles: ["node-ts-agent"], allowedModels: ["fixture"], maxDurationSeconds: 600, maxInferenceTokensPerJob: 100000,
    maxConcurrentAttemptsPerPrincipal: 1, maxQueuedJobsPerPrincipal: 1, retry: { maxAttempts: 1, backoffSeconds: 1 }, leaseSeconds: 30,
    requirements: { processIsolation: "uid", egress: "gateway-only" }, acknowledgedGaps: ["egress-not-enforced"], hosting: { modes: ["shared"] },
    approvalModes: ["manual", "assisted"],
  };
  const registry = {
    harnesses: new Map([definition, assisted].map((entry) => [entry.name, [{ definition: entry, digest: `sha256:${sha256Hex(canonicalJson(entry))}` }]])),
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
    mintToken: async (lease, turn) => { await store.grant(lease, turn.id); return "synthetic-unused"; },
    report: (event) => { if (event.endsWith("_failed")) console.error(event); },
  };
  service = new SharedSessionService(options);
  await service.start();
  // The worker enables the runtime's assisted-approval flag itself, so an assisted session holds its mode in a clean image.
  assert.equal(process.env.AUTO_APPROVAL, "true");
  assistedId = (await service.create(principal, { harness: "image-assisted", label: "image assisted approvals" })).id;
  await service.ensure(principal, assistedId);
  assert.equal(await service.approvalMode(principal, assistedId), "assisted");
  sessionId = (await service.create(principal, { harness: "image-fixture", label: "image qualification" })).id;
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
  await service.ensure(principal, assistedId);
  assert.equal(await service.approvalMode(principal, assistedId), "assisted");
  console.log("Linux shared image passed: unprivileged in-process worker, PostgreSQL state, one-use brokered ticket, forwarded-only ingress, replacement and no replay, assisted approvals without host-injected flags.");
} finally {
  try { await service?.stop(); }
  finally {
    try {
      if (upstream.listening) await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      const created = [sessionId, assistedId].filter(Boolean);
      if (created.length) {
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [created]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [created]);
      }
    } finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
  }
}
