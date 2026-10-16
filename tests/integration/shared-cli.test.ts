import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { migrate, SessionFileStore } from "@copilot-agent/job-store";
import { SharedSessionRuntime, type SharedSessionOptions } from "../../src/session-host/src/runtime.js";
import { readServerKey } from "@copilot-agent/service-defaults";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";
import { QualificationCli } from "../runtime/cli.js";
const enabled = process.env.HYBRID_CLI_TESTS === "1";

it.skipIf(!enabled)("answers through the real CLI and retains the shared conversation across runtime replacement", async () => {
  await localRuntimeArtifacts();
  const { credential, id: githubUserId } = await testGitHubAccount();
  const root = await mkdtemp(join(tmpdir(), "shared-cli-test-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const sessionId = randomUUID();
  const marker = `SHARED_CLI_REPLY_${randomUUID().replaceAll("-", "")}`;
  const resumedMarker = `RESUMED_CLI_REPLY_${randomUUID().replaceAll("-", "")}`;
  const question = "Confirm that this shared conversation can answer a question.";
  const followUp = "Confirm that the previous conversation is available after reconnecting.";
  const requests: unknown[] = [];
  let cli: QualificationCli | undefined;
  const connectionTokens = new Set<string>();
  let runtime: SharedSessionRuntime | undefined;
  const attach = async (connection: Awaited<ReturnType<SharedSessionRuntime["open"]>>) => {
    connectionTokens.add(connection.token);
    const url = new URL(connection.url);
    const key = await readServerKey(Number(url.port), connection.token);
    cli = new QualificationCli(root, credential);
    await cli.connect({
      sessionId, destination: "shared", transport: "direct", ahpSessionId: sessionId, url: url.href, token: connection.token, serverKey: key,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  };
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") { response.writeHead(404).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (data: string) => { body += data; });
    request.once("end", () => {
      const payload = JSON.parse(body);
      requests.push(payload.messages);
      const reply = JSON.stringify(payload.messages)?.includes(followUp) ? resumedMarker : marker;
      const stream = payload.stream === true;
      const base = { id: randomUUID(), model: "gpt-5.4", created: Math.floor(Date.now() / 1000) };
      if (!stream) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  try {
    await migrate(pool);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    runtime = new SharedSessionRuntime(root, new SessionFileStore(pool), () => {});
    await runtime.start();
    const options: SharedSessionOptions = {
      id: sessionId, principal: "cli-qualification", githubUserId, model: "gpt-5.4",
      instructions: "You are a synthetic shared-host qualification agent. Reply briefly.",
      provider: { type: "openai", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "local-synthetic", wireApi: "completions" },
    };
    await attach(await runtime.open(options));
    await cli!.send(question);
    await cli!.waitFor(marker);
    expect(requests.some((messages) => JSON.stringify(messages)?.includes(question))).toBe(true);
    expect(await readdir(join(root, "anchors", sessionId))).toEqual([]);
    await cli!.stop();
    await runtime.stop();
    runtime = undefined;
    const retained = await pool.query<{ content: Buffer }>(
      "SELECT content FROM session_files WHERE namespace_id=$1 AND content IS NOT NULL", [sessionId]);
    expect(retained.rows.some((row) => row.content.includes(marker))).toBe(true);
    expect(retained.rows.some((row) => row.content.includes(credential))).toBe(false);
    runtime = new SharedSessionRuntime(root, new SessionFileStore(pool), () => {});
    await runtime.start();
    await attach(await runtime.open(options));
    await cli!.waitFor(marker);
    await cli!.send(followUp);
    await cli!.waitFor(resumedMarker);
    const resumedRequest = JSON.stringify(requests.at(-1));
    expect(resumedRequest).toContain(question);
    expect(resumedRequest).toContain(marker);
    expect(resumedRequest).toContain(followUp);
    expect(await readdir(join(root, "anchors", sessionId))).toEqual([]);
  } catch (error) {
    let diagnostic = cli?.output ?? "";
    const logs = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".log")).slice(0, 5);
    for (const file of logs) diagnostic += `\n${file}:\n${(await readFile(join(root, file), "utf8")).slice(-3000)}`;
    for (const value of [credential, ...connectionTokens]) if (value) diagnostic = diagnostic.split(value).join("[redacted]");
    throw new Error(`CLI qualification failed. Terminal tail:\n${diagnostic.slice(-6000)}`, { cause: error });
  } finally {
    try { await cli?.stop(); }
    finally {
      try { await runtime?.stop(); }
      finally {
        try {
          if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
          await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [sessionId]);
        } finally {
          try { await pool.end(); }
          finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
        }
      }
    }
  }
}, 180_000);
