import { listen, listenPort, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { buildBroker } from "./broker.js";
import { DispatcherDirectory, sessionRoutes, sharedUpstream } from "./sessions.js";

const key = requireEnv("CONNECTION_BROKER_KEY");
if (key.length < 32) throw new Error("CONNECTION_BROKER_KEY must contain at least 32 characters.");
const directory = new DispatcherDirectory(serviceUrl("job-dispatcher"), key);
const { app } = buildBroker({
  families: [sessionRoutes(directory)],
  upstreams: { shared: sharedUpstream(new URL(serviceUrl("session-host")), key) },
});
await listen(app, listenPort(8084));
app.log.info("connection-broker ready");
