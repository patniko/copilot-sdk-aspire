import { DefaultAzureCredential } from "@azure/identity";
import { listen, listenPort, optionalEnv, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { DispatcherClient } from "./dispatcher-client.js";
import { parseRoutes, routesFromFoundry } from "./routes.js";
import { buildGateway } from "./server.js";
import { UpstreamTokenProvider } from "./upstream-auth.js";

const rawRoutes =
  process.env.INFERENCE_ROUTES ??
  routesFromFoundry(
    requireEnv("FOUNDRY_ENDPOINT"),
    requireEnv("FOUNDRY_DEPLOYMENTS")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
  );
const routes = parseRoutes(rawRoutes, optionalEnv("GATEWAY_ALLOW_INSECURE_LOOPBACK", "false") === "true");
const tokens = new UpstreamTokenProvider(new DefaultAzureCredential());
const dispatcher = new DispatcherClient(serviceUrl("job-dispatcher"), requireEnv("GATEWAY_KEY"));

const app = buildGateway({
  signingKey: requireEnv("CAPABILITY_SIGNING_KEY"),
  routes,
  upstreamToken: () => tokens.token(),
  introspect: (jti) => dispatcher.introspect(jti),
  reportUsage: (report) => dispatcher.reportUsage(report),
});

await listen(app, listenPort(8082));
app.log.info(
  { routes: [...routes.routes.values()].map((r) => ({ model: r.model, host: new URL(r.baseUrl).host, auth: r.auth })) },
  "inference-gateway ready",
);
