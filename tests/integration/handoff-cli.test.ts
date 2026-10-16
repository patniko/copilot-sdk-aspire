import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { HandoffView, SharedConnection, SharedSessionView } from "@copilot-agent/contracts";
import { migrate } from "@copilot-agent/job-store";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";
import { sharedStack, type SharedStack } from "./fixtures/shared-stack.js";
import { inspect, syntheticModel, type ModelRequest, type SyntheticModel } from "./fixtures/synthetic-model.js";

const enabled = process.env.HYBRID_CLI_TESTS === "1";

/** The first of `markers` to appear on the CLI's screen. */
async function firstOf(cli: QualificationCli, markers: string[], timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = markers.find((marker) => cli.screen.includes(marker));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`None of ${markers.join(", ")} appeared:\n${cli.screen}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it.skipIf(!enabled)("hands a shared triage conversation to another shared harness with summary history after the person approves in the CLI", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const root = await mkdtemp(join(tmpdir(), "handoff-cli-"));
  const principal = `handoff-cli-${randomUUID().slice(0, 8)}`;
  const key = `handoff-cli-key-${randomUUID()}`;
  const headers = { authorization: `Bearer ${key}` };
  const codeword = `CODEWORD_${randomUUID().slice(0, 8).toUpperCase()}`;
  const sessions: string[] = [];
  const events: string[] = [];
  const clis: QualificationCli[] = [];
  let model: SyntheticModel | undefined;
  let stack: SharedStack | undefined;
  const serving = (request: ModelRequest) => (inspect.system(request).includes("CLI_TRIAGE") ? "triage" : inspect.system(request).includes("CLI_NOTES") ? "notes" : undefined);
  try {
    await migrate(pool);
    model = await syntheticModel((request) => {
      const last = inspect.lastUser(request);
      if (serving(request) === "triage") {
        if (!last.includes("HAND ME OFF")) return { content: `TRIAGE_NOTED ${codeword}` };
        if (request.messages.at(-1)?.role === "tool") return { content: "TRIAGE_FINISHED" };
        return { call: { name: "transfer_to_cli_notes", arguments: { reason: "The person wants notes kept.", summary: `SUMMARY_FROM_TRIAGE: the codeword is ${codeword}.` } } };
      }
      if (serving(request) === "notes") return { content: last.includes("[handoff:") ? "NOTES_TOOK_OVER" : "NOTES_ANSWERED" };
      return { content: "UNEXPECTED" };
    });
    const registry = await sharedRegistry([
      sharedHarness("cli-triage", {
        instructions: "CLI_TRIAGE: route requests to the right harness.",
        hosting: { mode: "shared", handoffs: [{ harness: "cli-notes", description: "Keeps notes for the person.", history: "summary" }] },
      }),
      sharedHarness("cli-notes", { instructions: "CLI_NOTES: keep notes for the person." }),
    ]);
    stack = await sharedStack({
      pool, root, registry, admission: sharedAdmission(registry), modelUrl: model.url,
      principals: { [principal]: githubUserId }, apiKeys: { [principal]: key }, report: (event) => events.push(event),
    });
    const created = await stack.api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "cli-triage" } });
    expect(created.statusCode, created.body).toBe(201);
    const session = SharedSessionView.parse(created.json());
    sessions.push(session.id);
    const connect = async () => SharedConnection.parse((await stack!.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers })).json());
    await mkdir(join(root, "cli"));
    const triage = new QualificationCli(join(root, "cli"), credential);
    clis.push(triage);
    await triage.connect(await connect());
    await triage.send(`Remember ${codeword}.`);
    await triage.waitFor(`TRIAGE_NOTED ${codeword}`, 120_000);

    // The transfer asks the person in the CLI; they approve it.
    await triage.send("HAND ME OFF to the notes harness.");
    expect(await firstOf(triage, ["transfer_to_cli_notes", "TRIAGE_FINISHED"], 120_000)).toBe("transfer_to_cli_notes");
    await firstOf(triage, ["Approve", "Allow", "Yes"], 60_000);
    const prompt = triage.screen;
    await triage.press("\r");
    const handoff = await (async () => {
      for (const deadline = Date.now() + 120_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 250))) {
        const listed = (await stack!.api.inject({ method: "GET", url: `/v1/sessions/${session.id}/handoffs`, headers })).json() as { handoffs: unknown[] };
        const [latest] = listed.handoffs.map((entry) => HandoffView.parse(entry));
        if (latest && latest.state !== "accepted") return latest;
      }
      throw new Error(`The handoff did not settle:\n${triage.screen}\n${events.join("\n")}`);
    })();
    expect(handoff, JSON.stringify({ events, prompt })).toMatchObject({
      state: "committed", approval: "ask", approvedBy: "person", history: "summary", target: { name: "cli-notes" },
      from: { generation: 1, placement: "shared" }, to: { generation: 2, placement: "shared" },
    });
    expect(events).toContain("session.handoff_decision.approved_by_human_response");
    const moved = SharedSessionView.parse((await stack.api.inject({ method: "GET", url: `/v1/sessions/${session.id}`, headers })).json());
    expect(moved).toMatchObject({ harness: { name: "cli-notes" }, segment: { generation: 2, ahpSessionId: handoff.to!.ahpSessionId } });
    expect(handoff.to!.ahpSessionId).not.toBe(session.id);
    console.info(`Handoff approval prompt:\n${prompt}`);
    await triage.stop();

    // A new CLI attaches to the target's runtime session: the target's first turn greeted from the summary.
    const next = await connect();
    expect(next.ahpSessionId).toBe(handoff.to!.ahpSessionId);
    await mkdir(join(root, "cli-notes"));
    const notes = new QualificationCli(join(root, "cli-notes"), credential);
    clis.push(notes);
    await notes.connect(next);
    await notes.waitFor("NOTES_TOOK_OVER", 120_000);
    await notes.send("What do you know?");
    await notes.waitFor("NOTES_ANSWERED", 120_000);
    const first = model.requests.find((request) => serving(request) === "notes")!;
    expect(inspect.lastUser(first)).toContain(`SUMMARY_FROM_TRIAGE: the codeword is ${codeword}`);
    expect(JSON.stringify(first.messages)).not.toContain(`Remember ${codeword}`);
    expect(model.errors).toEqual([]);
  } catch (error) {
    const tails = clis.map((cli) => cli.output.slice(-5000)).join("\n----\n").split(credential).join("[redacted]");
    throw new Error(`Handoff CLI gate failed.\nEvents: ${events.join(", ")}\n${tails}`, { cause: error });
  } finally {
    try { for (const cli of clis) await cli.stop(); }
    finally {
      try { await stack?.close(); await model?.close(); }
      finally {
        await pool.query("DELETE FROM shared_sessions WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.query("DELETE FROM session_file_namespaces WHERE id=ANY($1::uuid[])", [sessions]);
        await pool.end();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
}, 600_000);
