import { join } from "node:path";
import { z } from "zod";
import { SharedPrincipalBindings, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import { DelegationStore, JobStore, migrate, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import {
  Admission, assertOverridesMatchHarnesses, createLogger, createPostgresPool, listen, listenPort, loadHarnesses, loadProfiles,
  loadPolicySet, optionalEnv, readPostgresConnection, requireEnv, serviceUrl,
} from "@copilot-agent/service-defaults";
import { SharedAdmission } from "./admission.js";
import { CompletionPump } from "./completions.js";
import { SharedConfiguration, type SharedRegistry } from "./configuration.js";
import { PERMISSION_HANDLERS } from "./permission-handlers.js";
import { buildSharedHost } from "./server.js";
import { SharedSessionService } from "./service.js";
import { createSharedEgress } from "./shared-egress.js";

const logger = createLogger("session-host");
const key = requireEnv("SHARED_WORKER_KEY");
const principals = SharedPrincipalBindings.parse(JSON.parse(requireEnv("SHARED_PRINCIPALS")));
const limits = SharedWorkerLimits.parse(JSON.parse(optionalEnv("SHARED_WORKER_LIMITS", "{}")));
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
const admission = new SharedAdmission({
  configuration,
  sessionLimits: SharedSessionLimits.parse(JSON.parse(optionalEnv("SHARED_SESSION_LIMITS", "{}"))),
  delegationHarnesses,
  permissionHandlers: new Set(PERMISSION_HANDLERS.keys()),
});
const pool = await createPostgresPool(readPostgresConnection("jobsdb"));
await migrate(pool);
const store = new SharedStore(pool);
const jobs = new JobStore(pool);
const delegations = new DelegationStore(pool, store, jobs);
const jobAdmissions = new WeakMap<SharedRegistry, Admission>();
const publicUrl = () => requireEnv("SHARED_PUBLIC_URL");
const egress = createSharedEgress({
  internal: [{ host: "127.0.0.1", port: Number(new URL(publicUrl()).port) }],
  report: (event, detail) => logger.info({ event, ...detail }, "shared egress"),
});
const service = new SharedSessionService({
  root: optionalEnv("SHARED_SESSION_DATA", join(process.cwd(), ".shared-session-data")),
  store, files: new SessionFileStore(pool), principals, admission, limits,
  gatewayUrl: `${serviceUrl("inference-gateway")}/openai/v1`,
  publicUrl,
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
  },
  permissionHandlers: PERMISSION_HANDLERS,
});
const app = buildSharedHost(service, key);
const completions = new CompletionPump(service, delegations, jobs, logger);
app.addHook("preClose", async () => { await completions.stop(); });
app.addHook("onClose", async () => { await pool.end(); });
await service.start();
completions.start();
await listen(app, listenPort(8083));
