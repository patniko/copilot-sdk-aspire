import {
  ExecutorCapabilities,
  JobErrorCode,
  RunnerEventBody,
  securityGaps,
  type ExecutionPolicy,
} from "@copilot-agent/contracts";
import type { AttemptOutcome, JobStore } from "@copilot-agent/job-store";
import { createService, HttpError, requireInternalKey, signCapability } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

export interface DispatcherDependencies {
  store: JobStore;
  policy: ExecutionPolicy;
  executorKey: string;
  gatewayKey: string;
  signingKey: string;
}

const LeaseBody = z.object({ leaseToken: z.string().min(16).max(200) }).strict();

const EventsBody = z
  .object({ leaseToken: z.string().min(16).max(200), events: z.array(RunnerEventBody).min(1).max(100) })
  .strict();

const ProvenanceBody = z
  .object({
    leaseToken: z.string().min(16).max(200),
    provenance: z
      .object({
        runner: z.object({ name: z.string(), version: z.string(), language: z.string(), sdkVersion: z.string() }),
        capabilities: z.array(z.string()),
        profile: z.string(),
        imageDigest: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const CompleteBody = z
  .object({
    leaseToken: z.string().min(16).max(200),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("succeeded"), output: z.unknown() }).strict(),
      z.object({ kind: z.literal("cancelled") }).strict(),
      z
        .object({
          kind: z.literal("failed"),
          code: JobErrorCode,
          message: z.string().max(2000),
          retryable: z.boolean(),
          uncertainEffects: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict();

const IntrospectBody = z.object({ jti: z.string().uuid() }).strict();
const UsageBody = z
  .object({
    jti: z.string().uuid(),
    model: z.string().max(200),
    inputTokens: z.number().int().min(0).max(10_000_000),
    outputTokens: z.number().int().min(0).max(10_000_000),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "invalid_request", "Invalid request body.", {
      issues: result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export function buildDispatcher(deps: DispatcherDependencies): FastifyInstance {
  const app = createService({ name: "job-dispatcher", bodyLimit: 4 * 1024 * 1024, ready: () => deps.store.ping() });
  const { policy } = deps;
  const heartbeatSeconds = Math.max(3, Math.floor(policy.leaseSeconds / 3));

  const executorOnly = (request: FastifyRequest) => requireInternalKey(request, deps.executorKey);
  const gatewayOnly = (request: FastifyRequest) => requireInternalKey(request, deps.gatewayKey);
  const attemptIdOf = (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (!z.string().uuid().safeParse(id).success) {
      throw new HttpError(404, "not_found", "Attempt not found.");
    }
    return id;
  };

  app.post("/internal/executor/claim", async (request, reply) => {
    executorOnly(request);
    const executor = parse(ExecutorCapabilities, request.body);
    const gaps = securityGaps(policy, executor);
    const unacknowledged = gaps.filter((gap) => !policy.acknowledgedGaps.includes(gap));
    if (unacknowledged.length > 0) {
      request.log.warn({ executor: executor.executorId, unacknowledged }, "executor not eligible to claim work");
      throw new HttpError(
        403,
        "executor_not_eligible",
        "The executor cannot enforce required security controls and the operator has not acknowledged the gap.",
        { gaps: unacknowledged },
      );
    }
    const eligibleProfiles = executor.profiles.filter((p) => policy.allowedProfiles.includes(p));
    if (eligibleProfiles.length === 0) {
      return reply.status(204).send();
    }
    const claim = await deps.store.claimNext({
      executor: { ...executor, profiles: eligibleProfiles },
      acknowledgedGaps: gaps,
      leaseSeconds: policy.leaseSeconds,
      maxConcurrentPerPrincipal: policy.maxConcurrentAttemptsPerPrincipal,
    });
    if (!claim) {
      return reply.status(204).send();
    }
    const capabilityToken = await signCapability(deps.signingKey, {
      attemptId: claim.attempt.id,
      jti: claim.capability.jti,
      jobId: claim.job.id,
      attempt: claim.attempt.number,
      principal: claim.job.principal,
      models: [claim.job.model],
      tokenBudget: Math.max(1, claim.capability.tokenBudget),
      expiresAt: claim.capability.expiresAt,
    });
    request.log.info(
      { job: claim.job.id, attempt: claim.attempt.number, executor: executor.executorId, gaps },
      "attempt claimed",
    );
    return {
      job: claim.job,
      attempt: claim.attempt,
      inference: { token: capabilityToken, model: claim.job.model },
      leaseSeconds: policy.leaseSeconds,
      heartbeatSeconds,
    };
  });

  app.post("/internal/attempts/:id/heartbeat", async (request, reply) => {
    executorOnly(request);
    const { leaseToken } = parse(LeaseBody, request.body);
    const result = await deps.store.heartbeat(attemptIdOf(request), leaseToken, policy.leaseSeconds);
    if (!result) {
      return reply.status(409).send({ error: { code: "lease_lost", message: "The attempt is no longer owned." } });
    }
    return result;
  });

  app.post("/internal/attempts/:id/provenance", async (request, reply) => {
    executorOnly(request);
    const body = parse(ProvenanceBody, request.body);
    const ok = await deps.store.recordProvenance(attemptIdOf(request), body.leaseToken, body.provenance);
    return ok ? { ok } : reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt." } });
  });

  app.post("/internal/attempts/:id/events", async (request, reply) => {
    executorOnly(request);
    const body = parse(EventsBody, request.body);
    const attemptId = attemptIdOf(request);
    for (const event of body.events) {
      if (!(await deps.store.appendRunnerEvent(attemptId, body.leaseToken, event))) {
        return reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt." } });
      }
    }
    return { ok: true };
  });

  app.post("/internal/attempts/:id/complete", async (request, reply) => {
    executorOnly(request);
    const body = parse(CompleteBody, request.body);
    const result = await deps.store.completeAttempt(
      attemptIdOf(request),
      body.leaseToken,
      body.outcome as AttemptOutcome,
      policy.retry.backoffSeconds,
    );
    if (!result.accepted) {
      return reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt; completion rejected." } });
    }
    request.log.info({ attempt: attemptIdOf(request), state: result.state }, "attempt completed");
    return { state: result.state };
  });

  app.post("/internal/capabilities/introspect", async (request) => {
    gatewayOnly(request);
    const { jti } = parse(IntrospectBody, request.body);
    return deps.store.introspectCapability(jti);
  });

  app.post("/internal/capabilities/usage", async (request) => {
    gatewayOnly(request);
    const usage = parse(UsageBody, request.body);
    return { recorded: await deps.store.recordUsage(usage.jti, usage.inputTokens, usage.outputTokens) };
  });

  return app;
}
