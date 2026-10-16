import {
  ExecutorCapabilities,
  ArtifactData,
  InputRequestBody,
  JobErrorCode,
  modelOptionViolations,
  type PolicySet,
  policyFor,
  RUNNER_REQUEST_ID,
  RunnerEventBody,
  securityRequirementsOf,
  toolPolicyViolations,
  type ExecutionPolicy,
} from "@copilot-agent/contracts";
import type { AllocationStore, DelegationStore, AttemptOutcome, Claim, JobStore, HostStore } from "@copilot-agent/job-store";
import { createService, HttpError, requireInternalKey, secretsEqual, signCapability } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerHostRoutes, type HostDependencies } from "./host-routes.js";
import { registerSharedRoutes, type SharedDispatcherDependencies } from "./shared-routes.js";
import { registerBrokerRoutes, type BrokerDispatcherDependencies } from "./broker-routes.js";
import { registerSessionContainerRoutes, type SessionContainerDispatcherDependencies } from "./session-container-routes.js";
import { registerWorkerRoutes, type WorkerDispatcherDependencies } from "./worker-routes.js";

export interface DispatcherDependencies {
  store: JobStore;
  /** Base policy plus per-harness overrides. Lease timing and per-caller limits come from the base policy. */
  policies: PolicySet;
  executorKey: string;
  gatewayKey: string;
  signingKey: string;
  hostStore?: HostStore;
  host?: HostDependencies;
  shared?: SharedDispatcherDependencies;
  /** Ticket consumption and placement lookup for the connection broker. */
  broker?: BrokerDispatcherDependencies;
  /** Allocation-authenticated routes and inference grants for resumable session containers. */
  sessionContainers?: SessionContainerDispatcherDependencies;
  /** Allocation-authenticated routes and inference grants for orchestrator worker containers. */
  workers?: WorkerDispatcherDependencies;
  allocations?: AllocationStore;
  delegations?: DelegationStore;
}

/**
 * Why a claimed job may no longer run under its harness's current effective policy, if anything.
 * Narrowing a policy after admission takes effect for queued work; widening never applies retroactively.
 */
export function policyRevocation(job: Claim["job"], policy: ExecutionPolicy): string | undefined {
  const definition = job.harness.definition;
  if (!policy.allowedProfiles.includes(job.profile)) {
    return `Profile '${job.profile}' is no longer approved by the operator policy.`;
  }
  if (!policy.allowedModels.includes(job.model)) {
    return `Model '${job.model}' is no longer approved by the operator policy.`;
  }
  const agent = (definition.agents ?? []).find((a) => a.model && !policy.allowedModels.includes(a.model));
  if (agent) {
    return `Sub-agent '${agent.name}' uses a model that is no longer approved by the operator policy.`;
  }
  const problems = [...modelOptionViolations(definition, policy), ...toolPolicyViolations(definition, policy)];
  return problems[0]?.message;
}

const LeaseBody = z.object({ leaseToken: z.string().min(16).max(200) }).strict();

const EventsBody = z
  .object({ leaseToken: z.string().min(16).max(200), events: z.array(RunnerEventBody).min(1).max(100) })
  .strict();

const CreateInputRequestBody = z
  .object({
    leaseToken: z.string().min(16).max(200),
    runnerRequestId: z.string().regex(RUNNER_REQUEST_ID),
    request: InputRequestBody,
  })
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
    requestId: z.string().uuid().optional(),
    jti: z.string().uuid(),
    model: z.string().max(200),
    inputTokens: z.number().int().min(0).max(10_000_000),
    outputTokens: z.number().int().min(0).max(10_000_000),
    usageKnown: z.boolean().optional(),
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
  const policy = deps.policies.base;
  const defaults = securityRequirementsOf(policy);
  const approvedProfiles = new Set([
    ...policy.allowedProfiles,
    ...[...deps.policies.overrides.values()].flatMap((o) => o.overrides.allowedProfiles ?? []),
  ]);
  const waitingThresholdSeconds = Math.max(60, policy.leaseSeconds * 2);
  let lastWaitingCheck = 0;
  if (deps.host) registerHostRoutes(app, deps.host);
  if (deps.shared) registerSharedRoutes(app, deps.shared, deps.signingKey, policy.allowedModels);
  if (deps.broker) registerBrokerRoutes(app, deps.broker);
  if (deps.sessionContainers) registerSessionContainerRoutes(app, deps.sessionContainers, deps.signingKey);
  if (deps.workers) registerWorkerRoutes(app, deps.workers, deps.signingKey);
  const heartbeatSeconds = Math.max(3, Math.floor(policy.leaseSeconds / 3));

  const executorOnly = async (request: FastifyRequest) => {
    const presented = request.headers["x-internal-key"];
    if (typeof presented !== "string") throw new HttpError(401, "unauthenticated", "Service authentication failed.");
    if (secretsEqual(presented, deps.executorKey)) return undefined;
    const allocation = await deps.allocations?.authenticate(presented);
    if (!allocation || allocation.kind !== "job") throw new HttpError(401, "unauthenticated", "Service authentication failed.");
    const id = (request.params as { id?: string }).id;
    if (id && (!z.string().uuid().safeParse(id).success || !(await deps.allocations!.ownsAttempt(allocation.id, id)))) {
      throw new HttpError(403, "forbidden", "This allocation does not own the attempt.");
    }
    return allocation;
  };
  const gatewayOnly = (request: FastifyRequest) => requireInternalKey(request, deps.gatewayKey);
  const attemptIdOf = (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (!z.string().uuid().safeParse(id).success) {
      throw new HttpError(404, "not_found", "Attempt not found.");
    }
    return id;
  };

  app.post("/internal/executor/claim", async (request, reply) => {
    const allocation = await executorOnly(request);
    const executor = parse(ExecutorCapabilities, request.body);
    if (allocation && executor.executorId !== allocation.id) throw new HttpError(403, "forbidden", "The executor identity must match its allocation.");
    if (allocation?.attemptId) return reply.status(410).send({ error: { code: "allocation_used", message: "This one-shot allocation has already claimed its attempt." } });
    const eligibleProfiles = executor.profiles.filter((p) => approvedProfiles.has(p));
    if (eligibleProfiles.length === 0) {
      return reply.status(204).send();
    }
    const eligibleExecutor = { ...executor, profiles: eligibleProfiles };
    const claim = await deps.store.claimNext({
      executor: eligibleExecutor,
      leaseSeconds: policy.leaseSeconds,
      maxConcurrentPerPrincipal: policy.maxConcurrentAttemptsPerPrincipal,
      defaults,
      allocationId: allocation?.id,
    });
    if (!claim) {
      if (Date.now() - lastWaitingCheck > 10_000) {
        lastWaitingCheck = Date.now();
        const waiting = await deps.store.reportJobsWaitingForEligibleExecutor({
          executor: eligibleExecutor,
          defaults,
          olderThanSeconds: waitingThresholdSeconds,
        });
        for (const job of waiting) {
          request.log.warn({ job: job.jobId, executor: executor.executorId, missing: job.missing }, "job waiting for an eligible executor");
        }
      }
      return reply.status(204).send();
    }
    const current = policyFor(deps.policies, claim.job.harness.definition.name);
    const revoked = policyRevocation(claim.job, current);
    if (revoked) {
      await deps.store.completeAttempt(
        claim.attempt.id,
        claim.attempt.leaseToken,
        { kind: "failed", code: "policy_revoked", message: revoked, retryable: false, uncertainEffects: false },
        policy.retry.backoffSeconds,
      );
      request.log.warn({ job: claim.job.id, reason: revoked }, "claimed job no longer allowed by its effective policy");
      return reply.status(204).send();
    }
    const capabilityToken = await signCapability(deps.signingKey, {
      attemptId: claim.attempt.id,
      jti: claim.capability.jti,
      jobId: claim.job.id,
      attempt: claim.attempt.number,
      principal: claim.job.principal,
      models: [...new Set([claim.job.model, ...(claim.job.harness.definition.agents ?? []).flatMap((a) => (a.model ? [a.model] : []))])],
      tokenBudget: Math.max(1, claim.capability.tokenBudget),
      expiresAt: claim.capability.expiresAt,
    });
    request.log.info(
      { job: claim.job.id, attempt: claim.attempt.number, executor: executor.executorId, gaps: claim.attempt.acknowledgedGaps },
      "attempt claimed",
    );
    return {
      job: { ...claim.job, ...(allocation && deps.delegations ? { artifacts: { inputs: await deps.delegations.inputs(claim.job.id) } } : {}) },
      attempt: claim.attempt,
      inference: { token: capabilityToken, model: claim.job.model },
      leaseSeconds: policy.leaseSeconds,
      heartbeatSeconds,
    };
  });

  app.post("/internal/attempts/:id/heartbeat", async (request, reply) => {
    await executorOnly(request);
    const { leaseToken } = parse(LeaseBody, request.body);
    const result = await deps.store.heartbeat(attemptIdOf(request), leaseToken, policy.leaseSeconds);
    if (!result) {
      return reply.status(409).send({ error: { code: "lease_lost", message: "The attempt is no longer owned." } });
    }
    return result;
  });

  app.post("/internal/attempts/:id/provenance", async (request, reply) => {
    await executorOnly(request);
    const body = parse(ProvenanceBody, request.body);
    const ok = await deps.store.recordProvenance(attemptIdOf(request), body.leaseToken, body.provenance);
    return ok ? { ok } : reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt." } });
  });

  app.post("/internal/attempts/:id/events", async (request, reply) => {
    await executorOnly(request);
    const body = parse(EventsBody, request.body);
    const attemptId = attemptIdOf(request);
    for (const event of body.events) {
      if (!(await deps.store.appendRunnerEvent(attemptId, body.leaseToken, event))) {
        return reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt." } });
      }
    }
    return { ok: true };
  });

  app.post("/internal/attempts/:id/input-requests", async (request, reply) => {
    await executorOnly(request);
    const body = parse(CreateInputRequestBody, request.body);
    try {
      const created = await deps.store.createInputRequest(
        attemptIdOf(request),
        body.leaseToken,
        body.runnerRequestId,
        body.request,
      );
      if (!created) {
        return reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt." } });
      }
      return reply.status(201).send(created);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "quota_exceeded") {
        return reply.status(429).send({ error: { code: "quota_exceeded", message: error.message } });
      }
      throw error;
    }
  });

  app.post("/internal/attempts/:id/input-requests/:requestId/poll", async (request, reply) => {
    await executorOnly(request);
    const { leaseToken } = parse(LeaseBody, request.body);
    const requestId = (request.params as { requestId: string }).requestId;
    if (!z.string().uuid().safeParse(requestId).success) {
      throw new HttpError(404, "not_found", "Input request not found.");
    }
    const result = await deps.store.pollInputRequest(attemptIdOf(request), leaseToken, requestId);
    if (result === undefined) {
      return reply.status(409).send({ error: { code: "lease_lost", message: "Stale attempt." } });
    }
    if (result === null) {
      throw new HttpError(404, "not_found", "Input request not found.");
    }
    return result;
  });

  app.post("/internal/attempts/:id/complete", async (request, reply) => {
    await executorOnly(request);
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
    const result = await deps.store.introspectCapability(jti);
    if (result.reason === "unknown" && deps.shared) {
      const shared = await deps.shared.store.introspect(jti, undefined, policy.allowedModels);
      if (shared.reason !== "unknown") return shared;
    }
    if (result.reason === "unknown" && deps.sessionContainers) {
      const container = await deps.sessionContainers.store.introspect(jti);
      if (container.reason !== "unknown") return container;
    }
    if (result.reason === "unknown" && deps.workers) {
      const worker = await deps.workers.workers.introspect(jti);
      if (worker.reason !== "unknown") return worker;
    }
    return result.reason === "unknown" && deps.hostStore ? deps.hostStore.introspect(jti) : result;
  });

  app.post("/internal/attempts/:id/artifacts", async (request) => {
    await executorOnly(request);
    if (!deps.delegations) throw new HttpError(409, "artifacts_unavailable", "Delegated artifact storage is unavailable.");
    const body = parse(LeaseBody.extend({ artifact: ArtifactData }), request.body);
    return deps.delegations.publishArtifact(attemptIdOf(request), body.leaseToken, body.artifact);
  });

  app.post("/internal/capabilities/begin", async (request) => {
    gatewayOnly(request);
    const body = parse(z.object({ jti: z.string().uuid(), requestId: z.string().uuid() }).strict(), request.body);
    try {
      const shared = await deps.shared?.store.introspect(body.jti);
      return { remainingTokens: shared && shared.reason !== "unknown"
        ? await deps.shared!.store.beginInference(body.jti, body.requestId, policy.allowedModels)
        : await deps.store.beginInferenceRequest(body.jti, body.requestId) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "quota_exceeded") {
        throw new HttpError(429, "inference_busy", "The conversation already has an inference request in flight.");
      }
      throw error;
    }
  });

  app.post("/internal/capabilities/usage", async (request) => {
    gatewayOnly(request);
    const usage = parse(UsageBody, request.body);
    if (deps.shared && usage.requestId) {
      const recorded = await deps.shared.store.recordUsage(usage.jti, usage.requestId, usage.inputTokens, usage.outputTokens, usage.usageKnown ?? true);
      if (recorded) return { recorded };
    }
    if (deps.hostStore && usage.requestId) {
      const recorded = await deps.hostStore.recordUsage(usage.jti, usage.requestId, usage.inputTokens, usage.outputTokens);
      if (recorded) return { recorded };
    }
    if (deps.sessionContainers && usage.requestId) {
      const recorded = await deps.sessionContainers.store.recordUsage(usage.jti, usage.requestId, usage.inputTokens, usage.outputTokens);
      if (recorded) return { recorded };
    }
    if (deps.workers && usage.requestId) {
      const recorded = await deps.workers.workers.recordUsage(usage.jti, usage.requestId, usage.inputTokens, usage.outputTokens);
      if (recorded) return { recorded };
    }
    return { recorded: await deps.store.recordUsage(usage.jti, usage.inputTokens, usage.outputTokens, usage.requestId, usage.usageKnown ?? true) };
  });

  return app;
}
