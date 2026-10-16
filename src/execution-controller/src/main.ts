import { ExecutionContainerSettings, SessionContainerSettings, SharedWorkerLimits } from "@copilot-agent/contracts";
import { AllocationStore, DelegationStore, JobStore, SharedStore, migrate } from "@copilot-agent/job-store";
import { createLogger, createPostgresPool, createService, listen, listenPort, optionalEnv, readPostgresConnection, requireEnv, serviceUrl } from "@copilot-agent/service-defaults";
import { ExecutionController } from "./controller.js";
import { registerSharedFileRoutes } from "./shared-files.js";

const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);
const shared = new SharedStore(pool);
const jobs = new JobStore(pool);
const sessions = optionalEnv("SESSION_CONTAINER_SETTINGS", "");
const controller = new ExecutionController({
  allocations: new AllocationStore(pool, shared), jobs, delegations: new DelegationStore(pool, shared, jobs),
  settings: ExecutionContainerSettings.parse(JSON.parse(requireEnv("EXECUTION_CONTAINER_SETTINGS"))),
  limits: SharedWorkerLimits.parse(JSON.parse(optionalEnv("SHARED_WORKER_LIMITS", "{}"))),
  ...(sessions ? { sessions: SessionContainerSettings.parse(JSON.parse(sessions)) } : {}),
  signingKey: requireEnv("ALLOCATION_SIGNING_KEY"),
  dispatcherUrl: serviceUrl("job-dispatcher"), gatewayUrl: serviceUrl("inference-gateway"),
  logger: createLogger("execution-controller"),
});
const app = createService({ name: "execution-controller", ready: async () => {
  if (!controller.healthy) throw new Error("Execution reconciliation is not ready.");
} });
// The shared worker reaches orchestrator conversations' shared volumes only through this service, with its own key.
const sharedFilesKey = optionalEnv("SHARED_FILES_KEY", "");
if (sharedFilesKey) {
  if (!sessions) throw new Error("The shared file service runs helpers from the session image; configure session containers.");
  registerSharedFileRoutes(app, controller, sharedFilesKey);
}
app.addHook("onClose", async () => { try { await controller.stop(); } finally { await pool.end(); } });
await controller.start();
await listen(app, listenPort(8084));
