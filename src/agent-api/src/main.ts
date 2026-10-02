import { JobEventListener, JobStore, migrate } from "@copilot-agent/job-store";
import {
  ApiKeyAuthenticator,
  createPostgresPool,
  listen,
  listenPort,
  loadHarnesses,
  loadPolicy,
  loadProfiles,
  readPostgresConnection,
  requireEnv,
} from "@copilot-agent/service-defaults";
import { Admission } from "./admission.js";
import { buildApi } from "./server.js";

const [harnesses, profiles, policy] = await Promise.all([loadHarnesses(), loadProfiles(), loadPolicy()]);
const pool = createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);

const store = new JobStore(pool);
const listener = new JobEventListener(pool);
await listener.start();

const app = buildApi({
  store,
  listener,
  admission: new Admission({ harnesses, profiles, policy }),
  authenticator: new ApiKeyAuthenticator(requireEnv("API_KEYS")),
  harnesses,
  maxOpenJobsPerPrincipal: policy.maxQueuedJobsPerPrincipal,
});

await listen(app, listenPort(8080));
app.log.info(
  { harnesses: [...harnesses.keys()], profiles: [...profiles.keys()], acknowledgedGaps: policy.acknowledgedGaps },
  "agent-api ready",
);
