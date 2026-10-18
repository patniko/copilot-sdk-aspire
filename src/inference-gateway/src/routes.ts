import { ConfigError } from "@copilot-agent/service-defaults";
import { WireApi } from "@copilot-agent/contracts";
import { z } from "zod";

const Route = z
  .object({
    /** Model name callers use. */
    model: z.string().min(1).max(200),
    /** OpenAI-compatible base URL of the approved upstream, e.g. https://x.openai.azure.com/openai/v1 */
    baseUrl: z.string().url(),
    /** Upstream deployment/model name. */
    deployment: z.string().min(1).max(200),
    /** `entra` uses the gateway's own identity. `none` is only allowed for loopback test upstreams. */
    auth: z.enum(["entra", "none"]),
    /** The OpenAI wire shape the upstream serves this model over; `completions` unless stated. */
    wireApi: WireApi.default("completions"),
  })
  .strict();

/** A configured (Foundry or explicit) route, or a GitHub Copilot route discovered with the gateway's GitHub credential. */
export type InferenceRoute = (Omit<z.infer<typeof Route>, "wireApi"> & { wireApi?: WireApi }) | {
  model: string;
  /** Resolved per request from the GitHub upstream; recorded here for logs. */
  baseUrl: string;
  deployment: string;
  auth: "github";
  wireApi: WireApi;
};

export interface RouteTable {
  routes: Map<string, InferenceRoute>;
}

export function parseRoutes(raw: string, allowInsecureLoopback: boolean): RouteTable {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new ConfigError("INFERENCE_ROUTES must be JSON.");
  }
  const parsed = z.array(Route).min(1).safeParse(parsedJson);
  if (!parsed.success) {
    throw new ConfigError(`INFERENCE_ROUTES is invalid: ${parsed.error.message}`);
  }
  const routes = new Map<string, InferenceRoute>();
  for (const route of parsed.data) {
    const url = new URL(route.baseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback)) {
      throw new ConfigError(`Route '${route.model}' must use HTTPS.`);
    }
    if (route.auth === "none" && !(allowInsecureLoopback && loopback)) {
      throw new ConfigError(`Route '${route.model}' must authenticate upstream with the gateway identity.`);
    }
    if (url.username || url.password || url.search) {
      throw new ConfigError(`Route '${route.model}' must not embed credentials or query parameters.`);
    }
    routes.set(route.model, { ...route, baseUrl: route.baseUrl.replace(/\/+$/, "") });
  }
  return { routes };
}

/** Builds the default route table from the Foundry endpoint and deployment parameters. */
export function routesFromFoundry(endpoint: string, deployments: string[]): string {
  const base = endpoint.replace(/\/+$/, "");
  const baseUrl = base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
  return JSON.stringify(deployments.map((d) => ({ model: d, baseUrl, deployment: d, auth: "entra" })));
}

/** Who serves a route, as reported in the gateway's model list. */
export function routeOwner(route: InferenceRoute): string {
  return route.auth === "github" ? "github" : "inference-gateway";
}

/** The wire API a route is served over; routes that do not say use chat completions. */
export function routeWireApi(route: InferenceRoute): WireApi {
  return route.wireApi ?? "completions";
}
