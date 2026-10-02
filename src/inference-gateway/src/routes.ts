import { ConfigError } from "@copilot-agent/service-defaults";
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
  })
  .strict();
export type InferenceRoute = z.infer<typeof Route>;

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
