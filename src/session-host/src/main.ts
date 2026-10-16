import { join } from "node:path";
import { z } from "zod";
import {
  SessionContainerSettings, SharedPrincipalBindings, SharedSessionLimits, SharedWorkerLimits, WORKER_CONTAINER_FEATURES,
} from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, HandoffStore, JobStore, migrate, PromotionStore, SessionFileStore, SharedStore, WorkerStore,
} from "@copilot-agent/job-store";
import {
  Admission, assertOverridesMatchHarnesses, createLogger, createPostgresPool, listen, listenPort, loadHarnesses, loadProfiles,
  loadPolicySet, optionalEnv, readPostgresConnection, requireEnv, serviceUrl,
} from "@copilot-agent/service-defaults";
import { SharedAdmission, sharedWorkerDeployment } from "./admission.js";
import { CompletionPump } from "./completions.js";
import { SharedConfiguration, type SharedRegistry } from "./configuration.js";
import { PERMISSION_HANDLERS } from "./permission-handlers.js";
import { buildSharedHost } from "./server.js";
import { SharedSessionService } from "./service.js";
import { createSharedEgress } from "./shared-egress.js";
import { WorkerInboxPump } from "./worker-inbox.js";

const logger = createLogger("session-host");
const key = requireEnv("SHARED_WORKER_KEY");
const brokerKey = requireEnv("CONNECTION_BROKER_KEY");
const principals = SharedPrincipalBindings.parse(JSON.parse(requireEnv("SHARED_PRINCIPALS")));
const limits = SharedWorkerLimits.parse(JSON.parse(optionalEnv("SHARED_WORKER_LIMITS", "{}")));
// Orchestrator coordinators run here; their workers run in session containers the execution controller starts.
const orchestratorWorkers = optionalEnv("ORCHESTRATOR_WORKERS", "false");
if (!["true", "false"].includes(orchestratorWorkers)) throw new Error("ORCHESTRATOR_WORKERS must be true or false.");
const workerContainers = orchestratorWorkers === "true"
  ? SessionContainerSettings.parse(JSON.parse(requireEnv("SESSION_CONTAINER_SETTINGS")))
  : undefined;
const configuration = new SharedConfiguration(async () => {
  const [harnesses, profiles, policies] = await Promise.all([loadHarnesses(), loadProfiles(), loadPolicySet()]);
  assertOverridesMatchHarnesses(policies, harnesses.keys());
  return { harnesses, profiles, policies };
}, (event) => logger.warn({ event }, "The edited configuration is invalid; the last valid configuration stays in force."));
const initial = await configuration.current();
const delegationHarnesses = optionalEnv("SHARED_JOB_HARNESSES", "").split(",").map((name) => name.trim()).filter(Boolean);
for (const name of delegationHarnesses) {
  const harness = initial.harnesses.get(name)?.[0];
  if (!harness || harness.definition.interaction === "conversation") throw new Error("SHARED_JOB_HARNESSES must identify published batch harnesses.");
}
// With session containers deployed, `promotable` conversations can move into them one way, as can handoffs to targets
// that run in their own container.
const sessionSettings = optionalEnv("SESSION_CONTAINER_SETTINGS", "");
const sessionContainers = sessionSettings ? SessionContainerSettings.parse(JSON.parse(sessionSettings)) : undefined;
const admission = new SharedAdmission({
  configuration,
  sessionLimits: SharedSessionLimits.parse(JSON.parse(optionalEnv("SHARED_SESSION_LIMITS", "{}"))),
  delegationHarnesses,
  permissionHandlers: new Set(PERMISSION_HANDLERS.keys()),
  deployment: sharedWorkerDeployment({ promotion: !!sessionContainers, workerContainers: !!workerContainers }),
  ...(sessionContainers ? { sessionContainers: { idleSeconds: sessionContainers.idleSeconds } } : {}),
});
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);
const store = new SharedStore(pool);
const jobs = new JobStore(pool);
const delegations = new DelegationStore(pool, store, jobs);
const allocations = new AllocationStore(pool, store);
const workers = workerContainers ? new WorkerStore(pool, store, allocations) : undefined;
const jobAdmissions = new WeakMap<SharedRegistry, Admission>();
const port = listenPort(8083);
// Shared egress also refuses this deployment's own listeners: this worker and the connection broker.
const ownListeners = [optionalEnv("SHARED_WORKER_URL", ""), optionalEnv("CONNECTION_BROKER_URL", "")].filter(Boolean).map((value) => {
  const url = new URL(value);
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port || (["https:", "wss:"].includes(url.protocol) ? 443 : 80)) };
});
const egress = createSharedEgress({
  internal: [{ host: "127.0.0.1", port }, ...ownListeners],
  report: (event, detail) => logger.info({ event, ...detail }, "shared egress"),
});
const service = new SharedSessionService({
  root: optionalEnv("SHARED_SESSION_DATA", join(process.cwd(), ".shared-session-data")),
  store, files: new SessionFileStore(pool), principals, admission, limits,
  gatewayUrl: `${serviceUrl("inference-gateway")}/openai/v1`,
  mintToken: async (lease, turn) => {
    const response = await fetch(`${serviceUrl("job-dispatcher")}/internal/shared/grant`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-key": key },
      body: JSON.stringify({ lease, turnId: turn.id }), redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Shared inference grant was refused (${response.status}).`);
    return z.object({ token: z.string().min(1) }).strict().parse(await response.json()).token;
  },
  report: (event, id) => logger.info({ event, session: id || undefined }, "shared session lifecycle"),
  toolkit: {
    egress,
    delegation: {
      admission: async () => {
        const registry = await configuration.current();
        let current = jobAdmissions.get(registry);
        if (!current) {
          current = new Admission({ harnesses: new Map(registry.harnesses), profiles: new Map(registry.profiles), policies: registry.policies });
          jobAdmissions.set(registry, current);
        }
        return current;
      },
      profiles: async () => (await configuration.current()).profiles,
      jobs, delegations, maxOpenJobs: initial.policies.base.maxQueuedJobsPerPrincipal,
    },
    ...(workers && workerContainers ? {
      workers: {
        workers, registry: () => configuration.current(), features: WORKER_CONTAINER_FEATURES,
        deploymentLimit: Math.max(1, limits.executionContainers),
        containers: { limits, startupSeconds: workerContainers.startupSeconds },
      },
    } : {}),
  },
  permissionHandlers: PERMISSION_HANDLERS,
  handoffs: new HandoffStore(pool, store),
  ...(sessionContainers ? { promotion: { store: new PromotionStore(pool, store, allocations), settings: sessionContainers } } : {}),
});
const app = buildSharedHost(service, key, brokerKey);
const completions = new CompletionPump(service, delegations, jobs, logger);
const workerInbox = workers ? new WorkerInboxPump(service, workers, logger) : undefined;
app.addHook("preClose", async () => {
  await completions.stop();
  await workerInbox?.stop();
});
app.addHook("onClose", async () => { await pool.end(); });
await service.start();
completions.start();
workerInbox?.start();
await listen(app, port);
