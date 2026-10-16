import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { HarnessDefinition } from "@copilot-agent/contracts";
import { migrate } from "@copilot-agent/job-store";
import { PERMISSION_HANDLERS, type CustomPermissionHandler } from "../../src/session-host/src/permission-handlers.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";
import { sharedStack, type SharedStack } from "./fixtures/shared-stack.js";
import { inspect, syntheticModel, type SyntheticModel } from "./fixtures/synthetic-model.js";

const enabled = process.env.HYBRID_SESSION_RUNTIME_TESTS === "1";
const principal = `approvals-${randomUUID()}`;
const handlers = new Map<string, CustomPermissionHandler>([
  ...PERMISSION_HANDLERS,
  ["failing-handler", { description: "Throws.", decide: () => { throw new Error("handler bug"); } }],
  ["slow-handler", { description: "Never answers.", decide: () => new Promise(() => undefined) }],
]);
const notes = (name: string, permissions: Partial<NonNullable<HarnessDefinition["permissions"]>>) => sharedHarness(name, {
  builtinTools: ["files"],
  limits: { maxDurationSeconds: 10, maxInferenceTokens: 1_000_000 },
  permissions: { default: "deny", kinds: { read: "allow", write: "ask" }, ...permissions },
});

let judge: "approve" | "decline" | "error" = "decline";
let model: SyntheticModel;
let stack: SharedStack;
let pool: pg.Pool;
let root: string;
const sessions: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  await localRuntimeArtifacts();
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), "shared-approvals-"));
  model = await syntheticModel((request) => {
    if (inspect.isJudge(request)) {
      if (judge === "error") return { status: 500 };
      return { content: judge === "approve" ? "ALLOW: The person asked for this note." : "DENY: Synthetic decline." };
    }
    const target = /WRITE (\S+)/.exec(inspect.lastUser(request))?.[1];
    if (target && !inspect.called(request).includes("write_workspace_file")) {
      return { call: { name: "write_workspace_file", arguments: { path: target, content: "approved note" } } };
    }
    return { content: `WRITE_FINISHED ${inspect.results(request).at(-1) ?? ""}`.slice(0, 500) };
  });
  const registry = await sharedRegistry([
    notes("manual-notes", {}),
    notes("assisted-notes", { approvalMode: "assisted", judgeModel: "fixture" }),
    notes("allow-notes", { approvalMode: "allow-all" }),
    notes("drafts-notes", { approvalMode: "custom", handler: "workspace-drafts" }),
    notes("failing-notes", { approvalMode: "custom", handler: "failing-handler" }),
    notes("slow-notes", { approvalMode: "custom", handler: "slow-handler" }),
  ], { permissionHandlers: [...handlers.keys()] }, {
    "assisted-notes": { hosting: { modes: ["shared"] }, approvalModes: ["manual", "assisted"] },
    "allow-notes": { hosting: { modes: ["shared"] }, approvalModes: ["manual", "allow-all"] },
    ...Object.fromEntries(["drafts-notes", "failing-notes", "slow-notes"].map((name) => [name, { hosting: { modes: ["shared"] }, approvalModes: ["manual", "custom"] }])),
  });
  const profile = registry.profiles.get("node-ts-agent")!;
  (registry.profiles as Map<string, typeof profile>).set("node-ts-agent", { ...profile, permissionHandlers: [...handlers.keys()] });
  stack = await sharedStack({
    pool, root, registry, admission: sharedAdmission(registry, { handlers: handlers.keys() }),
    principals: { [principal]: 1 }, apiKeys: { [principal]: "synthetic-approvals-key-0123456789" }, modelUrl: model.url, permissionHandlers: handlers, permissionHandlerTimeoutMs: 300,
  });
}, 120_000);
afterAll(async () => {
  if (!enabled) return;
  try { await stack?.close(); await model?.close(); }
  finally {
    await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
    await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
    await pool.end();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Runs one unattended turn (no client attached) that asks for a workspace write, and reports what happened. */
async function unattendedWrite(harness: string, path: string): Promise<{ written: boolean; judged: number; reply: string; session: string; ms: number }> {
  const view = await stack.service.create(principal, { harness, label: "" });
  sessions.push(view.id);
  const before = model.requests.length;
  const started = Date.now();
  await stack.service.continueConversation(principal, view.id, randomUUID(), `WRITE ${path}`);
  const deadline = Date.now() + 40_000;
  while (stack.service.busy(view.id)) {
    if (Date.now() > deadline) throw new Error(`The ${harness} turn did not end.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const files = await pool.query<{ path: string }>("SELECT path FROM session_files WHERE namespace_id=$1 AND content IS NOT NULL", [view.id]);
  const turn = model.requests.slice(before);
  return {
    written: files.rows.some((row) => row.path.endsWith(`/${path.toLowerCase()}`)),
    judged: turn.filter((request) => inspect.isJudge(request)).length,
    reply: turn.filter((request) => !inspect.isJudge(request)).map((request) => inspect.results(request).at(-1) ?? "").join("\n"),
    session: view.id, ms: Date.now() - started,
  };
}

describe.skipIf(!enabled)("shared approval modes on the in-process runtime", () => {
  it("runs allow-all requests without a person, and never runs manual requests with nobody attached", async () => {
    const allowed = await unattendedWrite("allow-notes", "allowed.md");
    expect(allowed).toMatchObject({ written: true, judged: 0 });
    expect(await stack.service.approvalMode(principal, allowed.session)).toBe("allow-all");
    const manual = await unattendedWrite("manual-notes", "manual.md");
    expect(manual).toMatchObject({ written: false, judged: 0 });
    expect(model.errors).toEqual([]);
  }, 90_000);

  it("asks the runtime's judge through the session's provider, and fails closed when it declines or errors", async () => {
    judge = "decline";
    const declined = await unattendedWrite("assisted-notes", "declined.md");
    expect(declined.judged).toBeGreaterThan(0);
    expect(declined.written).toBe(false);
    judge = "error";
    const failed = await unattendedWrite("assisted-notes", "failed.md");
    expect(failed.written).toBe(false);
    judge = "approve";
    const approved = await unattendedWrite("assisted-notes", "approved.md");
    expect(approved.judged).toBeGreaterThan(0);
    // The judge's verdict goes to the AHP host participant, not the application's handler, so with nobody attached even
    // an approved request stays pending until the turn deadline: an unattended assisted request does not run.
    expect(approved.written).toBe(false);
    const usage = await stack.store.get(principal, approved.session);
    expect(usage?.view.budget.usedTokens).toBeGreaterThan(0);
    expect(model.errors).toEqual([]);
  }, 150_000);

  it("lets a custom handler approve or deny, and denies when it fails or is slow", async () => {
    const drafted = await unattendedWrite("drafts-notes", "drafts/plan.md");
    expect(drafted.written).toBe(true);
    const refused = await unattendedWrite("drafts-notes", "final.md");
    expect(refused.written).toBe(false);
    expect(refused.reply).toContain("Only files under drafts/");
    for (const harness of ["failing-notes", "slow-notes"]) {
      const result = await unattendedWrite(harness, "drafts/never.md");
      expect(result, harness).toMatchObject({ written: false });
      expect(result.reply, harness).toContain("permission handler failed or did not answer");
      expect(result.ms, harness).toBeLessThan(9_000);
    }
  }, 120_000);

  it("keeps the runtime out of approval modes the harness's policy does not allow", async () => {
    const manual = await stack.service.create(principal, { harness: "manual-notes", label: "" });
    sessions.push(manual.id);
    await stack.service.ensure(principal, manual.id);
    expect(await stack.service.requestApprovalMode(principal, manual.id, "allow-all")).toBe("manual");
    expect(await stack.service.requestApprovalMode(principal, manual.id, "assisted")).toBe("manual");
    const assisted = await stack.service.create(principal, { harness: "assisted-notes", label: "" });
    sessions.push(assisted.id);
    await stack.service.ensure(principal, assisted.id);
    expect(await stack.service.approvalMode(principal, assisted.id)).toBe("assisted");
    expect(await stack.service.requestApprovalMode(principal, assisted.id, "allow-all")).not.toBe("allow-all");
    expect(await stack.service.requestApprovalMode(principal, assisted.id, "manual")).toBe("manual");
    expect(await stack.service.requestApprovalMode(principal, assisted.id, "assisted")).toBe("assisted");
  }, 60_000);
});
