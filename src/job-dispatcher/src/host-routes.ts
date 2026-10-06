import type { ExecutionPolicy, ExecutionProfile, HarnessSnapshot } from "@copilot-agent/contracts";
import { HostStore, StoreError } from "@copilot-agent/job-store";
import { admitHostedHarness, HttpError, requireInternalKey, signSessionCapability } from "@copilot-agent/service-defaults";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface HostDependencies {
  store: HostStore;
  key: string;
  owner: string;
  harness: HarnessSnapshot;
  profiles: Map<string, ExecutionProfile>;
  policy: ExecutionPolicy;
  signingKey: string;
}

export function registerHostRoutes(app: FastifyInstance, deps: HostDependencies): void {
  const owner = deps.owner.toLowerCase();
  const leaseSeconds = 30;
  const epochSchema = z.object({ epoch: z.string().uuid() }).strict();
  const sessionSchema = epochSchema.extend({ sessionId: z.string().uuid(), resume: z.boolean() });
  const tokenSchema = epochSchema.extend({ sessionId: z.string().uuid() });

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid demo host control request.");
    return parsed.data;
  };
  const perform = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof StoreError) {
        throw new HttpError(error.code === "quota_exceeded" ? 429 : error.code === "not_found" ? 404 : 409, error.code, error.message);
      }
      throw error;
    }
  };

  app.post("/internal/host/acquire", async (request) => {
    requireInternalKey(request, deps.key);
    const body = parse(z.object({ ownerUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(), request.body);
    admitHostedHarness(deps.harness, deps.profiles, deps.policy);
    return perform(() => deps.store.acquire(owner, leaseSeconds, body.ownerUserId));
  });
  app.post("/internal/host/connection", async (request) => {
    requireInternalKey(request, deps.key);
    const body = parse(epochSchema.extend({ token: z.string().min(32).max(200) }), request.body);
    return { authorized: await deps.store.consumeConnection(body.epoch, owner, body.token) };
  });
  app.post("/internal/host/heartbeat", async (request) => {
    requireInternalKey(request, deps.key);
    const body = parse(epochSchema.extend({
      environmentId: z.string().max(200).optional(),
      serverKey: z.object({
        keyId: z.string().min(1).max(200), algorithm: z.enum(["x25519-sealedbox", "hpke-x25519-hkdf-sha256-aes256gcm"]),
        publicKey: z.string().min(1).max(1000),
      }).strict().optional(),
    }), request.body);
    await perform(() => deps.store.heartbeat(body.epoch, leaseSeconds, body.environmentId, body.serverKey));
    return { closedSessions: (await deps.store.list(owner)).filter((session) => session.closed).map((session) => session.id) };
  });
  app.post("/internal/host/release", async (request) => {
    requireInternalKey(request, deps.key);
    const body = parse(epochSchema, request.body);
    await deps.store.release(body.epoch);
    return { released: true };
  });
  app.post("/internal/host/session", async (request) => {
    requireInternalKey(request, deps.key);
    const body = parse(sessionSchema, request.body);
    const defaults = admitHostedHarness(deps.harness, deps.profiles, deps.policy);
    const session = await perform(() => deps.store.session(body.epoch, owner, body.sessionId, body.resume, {
      harness: deps.harness, ...defaults,
    }));
    const current = admitHostedHarness(session.harness, deps.profiles, deps.policy);
    if (current.model !== session.model) throw new HttpError(403, "host_policy_rejected", "The retained session model is no longer approved.");
    return session;
  });
  app.post("/internal/host/token", async (request) => {
    requireInternalKey(request, deps.key);
    const body = parse(tokenSchema, request.body);
    const grant = await perform(() => deps.store.grant(body.epoch, owner, body.sessionId));
    const current = admitHostedHarness(grant.session.harness, deps.profiles, deps.policy);
    if (current.model !== grant.session.model || current.tokenBudget < grant.session.tokenBudget) {
      throw new HttpError(403, "host_policy_rejected", "The retained session requires limits no longer approved by policy.");
    }
    const token = await signSessionCapability(deps.signingKey, {
      sub: body.sessionId, jti: grant.jti, session: body.sessionId, epoch: body.epoch,
      prn: owner, mdl: [...new Set([grant.session.model, ...(grant.session.harness.definition.agents ?? []).flatMap((agent) => agent.model ? [agent.model] : [])])],
      tok: grant.session.tokenBudget, expiresAt: grant.expiresAt,
    });
    return { token };
  });
}
