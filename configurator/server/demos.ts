import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DEMO_MODES, defineAgent, demoAgent, type DemoMode } from "@copilot-agent/client";
import type { ExecutionPolicy, HostingPolicy } from "@copilot-agent/contracts";
import type { DemoCheck, DemosInfo, DemoLaunch } from "./types.js";
import type { Repo } from "./repo.js";
import type { StatusService } from "./status.js";
import type { TryService } from "./try.js";

/** The orchestrator demo's worker harnesses, published in the example workspace. */
export const DEMO_WORKER_HARNESSES = ["hybrid-builder", "hybrid-reviewer"] as const;
const PREFERRED_MODEL = "github/claude-sonnet-5.5";
const HYBRID_CLI = "C:\\projects\\copilot-agent-runtime-hybrid\\dist-cli\\index.js";
/** Worker ceilings the orchestrator demo needs in the base policy (its reviewer inherits the person's authority). */
const DEMO_WORKERS = {
  maxConcurrentPerSession: 2, maxPerSession: 8, maxPerPrincipal: 4, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: true,
};

export class DemoError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

/** Opens a visible terminal window running `command` in `cwd`. Replaced in tests. */
export type TerminalLauncher = (title: string, command: string, cwd: string) => Promise<void>;

const TITLES: Record<DemoMode, { title: string; tagline: string }> = {
  shared: { title: "Shared", tagline: "Many conversations, one runtime. No container." },
  isolated: { title: "Isolated", tagline: "Its own container, with a shell." },
  promotable: { title: "Promotable", tagline: "Starts shared, moves itself into a container." },
  orchestrator: { title: "Orchestrator", tagline: "A shared coordinator with container workers." },
};

/**
 * The configurator's Demos page: launches the code-defined demo agents (the same ones `pnpm agent:demo` uses) on the
 * local stack, opens the Copilot CLI on them in a new terminal window, and relays their live state, worker approvals,
 * promotion, and closing. The API key stays in the companion server.
 */
export class DemoService {
  readonly #cli: string;
  readonly #openTerminal: TerminalLauncher;

  constructor(private readonly deps: {
    root: string;
    repo: Repo;
    tryService: Pick<TryService, "forward">;
    status: Pick<StatusService, "local">;
    cli?: string;
    openTerminal?: TerminalLauncher;
  }) {
    this.#cli = deps.cli ?? process.env.COPILOT_DEMO_CLI ?? (existsSync(HYBRID_CLI) ? HYBRID_CLI : "copilot");
    if (/["'`$;&|<>\r\n]/.test(this.#cli)) throw new Error("The demo CLI path contains characters a shell would interpret.");
    this.#openTerminal = deps.openTerminal ?? openTerminalWindow;
  }

  async info(requestedModel?: string): Promise<DemosInfo> {
    const [policy, local, workersPublished] = await Promise.all([
      this.deps.repo.readPolicy().catch(() => undefined),
      this.deps.status.local().catch(() => ({ apiUrl: undefined })),
      Promise.all(DEMO_WORKER_HARNESSES.map((name) => this.deps.repo.harnessExists(name))),
    ]);
    const models = policy?.allowedModels ?? [];
    const model = requestedModel && models.includes(requestedModel) ? requestedModel : defaultModel(models);
    const modes = new Set(policy?.hosting?.modes ?? ["isolated"]);
    const workers = policy?.hosting?.workers;
    const missingWorkers = DEMO_WORKER_HARNESSES.filter((_, index) => !workersPublished[index]);
    const cliFound = this.#cli === "copilot" || existsSync(this.#cli);
    const checks: DemoCheck[] = [
      { id: "stack", label: "Local stack", ok: Boolean(local.apiUrl), detail: local.apiUrl ? `agent-api at ${local.apiUrl}` : "Start the local stack from Local run.", fix: local.apiUrl ? undefined : "start" },
      { id: "inline", label: "Code-defined agents", ok: policy?.allowInlineHarnesses === true, detail: policy?.allowInlineHarnesses ? "allowInlineHarnesses is on" : "The base policy does not allow submitted definitions.", fix: "prepare" },
      { id: "modes", label: "Hosting modes", ok: DEMO_MODES.every((mode) => modes.has(mode)), detail: `Base policy allows ${[...modes].join(", ")}.`, fix: "prepare" },
      { id: "workers", label: "Orchestrator workers", ok: Boolean(workers?.allowInheritedAuthority) && missingWorkers.length === 0,
        detail: missingWorkers.length ? `Publish ${missingWorkers.join(", ")}.` : workers?.allowInheritedAuthority ? "Worker ceilings allow inherited authority." : "The base policy has no worker ceilings for inherited authority.",
        ...(missingWorkers.length ? {} : { fix: "prepare" as const }) },
      { id: "model", label: "Model", ok: Boolean(model), detail: model ? `${model} is approved.` : "Approve a model in Policy.", },
      { id: "cli", label: "Copilot CLI", ok: cliFound, detail: cliFound ? this.#cli : `${this.#cli} was not found; set COPILOT_DEMO_CLI.` },
    ];
    const common = [checks[0]!, checks[1]!, checks[4]!].filter((check) => !check.ok).map((check) => check.detail);
    return {
      checks,
      models,
      model: model ?? "",
      cli: { command: this.#cli, found: cliFound },
      modes: DEMO_MODES.map((mode) => {
        const demo = demoAgent(mode, model ?? PREFERRED_MODEL);
        const problems = [...common];
        if (!modes.has(mode)) problems.push(`The base policy does not allow ${mode} hosting.`);
        if (mode === "orchestrator" && !checks[3]!.ok) problems.push(checks[3]!.detail);
        return { mode, ...TITLES[mode], story: demo.story, prompts: demo.prompts, definition: defineAgent(demo.spec), problems };
      }),
    };
  }

  /**
   * Allows what the demos need in the base policy: submitted definitions, all four hosting modes, and worker ceilings.
   * Everything else is kept. agent-api reads policy at startup, so the page restarts it afterwards.
   */
  async prepare(): Promise<{ changed: string[] }> {
    const policy = await this.deps.repo.readPolicy();
    const changed: string[] = [];
    const next: ExecutionPolicy = { ...policy };
    if (policy.allowInlineHarnesses !== true) {
      next.allowInlineHarnesses = true;
      changed.push("allowInlineHarnesses");
    }
    const hosting: HostingPolicy = { ...(policy.hosting ?? {}) };
    const modes = [...new Set([...(hosting.modes ?? ["isolated"]), ...DEMO_MODES])];
    if (modes.length !== (hosting.modes ?? ["isolated"]).length) {
      hosting.modes = modes;
      changed.push("hosting.modes");
    }
    if (!hosting.workers?.allowInheritedAuthority) {
      hosting.workers = { ...DEMO_WORKERS, ...(hosting.workers ?? {}), allowInheritedAuthority: true };
      changed.push("hosting.workers");
    }
    if (changed.length) await this.deps.repo.writePolicy({ ...next, hosting });
    return { changed };
  }

  async launch(mode: DemoMode, model: string, label?: string): Promise<DemoLaunch> {
    const info = await this.info(model);
    const demo = info.modes.find((entry) => entry.mode === mode)!;
    if (!info.models.includes(model)) throw new DemoError(422, `${model} is not approved by the policy.`, "model_not_approved");
    const definition = demo.definition;
    const created = await this.deps.tryService.forward("local", "POST", "/v1/sessions", { definition, label: label ?? `${demo.title} demo` });
    if (created.status >= 300) throw apiError(created);
    const session = created.body as { id: string };
    return { session, definition, terminal: await this.openCli(session.id, `${demo.title} demo`) };
  }

  /** Opens the Copilot CLI on a session in a new terminal window, through the same launcher as `pnpm host:connect`. */
  async openCli(sessionId: string, title = "Managed agent demo"): Promise<DemoLaunch["terminal"]> {
    const command = `pnpm host:connect --resume ${sessionId} --cli ${this.#cli}`;
    try {
      await this.#openTerminal(title, command, this.deps.root);
      return { opened: true, command };
    } catch (error) {
      return { opened: false, command, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async session(id: string): Promise<{ session: unknown; workers?: unknown[] }> {
    const view = await this.#get(`/v1/sessions/${id}`) as { mode?: string };
    if (view.mode !== "orchestrator") return { session: view };
    const workers = await this.#get(`/v1/sessions/${id}/workers`) as { workers?: unknown[] };
    return { session: view, workers: workers.workers ?? [] };
  }

  async workerRequests(): Promise<unknown> {
    return this.#get("/v1/worker-input-requests?state=pending");
  }

  async respond(sessionId: string, requestId: string, body: unknown): Promise<unknown> {
    return this.#post(`/v1/sessions/${sessionId}/input-requests/${requestId}/respond`, body);
  }

  async promote(id: string): Promise<unknown> {
    return this.#post(`/v1/sessions/${id}/promote`, { reason: "Promoted from the configurator's Demos page." });
  }

  async close(id: string): Promise<unknown> {
    return this.#post(`/v1/sessions/${id}/close`, {});
  }

  async #get(path: string): Promise<unknown> {
    const result = await this.deps.tryService.forward("local", "GET", path);
    if (result.status >= 300) throw apiError(result);
    return result.body;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const result = await this.deps.tryService.forward("local", "POST", path, body);
    if (result.status >= 300) throw apiError(result);
    return result.body;
  }
}

function defaultModel(models: string[]): string | undefined {
  return models.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : models.find((model) => model.startsWith("github/")) ?? models[0];
}

function apiError(result: { status: number; body: unknown }): DemoError {
  const error = (result.body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
  return new DemoError(result.status, error?.message ?? `The agent API answered ${result.status}.`, error?.code, error?.details);
}

/**
 * A new terminal window on this machine running `command` from `cwd`: a console window on Windows (Windows Terminal
 * when it is the default terminal), Terminal.app on macOS, and the default terminal emulator on Linux. `command` is
 * built only from validated server-side values.
 */
export async function openTerminalWindow(title: string, command: string, cwd: string): Promise<void> {
  const safeTitle = title.replace(/[^A-Za-z0-9 ._-]/g, "");
  const launch = (file: string, args: string[], options: { windowsVerbatimArguments?: boolean } = {}) => new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: "ignore", windowsHide: false, ...options });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  if (process.platform === "win32") {
    // No /s: the line starts with `start`, so cmd keeps every quote as written.
    const line = `/d /c start "${safeTitle}" /D "${cwd}" powershell.exe -NoExit -NoProfile -Command "$Host.UI.RawUI.WindowTitle='${safeTitle}'; ${command}"`;
    return launch("cmd.exe", [line], { windowsVerbatimArguments: true });
  }
  if (process.platform === "darwin") {
    const script = `cd ${JSON.stringify(cwd)} && ${command}`;
    return launch("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`, "-e", 'tell application "Terminal" to activate']);
  }
  return launch("x-terminal-emulator", ["-T", safeTitle, "-e", "bash", "-lc", `${command}; exec bash`]);
}
