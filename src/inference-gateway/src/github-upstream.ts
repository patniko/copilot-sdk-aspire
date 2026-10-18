import { GITHUB_MODEL_PREFIX, type WireApi } from "@copilot-agent/contracts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRoute } from "./routes.js";

/** A model the GitHub account can use, as the Copilot SDK lists it. */
export interface GitHubModel {
  id: string;
  /** The account's policy for the model; absent when the model needs none. */
  policyState?: string;
}

/** The Copilot API endpoint the SDK resolves for one model (`session.provider.getEndpoint`). */
export interface GitHubEndpoint {
  type: string;
  wireApi?: string;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string | undefined>;
  sessionToken?: { token: string; header: string; expiresAt?: string };
}

/** The Copilot SDK surface the upstream uses; replaced in tests. */
export interface GitHubModelSource {
  listModels(): Promise<GitHubModel[]>;
  endpoint(model: string): Promise<GitHubEndpoint>;
  stop(): Promise<void>;
}

export interface ResolvedUpstream {
  baseUrl: string;
  headers: Record<string, string>;
}

const ENDPOINT_TTL_MS = 10 * 60_000;
/** Headers the gateway sets itself for every upstream request. */
const GATEWAY_OWNED = new Set(["content-type", "accept", "content-length", "host", "x-interaction-id"]);

/**
 * GitHub Copilot inference through the gateway's own GitHub credential. The Copilot SDK resolves the account's models
 * and, per model, the Copilot API endpoint and headers; the gateway proxies capability-checked requests to it. The
 * credential never leaves the gateway. Models are exposed as `github/<id>`.
 */
export class GitHubUpstream {
  readonly #source: () => Promise<GitHubModelSource>;
  readonly #requested: ReadonlySet<string> | undefined;
  #client: Promise<GitHubModelSource> | undefined;
  readonly #endpoints = new Map<string, { value: Promise<ResolvedUpstream>; expiresAt: number }>();

  /** `models` lists bare Copilot model IDs to expose; omit it to expose every model the account may use. */
  constructor(source: () => Promise<GitHubModelSource>, models?: readonly string[]) {
    this.#source = source;
    this.#requested = models?.length ? new Set(models) : undefined;
  }

  /** Lists the account's usable models with the wire API each is served over. */
  async discover(): Promise<{ routes: InferenceRoute[]; missing: string[] }> {
    const client = await this.#connect();
    const available = (await client.listModels()).filter(
      (model) => model.id !== "auto" && (model.policyState === undefined || model.policyState === "enabled"),
    );
    const selected = this.#requested ? available.filter((model) => this.#requested!.has(model.id)) : available;
    const missing = this.#requested ? [...this.#requested].filter((id) => !available.some((model) => model.id === id)) : [];
    const routes: InferenceRoute[] = [];
    for (const model of selected) {
      const endpoint = await client.endpoint(model.id);
      routes.push({
        model: `${GITHUB_MODEL_PREFIX}${model.id}`,
        baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
        deployment: model.id,
        auth: "github",
        wireApi: wireApiFor(endpoint),
      });
    }
    return { routes, missing };
  }

  /** The Copilot API base URL and headers for a model, cached until shortly before they expire. */
  endpoint(model: string): Promise<ResolvedUpstream> {
    const cached = this.#endpoints.get(model);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.#resolve(model);
    this.#endpoints.set(model, { value, expiresAt: Date.now() + ENDPOINT_TTL_MS });
    value.then(
      (resolved) => this.#endpoints.set(model, { value, expiresAt: expiry(resolved) }),
      () => this.#endpoints.delete(model),
    );
    return value;
  }

  /** Forgets a model's endpoint after the upstream refuses it, so the next request resolves a fresh one. */
  invalidate(model: string): void {
    this.#endpoints.delete(model);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#endpoints.clear();
    await (await client?.catch(() => undefined))?.stop().catch(() => undefined);
  }

  #connect(): Promise<GitHubModelSource> {
    this.#client ??= this.#source().catch((error: unknown) => {
      this.#client = undefined;
      throw error;
    });
    return this.#client;
  }

  async #resolve(model: string): Promise<ResolvedUpstream & { expiresAt?: number }> {
    let endpoint: GitHubEndpoint;
    try {
      endpoint = await (await this.#connect()).endpoint(model);
    } catch (error) {
      // A failed SDK client is replaced on the next request.
      await this.stop();
      throw error;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(endpoint.headers)) {
      if (value !== undefined && !GATEWAY_OWNED.has(name.toLowerCase())) headers[name] = value;
    }
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "authorization") && endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }
    let expiresAt: number | undefined;
    if (endpoint.sessionToken) {
      headers[endpoint.sessionToken.header] = endpoint.sessionToken.token;
      const parsed = endpoint.sessionToken.expiresAt ? Date.parse(endpoint.sessionToken.expiresAt) : NaN;
      if (Number.isFinite(parsed)) expiresAt = parsed - 60_000;
    }
    return { baseUrl: endpoint.baseUrl.replace(/\/+$/, ""), headers, expiresAt };
  }
}

function expiry(resolved: ResolvedUpstream & { expiresAt?: number }): number {
  return Math.min(Date.now() + ENDPOINT_TTL_MS, resolved.expiresAt ?? Infinity);
}

/**
 * The gateway serves Copilot models over OpenAI shapes only. Anthropic-shaped Copilot models also accept
 * `/chat/completions`; OpenAI models that require `/responses` are served over it.
 */
export function wireApiFor(endpoint: Pick<GitHubEndpoint, "type" | "wireApi">): WireApi {
  return endpoint.type !== "anthropic" && endpoint.wireApi === "responses" ? "responses" : "completions";
}

/** Environment the gateway's Copilot runtime needs; the gateway's own keys are not passed to it. */
const RUNTIME_ENV = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "windir", "PATHEXT", "LOCALAPPDATA", "APPDATA", "USERPROFILE",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

/** A model source backed by the published Copilot SDK, authenticated with the operator's GitHub token. */
export async function sdkModelSource(token: string): Promise<GitHubModelSource> {
  const { CopilotClient } = await import("@github/copilot-sdk");
  const env: Record<string, string> = { COPILOT_ALLOW_GET_PROVIDER_ENDPOINT: "true" };
  for (const key of RUNTIME_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: await mkdtemp(join(tmpdir(), "inference-gateway-copilot-")),
    gitHubToken: token,
    useLoggedInUser: false,
    logLevel: "error",
    env,
  });
  await client.start();
  try {
    const session = await client.createSession({
      availableTools: [],
      onPermissionRequest: () => ({ kind: "reject" }),
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
    });
    return {
      listModels: async () =>
        (await client.listModels()).map((model) => ({ id: model.id, ...(model.policy?.state ? { policyState: model.policy.state } : {}) })),
      endpoint: async (model) => (await session.rpc.provider.getEndpoint({ modelId: model })) as GitHubEndpoint,
      stop: async () => {
        await session.disconnect().catch(() => undefined);
        await client.stop();
      },
    };
  } catch (error) {
    await client.stop().catch(() => undefined);
    throw error;
  }
}
