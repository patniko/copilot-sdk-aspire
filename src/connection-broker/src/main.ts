import type { HostBrokerRoute, PlacementRoute } from "@copilot-agent/contracts";
import { listen, listenPort, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { buildBroker } from "./broker.js";
import { DispatcherHostDirectory, hostRoutes, hostUpstream } from "./hosts.js";
import { containerUpstream, DispatcherDirectory, sessionRoutes, sharedUpstream } from "./sessions.js";

const key = requireEnv("CONNECTION_BROKER_KEY");
if (key.length < 32) throw new Error("CONNECTION_BROKER_KEY must contain at least 32 characters.");
const dispatcher = serviceUrl("job-dispatcher");
const directory = new DispatcherDirectory(dispatcher, key);
const { app } = buildBroker<PlacementRoute | HostBrokerRoute>({
  families: [sessionRoutes(directory), hostRoutes(new DispatcherHostDirectory(dispatcher, key))],
  upstreams: { shared: sharedUpstream(new URL(serviceUrl("session-host")), key), container: containerUpstream(), host: hostUpstream },
});
await listen(app, listenPort(8084));
app.log.info("connection-broker ready");
