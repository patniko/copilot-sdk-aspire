import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorCapabilities } from "@copilot-agent/contracts";
import {
  configRoot,
  createLogger,
  intEnv,
  loadProfiles,
  optionalEnv,
  requireEnv,
  serviceUrl,
} from "@copilot-agent/service-defaults";
import { runAttempt } from "./attempt.js";
import { DispatcherClient, NotEligibleError } from "./dispatcher-client.js";
import { probeIsolation } from "./isolation.js";

const logger = createLogger("agent-executor");
const root = configRoot();
const profiles = await loadProfiles(root);
const enabledProfiles = optionalEnv("EXECUTOR_PROFILES", [...profiles.keys()].join(","))
  .split(",")
  .map((p) => p.trim())
  .filter((p) => profiles.has(p));
const isolation = await probeIsolation(intEnv("RUNNER_UID", 10001), intEnv("RUNNER_GID", 10001));
const dispatcher = new DispatcherClient(serviceUrl("job-dispatcher"), requireEnv("EXECUTOR_KEY"));
const gatewayBaseUrl = `${serviceUrl("inference-gateway")}/openai/v1/`;
const workspaceRoot = optionalEnv("WORKSPACE_ROOT", join(tmpdir(), "agent-work"));
const parallelism = intEnv("EXECUTOR_PARALLELISM", 2);
const imageDigest = process.env.IMAGE_DIGEST;

const capabilities: ExecutorCapabilities = {
  executorId: optionalEnv("EXECUTOR_ID", `${hostname()}-${process.pid}`),
  imageDigest,
  profiles: enabledProfiles,
  processIsolation: isolation.processIsolation,
  egress: isolation.egress,
  platform: `${process.platform}-${process.arch}`,
};

logger.info(
  { capabilities, workspaceRoot, gateway: new URL(gatewayBaseUrl).host, parallelism },
  "agent-executor starting",
);

const shutdown = new AbortController();
let draining = false;
const active = new Set<Promise<void>>();

async function slot(index: number): Promise<void> {
  let idleDelay = 1_000;
  while (!draining) {
    try {
      const claim = await dispatcher.claim(capabilities);
      if (!claim) {
        await sleep(idleDelay);
        idleDelay = Math.min(idleDelay * 1.5, 3_000);
        continue;
      }
      idleDelay = 1_000;
      const profile = profiles.get(claim.job.profile);
      if (!profile) {
        await dispatcher.complete(claim.attempt.id, claim.attempt.leaseToken, {
          kind: "failed",
          code: "unsupported",
          message: `Profile '${claim.job.profile}' is not installed on this executor.`,
          retryable: true,
          uncertainEffects: false,
        });
        continue;
      }
      const outcome = await runAttempt({
        claim,
        profile,
        dispatcher,
        isolation,
        configRoot: root,
        workspaceRoot,
        gatewayBaseUrl,
        imageDigest,
        logger,
        shutdown: shutdown.signal,
      });
      if (outcome) {
        const state = await dispatcher.complete(claim.attempt.id, claim.attempt.leaseToken, outcome);
        logger.info(
          { job: claim.job.id, attempt: claim.attempt.number, outcome: outcome.kind, state: state ?? "stale" },
          "attempt finished",
        );
      }
    } catch (error) {
      if (error instanceof NotEligibleError) {
        logger.error({ gaps: error.gaps }, "executor is not eligible under the execution policy; not claiming work");
        await sleep(30_000);
      } else {
        logger.error({ err: error, slot: index }, "executor loop error");
        await sleep(2_000);
      }
    }
  }
}

for (let i = 0; i < parallelism; i++) {
  const task = slot(i);
  active.add(task);
  void task.finally(() => active.delete(task));
}

const stop = async (signal: string) => {
  logger.info({ signal }, "draining executor");
  draining = true;
  setTimeout(() => shutdown.abort(), 20_000).unref();
  await Promise.race([Promise.allSettled([...active]), sleep(28_000)]);
  process.exit(0);
};
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
