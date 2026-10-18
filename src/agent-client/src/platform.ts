import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  HarnessDefinition, PromotionResponse, SharedConnection, SharedSessionView, WorkerInputRequestView, WorkerView,
  type HostingTransport, type InputResponseBody,
} from "@copilot-agent/contracts";
import { superviseSessionCli } from "./cli-supervisor.js";

/** A person's answer to a worker request (`expired` is the service's own outcome, not an answer). */
export type WorkerResponse = Exclude<InputResponseBody, { kind: "expired" }>;

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
/** Credentials the local demo stack keeps in the environment; the CLI never needs them. */
const STRIPPED_ENV = ["DEMO_HOST_GITHUB_TOKEN", "DEMO_TEST_GITHUB_TOKEN", "Parameters__demo-host-github-token"];

export interface AgentPlatformOptions {
  /** The agent API's base URL: HTTPS, or HTTP on a loopback address. */
  apiUrl: string;
  /** An API key for the agent API. Kept private to the client and never printed. */
  apiKey: string;
  /** Per-request timeout; thirty seconds by default. */
  timeoutMs?: number;
  /** For tests: a fetch implementation. */
  fetch?: typeof fetch;
}

export interface LocalPlatformOptions {
  /** The repository root that holds `apphost.mts`; found by walking up from the working directory by default. */
  root?: string;
  /** The environment for `aspire` commands, for example with `ASPIRE_CLI_NUGET_SERVICE_INDEX`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CreateSessionOptions {
  /** A label shown in session lists. */
  label?: string;
  /** For a published harness: a specific version instead of the latest. */
  version?: string;
}

export interface OpenCliOptions {
  /** The Copilot CLI executable, or a `.js`/`.mjs`/`.cjs` entry point run with this Node.js. `copilot` by default. */
  cli?: string;
  transport?: HostingTransport;
  /** Arguments before the connection arguments; `["--experimental"]` by default. */
  args?: string[];
  /** The CLI's environment; this process's environment by default. Demo stack credentials are always removed. */
  env?: NodeJS.ProcessEnv;
  /** Status lines while the session moves; standard error by default. */
  notify?: (message: string) => void;
}

/** The agent API refused a request; `code` and `details` come from its `{ error }` body when it sent one. */
export class AgentPlatformError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly details?: unknown) {
    super(message);
    this.name = "AgentPlatformError";
  }
}

/**
 * A client for the agent platform's conversation API. `createSession` creates a managed conversation in the service
 * from a published harness or a definition made with `defineAgent`; the service applies operator policy and decides
 * placement, and the returned handle opens the Copilot CLI on it over AHP.
 */
export class AgentPlatform {
  readonly apiUrl: string;
  readonly #key: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: AgentPlatformOptions) {
    this.apiUrl = apiBase(options.apiUrl).href;
    if (!options.apiKey || /\s/.test(options.apiKey)) throw new Error("Provide the agent API key.");
    this.#key = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * The local development stack: `AGENT_API_URL` and `AGENT_API_KEY` when both are set, otherwise the running
   * AppHost's `agent-api` endpoint (`aspire describe`) and its generated development key (`aspire secret get`).
   */
  static async local(options: LocalPlatformOptions = {}): Promise<AgentPlatform> {
    const env = options.env ?? process.env;
    if (env.AGENT_API_URL && env.AGENT_API_KEY) {
      return new AgentPlatform({ apiUrl: env.AGENT_API_URL, apiKey: env.AGENT_API_KEY, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
    }
    const root = options.root ?? findAppHostRoot(process.cwd());
    if (!root) throw new Error("Could not find apphost.mts. Run from the repository, or set AGENT_API_URL and AGENT_API_KEY.");
    const apphost = join(root, "apphost.mts");
    const aspire = async (args: string[]) => {
      try {
        const { stdout } = await promisify(execFile)("aspire", [...args, "--apphost", apphost, "--nologo", "--non-interactive"], {
          cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        });
        return stdout;
      } catch {
        return undefined;
      }
    };
    const apiUrl = env.AGENT_API_URL ?? localApiUrl(await aspire(["describe", "--format", "Json"]));
    if (!apiUrl) throw new Error("The local stack is not running (no agent-api endpoint). Start it with pnpm aspire:run.");
    const apiKey = env.AGENT_API_KEY ?? (await aspire(["secret", "get", "Parameters:dev-api-key"]))?.trim().split(/\r?\n/).pop()?.trim();
    if (!apiKey) throw new Error("No local API key yet. Start the local stack once to generate it.");
    return new AgentPlatform({ apiUrl, apiKey, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  }

  /**
   * Creates a conversation in the service. A `HarnessDefinition` (from `defineAgent`) is submitted as an inline
   * harness, which needs the operator's `allowInlineHarnesses`; a string names a published harness.
   */
  async createSession(agent: HarnessDefinition | string, options: CreateSessionOptions = {}): Promise<ManagedSession> {
    const body = typeof agent === "string"
      ? { harness: agent, ...(options.version ? { version: options.version } : {}) }
      : { definition: HarnessDefinition.parse(agent) };
    const view = SharedSessionView.parse(await this.request("POST", "/v1/sessions", { ...body, ...(options.label ? { label: options.label } : {}) }));
    return new ManagedSession(this, view);
  }

  /** A handle for an existing conversation of this caller. */
  async session(id: string): Promise<ManagedSession> {
    return new ManagedSession(this, await this.view(id));
  }

  /** This caller's recent conversations, including closed ones, newest first. */
  async sessions(): Promise<SharedSessionView[]> {
    const body = await this.request("GET", "/v1/sessions") as { sessions?: unknown };
    return SharedSessionView.array().parse(body.sessions ?? []);
  }

  /** Pending (or, with `state: "all"`, recent) worker approvals and questions across this caller's conversations. */
  async workerInputRequests(state: "pending" | "all" = "pending"): Promise<WorkerInputRequestView[]> {
    const body = await this.request("GET", `/v1/worker-input-requests?state=${state}`) as { requests?: unknown };
    return WorkerInputRequestView.array().parse(body.requests ?? []);
  }

  /** A person's answer to a worker's approval or question; coordinators cannot answer permission requests. */
  async respondToWorker(sessionId: string, requestId: string, response: WorkerResponse): Promise<WorkerInputRequestView> {
    if (!SESSION_ID.test(sessionId) || !SESSION_ID.test(requestId)) throw new Error("Session and request IDs are UUIDs.");
    return WorkerInputRequestView.parse(await this.request("POST", `/v1/sessions/${sessionId}/input-requests/${requestId}/respond`, response));
  }

  /** The service's current view of one of this caller's conversations. */
  async view(id: string): Promise<SharedSessionView> {
    if (!SESSION_ID.test(id)) throw new Error("A session ID is a UUID.");
    return SharedSessionView.parse(await this.request("GET", `/v1/sessions/${id.toLowerCase()}`));
  }

  /** @internal Sends one authenticated API request and returns its JSON body, or throws `AgentPlatformError`. */
  async request(method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.apiUrl), {
        method, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { authorization: `Bearer ${this.#key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new AgentPlatformError(0, "unreachable", `Could not reach the agent API at ${this.apiUrl}: ${error instanceof Error ? error.message : "request failed"}`);
    }
    if (!response.ok) throw await apiError(response);
    return response.json();
  }
}

/** One managed conversation: its current view, connection material, and the Copilot CLI attached to it. */
export class ManagedSession {
  readonly id: string;
  #view: SharedSessionView;

  constructor(private readonly platform: AgentPlatform, view: SharedSessionView) {
    this.id = view.id;
    this.#view = view;
  }

  /** The service's view of the session when it was last read. */
  get view(): SharedSessionView {
    return this.#view;
  }

  async refresh(): Promise<SharedSessionView> {
    this.#view = await this.platform.view(this.id);
    return this.#view;
  }

  /** One-use connection material at the session's current placement, through the connection broker. */
  async connection(transport: HostingTransport = "direct"): Promise<SharedConnection> {
    const result = SharedConnection.parse(await this.platform.request("POST", `/v1/sessions/${this.id}/connection`, { transport }));
    const endpoint = new URL(result.url);
    if (result.sessionId !== this.id || Date.parse(result.expiresAt) <= Date.now() || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== `/sessions/${this.id}`
      || (endpoint.protocol === "ws:" && !LOOPBACK.includes(endpoint.hostname))) {
      throw new AgentPlatformError(502, "invalid_connection", "The API returned an invalid or expired broker connection.");
    }
    return result;
  }

  /**
   * Runs the Copilot CLI attached to this session over AHP, in this terminal, and resolves with its exit code. The
   * CLI reaches the broker through a loopback relay; when the session moves (for example after promotion), the CLI
   * is restarted on the new placement.
   */
  async openCli(options: OpenCliOptions = {}): Promise<number> {
    const cli = options.cli ?? "copilot";
    const transport = options.transport ?? "direct";
    const env = { ...(options.env ?? process.env) };
    for (const name of STRIPPED_ENV) delete env[name];
    const script = /\.(?:cjs|mjs|js)$/i.test(cli);
    return superviseSessionCli({
      command: script ? process.execPath : cli,
      args: [...(script ? [resolve(cli)] : []), ...(options.args ?? ["--experimental"])],
      env,
      connection: await this.connection(transport),
      provision: () => this.connection(transport),
      ...(options.notify ? { notify: options.notify } : {}),
    });
  }

  /** The orchestrator workers this conversation started, oldest first. */
  async workers(): Promise<WorkerView[]> {
    const body = await this.platform.request("GET", `/v1/sessions/${this.id}/workers`) as { workers?: unknown };
    return WorkerView.array().parse(body.workers ?? []);
  }

  /**
   * Requests the one-way move of a `promotable` conversation from the shared worker into its own container. The agent
   * can also do this itself with its `promote_session` tool. An attached CLI is moved to the container.
   */
  async promote(reason?: string): Promise<PromotionResponse> {
    return PromotionResponse.parse(await this.platform.request("POST", `/v1/sessions/${this.id}/promote`, reason ? { reason } : {}));
  }

  /** Closes the conversation; it cannot be resumed afterwards. */
  async close(): Promise<void> {
    await this.platform.request("POST", `/v1/sessions/${this.id}/close`, {});
  }
}

function apiBase(value: string): URL {
  let api: URL;
  try { api = new URL(value); } catch { throw new Error("The agent API URL is not a valid URL."); }
  if (api.username || api.password || api.search || api.hash
    || (api.protocol !== "https:" && !(api.protocol === "http:" && LOOPBACK.includes(api.hostname)))) {
    throw new Error("The agent API must use HTTPS, or HTTP on a loopback address, without embedded credentials.");
  }
  return api;
}

async function apiError(response: Response): Promise<AgentPlatformError> {
  let code: string | undefined;
  let message = `The agent API answered ${response.status}.`;
  let details: unknown;
  try {
    const error = (await response.json() as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error;
    if (typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code)) code = error.code;
    if (typeof error?.message === "string" && error.message) message = error.message.slice(0, 2000);
    details = error?.details;
  } catch { /* The status alone is reported. */ }
  return new AgentPlatformError(response.status, code, message, details);
}

/** The `agent-api` resource's URL in `aspire describe --format Json` output, preferring its `http` endpoint. */
export function localApiUrl(describeOutput: string | undefined): string | undefined {
  if (!describeOutput) return undefined;
  const start = describeOutput.search(/[[{]/);
  if (start < 0) return undefined;
  let parsed: { resources?: Array<{ displayName?: unknown; urls?: unknown }> };
  try { parsed = JSON.parse(describeOutput.slice(start)); } catch { return undefined; }
  const api = parsed.resources?.find((resource) => resource.displayName === "agent-api");
  const urls = Array.isArray(api?.urls)
    ? (api.urls as Array<{ name?: unknown; url?: unknown }>).filter((u): u is { name?: unknown; url: string } => typeof u.url === "string" && /^https?:\/\//.test(u.url))
    : [];
  return (urls.find((u) => u.name === "http") ?? urls[0])?.url;
}

function findAppHostRoot(from: string): string | undefined {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "apphost.mts"))) return directory;
    if (dirname(directory) === directory) return undefined;
  }
}
