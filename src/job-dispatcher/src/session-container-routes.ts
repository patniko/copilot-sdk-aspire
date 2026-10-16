import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  policyFor, SessionContainerHeartbeat, SessionContainerReady,
  type PolicySet, type SessionContainerHeartbeatResult, type SessionContainerSpec,
} from "@copilot-agent/contracts";
import { StoreError, type AllocationStore, type SessionContainerStore } from "@copilot-agent/job-store";
import { HttpError, signSessionCapability } from "@copilot-agent/service-defaults";
import type { z } from "zod";

export interface SessionContainerDispatcherDependencies {
  allocations: AllocationStore;
  store: SessionContainerStore;
  policies: PolicySet;
  heartbeatSeconds: number;
}

/**
 * Routes for session containers. Each authenticates the container's allocation credential, which is bound to one
 * session: the container can read only its own session's spec, publish its own readiness and liveness, and obtain
 * inference grants for its own session budget. Client tickets are consumed by the connection broker, not here.
 */
export function registerSessionContainerRoutes(app: FastifyInstance, deps: SessionContainerDispatcherDependencies, signingKey: string): void {
  const container = async (request: FastifyRequest) => {
    const presented = request.headers["x-internal-key"];
    const allocation = typeof presented === "string" && presented.length >= 32 && presented.length <= 200
      ? await deps.allocations.authenticate(presented) : undefined;
    if (!allocation || allocation.kind !== "session") throw new HttpError(401, "unauthenticated", "Service authentication failed.");
    return allocation;
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid session container request.");
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

  app.post("/internal/session-containers/spec", async (request, reply): Promise<SessionContainerSpec> => {
    const allocation = await container(request);
    reply.header("cache-control", "no-store");
    return perform(() => deps.store.spec(allocation.id, deps.heartbeatSeconds));
  });
  app.post("/internal/session-containers/ready", async (request) => {
    const allocation = await container(request);
    const body = parse(SessionContainerReady, request.body);
    await perform(() => deps.allocations.ready(allocation.id, body.serverKey));
    return { ready: true };
  });
  app.post("/internal/session-containers/heartbeat", async (request): Promise<SessionContainerHeartbeatResult> => {
    const allocation = await container(request);
    return deps.allocations.containerHeartbeat(allocation.id, parse(SessionContainerHeartbeat, request.body));
  });
  app.post("/internal/session-containers/token", async (request, reply) => {
    const allocation = await container(request);
    reply.header("cache-control", "no-store");
    const grant = await perform(() => deps.store.grant(allocation.id));
    const policy = policyFor(deps.policies, grant.harness.definition.name);
    if (!grant.models.every((model) => policy.allowedModels.includes(model))) {
      throw new HttpError(409, "policy_revoked", "The session's models are no longer approved by the operator policy.");
    }
    return { token: await signSessionCapability(signingKey, {
      sub: grant.sessionId, jti: grant.jti, session: grant.sessionId, epoch: grant.allocationId, prn: grant.principal,
      mdl: grant.models, tok: grant.remainingTokens, expiresAt: grant.expiresAt,
    }) };
  });
}
