import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, type PromotionSnapshotManifest } from "@copilot-agent/contracts";
import { AllocationStore, migrate, PromotionStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { SharedSessionRuntime } from "../../src/session-host/src/runtime.js";
import { workspaceTools } from "../../src/session-host/src/tools.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";

/**
 * The stage-5 history transplant gate (docs/HOSTING-MODES-PLAN.md, 7.3): a shared conversation whose history and
 * workspace live in PostgreSQL-backed sessionFs is snapshotted under a fenced lease, restored onto a real filesystem in
 * a Linux container, and resumed there under the same session ID at a different absolute path.
 */
const enabled = process.env.HYBRID_PROMOTION_TESTS === "1";
const image = process.env.HYBRID_SESSION_IMAGE ?? "copilot-hybrid-session-host:local";
const fixtures = join(import.meta.dirname, "fixtures");
const resources = { cpus: 0.5, memoryMiB: 1024 };
const capacity = SharedWorkerLimits.parse({ executionContainers: 32, containersPerPrincipal: 16 });

interface ResumeResult {
  restored: { files: number; directories: number; bytes: number };
  historyHasMarker: boolean; reply: string; priorContext: boolean; toolResults: string; sessionUri: string;
  workspace: string[]; cwd: string;
}

function databaseForContainers(): URL {
  const database = new URL(inject("databaseUrl"));
  if (["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)) database.hostname = "host.docker.internal";
  return database;
}

async function docker(args: string[], env: Record<string, string> = {}, secret?: string): Promise<string> {
  try {
    const result = await promisify(execFile)("docker", [
      "run", "--rm", "--entrypoint", "node",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      ...Object.keys(env).flatMap((name) => ["--env", name]), ...args,
    ], { encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } });
    return result.stdout;
  } catch (error) {
    let detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "Container command failed.";
    if (secret) detail = detail.split(secret).join("[redacted]");
    throw new Error(`Promotion container step failed: ${detail.slice(-4000)}`);
  }
}

function result<T>(stdout: string, label: string): T {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${label} `));
  if (!line) throw new Error(`The container printed no ${label}: ${stdout.slice(-2000)}`);
  return JSON.parse(line.slice(label.length + 1)) as T;
}

/** Fetches the snapshot the way the started container does, through its allocation, and stages it for a bind mount. */
async function materialize(promotions: PromotionStore, allocationId: string, directory: string): Promise<{ manifest: PromotionSnapshotManifest; digest: string; sessionId: string }> {
  await mkdir(join(directory, "files"), { recursive: true });
  let page = await promotions.snapshotPage(allocationId, 0, 256 * 1024);
  const first = page;
  for (;;) {
    for (const file of page.files) await writeFile(join(directory, "files", String(file.ordinal)), file.content);
    if (page.next === undefined) break;
    page = await promotions.snapshotPage(allocationId, page.next, 256 * 1024);
  }
  await writeFile(join(directory, "snapshot.json"), JSON.stringify({ sessionId: first.sessionId, digest: first.digest, manifest: first.manifest }));
  return { manifest: first.manifest, digest: first.digest, sessionId: first.sessionId };
}

async function resume(directory: string, marker: string): Promise<ResumeResult> {
  const stdout = await docker([
    "--tmpfs", "/workspace:rw,uid=1000,gid=1000,mode=0700",
    "--mount", `type=bind,source=${directory},target=/snapshot,readonly`,
    "--mount", `type=bind,source=${join(fixtures, "promotion-resume.mjs")},target=/app/promotion-resume.mjs,readonly`,
    image, "promotion-resume.mjs",
  ], { PROMOTION_MARKER: marker });
  return result<ResumeResult>(stdout, "PROMOTION_RESUME_RESULT");
}

function expectTransplant(resumed: ResumeResult, manifest: PromotionSnapshotManifest, marker: string): void {
  expect(manifest.entries.filter((entry) => entry.area === "workspace").map((entry) => entry.path)).toEqual(["Notes", "Notes/MixedCase.md"]);
  expect(manifest.entries.some((entry) => entry.area === "state" && entry.path === "events.jsonl")).toBe(true);
  expect(resumed.historyHasMarker).toBe(true);
  expect(resumed.priorContext).toBe(true);
  expect(resumed.reply).toBe("PROMOTED_TURN_DONE");
  expect(resumed.toolResults).toContain("/workspace");
  expect(resumed.toolResults).toContain("./Notes/MixedCase.md");
  expect(resumed.toolResults).toContain(`# Notes ${marker}`);
  expect(resumed.workspace).toEqual(["Notes", "Notes/MixedCase.md", "Notes/created-in-container.txt"]);
  expect(resumed.cwd).toBe("cwd: /workspace");
}

describe.skipIf(!enabled)("promotion history transplant (real runtime, Linux container, synthetic inference)", () => {
  it("resumes a conversation from the host's PostgreSQL-backed shared runtime in a Linux container", async () => {
    await localRuntimeArtifacts();
    const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
    const root = await mkdtemp(join(tmpdir(), "promotion-shared-"));
    // Docker Desktop shares long-form paths; resolve the temporary directory's short form.
    const staging = await realpath(await mkdtemp(join(tmpdir(), "promotion-snapshot-")));
    const shared = new SharedStore(pool);
    const files = new SessionFileStore(pool);
    const promotions = new PromotionStore(pool, shared);
    const principal = `promotion-${randomUUID()}`;
    const marker = `PROMOTION_MARKER_${randomUUID().replaceAll("-", "")}`;
    let sessionId: string | undefined;
    let runtime: SharedSessionRuntime | undefined;
    const upstream = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.once("end", () => {
        const payload = JSON.parse(body) as { messages: Array<{ tool_calls?: unknown[] }> };
        const id = randomUUID();
        const called = payload.messages.some((message) => message.tool_calls?.length);
        const delta = called
          ? { role: "assistant", content: `ACK ${marker}` }
          : { role: "assistant", tool_calls: [{ index: 0, id: `call_${id.slice(0, 8)}`, type: "function", function: {
            name: "write_workspace_file", arguments: JSON.stringify({ path: "Notes/MixedCase.md", content: `# Notes ${marker}\n` }),
          } }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: called ? "stop" : "tool_calls" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    try {
      await migrate(pool);
      await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
      const definition = SharedSessionDefinition.parse({ model: "fixture", limits: SharedSessionLimits.parse({}), instructions: "Synthetic promotion qualification agent." });
      sessionId = (await shared.create(principal, 1, "promotion transplant", definition, 100)).id;
      runtime = new SharedSessionRuntime(root, files, () => {});
      await runtime.start();
      let idle: () => void = () => {};
      const finished = new Promise<void>((resolve) => { idle = resolve; });
      await runtime.open({
        id: sessionId, principal, githubUserId: 1, model: "fixture", instructions: "Synthetic promotion qualification agent.",
        provider: { type: "openai", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, wireApi: "completions", apiKey: "synthetic-unused" },
        tools: (context) => workspaceTools(context).map((entry) => entry.tool),
        permissions: () => async () => ({ kind: "approve-once" }),
        onEvent: (_context, event) => { if (event.type === "session.idle" && !event.agentId) idle(); },
      });
      await runtime.sendSystem(sessionId, `Remember the code word ${marker} and keep notes in the workspace.`);
      await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("The shared turn did not finish.")), 60_000))]);
      const areas = await runtime.storageAreas(sessionId);
      await runtime.close(sessionId);

      const { promotion } = await promotions.request({ principal, sessionId, source: "api", requestKey: "transplant-gate", size: "small", resources });
      await promotions.begin(promotion.id);
      const lease = await files.acquire(sessionId, principal, `promotion:${promotion.id}`);
      const captured = await promotions.capture(promotion.id, lease, areas);
      await files.release(lease);
      expect(captured.state).toBe("starting");
      const allocation = await new AllocationStore(pool, shared).request({
        sessionId, principal, purpose: "session", size: "small", resources, volumes: [], idleSeconds: 300, startupSeconds: 120, maxLifetimeSeconds: 600,
      }, capacity);
      await promotions.attachAllocation(promotion.id, allocation.id);
      await expect(promotions.snapshotPage(randomUUID())).rejects.toMatchObject({ code: "not_found" });
      const { manifest } = await materialize(promotions, allocation.id, staging);
      expectTransplant(await resume(staging, marker), manifest, marker);
    } finally {
      try { await runtime?.stop(); }
      finally {
        try {
          if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
          if (sessionId) {
            await pool.query("DELETE FROM execution_allocations WHERE session_id=$1", [sessionId]);
            await pool.query("DELETE FROM shared_sessions WHERE id=$1", [sessionId]);
            await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [sessionId]);
          }
        } finally {
          await pool.end();
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          await rm(staging, { recursive: true, force: true });
        }
      }
    }
  }, 300_000);

  it("resumes a conversation from the Linux shared-worker image in a second Linux container", async () => {
    const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
    // Docker Desktop shares long-form paths; resolve the temporary directory's short form.
    const staging = await realpath(await mkdtemp(join(tmpdir(), "promotion-snapshot-")));
    const shared = new SharedStore(pool);
    const promotions = new PromotionStore(pool, shared);
    const principal = `promotion-${randomUUID()}`;
    const marker = `PROMOTION_MARKER_${randomUUID().replaceAll("-", "")}`;
    const database = databaseForContainers();
    let sessionId: string | undefined;
    try {
      await migrate(pool);
      const definition = SharedSessionDefinition.parse({ model: "fixture", limits: SharedSessionLimits.parse({}), instructions: "Synthetic promotion qualification agent." });
      sessionId = (await shared.create(principal, 1, "promotion transplant", definition, 100)).id;
      const { promotion } = await promotions.request({ principal, sessionId, source: "api", requestKey: "transplant-gate", size: "small", resources });
      await promotions.begin(promotion.id);
      const stdout = await docker([
        "--mount", `type=bind,source=${join(fixtures, "promotion-shared.mjs")},target=/app/promotion-shared.mjs,readonly`,
        image, "promotion-shared.mjs",
      ], { TEST_DATABASE_URL: database.href, SESSION_ID: sessionId, PRINCIPAL: principal, PROMOTION_ID: promotion.id, PROMOTION_MARKER: marker }, database.href);
      const sharedSide = result<{ areas: { state: string; workspace: string }; state: string }>(stdout, "PROMOTION_SHARED_RESULT");
      expect(sharedSide.state).toBe("starting");
      expect(sharedSide.areas.state).toMatch(/^\/data\/promotion-worker-[^/]+\/session-state$/);
      const allocation = await new AllocationStore(pool, shared).request({
        sessionId, principal, purpose: "session", size: "small", resources, volumes: [], idleSeconds: 300, startupSeconds: 120, maxLifetimeSeconds: 600,
      }, capacity);
      await promotions.attachAllocation(promotion.id, allocation.id);
      const { manifest } = await materialize(promotions, allocation.id, staging);
      expectTransplant(await resume(staging, marker), manifest, marker);
    } finally {
      try {
        if (sessionId) {
          await pool.query("DELETE FROM execution_allocations WHERE session_id=$1", [sessionId]);
          await pool.query("DELETE FROM shared_sessions WHERE id=$1", [sessionId]);
          await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [sessionId]);
        }
      } finally {
        await pool.end();
        await rm(staging, { recursive: true, force: true });
      }
    }
  }, 300_000);
});
