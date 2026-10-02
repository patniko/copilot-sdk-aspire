import { capture, parseJsonOutput } from "./process.js";
import type { Settings } from "./settings.js";
import type { StatusService } from "./status.js";
import type { DeployTarget, TryTarget } from "./types.js";

export class TryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface Connection {
  apiUrl: string;
  key: string;
  at: number;
}

/**
 * Talks to a running agent-api on behalf of the UI. The API key is resolved and attached here so it
 * never needs to be pasted into the configurator; it is only returned on an explicit "copy key" request.
 */
export class TryService {
  readonly #connections = new Map<string, Connection>();

  constructor(
    private readonly root: string,
    private readonly settings: Settings,
    private readonly status: StatusService,
  ) {}

  async connection(target: TryTarget, refresh = false): Promise<Connection> {
    const cacheKey = target === "local" ? "local" : `azure:${(await this.settings.read()).selectedTarget ?? ""}`;
    const cached = this.#connections.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.at < 5 * 60_000) {
      return cached;
    }
    const connection = target === "local" ? await this.#local() : await this.#azure(await this.settings.target(undefined));
    this.#connections.set(cacheKey, connection);
    return connection;
  }

  async #local(): Promise<Connection> {
    const local = await this.status.local();
    if (!local.apiUrl) {
      throw new TryError(409, "The local stack is not running. Start it from Local run.");
    }
    const key = await this.settings.devApiKey();
    if (!key) {
      throw new TryError(409, "No local API key yet. Start the local stack once to generate it.");
    }
    return { apiUrl: local.apiUrl, key, at: Date.now() };
  }

  async #azure(target: DeployTarget): Promise<Connection> {
    const args = ["--resource-group", target.resourceGroup, "--subscription", target.subscriptionId, "-o", "json"];
    const app = await capture("az", ["containerapp", "show", "--name", "agent-api", ...args], { cwd: this.root, timeoutMs: 60_000 });
    const fqdn = parseJsonOutput<{ properties?: { configuration?: { ingress?: { fqdn?: string } } } }>(app.stdout)?.properties
      ?.configuration?.ingress?.fqdn;
    if (app.code !== 0 || !fqdn) {
      throw new TryError(409, `agent-api is not deployed to ${target.resourceGroup}. Deploy first.`);
    }
    const secret = await capture(
      "az",
      ["containerapp", "secret", "show", "--name", "agent-api", "--secret-name", "api-keys", ...args],
      { cwd: this.root, timeoutMs: 60_000 },
    );
    const value = parseJsonOutput<{ value?: string }>(secret.stdout)?.value ?? "";
    const key = value.includes(":") ? value.split(";")[0]!.split(":").slice(1).join(":") : "";
    if (!key) {
      throw new TryError(409, "Could not read the deployed API key (requires access to the agent-api secrets).");
    }
    return { apiUrl: `https://${fqdn}`, key, at: Date.now() };
  }

  /** Forwards one request to the agent API. Paths are fixed by the caller; bodies are JSON. */
  async forward(target: TryTarget, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    if (!/^\/v1\/[A-Za-z0-9/:?=&._-]*$/.test(path)) {
      throw new TryError(400, "Unsupported path.");
    }
    const send = async (connection: Connection) =>
      fetch(`${connection.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${connection.key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    let connection = await this.connection(target);
    let response: Response;
    try {
      response = await send(connection);
      if (response.status === 401) {
        connection = await this.connection(target, true);
        response = await send(connection);
      }
    } catch {
      connection = await this.connection(target, true);
      response = await send(connection).catch(() => {
        throw new TryError(502, `Could not reach agent-api at ${connection.apiUrl}.`);
      });
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON error bodies are returned as text.
    }
    return { status: response.status, body: parsed };
  }
}
