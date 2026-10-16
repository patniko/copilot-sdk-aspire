import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { SharedConnection } from "@copilot-agent/contracts";
import { Terminal as HeadlessTerminal } from "@xterm/headless";

interface Terminal {
  write(value: string): void;
  kill(): void;
  onData(handler: (value: string) => void): { dispose(): void };
  onExit(handler: (exit: { exitCode: number }) => void): { dispose(): void };
}
interface PtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Terminal;
}

/** Real locally built CLI; identity consent and folder trust are explicit and fixture-scoped. */
export class QualificationCli {
  #terminal?: Terminal;
  #exit?: Promise<void>;
  #exited = false;
  #output = "";
  #promptOutput = "";
  readonly #display = new HeadlessTerminal({ cols: 140, rows: 42, scrollback: 5000, allowProposedApi: true });
  #rendered = "";
  readonly #secrets = new Set<string>();
  constructor(private readonly root: string, private readonly credential: string) { this.#secrets.add(credential); }
  get output(): string {
    let output = this.#output;
    for (const secret of this.#secrets) output = output.split(secret).join("[redacted]");
    return output;
  }

  async connect(connection: SharedConnection): Promise<void> {
    const path = process.env.HYBRID_CLI_PATH;
    if (!path || !isAbsolute(path)) throw new Error("HYBRID_CLI_PATH must identify the matching locally built CLI.");
    await access(path);
    const require = createRequire(join(resolve(dirname(path), ".."), "package.json"));
    const pty: PtyModule = require("node-pty");
    const url = new URL(connection.url);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(DEMO_|HYBRID_|SHARED_|COPILOT_|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)) env[name] = value;
    }
    env.GH_TOKEN = this.credential;
    env.GITHUB_TOKEN = this.credential;
    env.COPILOT_AHP_SERVER_KEY = JSON.stringify({ endpoint: url.href, ...connection.serverKey });
    this.#secrets.add(connection.token);
    url.searchParams.set("tkn", connection.token);
    this.#terminal = pty.spawn(process.execPath, [path, "--experimental", "--ahp", url.href, "--ahp-authenticate-with-github", "--resume", connection.ahpSessionId], {
      name: "xterm-256color", cols: 140, rows: 42, cwd: this.root, env,
    });
    this.#terminal.onData((value) => {
      const text = stripVTControlCharacters(value);
      this.#output = (this.#output + text).slice(-100_000);
      this.#promptOutput = (this.#promptOutput + text).slice(-30_000);
      this.#display.write(value, () => {
        const buffer = this.#display.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
        this.#rendered = lines.join("\n");
      });
    });
    this.#exit = new Promise((resolveExit) => this.#terminal!.onExit(() => { this.#exited = true; resolveExit(); }));
    await this.waitFor("Confirm folder trust");
    if (!this.#output.includes(this.root)) throw new Error("The CLI did not identify the task-owned fixture directory.");
    this.#promptOutput = "";
    this.#terminal.write("\r");
    await this.wait(() => /(Type.*message|Ask.*anything|for shortcuts|Enter.*prompt|\u276f)/i.test(this.#promptOutput), "CLI prompt");
  }

  async send(prompt: string): Promise<void> {
    if (!this.#terminal || this.#exited) throw new Error("The CLI is not connected.");
    this.#terminal.write(prompt);
    await delay(250);
    this.#terminal.write("\r");
  }
  /** The rendered terminal screen, as a person would see it. */
  get screen(): string { return this.#rendered; }
  /** Sends raw keystrokes, such as "\x1b" for Escape. */
  async press(keys: string): Promise<void> {
    if (!this.#terminal || this.#exited) throw new Error("The CLI is not connected.");
    this.#terminal.write(keys);
    await delay(250);
  }
  async waitFor(marker: string, timeout = 60_000): Promise<void> {
    await this.wait(() => this.#rendered.includes(marker), marker, timeout);
  }
  private async wait(predicate: () => boolean, label: string, timeout = 60_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (this.#exited || Date.now() > deadline) throw new Error(`CLI stopped or timed out waiting for ${label}:\n${this.output.slice(-8000)}`);
      await delay(100);
    }
  }
  async stop(): Promise<void> {
    if (!this.#terminal || this.#exited) { this.#display.dispose(); return; }
    this.#terminal.kill();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.#exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Test CLI did not terminate.")), 10_000); })]);
    } finally { clearTimeout(timer); this.#display.dispose(); }
  }
}
