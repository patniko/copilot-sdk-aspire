import { HostStore, JobStore, migrate } from "@copilot-agent/job-store";
import {
  createPostgresPool,
  listen,
  listenPort,
  loadPolicy,
  loadHarnesses,
  loadProfiles,
  optionalEnv,
  readPostgresConnection,
  requireEnv,
} from "@copilot-agent/service-defaults";
import { buildDispatcher } from "./server.js";

const policy = await loadPolicy();
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);
const store = new JobStore(pool);
const hostStore = new HostStore(pool);
const hostOwner = optionalEnv("DEMO_HOST_OWNER", "").toLowerCase();
const hostRegistry = hostOwner ? await loadHarnesses() : undefined;
const hostHarness = hostRegistry?.get(optionalEnv("DEMO_HOST_HARNESS", "interactive-demo"))?.[0];
if (hostOwner && !hostHarness) throw new Error("The configured demo host harness is not published.");

const app = buildDispatcher({
  store,
  policy,
  executorKey: requireEnv("EXECUTOR_KEY"),
  gatewayKey: requireEnv("GATEWAY_KEY"),
  signingKey: requireEnv("CAPABILITY_SIGNING_KEY"),
  hostStore,
  ...(hostOwner && hostHarness ? {
    host: {
      store: hostStore, key: requireEnv("DEMO_HOST_KEY"), owner: hostOwner,
      harness: hostHarness, profiles: await loadProfiles(), policy,
      signingKey: requireEnv("CAPABILITY_SIGNING_KEY"),
    },
  } : {}),
});

await listen(app, listenPort(8081));
app.log.info({ acknowledgedGaps: policy.acknowledgedGaps, requirements: policy.requirements }, "job-dispatcher ready");

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
