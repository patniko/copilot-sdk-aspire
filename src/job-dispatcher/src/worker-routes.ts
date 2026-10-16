import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  policyFor, SessionContainerHeartbeat, WorkerAuthorityApplied, WorkerDeliveredReport, WorkerFailureReport, WorkerInputCreation,
  WorkerTurnFinishReport, WorkerTurnStartReport,
  type PolicySet, type SessionContainerHeartbeatResult, type WorkerAuthorityGrant, type WorkerContainerSpec, type WorkerControl,
  type WorkerInputPoll,
} from "@copilot-agent/contracts";
import { StoreError, type AllocationStore, type WorkerStore } from "@copilot-agent/job-store";
import { HttpError, signSessionCapability } from "@copilot-agent/service-defaults";

export interface WorkerDispatcherDependencies {
  allocations: AllocationStore;
  workers: WorkerStore;
  policies: PolicySet;
  heartbeatSeconds: number;
}

const Empty = z.object({}).strict();
const Poll = z.object({ id: z.string().uuid() }).strict();
const Grant = z.object({ grantId: z.string().uuid() }).strict();
const Applied = WorkerAuthorityApplied.extend({ grantId: z.string().uuid() }).strict();

/**
 * Routes for orchestrator worker containers (docs/HOSTING-MODES-PLAN.md, section 7.4). Each authenticates the
 * container's allocation credential, which is bound to exactly one worker: the container reads only its worker's spec,
 * messages, and authority grants, reports only its worker's turns and requests, and obtains inference grants against
 * only its worker's reservation. A worker container has no client listener, so readiness carries no server key.
 */
export function registerWorkerRoutes(app: FastifyInstance, deps: WorkerDispatcherDependencies, signingKey: string): void {
  const container = async (request: FastifyRequest) => {
    const presented = request.headers["x-internal-key"];
    const allocation = typeof presented === "string" && presented.length >= 32 && presented.length <= 200
      ? await deps.allocations.authenticate(presented) : undefined;
    if (!allocation || allocation.kind !== "worker") throw new HttpError(401, "unauthenticated", "Service authentication failed.");
    return allocation;
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid worker container request.");
    return parsed.data;
  };
  const perform = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) {
      if (error instanceof StoreError) {
        throw new HttpError({ not_found: 404, quota_exceeded: 429, invalid_request: 400, invalid_state: 409, idempotency_conflict: 409 }[error.code], error.code, error.message);
      }
      throw error;
    }
  };
  const route = <T>(path: string, handler: (allocation: Awaited<ReturnType<typeof container>>, body: unknown) => Promise<T>) =>
    app.post(`/internal/workers/${path}`, async (request, reply) => {
      const allocation = await container(request);
      reply.header("cache-control", "no-store");
      return handler(allocation, request.body ?? {});
    });

  route("spec", async (allocation): Promise<WorkerContainerSpec> => perform(() => deps.workers.spec(allocation.id, deps.heartbeatSeconds)));
  route("ready", async (allocation, body) => {
    parse(Empty, body);
    await perform(() => deps.allocations.ready(allocation.id));
    return { ready: true };
  });
  route("heartbeat", async (allocation, body): Promise<SessionContainerHeartbeatResult> =>
    deps.allocations.containerHeartbeat(allocation.id, parse(SessionContainerHeartbeat, body)));
  route("token", async (allocation) => {
    const grant = await perform(() => deps.workers.grant(allocation.id));
    const policy = policyFor(deps.policies, grant.policyHarness);
    if (!grant.models.every((model) => policy.allowedModels.includes(model))) {
      throw new HttpError(409, "policy_revoked", "The worker's models are no longer approved by the operator policy.");
    }
    return { token: await signSessionCapability(signingKey, {
      sub: grant.workerId, jti: grant.jti, session: grant.workerId, epoch: grant.allocationId, prn: grant.principal,
      mdl: grant.models, tok: grant.remainingTokens, expiresAt: grant.expiresAt,
    }) };
  });
  route("control", async (allocation, body): Promise<WorkerControl> => {
    parse(Empty, body);
    return perform(() => deps.workers.control(allocation.workerId));
  });
  route("messages/delivered", async (allocation, body) => {
    const { ids } = parse(WorkerDeliveredReport, body);
    await perform(() => deps.workers.messagesDelivered(allocation.workerId, ids));
    return { recorded: true };
  });
  route("turns/started", async (allocation, body) => {
    const { turnId } = parse(WorkerTurnStartReport, body);
    await perform(() => deps.workers.turnStarted(allocation.workerId, turnId));
    return { recorded: true };
  });
  route("turns/finished", async (allocation, body) => {
    const { turnId, ...outcome } = parse(WorkerTurnFinishReport, body);
    await perform(() => deps.workers.turnFinished(allocation.workerId, turnId, outcome));
    return { recorded: true };
  });
  route("failed", async (allocation, body) => {
    const { message } = parse(WorkerFailureReport, body);
    await perform(() => deps.workers.failed(allocation.workerId, message));
    return { recorded: true };
  });
  route("input-requests", async (allocation, body) => {
    const input = parse(WorkerInputCreation, body);
    return perform(() => deps.workers.createInputRequest(allocation.workerId, input.turnId, input.runtimeRequestId, input.request));
  });
  route("input-requests/poll", async (allocation, body): Promise<WorkerInputPoll> => {
    const { id } = parse(Poll, body);
    const result = await perform(() => deps.workers.pollInputRequest(allocation.workerId, id));
    if (!result) throw new HttpError(404, "not_found", "The input request was not found.");
    return result;
  });
  route("authority", async (allocation, body): Promise<WorkerAuthorityGrant> => {
    const { grantId } = parse(Grant, body);
    const grant = await perform(() => deps.workers.authorityGrant(allocation.workerId, grantId));
    if (!grant) throw new HttpError(404, "not_found", "The authority grant was not found.");
    return grant;
  });
  route("authority/applied", async (allocation, body) => {
    const { grantId, ...counts } = parse(Applied, body);
    await perform(() => deps.workers.authorityApplied(allocation.workerId, grantId, counts));
    return { recorded: true };
  });
}
