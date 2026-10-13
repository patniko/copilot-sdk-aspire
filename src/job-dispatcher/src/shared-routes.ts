import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SharedStore, StoreError } from "@copilot-agent/job-store";
import { HttpError, requireInternalKey, signSessionCapability } from "@copilot-agent/service-defaults";

export interface SharedDispatcherDependencies { store: SharedStore; key: string }
const GrantRequest = z.object({
  lease: z.object({ id: z.string().uuid(), principal: z.string().min(1).max(128), epoch: z.string().uuid() }).strict(),
  turnId: z.string().uuid(),
}).strict();

export function registerSharedRoutes(app: FastifyInstance, deps: SharedDispatcherDependencies, signingKey: string, allowedModels: readonly string[]): void {
  app.post("/internal/shared/grant", async (request) => {
    requireInternalKey(request, deps.key);
    const parsed = GrantRequest.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid conversation grant request.");
    const { lease, turnId } = parsed.data;
    try {
      const grant = await deps.store.grant(lease, turnId);
      if (!allowedModels.includes(grant.model)) throw new HttpError(409, "policy_revoked", "The retained conversation model is no longer approved.");
      return { token: await signSessionCapability(signingKey, {
        sub: lease.id, session: lease.id, epoch: lease.epoch, jti: turnId,
        prn: lease.principal, mdl: [grant.model], tok: grant.tokenBudget, expiresAt: grant.expiresAt,
      }) };
    } catch (error) {
      if (error instanceof StoreError) throw new HttpError(error.code === "quota_exceeded" ? 429 : 409, error.code, error.message);
      throw error;
    }
  });
}
