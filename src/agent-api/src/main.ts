import { SessionContainerSettings, SharedPrincipalBindings, SharedWorkerLimits } from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, HostStore, JobEventListener, JobStore, SessionContainerStore, SessionDirectory, SharedStore, migrate,
} from "@copilot-agent/job-store";
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
  serviceUrl,
} from "@copilot-agent/service-defaults";
import { Admission } from "@copilot-agent/service-defaults";
import { buildApi } from "./server.js";
import { ContainerSessionService, sessionContainerOffer } from "./container-sessions.js";

const [harnesses, profiles, policies] = await Promise.all([loadHarnesses(), loadProfiles(), loadPolicySet()]);
assertOverridesMatchHarnesses(policies, harnesses.keys());
const policy = policies.base;
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);

const store = new JobStore(pool);
const execution = optionalEnv("EXECUTOR_MODE", "pool");
if (execution !== "pool" && execution !== "on-demand") throw new Error("EXECUTOR_MODE must be pool or on-demand.");
const hostOwner = optionalEnv("DEMO_HOST_OWNER", "").toLowerCase();
const listener = new JobEventListener(pool);
await listener.start();
const sharedStore = new SharedStore(pool);
const sessionSettings = optionalEnv("SESSION_CONTAINER_SETTINGS", "");
const sessionContainers = sessionSettings ? SessionContainerSettings.parse(JSON.parse(sessionSettings)) : undefined;

const app = buildApi({
  store,
  listener,
  admission: new Admission({ harnesses, profiles, policies }),
  authenticator: new ApiKeyAuthenticator(requireEnv("API_KEYS")),
  harnesses,
  maxOpenJobsPerPrincipal: policy.maxQueuedJobsPerPrincipal,
  console: optionalEnv("CONSOLE_ENABLED", "true") !== "false",
  execution: execution === "on-demand" ? "dedicated" : "pool",
  delegations: new DelegationStore(pool, sharedStore, store),
  ...(process.env.SHARED_WORKER_KEY ? { shared: { url: serviceUrl("session-host"), key: requireEnv("SHARED_WORKER_KEY") } } : {}),
  ...(sessionContainers ? {
    containers: new ContainerSessionService({
      store: new SessionContainerStore(pool, sharedStore), allocations: new AllocationStore(pool, sharedStore), directory: new SessionDirectory(pool),
      harnesses, profiles, policies, settings: sessionContainers,
      principals: SharedPrincipalBindings.parse(JSON.parse(requireEnv("SHARED_PRINCIPALS"))),
      limits: SharedWorkerLimits.parse(JSON.parse(optionalEnv("SHARED_WORKER_LIMITS", "{}"))),
      deployment: { isolatedHosts: [], sessionContainers: sessionContainerOffer() },
      ...(process.env.CONNECTION_BROKER_URL ? { brokerUrl: requireEnv("CONNECTION_BROKER_URL") } : {}),
    }),
  } : {}),
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
