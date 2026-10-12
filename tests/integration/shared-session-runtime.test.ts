import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { migrate, SessionFileStore } from "@copilot-agent/job-store";
import { SharedSessionRuntime, type SharedSessionOptions } from "../../src/session-host/src/runtime.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";

const enabled = process.env.HYBRID_SESSION_RUNTIME_TESTS === "1";

it.skipIf(!enabled)("retains independently owned conversations across shared-runtime replacement", async () => {
  await localRuntimeArtifacts();
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  const root = await mkdtemp(join(tmpdir(), "shared-session-runtime-"));
  const files = new SessionFileStore(pool);
  const events: string[] = [];
  const options: SharedSessionOptions[] = [1, 2].map((number) => ({
    id: randomUUID(), principal: `principal-${number}`, githubUserId: number,
    model: "qualification-model", instructions: `Synthetic coordinator ${number}.`,
    provider: { type: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-unused", wireApi: "completions" },
  }));
  let runtime: SharedSessionRuntime | undefined;
  try {
    runtime = new SharedSessionRuntime(root, files, (event) => events.push(event), 2);
    await runtime.start();
    const first = await runtime.open(options[0]);
    const second = await runtime.open(options[1]);
    expect(first.url).not.toBe(second.url);
    expect(first.sessionUri).toBe(`ahp-session:/${options[0].id}`);
    await expect(runtime.open({ ...options[0], id: randomUUID() })).rejects.toThrow(/capacity/);
    await runtime.stop();
    runtime = undefined;
    const replacement = new SharedSessionRuntime(root, files, (event) => events.push(event), 2);
    runtime = replacement;
    await replacement.start();
    await expect(replacement.open({ ...options[0], principal: "wrong-principal" })).rejects.toThrow(/principal/);
    const resumed = await replacement.open(options[0]);
    expect(resumed.sessionUri).toBe(first.sessionUri);
    await replacement.close(options[0].id);
    await expect(replacement.open({ ...options[0], model: "different-model" })).rejects.toThrow(/configuration differs/);
    expect(events.filter((event) => event === "session.created")).toHaveLength(2);
    expect(events.filter((event) => event === "session.resumed")).toHaveLength(1);
  } finally {
    try { await runtime?.stop(); }
    finally {
      try {
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [options.map((entry) => entry.id)]);
        await pool.end();
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}, 90_000);
