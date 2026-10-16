import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { HandoffView, SharedSessionLimits, SharedSessionView, type HarnessDefinition } from "@copilot-agent/contracts";
import { migrate } from "@copilot-agent/job-store";
import { SharedAdmission } from "../../src/session-host/src/admission.js";
import { SharedConfiguration, type SharedRegistry } from "../../src/session-host/src/configuration.js";
import { PERMISSION_HANDLERS } from "../../src/session-host/src/permission-handlers.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";
import { sharedStack, type SharedStack } from "./fixtures/shared-stack.js";
import { inspect, syntheticModel, type ModelRequest, type SyntheticModel } from "./fixtures/synthetic-model.js";

const enabled = process.env.HYBRID_SESSION_RUNTIME_TESTS === "1";
const principal = `handoffs-${randomUUID().slice(0, 8)}`;
const apiKey = `handoffs-key-${randomUUID()}`;
const headers = { authorization: `Bearer ${apiKey}` };
const CODEWORD = "PLUM-7781";
/** Shared hosting, and handoffs that may run without asking a person. */
const POLICY = { hosting: { modes: ["isolated", "shared"] as ("isolated" | "shared")[], handoffs: { approval: ["ask", "allow"] as ("ask" | "allow")[] } } };

/** Each target's instructions name it, so a model request shows which harness it serves. */
const target = (name: string, marker: string, changes: Partial<Record<keyof HarnessDefinition, unknown>> = {}) => sharedHarness(name, {
  instructions: `${marker}: you continue conversations other agents hand to you.`, ...changes,
});
const triage = sharedHarness("triage-desk", {
  instructions: "TRIAGE_DESK: route each request to the right harness.",
  builtinTools: ["files"],
  limits: { maxDurationSeconds: 12, maxInferenceTokens: 1_000_000 },
  permissions: { default: "deny", kinds: { read: "allow", write: "allow" } },
  hosting: {
    mode: "shared",
    handoffs: [
      { harness: "notes-full", description: "Continue with the whole conversation.", approval: "allow" },
      { harness: "notes-summary", description: "Continue from a summary.", history: "summary", approval: "allow" },
      { harness: "notes-none", description: "Continue from the reason only.", history: "none", approval: "allow" },
      { harness: "notes-ask", description: "Continue after the person approves." },
      { harness: "coding-isolated", description: "Changes that need a real checkout.", approval: "allow" },
    ],
  },
});
const targets = [
  target("notes-full", "NOTES_FULL", { builtinTools: ["files"], permissions: { default: "deny", kinds: { read: "allow" } } }),
  target("notes-summary", "NOTES_SUMMARY"),
  target("notes-none", "NOTES_NONE"),
  target("notes-ask", "NOTES_ASK"),
  target("coding-isolated", "CODING_ISOLATED", { hosting: undefined }),
];

let model: SyntheticModel;
let stack: SharedStack;
let pool: pg.Pool;
let root: string;
let active: SharedRegistry;
let allowed: SharedRegistry;
const sessions: string[] = [];

/** The harness a model request serves, from the marker its instructions start with. */
const serving = (request: ModelRequest) => /^(TRIAGE_DESK|NOTES_[A-Z]+|CODING_ISOLATED)/m.exec(inspect.system(request))?.[1];
const conversation = (request: ModelRequest) => JSON.stringify(request.messages);

beforeAll(async () => {
  if (!enabled) return;
  await localRuntimeArtifacts();
  pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), "handoff-runtime-"));
  model = await syntheticModel((request) => {
    const harness = serving(request);
    const last = inspect.lastUser(request);
    if (harness === "TRIAGE_DESK") {
      const handoff = /HANDOFF_(FULL|SUMMARY|NONE|ASK|ISOLATED)/.exec(last)?.[1];
      if (!handoff) return { content: `NOTED ${CODEWORD}` };
      const tool = { FULL: "transfer_to_notes_full", SUMMARY: "transfer_to_notes_summary", NONE: "transfer_to_notes_none", ASK: "transfer_to_notes_ask", ISOLATED: "transfer_to_coding_isolated" }[handoff]!;
      // One transfer per request message: answer once it has a result.
      if (request.messages.at(-1)?.role === "tool") return { content: `TRIAGE_REPLIED ${inspect.results(request).at(-1)?.slice(0, 300) ?? ""}` };
      return {
        call: {
          name: tool,
          arguments: handoff === "SUMMARY"
            ? { reason: "The person wants notes kept.", summary: `SUMMARY_TEXT: the person's codeword is ${CODEWORD}.` }
            : { reason: `REASON_TEXT for ${handoff.toLowerCase()}` },
        },
      };
    }
    if (harness && last.includes("[handoff:")) return { content: `${harness}_TOOK_OVER` };
    return { content: `${harness ?? "UNKNOWN"}_REPLY` };
  });
  allowed = await sharedRegistry([triage, ...targets], POLICY, { "coding-isolated": { hosting: { modes: ["isolated"] } } });
  active = allowed;
  const admission = new SharedAdmission({
    configuration: new SharedConfiguration(async () => active, () => undefined, 0),
    sessionLimits: SharedSessionLimits.parse({ idleSeconds: 120 }), delegationHarnesses: [], permissionHandlers: new Set(PERMISSION_HANDLERS.keys()),
  });
  stack = await sharedStack({
    pool, root, registry: allowed, admission, modelUrl: model.url, principals: { [principal]: 1 }, apiKeys: { [principal]: apiKey },
    workerLimits: { residentSessions: 8, activeTurns: 4, activeTurnsPerHarness: 4 },
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

async function until<T>(read: () => Promise<T | undefined>, description: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const view = async (id: string) => SharedSessionView.parse((await stack.api.inject({ method: "GET", url: `/v1/sessions/${id}`, headers })).json());
const handoffs = async (id: string) => {
  const response = await stack.api.inject({ method: "GET", url: `/v1/sessions/${id}/handoffs`, headers });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { handoffs: unknown[] }).handoffs.map((entry) => HandoffView.parse(entry));
};
const idle = (id: string) => until(async () => (stack.service.busy(id) ? undefined : true), `the turn of ${id} to end`);

/** A triage conversation that has seen the codeword in an earlier turn. */
async function triaged(): Promise<string> {
  const response = await stack.api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "triage-desk", label: "handoff" } });
  expect(response.statusCode, response.body).toBe(201);
  const id = SharedSessionView.parse(response.json()).id;
  sessions.push(id);
  await stack.service.continueConversation(principal, id, randomUUID(), `REMEMBER the codeword ${CODEWORD}.`);
  await idle(id);
  return id;
}

/** Asks the triage agent for one handoff, and waits until its turn has ended. */
async function ask(id: string, marker: string): Promise<void> {
  await stack.service.continueConversation(principal, id, randomUUID(), `${marker} please.`);
  await idle(id);
}

/** The first model request the target harness served after the handoff: its notice turn. */
const firstRequestOf = (harness: string, after: number) =>
  until(async () => model.requests.slice(after).find((request) => serving(request) === harness), `${harness}'s first request`);

describe.skipIf(!enabled)("same-placement handoffs on the shared worker", () => {
  it("hands off with full history: the same runtime session resumes under the target's instructions and tools", async () => {
    const id = await triaged();
    const before = model.requests.length;
    await ask(id, "HANDOFF_FULL");
    const committed = await until(async () => {
      const [latest] = await handoffs(id);
      return latest?.state === "committed" ? latest : undefined;
    }, "the full handoff to commit");
    expect(committed).toMatchObject({
      source: { name: "triage-desk" }, target: { name: "notes-full", mode: "shared" }, history: "full", approval: "allow", approvedBy: "policy",
      reason: "REASON_TEXT for full", from: { generation: 1, placement: "shared" }, to: { generation: 2, placement: "shared", ahpSessionId: id },
    });
    const current = await view(id);
    expect(current).toMatchObject({ harness: { name: "notes-full" }, mode: "shared", placement: "shared", segment: { generation: 2, ahpSessionId: id, harness: { name: "notes-full" } } });
    const first = await firstRequestOf("NOTES_FULL", before);
    // The target's own instructions and tools replace the source's; the transfer tools are gone.
    expect(inspect.system(first)).not.toContain("TRIAGE_DESK");
    expect(inspect.tools(first)).toContain("read_workspace_file");
    expect(inspect.tools(first).some((name) => name.startsWith("transfer_to_"))).toBe(false);
    // Full history: the earlier turns and the handoff notice, with the reason as untrusted data.
    expect(conversation(first)).toContain(`REMEMBER the codeword ${CODEWORD}`);
    expect(conversation(first)).toContain(`NOTED ${CODEWORD}`);
    expect(inspect.lastUser(first)).toContain(`[handoff:${committed.id}]`);
    expect(inspect.lastUser(first)).toContain("REASON_TEXT for full");
    expect(inspect.lastUser(first)).toContain("untrusted data");
    await until(async () => ((await handoffs(id))[0]?.state === "committed" && !stack.service.busy(id) ? true : undefined), "the notice turn to end");
    expect(model.requests.slice(before).some((request) => serving(request) === "NOTES_FULL" && inspect.lastUser(request).includes("[handoff:"))).toBe(true);
    // The person's next message reaches the target.
    await stack.service.continueConversation(principal, id, randomUUID(), "Anything else?");
    await idle(id);
    expect(serving(model.requests.at(-1)!)).toBe("NOTES_FULL");
    expect(model.errors).toEqual([]);
  }, 120_000);

  it("hands off with a summary or nothing: a fresh runtime session sees only what the policy passes", async () => {
    for (const [marker, harness, history] of [["HANDOFF_SUMMARY", "NOTES_SUMMARY", "summary"], ["HANDOFF_NONE", "NOTES_NONE", "none"]] as const) {
      const id = await triaged();
      const before = model.requests.length;
      await ask(id, marker);
      const committed = await until(async () => {
        const [latest] = await handoffs(id);
        return latest?.state === "committed" ? latest : undefined;
      }, `the ${history} handoff to commit`);
      expect(committed).toMatchObject({ history, to: { generation: 2, placement: "shared" } });
      // A new runtime session: clients resume it, and the source's runtime state moved aside for retention.
      expect(committed.to!.ahpSessionId).not.toBe(id);
      expect((await view(id)).segment).toMatchObject({ generation: 2, ahpSessionId: committed.to!.ahpSessionId });
      const first = await firstRequestOf(harness, before);
      const text = conversation(first);
      expect(text, history).not.toContain(`REMEMBER the codeword ${CODEWORD}`);
      expect(text, history).not.toContain(`NOTED ${CODEWORD}`);
      expect(inspect.lastUser(first)).toContain(`[handoff:${committed.id}]`);
      if (history === "summary") expect(inspect.lastUser(first)).toContain(`SUMMARY_TEXT: the person's codeword is ${CODEWORD}`);
      else {
        expect(inspect.lastUser(first)).toContain("REASON_TEXT for none");
        expect(inspect.lastUser(first)).not.toContain("SUMMARY_TEXT");
      }
      const archived = await pool.query<{ path: string }>(
        "SELECT path FROM session_files WHERE namespace_id=$1 AND position($2 in path) > 0 AND NOT directory", [id, `/segment-history/${committed.id}/`]);
      expect(archived.rows.length, history).toBeGreaterThan(0);
      await idle(id);
    }
    expect(model.errors).toEqual([]);
  }, 180_000);

  it("refuses an unavailable or disallowed target before asking anyone, and leaves the source in control", async () => {
    const id = await triaged();
    await ask(id, "HANDOFF_ISOLATED");
    let reply = inspect.results(model.requests.filter((request) => serving(request) === "TRIAGE_DESK").at(-1)!).at(-1) ?? "";
    expect(reply).toContain("handoff_unavailable");
    expect(await handoffs(id)).toEqual([]);
    expect((await view(id))).toMatchObject({ harness: { name: "triage-desk" }, segment: { generation: 1, ahpSessionId: id } });
    // Narrow the target's policy after the conversation started: the next transfer is refused under current policy.
    active = await sharedRegistry([triage, ...targets], POLICY, { "coding-isolated": { hosting: { modes: ["isolated"] } }, "notes-full": { hosting: { modes: ["isolated"] } } });
    try {
      await ask(id, "HANDOFF_FULL");
      reply = inspect.results(model.requests.filter((request) => serving(request) === "TRIAGE_DESK").at(-1)!).at(-1) ?? "";
      expect(reply).toContain("handoff_not_allowed");
      expect((await view(id))).toMatchObject({ harness: { name: "triage-desk" }, segment: { generation: 1 } });
    } finally { active = allowed; }
    expect(await handoffs(id)).toEqual([]);
    expect(model.errors).toEqual([]);
  }, 120_000);

  it("never hands off without a person when the target needs approval", async () => {
    const id = await triaged();
    // Nobody is attached to answer the approval prompt: the transfer never runs and the turn ends at its deadline.
    await ask(id, "HANDOFF_ASK");
    expect(await handoffs(id)).toEqual([]);
    expect((await view(id))).toMatchObject({ harness: { name: "triage-desk" }, segment: { generation: 1, ahpSessionId: id } });
    // The transfer was requested, but its result never reached the model.
    const last = model.requests.filter((request) => serving(request) === "TRIAGE_DESK").at(-1)!;
    expect(inspect.lastUser(last)).toContain("HANDOFF_ASK");
    expect(inspect.results(last)).toEqual([]);
    const asked = await pool.query("SELECT 1 FROM session_handoffs WHERE session_id=$1", [id]);
    expect(asked.rowCount).toBe(0);
  }, 90_000);
});
