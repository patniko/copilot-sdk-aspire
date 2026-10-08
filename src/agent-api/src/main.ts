import { HostStore, JobEventListener, JobStore, migrate } from "@copilot-agent/job-store";
import {
  ApiKeyAuthenticator,
  assertOverridesMatchHarnesses,
  createPostgresPool,
  listen,
  listenPort,
  loadHarnesses,
  loadPolicySet,
  loadProfiles,
  optionalEnv,
  readPostgresConnection,
  requireEnv,
} from "@copilot-agent/service-defaults";
import { Admission } from "./admission.js";
import { buildApi } from "./server.js";

const [harnesses, profiles, policies] = await Promise.all([loadHarnesses(), loadProfiles(), loadPolicySet()]);
assertOverridesMatchHarnesses(policies, harnesses.keys());
const policy = policies.base;
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);

const store = new JobStore(pool);
const hostOwner = optionalEnv("DEMO_HOST_OWNER", "").toLowerCase();
const listener = new JobEventListener(pool);
await listener.start();

const app = buildApi({
  store,
  listener,
  admission: new Admission({ harnesses, profiles, policies }),
  authenticator: new ApiKeyAuthenticator(requireEnv("API_KEYS")),
  harnesses,
  maxOpenJobsPerPrincipal: policy.maxQueuedJobsPerPrincipal,
  console: optionalEnv("CONSOLE_ENABLED", "true") !== "false",
  ...(hostOwner ? {
    host: {
      store: new HostStore(pool), owner: hostOwner, principal: "dev",
      transport: requireEnv("DEMO_HOST_TRANSPORT"),
    },
  } : {}),
});

await listen(app, listenPort(8080));
app.log.info(
  {
    harnesses: [...harnesses.keys()],
    profiles: [...profiles.keys()],
    acknowledgedGaps: policy.acknowledgedGaps,
    policyOverrides: [...policies.overrides.keys()],
  },
  "agent-api ready",
);
