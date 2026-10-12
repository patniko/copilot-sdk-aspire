import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { expect, inject, it } from "vitest";
import { migrate, SessionFileStore } from "@copilot-agent/job-store";
import { SharedSessionRuntime } from "../../src/session-host/src/runtime.js";
import { readServerKey } from "../../src/agent-host/src/server-key.js";
import { testGitHubAccount } from "../runtime/account.js";
import { localRuntimeArtifacts } from "../runtime/artifacts.js";

interface Terminal {
  write(value: string): void;
  kill(): void;
  onData(handler: (value: string) => void): { dispose(): void };
  onExit(handler: (exit: { exitCode: number }) => void): { dispose(): void };
}
interface PtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Terminal;
}
const enabled = process.env.HYBRID_CLI_TESTS === "1";

it.skipIf(!enabled)("attaches the real CLI to a shared in-process conversation and displays a synthetic model reply", async () => {
  await localRuntimeArtifacts();
  const cliPath = process.env.HYBRID_CLI_PATH;
  if (!cliPath || !isAbsolute(cliPath)) throw new Error("HYBRID_CLI_PATH must identify the locally built dist-cli/index.js.");
  await access(cliPath);
  const require = createRequire(join(resolve(dirname(cliPath), ".."), "package.json"));
  const pty: PtyModule = require("node-pty");
  const { credential, id: githubUserId } = await testGitHubAccount();
  const root = await mkdtemp(join(tmpdir(), "shared-cli-test-"));
  const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
  const sessionId = randomUUID();
  const marker = `SHARED_CLI_REPLY_${randomUUID().replaceAll("-", "")}`;
  const question = "Confirm that this shared conversation can answer a question.";
  const requests: unknown[] = [];
  let calls = 0;
  let terminal: Terminal | undefined;
  let exited = false;
  let terminalExit: Promise<void> | undefined;
  let terminalOutput = "";
  let connectionToken = "";
  let runtime: SharedSessionRuntime | undefined;
  const wait = async (predicate: () => boolean, label: string, timeout = 60_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (exited) throw new Error(`The CLI exited while ${label}.`);
      if (Date.now() > deadline) throw new Error(`Timed out while ${label}.`);
      await delay(250);
    }
  };
  const upstream = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") { response.writeHead(404).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (data: string) => { body += data; });
    request.once("end", () => {
      calls++;
      const payload = JSON.parse(body);
      requests.push(payload.messages);
      const stream = payload.stream === true;
      const base = { id: randomUUID(), model: "gpt-5.4", created: Math.floor(Date.now() / 1000) };
      if (!stream) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: marker }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  try {
    await migrate(pool);
    await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
    runtime = new SharedSessionRuntime(root, new SessionFileStore(pool), () => {});
    await runtime.start();
    const connection = await runtime.open({
      id: sessionId, principal: "cli-qualification", githubUserId, model: "gpt-5.4",
      instructions: "You are a synthetic shared-host qualification agent. Reply briefly.",
      provider: { type: "openai", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "local-synthetic", wireApi: "completions" },
    });
    connectionToken = connection.token;
    const url = new URL(connection.url);
    const key = await readServerKey(Number(url.port), connection.token);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !/^(DEMO_|HYBRID_|COPILOT_|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)) env[name] = value;
    env.GH_TOKEN = credential;
    env.GITHUB_TOKEN = credential;
    env.COPILOT_AHP_SERVER_KEY = JSON.stringify({ endpoint: url.href, ...key });
    url.searchParams.set("tkn", connection.token);
    terminal = pty.spawn(process.execPath, [cliPath, "--experimental", "--ahp", url.href, "--ahp-authenticate-with-github", "--resume", sessionId], {
      name: "xterm-256color", cols: 140, rows: 42, cwd: root, env,
    });
    terminal.onData((text) => { terminalOutput = (terminalOutput + stripVTControlCharacters(text)).slice(-60_000); });
    terminalExit = new Promise<void>((resolve) => terminal!.onExit(() => { exited = true; resolve(); }));
    await wait(() => terminalOutput.includes("Confirm folder trust"), "waiting for fixture folder trust");
    expect(terminalOutput).toContain(root);
    // Select session-only trust for this empty test fixture, never remembered folder trust.
    terminalOutput = "";
    terminal.write("\r");
    await wait(() => /(Type.*message|Ask.*anything|for shortcuts|Enter.*prompt|\u276f)/i.test(terminalOutput), "waiting for the input prompt");
    terminal.write(question);
    await delay(250);
    terminal.write("\r");
    await wait(() => calls > 0, "waiting for a model request", 45_000);
    await wait(() => terminalOutput.includes(marker), "waiting for the CLI reply", 30_000);
    expect(requests.some((messages) => JSON.stringify(messages)?.includes(question))).toBe(true);
    expect(await readdir(join(root, "anchors", sessionId))).toEqual([]);
  } catch (error) {
    let diagnostic = terminalOutput;
    const logs = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".log")).slice(0, 5);
    for (const file of logs) diagnostic += `\n${file}:\n${(await readFile(join(root, file), "utf8")).slice(-3000)}`;
    const catalogue = existsSync(join(root, "runtime", "ahp"))
      ? (await readdir(join(root, "runtime", "ahp"), { recursive: true })).filter((path) => path.endsWith(`${sessionId}.json`)) : [];
    for (const file of catalogue) {
      const record = JSON.parse(await readFile(join(root, "runtime", "ahp", file), "utf8"));
      diagnostic += `\nCatalog workspace: ${record.working_directory}`;
    }
    const workspaceMetadata = await pool.query<{ content: Buffer }>(
      "SELECT content FROM session_files WHERE namespace_id=$1 AND right(path,14)='workspace.yaml'", [sessionId]);
    for (const row of workspaceMetadata.rows) diagnostic += `\nProvider workspace: ${row.content.toString().split("\n").filter((line) => /cwd|workingDirectory/.test(line)).join("\n")}`;
    for (const value of [credential, connectionToken]) if (value) diagnostic = diagnostic.split(value).join("[redacted]");
    throw new Error(`CLI qualification failed. Terminal tail:\n${diagnostic.slice(-6000)}`, { cause: error });
  } finally {
    try {
      if (terminal && !exited) {
        terminal.kill();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([terminalExit, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Test CLI did not terminate.")), 10_000); })]);
        } finally { clearTimeout(timer); }
      }
    } finally {
      try { await runtime?.stop(); }
      finally {
        try {
          if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
          await pool.query("DELETE FROM session_file_namespaces WHERE id=$1", [sessionId]);
        } finally {
          try { await pool.end(); }
          finally { await rm(root, { recursive: true, force: true }); }
        }
      }
    }
  }
}, 180_000);
