import { DefaultAzureCredential } from "@azure/identity";
import { ConfigError, listen, listenPort, optionalEnv, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { DispatcherClient } from "./dispatcher-client.js";
import { GitHubUpstream, sdkModelSource } from "./github-upstream.js";
import { parseRoutes, routesFromFoundry, type RouteTable } from "./routes.js";
import { buildGateway } from "./server.js";
import { UpstreamTokenProvider } from "./upstream-auth.js";

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

const foundryEndpoint = optionalEnv("FOUNDRY_ENDPOINT", "");
const foundryDeployments = list(process.env.FOUNDRY_DEPLOYMENTS);
const rawRoutes = process.env.INFERENCE_ROUTES
  ?? (foundryEndpoint && foundryDeployments.length ? routesFromFoundry(foundryEndpoint, foundryDeployments) : undefined);
const githubToken = process.env.GITHUB_INFERENCE_TOKEN?.trim();
if (!rawRoutes && !githubToken) {
  throw new ConfigError("Configure an inference upstream: FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENTS, GITHUB_INFERENCE_TOKEN, or both.");
}
const routes: RouteTable = rawRoutes
  ? parseRoutes(rawRoutes, optionalEnv("GATEWAY_ALLOW_INSECURE_LOOPBACK", "false") === "true")
  : { routes: new Map() };
const tokens = new UpstreamTokenProvider(new DefaultAzureCredential());
const dispatcher = new DispatcherClient(serviceUrl("job-dispatcher"), requireEnv("GATEWAY_KEY"));
const github = githubToken ? new GitHubUpstream(() => sdkModelSource(githubToken), list(process.env.GITHUB_INFERENCE_MODELS)) : undefined;

const app = buildGateway({
  signingKey: requireEnv("CAPABILITY_SIGNING_KEY"),
  routes,
  upstreamToken: () => tokens.token(),
  ...(github ? { github: { endpoint: (model: string) => github.endpoint(model), invalidate: (model: string) => github.invalidate(model) } } : {}),
  introspect: (jti) => dispatcher.introspect(jti),
  beginRequest: (jti, requestId) => dispatcher.beginRequest(jti, requestId),
  reportUsage: (report) => dispatcher.reportUsage(report),
});

/** Adds the GitHub account's models; retried until it succeeds so a transient failure does not drop them for good. */
async function discoverGitHub(upstream: GitHubUpstream): Promise<void> {
  try {
    const { routes: discovered, missing } = await upstream.discover();
    for (const route of discovered) {
      if (routes.routes.has(route.model)) {
        app.log.warn({ model: route.model }, "GitHub model name is already routed; keeping the configured route");
        continue;
      }
      routes.routes.set(route.model, route);
    }
    if (missing.length) app.log.warn({ missing }, "requested GitHub models are not available to the account");
    app.log.info({ models: discovered.map((route) => ({ model: route.model, wireApi: route.wireApi })) }, "GitHub inference ready");
  } catch (error) {
    // Never log the credential; the SDK's message describes the failure.
    app.log.error({ err: error instanceof Error ? { message: error.message } : String(error) }, "GitHub inference discovery failed; retrying in 60 s");
    setTimeout(() => void discoverGitHub(upstream), 60_000).unref();
  }
}
if (github) {
  app.addHook("onClose", async () => { await github.stop(); });
  await discoverGitHub(github);
}

await listen(app, listenPort(8082));
app.log.info(
  { routes: [...routes.routes.values()].map((r) => ({ model: r.model, host: new URL(r.baseUrl).host, auth: r.auth, wireApi: r.wireApi ?? "completions" })) },
  "inference-gateway ready",
);
