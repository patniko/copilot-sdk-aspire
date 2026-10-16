import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { SharedConnection, SharedSessionView } from "@copilot-agent/contracts";
import { migrate } from "@copilot-agent/job-store";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "./fixtures/shared-harness.js";
import { sharedStack, type SharedStack } from "./fixtures/shared-stack.js";
import { inspect, syntheticModel, type SyntheticModel } from "./fixtures/synthetic-model.js";

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

it.skipIf(!enabled)("routes requests the judge declines to the attached CLI and offers it only the approval modes policy allows", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const root = await mkdtemp(join(tmpdir(), "shared-approval-cli-"));
  const principal = `approval-cli-${randomUUID().slice(0, 8)}`;
  const key = `approval-cli-key-${randomUUID()}`;
  const sessions: string[] = [];
  let judge: "allow" | "deny" = "allow";
  let model: SyntheticModel | undefined;
  let stack: SharedStack | undefined;
  let cli: QualificationCli | undefined;
  const written = async (id: string, path: string) =>
    (await pool.query("SELECT 1 FROM session_files WHERE namespace_id=$1 AND content IS NOT NULL AND path LIKE $2", [id, `%/${path}`])).rowCount === 1;
  try {
    await migrate(pool);
    model = await syntheticModel((request) => {
      if (inspect.isJudge(request)) return { content: judge === "allow" ? "ALLOW: The person asked for this note." : "DENY: Synthetic decline." };
      const target = /WRITE (\S+)/.exec(inspect.lastUser(request))?.[1];
      if (!target) return { content: "APPROVAL_CLI_OK" };
      const calls = inspect.called(request).length;
      const results = inspect.results(request);
      // One write per WRITE message: answer once this message's write has a result.
      return results.length >= calls && request.messages.at(-1)?.role === "tool"
        ? { content: `WRITE_FINISHED ${target}` }
        : { call: { name: "write_workspace_file", arguments: { path: target, content: "A note." } } };
    });
    const registry = await sharedRegistry([sharedHarness("cli-assisted", {
      builtinTools: ["files"],
      permissions: { default: "deny", kinds: { read: "allow", write: "ask" }, approvalMode: "assisted", judgeModel: "fixture" },
    })], {}, { "cli-assisted": { hosting: { modes: ["shared"] }, approvalModes: ["manual", "assisted"] } });
    stack = await sharedStack({
      pool, root, registry, admission: sharedAdmission(registry), modelUrl: model.url,
      principals: { [principal]: githubUserId }, apiKeys: { [principal]: key },
    });
    const headers = { authorization: `Bearer ${key}` };
    const created = await stack.api.inject({ method: "POST", url: "/v1/sessions", headers, payload: { harness: "cli-assisted" } });
    const session = SharedSessionView.parse(created.json());
    sessions.push(session.id);
    const connection = SharedConnection.parse((await stack.api.inject({ method: "POST", url: `/v1/sessions/${session.id}/connection`, headers })).json());
    expect(await stack.service.approvalMode(principal, session.id)).toBe("assisted");
    await mkdir(join(root, "cli"));
    cli = new QualificationCli(join(root, "cli"), credential);
    await cli.connect(connection);

    // The judge declines: the request reaches the attached person through the AHP prompt, and they approve it.
    judge = "deny";
    await cli.send("WRITE reviewed.md");
    expect(await firstOf(cli, ["Approve once", "WRITE_FINISHED reviewed.md"], 90_000)).toBe("Approve once");
    const prompt = cli.screen;
    await cli.press("\r");
    await cli.waitFor("WRITE_FINISHED reviewed.md", 90_000);
    expect(await written(session.id, "reviewed.md")).toBe(true);
    // The judge declines again and the person denies it: the write does not run.
    await cli.send("WRITE refused.md");
    expect(await firstOf(cli, ["Approve once", "WRITE_FINISHED refused.md"], 90_000)).toBe("Approve once");
    await cli.press("\x1b[B");
    await cli.press("\r");
    // The CLI then asks for optional feedback: Enter submits typed feedback (an empty Enter does nothing).
    await cli.waitFor("Denial feedback", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cli.press("Not this file");
    await cli.press("\r");
    for (const deadline = Date.now() + 60_000; stack.service.busy(session.id);) {
      if (Date.now() > deadline) throw new Error(`The denied turn did not end:\n${cli.screen}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await written(session.id, "refused.md")).toBe(false);
    console.info(`Permission prompt after a judge decline:\n${prompt}`);

    // The judge approves: the write runs without prompting the person.
    judge = "allow";
    await cli.send("WRITE approved.md");
    expect(await firstOf(cli, ["WRITE_FINISHED approved.md", "Approve once"], 90_000)).toBe("WRITE_FINISHED approved.md");
    expect(await written(session.id, "approved.md")).toBe(true);

    // Switching approval modes from the CLI offers only the modes the harness's policy allows.
    await cli.send("/permissions");
    await cli.press("\r");
    try { await cli.waitFor("1. Manual Approval", 30_000); }
    catch (error) { throw new Error(`The approval picker did not open:\n${cli.screen}`, { cause: error }); }
    const picker = cli.screen;
    await cli.press("\x1b");
    console.info(`Approval picker for cli-assisted:\n${picker}`);
    expect(picker).toContain("Assisted Permissions");
    expect(picker).not.toContain("Allow All");
    await cli.send("/permissions allow-all");
    await cli.press("\r");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await stack.service.approvalMode(principal, session.id)).not.toBe("allow-all");
    expect(model.errors).toEqual([]);
  } catch (error) {
    throw new Error(`Approval CLI gate failed.\n${(cli?.output ?? "").slice(-6000).split(credential).join("[redacted]")}`, { cause: error });
  } finally {
    try { await cli?.stop(); }
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
}, 420_000);
