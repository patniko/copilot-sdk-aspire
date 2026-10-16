import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  policyFor, PromotionContainerFailure, PromotionSnapshotPageRequest, SessionContainerHeartbeat, SessionContainerReady,
  type PolicySet, type PromotionSnapshotPage, type SessionContainerHeartbeatResult, type SessionContainerReadyResult, type SessionContainerSpec,
} from "@copilot-agent/contracts";
import { StoreError, type AllocationStore, type PromotionStore, type SessionContainerStore } from "@copilot-agent/job-store";
import { HttpError, signSessionCapability } from "@copilot-agent/service-defaults";
import type { z } from "zod";

export interface SessionContainerDispatcherDependencies {
  allocations: AllocationStore;
  store: SessionContainerStore;
  policies: PolicySet;
  heartbeatSeconds: number;
  /** The promotion ledger, for containers started to promote a shared session. */
  promotions?: PromotionStore;
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
  // A container started for a promotion is ready once it has restored and resumed the session: its readiness first
  // commits the cutover, so the session's placement is this container before any client is routed here.
  app.post("/internal/session-containers/ready", async (request): Promise<SessionContainerReadyResult> => {
    const allocation = await container(request);
    const body = parse(SessionContainerReady, request.body);
    const promotion = await deps.promotions?.byAllocation(allocation.id);
    if (promotion?.state === "starting") await perform(() => deps.promotions!.commit(promotion.id, allocation.id));
    else if (promotion && promotion.state !== "committed") throw new HttpError(409, "invalid_state", "The promotion this container was started for ended.");
    await perform(() => deps.allocations.ready(allocation.id, body.serverKey));
    return { ready: true, ...(promotion ? { promoted: promotion.id } : {}) };
  });
  // The snapshot a promotion container restores, readable only by the allocation started for it and only before cutover.
  app.post("/internal/session-containers/promotion-snapshot", async (request, reply): Promise<PromotionSnapshotPage> => {
    const allocation = await container(request);
    reply.header("cache-control", "no-store");
    if (!deps.promotions) throw new HttpError(404, "not_found", "No promotion snapshot is available to this allocation.");
    const { from } = parse(PromotionSnapshotPageRequest, request.body ?? {});
    const page = await perform(() => deps.promotions!.snapshotPage(allocation.id, from));
    return { ...page, files: page.files.map((file) => ({ ordinal: file.ordinal, content: file.content.toString("base64") })) };
  });
  app.post("/internal/session-containers/promotion-failed", async (request) => {
    const allocation = await container(request);
    const body = parse(PromotionContainerFailure, request.body);
    const promotion = await deps.promotions?.byAllocation(allocation.id);
    if (!promotion || promotion.state !== "starting") throw new HttpError(404, "not_found", "No promotion is starting in this allocation.");
    await perform(() => deps.promotions!.fail(promotion.id, body.code, body.message));
    return { failed: true };
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
