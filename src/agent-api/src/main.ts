import { DelegationStore, HostStore, JobEventListener, JobStore, SharedStore, migrate } from "@copilot-agent/job-store";
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
const deployment = hostingDeployment({ executor: execution, ownerHosts, sharedWorker: !!process.env.SHARED_WORKER_KEY });
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
  execution: execution === "on-demand" ? "dedicated" : "pool",
  delegations: new DelegationStore(pool, new SharedStore(pool), store),
  hosting: { harnesses, profiles, policies, deployment },
  ...(process.env.SHARED_WORKER_KEY ? { shared: {
    url: serviceUrl("session-host"), key: requireEnv("SHARED_WORKER_KEY"), brokerUrl: requireEnv("CONNECTION_BROKER_URL"),
  } } : {}),
  ...(ownerHosts.length ? { hosts: { store: hostStore, hosts: ownerHosts, harnesses, policies, profiles } } : {}),
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
