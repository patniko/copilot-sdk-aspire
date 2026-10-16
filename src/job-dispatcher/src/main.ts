import { policyFor, SessionContainerSettings } from "@copilot-agent/contracts";
import { AllocationStore, DelegationStore, HostStore, JobStore, PlacementStore, PromotionStore, SessionContainerStore, SharedStore, migrate } from "@copilot-agent/job-store";
import {
  createPostgresPool,
  listen,
  listenPort,
  loadPolicySet,
  loadHarnesses,
  loadProfiles,
  optionalEnv,
  ownerHostKey,
  ownerHostUrl,
  readOwnerHosts,
  readPostgresConnection,
  requireEnv,
} from "@copilot-agent/service-defaults";
import { buildDispatcher } from "./server.js";
import type { OwnerHostRoute } from "./host-routes.js";

const policies = await loadPolicySet();
const policy = policies.base;
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);
const store = new JobStore(pool);
const sharedStore = new SharedStore(pool);
const hostStore = new HostStore(pool);
const ownerHosts = readOwnerHosts();
const managedHosts = ownerHosts.some((host) => host.execution === "managed");
const hostRegistry = managedHosts ? await loadHarnesses() : undefined;
const hostRoutes: OwnerHostRoute[] = ownerHosts.map((host) => {
  const snapshot = host.execution === "managed" ? hostRegistry?.get(host.harness)?.[0] : undefined;
  if (host.execution === "managed" && !snapshot) throw new Error(`The owner host harness '${host.harness}' is not published.`);
  const endpoint = ownerHostUrl(host);
  return {
    harness: host.harness, owner: host.owner, key: ownerHostKey(host), transport: host.transport, execution: host.execution,
    snapshot, policy: policyFor(policies, host.harness), ...(endpoint ? { endpoint } : {}),
  };
});
const legacyHost = ownerHosts.find((host) => host.legacy);
const adoptedLegacyHost = legacyHost ? await hostStore.adoptLegacyHost(legacyHost.harness) : false;
const allocations = new AllocationStore(pool, sharedStore);
const sessionSettings = optionalEnv("SESSION_CONTAINER_SETTINGS", "");
const sessionContainers = sessionSettings ? SessionContainerSettings.parse(JSON.parse(sessionSettings)) : undefined;

const app = buildDispatcher({
  store,
  policies,
  executorKey: requireEnv("EXECUTOR_KEY"),
  gatewayKey: requireEnv("GATEWAY_KEY"),
  signingKey: requireEnv("CAPABILITY_SIGNING_KEY"),
  hostStore,
  ...(process.env.SHARED_WORKER_KEY ? {
    shared: { store: sharedStore, key: requireEnv("SHARED_WORKER_KEY") },
    allocations,
    delegations: new DelegationStore(pool, sharedStore, store),
  } : {}),
  ...(process.env.SHARED_WORKER_KEY && sessionContainers ? {
    sessionContainers: {
      allocations, store: new SessionContainerStore(pool, sharedStore), policies, heartbeatSeconds: sessionContainers.heartbeatSeconds,
      promotions: new PromotionStore(pool, sharedStore, allocations),
    },
  } : {}),
  ...(process.env.CONNECTION_BROKER_KEY ? {
    broker: { store: new PlacementStore(pool), key: requireEnv("CONNECTION_BROKER_KEY") },
  } : {}),
  ...(hostRoutes.length ? {
    host: {
      store: hostStore, hosts: hostRoutes, profiles: managedHosts ? await loadProfiles() : undefined,
      signingKey: requireEnv("CAPABILITY_SIGNING_KEY"),
    },
  } : {}),
});

await listen(app, listenPort(8081));
if (adoptedLegacyHost) app.log.warn({ harness: legacyHost!.harness }, "adopted the legacy demo host as this harness's owner host");
app.log.info(
  {
    acknowledgedGaps: policy.acknowledgedGaps, requirements: policy.requirements, policyOverrides: [...policies.overrides.keys()],
    ownerHosts: ownerHosts.map((host) => ({ harness: host.harness, transport: host.transport, execution: host.execution })),
  },
  "job-dispatcher ready",
);

// Lease reaper: recovers attempts whose executor stopped heartbeating.
const reap = async () => {
  try {
    const recovered = await store.reapExpiredLeases(policy.retry.backoffSeconds);
    if (recovered > 0) {
      app.log.warn({ recovered }, "recovered expired attempt leases");
    }
  } catch (error) {
    app.log.error({ err: error }, "lease reaper failed");
  }
};
setInterval(() => void reap(), 5_000).unref();
