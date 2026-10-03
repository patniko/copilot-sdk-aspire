import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chown, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  JsonLineDecoder,
  requiredRunnerCapabilities,
  RUNNER_MAX_LINE_BYTES,
  RUNNER_PROTOCOL_VERSION,
  RunnerToExecutor,
  type ExecutionProfile,
  type ExecutorToRunner,
  type RunnerEventBody,
} from "@copilot-agent/contracts";
import { createAjv, type Logger } from "@copilot-agent/service-defaults";
import { LeaseLostError, type ClaimResponse, type DispatcherClient, type Outcome } from "./dispatcher-client.js";
import type { IsolationSettings } from "./isolation.js";

export interface AttemptContext {
  claim: ClaimResponse;
  profile: ExecutionProfile;
  dispatcher: DispatcherClient;
  isolation: IsolationSettings;
  configRoot: string;
  workspaceRoot: string;
  gatewayBaseUrl: string;
  imageDigest?: string;
  logger: Logger;
  /** Aborted when the executor is shutting down. */
  shutdown: AbortSignal;
  /**
   * Aborted as soon as the executor starts draining. Container platforms may signal every process in the
   * container at that moment, so a runner that dies then is reported as executor loss, not a runner fault.
   */
  draining?: AbortSignal;
}

const HELLO_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 15_000;
const REQUIRED_RUNNER_CAPABILITIES = ["cancel", "structured-result"];

const ajv = createAjv();

/**
 * Runs one attempt: prepares a private workspace, launches the profile's runner as an unprivileged
 * process with a minimal environment, speaks runner protocol v1, renews the lease, and propagates
 * cancellation and deadlines. Returns undefined when ownership was lost and no completion may be sent.
 */
export async function runAttempt(ctx: AttemptContext): Promise<Outcome | undefined> {
  const { claim, profile, logger } = ctx;
  const log = logger.child({ job: claim.job.id, attempt: claim.attempt.number, profile: profile.id });
  const workspace = join(ctx.workspaceRoot, claim.attempt.id);
  await prepareWorkspace(workspace, ctx.isolation);

  let child: ChildProcessWithoutNullStreams | undefined;
  let outcome: Outcome | undefined;
  let leaseLost = false;
  let cancelSent = false;
  let killTimer: NodeJS.Timeout | undefined;
  const pendingEvents: RunnerEventBody[] = [];
  const stderrTail: string[] = [];

  const send = (message: ExecutorToRunner) => {
    if (child && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };
  const kill = () => {
    if (!child || child.exitCode !== null) {
      return;
    }
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
  };
  const requestStop = (reason: string, finalOutcome: Outcome) => {
    if (cancelSent) {
      return;
    }
    cancelSent = true;
    outcome ??= finalOutcome;
    log.info({ reason }, "stopping runner");
    send({ type: "cancel", reason });
    killTimer = setTimeout(kill, CANCEL_GRACE_MS);
  };

  try {
    child = spawnRunner(ctx, workspace);
    const exited = new Promise<number | null>((resolveExit) => {
      child!.on("close", (code) => resolveExit(code));
      child!.on("error", (error) => {
        log.error({ err: error }, "runner failed to start");
        resolveExit(-1);
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail.push(chunk);
      while (stderrTail.join("").length > 4096) {
        stderrTail.shift();
      }
    });

    let helloReceived = false;
    const helloTimer = setTimeout(() => {
      if (!helloReceived) {
        outcome ??= protocolFailure("The runner did not announce itself.");
        kill();
      }
    }, HELLO_TIMEOUT_MS);

    const decoder = new JsonLineDecoder(RUNNER_MAX_LINE_BYTES);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = line === null ? undefined : safeParse(line);
        if (!message) {
          outcome ??= protocolFailure("The runner sent an invalid protocol message.");
          kill();
          return;
        }
        switch (message.type) {
          case "hello": {
            if (helloReceived) {
              break;
            }
            helloReceived = true;
            clearTimeout(helloTimer);
            const missing = [...REQUIRED_RUNNER_CAPABILITIES, ...requiredRunnerCapabilities(claim.job.harness.definition)].filter(
              (c) => !message.capabilities.includes(c),
            );
            if (message.protocol !== RUNNER_PROTOCOL_VERSION || missing.length > 0) {
              outcome ??= protocolFailure(`Runner is incompatible (missing: ${missing.join(", ") || "protocol"}).`);
              kill();
              return;
            }
            ctx.dispatcher
              .provenance(claim.attempt.id, claim.attempt.leaseToken, {
                runner: message.runner,
                capabilities: message.capabilities,
                profile: profile.id,
                imageDigest: ctx.imageDigest,
              })
              .catch((error) => log.warn({ err: error }, "provenance not recorded"));
            send({
              type: "start",
              protocol: RUNNER_PROTOCOL_VERSION,
              job: { id: claim.job.id, attempt: claim.attempt.number, principal: claim.job.principal },
              harness: claim.job.harness,
              profile: profile.id,
              input: claim.job.input,
              deadline: claim.attempt.deadline,
              inference: { baseUrl: ctx.gatewayBaseUrl, token: claim.inference.token, model: claim.inference.model },
              workspace,
            });
            break;
          }
          case "event":
            pendingEvents.push(message.event);
            break;
          case "result": {
            const validate = ajv.compile(claim.job.harness.definition.output.schema);
            outcome ??= validate(message.output)
              ? { kind: "succeeded", output: message.output }
              : {
                  kind: "failed",
                  code: "invalid_output",
                  message: "The runner result does not match the harness output schema.",
                  retryable: false,
                  uncertainEffects: false,
                };
            break;
          }
          case "failure":
            outcome ??=
              message.code === "cancelled"
                ? { kind: "cancelled" }
                : {
                    kind: "failed",
                    code: message.code,
                    message: message.message,
                    retryable: message.retryable,
                    uncertainEffects: message.uncertainEffects,
                  };
            break;
        }
      }
    });

    // Lease renewal, cancellation propagation, and event delivery.
    let lastRenewal = Date.now();
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const status = await ctx.dispatcher.heartbeat(claim.attempt.id, claim.attempt.leaseToken);
          lastRenewal = Date.now();
          if (status.cancelRequested) {
            requestStop("cancel requested", { kind: "cancelled" });
          }
        } catch (error) {
          if (error instanceof LeaseLostError) {
            leaseLost = true;
            log.warn("lease lost; terminating runner");
            kill();
          } else if (Date.now() - lastRenewal > claim.leaseSeconds * 1000) {
            leaseLost = true;
            log.error({ err: error }, "lease could not be renewed in time; terminating runner");
            kill();
          }
        }
      })();
    }, claim.heartbeatSeconds * 1000);

    const flush = setInterval(() => void flushEvents(), 500);
    const flushEvents = async () => {
      if (pendingEvents.length === 0 || leaseLost) {
        return;
      }
      const batch = pendingEvents.splice(0, 100);
      try {
        await ctx.dispatcher.events(claim.attempt.id, claim.attempt.leaseToken, batch);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          leaseLost = true;
          kill();
        }
      }
    };

    const deadlineMs = new Date(claim.attempt.deadline).getTime() - Date.now();
    const deadlineTimer = setTimeout(
      () =>
        requestStop("deadline", {
          kind: "failed",
          code: "deadline_exceeded",
          message: "The attempt exceeded its deadline.",
          retryable: false,
          uncertainEffects: false,
        }),
      Math.max(1_000, deadlineMs),
    );
    const onShutdown = () =>
      requestStop("executor shutdown", {
        kind: "failed",
        code: "executor_lost",
        message: "The executor shut down during the attempt.",
        retryable: true,
        uncertainEffects: true,
      });
    ctx.shutdown.addEventListener("abort", onShutdown, { once: true });

    const exitCode = await exited;
    clearInterval(heartbeat);
    clearInterval(flush);
    clearTimeout(deadlineTimer);
    clearTimeout(helloTimer);
    if (killTimer) {
      clearTimeout(killTimer);
    }
    ctx.shutdown.removeEventListener("abort", onShutdown);
    await flushEvents();

    if (leaseLost) {
      return undefined;
    }
    if (!outcome) {
      const draining = ctx.draining?.aborted || ctx.shutdown.aborted;
      log.warn({ exitCode, draining, stderr: stderrTail.join("").slice(-1000) }, "runner exited without a result");
      outcome = draining
        ? {
            kind: "failed",
            code: "executor_lost",
            message: "The executor shut down during the attempt.",
            retryable: true,
            uncertainEffects: true,
          }
        : {
            kind: "failed",
            code: "runner_exited",
            message: `The runner exited (code ${exitCode}) without reporting a result.`,
            retryable: true,
            uncertainEffects: true,
          };
    }
    return outcome;
  } finally {
    kill();
    await rm(workspace, { recursive: true, force: true }).catch((error) =>
      log.warn({ err: error }, "workspace cleanup failed"),
    );
  }
}

function spawnRunner(ctx: AttemptContext, workspace: string): ChildProcessWithoutNullStreams {
  const { profile, isolation } = ctx;
  const expand = (value: string) => value.replaceAll("{root}", ctx.configRoot);
  const env: Record<string, string> = {
    PATH: process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/local/bin:/usr/bin:/bin",
    HOME: join(workspace, "home"),
    TMPDIR: join(workspace, "tmp"),
    TMP: join(workspace, "tmp"),
    TEMP: join(workspace, "tmp"),
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    NODE_ENV: "production",
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "windir", "ComSpec", "PATHEXT", "LOCALAPPDATA", "APPDATA"]) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(profile.entrypoint.env)) {
    env[key] = expand(value);
  }
  return spawn(expand(profile.entrypoint.command), profile.entrypoint.args.map(expand), {
    cwd: resolve(ctx.configRoot, profile.entrypoint.directory),
    env,
    uid: isolation.processIsolation === "uid" ? isolation.uid : undefined,
    gid: isolation.processIsolation === "uid" ? isolation.gid : undefined,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function prepareWorkspace(workspace: string, isolation: IsolationSettings): Promise<void> {
  for (const dir of [workspace, join(workspace, "home"), join(workspace, "tmp")]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (isolation.processIsolation === "uid" && isolation.uid !== undefined && isolation.gid !== undefined) {
      await chown(dir, isolation.uid, isolation.gid);
    }
  }
}

function safeParse(line: string) {
  try {
    const parsed = RunnerToExecutor.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function protocolFailure(message: string): Outcome {
  return { kind: "failed", code: "protocol_error", message, retryable: false, uncertainEffects: false };
}
