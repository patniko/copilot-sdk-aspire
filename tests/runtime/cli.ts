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
  /** Status lines the launcher's supervisor printed, and an incomplete trailing line. */
  readonly #launcher: string[] = [];
  readonly #sequences = new Set<string>();
  #line = "";
  /** Output since the current CLI started (a launcher restart starts it afresh). */
  #current = "";
  constructor(private readonly root: string, private readonly credential: string) { this.#secrets.add(credential); }
  get output(): string {
    let output = this.#output;
    for (const secret of this.#secrets) output = output.split(secret).join("[redacted]");
    return output;
  }
  /** The terminal as currently rendered, with secrets redacted. */
  get screen(): string {
    let screen = this.#rendered;
    for (const secret of this.#secrets) screen = screen.split(secret).join("[redacted]");
    return screen;
  }

  /** Lines the launcher's supervisor printed in this terminal (supervised mode). */
  get launcher(): readonly string[] { return this.#launcher; }
  /** Whether the terminal's process is still running. */
  get running(): boolean { return this.#terminal !== undefined && !this.#exited; }

  async connect(connection: SharedConnection): Promise<void> {
    const url = new URL(connection.url);
    const serverKey = JSON.stringify({ endpoint: url.href, ...connection.serverKey });
    url.searchParams.set("tkn", connection.token);
    await this.launch(["--experimental", "--ahp", url.href, "--ahp-authenticate-with-github", "--resume", connection.ahpSessionId],
      { COPILOT_AHP_SERVER_KEY: serverKey }, [connection.token]);
  }

  /**
   * Starts the CLI with explicit arguments and extra environment, confirms folder trust for the fixture directory when
   * asked, and waits for the input prompt. `secrets` are redacted from diagnostics.
   */
  async launch(args: string[], extra: Record<string, string> = {}, secrets: string[] = []): Promise<void> {
    const path = await this.#cliPath();
    this.#start([path, ...args], extra, secrets);
    await this.#ready();
  }

  /**
   * Runs the launcher's session supervisor (tests/runtime/supervised-cli.ts) in this terminal, as `pnpm host:connect`
   * does for an application session: the CLI attaches through the supervisor's loopback relay, and when the session
   * moves the supervisor re-provisions it through the launcher's routing and restarts the CLI in this terminal.
   */
  async supervise(connection: SharedConnection, launcher: { apiUrl: string; apiKey: string; harness: string }): Promise<void> {
    const path = await this.#cliPath();
    const tsx = join(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    this.#start([tsx, join(import.meta.dirname, "supervised-cli.ts")], {
      SUPERVISED_API_URL: launcher.apiUrl, SUPERVISED_API_KEY: launcher.apiKey, SUPERVISED_HARNESS: launcher.harness,
      SUPERVISED_CLI: path, SUPERVISED_CONNECTION: JSON.stringify(connection),
    }, [connection.token, launcher.apiKey]);
    await this.#ready();
  }

  /** Waits until the supervisor has restarted the CLI `count` times in this terminal, then for the new CLI's prompt. */
  async resumed(count = 1, timeout = 300_000): Promise<void> {
    await this.wait(() => this.#launcher.filter((line) => line.includes("Resuming session")).length >= count, "the launcher to restart the CLI", timeout);
    await this.#ready();
  }

  async #cliPath(): Promise<string> {
    const path = process.env.HYBRID_CLI_PATH;
    if (!path || !isAbsolute(path)) throw new Error("HYBRID_CLI_PATH must identify the matching locally built CLI.");
    await access(path);
    return path;
  }

  /** Runs `node <args>` in a new pseudo-terminal with the fixture identity and `extra` environment. */
  #start(args: string[], extra: Record<string, string>, secrets: string[]): void {
    const require = createRequire(join(resolve(dirname(process.env.HYBRID_CLI_PATH!), ".."), "package.json"));
    const pty: PtyModule = require("node-pty");
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(DEMO_|HYBRID_|SHARED_|COPILOT_|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)) env[name] = value;
    }
    env.GH_TOKEN = this.credential;
    env.GITHUB_TOKEN = this.credential;
    Object.assign(env, extra);
    for (const secret of secrets) this.#secrets.add(secret);
    this.#output = "";
    this.#promptOutput = "";
    this.#current = "";
    this.#exited = false;
    this.#terminal = pty.spawn(process.execPath, args, { name: "xterm-256color", cols: 140, rows: 42, cwd: this.root, env });
    this.#terminal.onData((value) => {
      const text = stripVTControlCharacters(value);
      this.#output = (this.#output + text).slice(-100_000);
      // A CLI the launcher restarted draws a new screen: waits for its prompts look only at what follows the restart.
      if (this.#scanLauncher(text)) {
        this.#current = "";
        this.#promptOutput = "";
        this.#rendered = "";
        this.#display.write("\x1bc");
      }
      this.#current = (this.#current + text).slice(-100_000);
      this.#promptOutput = (this.#promptOutput + text).slice(-30_000);
      this.#display.write(value, () => {
        const buffer = this.#display.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
        this.#rendered = lines.join("\n");
      });
    });
    this.#exit = new Promise((resolveExit) => this.#terminal!.onExit(() => { this.#exited = true; resolveExit(); }));
  }

  /** Records completed `[launcher]` status lines once each; true when a new one announces a CLI restart. */
  #scanLauncher(text: string): boolean {
    let restarted = false;
    this.#line = (this.#line + text).slice(-10_000);
    for (let end = this.#line.indexOf("\n"); end >= 0; end = this.#line.indexOf("\n")) {
      const line = this.#line.slice(0, end);
      this.#line = this.#line.slice(end + 1);
      const at = line.indexOf("[launcher]");
      if (at < 0) continue;
      const entry = line.slice(at).trim();
      // Windows ConPTY repaints earlier output when the screen changes; a numbered line already seen is a repaint.
      const sequence = /^\[launcher\] #(\d+) /.exec(entry)?.[1];
      if (sequence !== undefined) {
        if (this.#sequences.has(sequence)) continue;
        this.#sequences.add(sequence);
      }
      this.#launcher.push(entry);
      if (entry.includes("Resuming session")) restarted = true;
    }
    return restarted;
  }

  /** Confirms folder trust for the fixture directory when the CLI asks, and waits for its input prompt. */
  async #ready(): Promise<void> {
    const prompt = /(Type.*message|Ask.*anything|for shortcuts|Enter.*prompt|\u276f)/i;
    // The trust dialog also draws a \u276f selector, so look for its title in the raw stream as well as on screen.
    const trust = () => this.#rendered.includes("Confirm folder trust") || this.#current.includes("Confirm folder trust");
    await this.wait(() => trust() || prompt.test(this.#promptOutput), "folder trust or the CLI prompt", 120_000);
    if (!trust()) await delay(1000);
    if (trust()) {
      if (!this.#current.includes(this.root)) throw new Error("The CLI did not identify the task-owned fixture directory.");
      this.#promptOutput = "";
      this.#terminal!.write("\r");
      await this.wait(() => prompt.test(this.#promptOutput), "CLI prompt");
    }
  }

  async send(prompt: string): Promise<void> {
    if (!this.#terminal || this.#exited) throw new Error("The CLI is not connected.");
    this.#terminal.write(prompt);
    await delay(250);
    this.#terminal.write("\r");
  }
  /** Sends raw keystrokes, such as "\x1b" for Escape. */
  async press(keys: string): Promise<void> {
    if (!this.#terminal || this.#exited) throw new Error("The CLI is not connected.");
    this.#terminal.write(keys);
    await delay(250);
  }
  /** Waits for text on the rendered screen or, when the emulator lags, in the raw stream. */
  async waitFor(marker: string, timeout = 60_000): Promise<void> {
    await this.wait(() => this.#rendered.includes(marker) || this.#output.includes(marker), marker, timeout);
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
