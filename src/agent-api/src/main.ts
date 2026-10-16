import { SessionContainerSettings, SharedPrincipalBindings, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, HostStore, JobEventListener, JobStore, SessionContainerStore, SessionDirectory, SharedStore, WorkerStore,
  migrate,
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
  ownerHostUrl,
  readOwnerHosts,
  readPostgresConnection,
  requireEnv,
  serviceUrl,
} from "@copilot-agent/service-defaults";
import { Admission } from "@copilot-agent/service-defaults";
import { hostingDeployment } from "./hosting-deployment.js";
import { buildApi } from "./server.js";
import { ContainerSessionService } from "./container-sessions.js";

const [harnesses, profiles, policies] = await Promise.all([loadHarnesses(), loadProfiles(), loadPolicySet()]);
assertOverridesMatchHarnesses(policies, harnesses.keys());
const policy = policies.base;
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);

const store = new JobStore(pool);
const execution = optionalEnv("EXECUTOR_MODE", "pool");
if (execution !== "pool" && execution !== "on-demand") throw new Error("EXECUTOR_MODE must be pool or on-demand.");
const ownerHosts = readOwnerHosts().map((host) => ({ ...host, url: ownerHostUrl(host) }));
const hostStore = new HostStore(pool);
const legacyHost = ownerHosts.find((host) => host.legacy);
if (legacyHost) await hostStore.adoptLegacyHost(legacyHost.harness);
const sessionSettings = optionalEnv("SESSION_CONTAINER_SETTINGS", "");
const sessionContainers = sessionSettings ? SessionContainerSettings.parse(JSON.parse(sessionSettings)) : undefined;
const orchestratorWorkers = optionalEnv("ORCHESTRATOR_WORKERS", "false");
if (!["true", "false"].includes(orchestratorWorkers)) throw new Error("ORCHESTRATOR_WORKERS must be true or false.");
if (orchestratorWorkers === "true" && (!sessionContainers || !process.env.SHARED_WORKER_KEY)) {
  throw new Error("Orchestrator workers need the shared worker and session containers.");
}
const deployment = hostingDeployment({
  executor: execution, ownerHosts, sharedWorker: !!process.env.SHARED_WORKER_KEY, sessionContainers: !!sessionContainers,
  workerContainers: orchestratorWorkers === "true",
});
const listener = new JobEventListener(pool);
await listener.start();
const sharedStore = new SharedStore(pool);
const hosting = { harnesses, profiles, policies, deployment };

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
  hosting,
  ...(process.env.SHARED_WORKER_KEY ? { shared: {
    url: serviceUrl("session-host"), key: requireEnv("SHARED_WORKER_KEY"), brokerUrl: requireEnv("CONNECTION_BROKER_URL"),
  }, workers: new WorkerStore(pool, sharedStore, new AllocationStore(pool, sharedStore)) } : {}),
  ...(sessionContainers ? {
    containers: new ContainerSessionService({
      store: new SessionContainerStore(pool, sharedStore), allocations: new AllocationStore(pool, sharedStore), directory: new SessionDirectory(pool),
      catalog: hosting, settings: sessionContainers,
      principals: SharedPrincipalBindings.parse(JSON.parse(requireEnv("SHARED_PRINCIPALS"))),
      limits: SharedWorkerLimits.parse(JSON.parse(optionalEnv("SHARED_WORKER_LIMITS", "{}"))),
      sessionLimits: SharedSessionLimits.parse(JSON.parse(optionalEnv("SHARED_SESSION_LIMITS", "{}"))),
      brokerUrl: requireEnv("CONNECTION_BROKER_URL"),
    }),
  } : {}),
  ...(ownerHosts.length ? {
    hosts: {
      store: hostStore, hosts: ownerHosts, harnesses, policies, profiles,
      ...(process.env.CONNECTION_BROKER_URL ? { brokerUrl: process.env.CONNECTION_BROKER_URL } : {}),
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
