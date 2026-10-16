import {
  AHP_SESSION_ID,
  effectiveHostingPolicy,
  hostingModeOf,
  hostingPolicyViolations,
  ownerHostTransports,
  type ExecutionPolicy,
  type ExecutionProfile,
  type HarnessSnapshot,
  type OwnerHostTransport,
} from "@copilot-agent/contracts";
import { HostStore, StoreError, type HostKey } from "@copilot-agent/job-store";
import { admitHostedHarness, HttpError, secretsEqual, signSessionCapability } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

/** One deployed owner host as the dispatcher sees it. Its own service key identifies it on every control request. */
export interface OwnerHostRoute {
  harness: string;
  owner: string;
  key: string;
  transport: OwnerHostTransport;
  execution: "managed" | "github-native";
  /** Managed hosts: the published conversation harness that new sessions are admitted with. */
  snapshot?: HarnessSnapshot;
  /** The harness's effective policy. */
  policy: ExecutionPolicy;
}

/**
 * A managed owner host runs its harness isolated, so the harness must use isolated hosting and its effective policy
 * must allow that mode and every transport the host would open. A relay environment is registered at startup, so a
 * disallowed transport stops the host rather than only failing later connection requests.
 */
export function ownerHostPolicyProblem(host: Pick<OwnerHostRoute, "harness" | "transport" | "snapshot" | "policy">): { code: string; message: string } | undefined {
  if (!host.snapshot) return undefined;
  const definition = host.snapshot.definition;
  const mode = hostingModeOf(definition);
  if (mode !== "isolated") {
    return { code: "hosting_mode_mismatch", message: `Owner hosts serve isolated harnesses; '${host.harness}' uses ${mode} hosting.` };
  }
  const violation = hostingPolicyViolations(definition, host.policy)[0];
  if (violation) return { code: violation.code, message: violation.message };
  const allowed = effectiveHostingPolicy(host.policy).transports;
  const blocked = ownerHostTransports(host.transport).find((transport) => !allowed.includes(transport));
  if (blocked) {
    return {
      code: "transport_not_allowed",
      message: `The operator policy does not allow the ${blocked === "github" ? "GitHub relay" : "direct WSS transport"} for '${host.harness}'.`,
    };
  }
  return undefined;
}

export interface HostDependencies {
  store: HostStore;
  hosts: OwnerHostRoute[];
  profiles?: Map<string, ExecutionProfile>;
  signingKey: string;
}

export function registerHostRoutes(app: FastifyInstance, deps: HostDependencies): void {
  const harnesses = new Set(deps.hosts.map((host) => host.harness));
  const keys = new Set(deps.hosts.map((host) => host.key));
  if (harnesses.size !== deps.hosts.length || keys.size !== deps.hosts.length) {
    throw new Error("Each owner host needs its own harness and its own service key.");
  }
  if (deps.hosts.some((host) => host.key.length < 32)) throw new Error("Owner host service keys must contain at least 32 characters.");
  const leaseSeconds = 30;
  const hostOf = (request: FastifyRequest): OwnerHostRoute & { id: HostKey } => {
    const presented = request.headers["x-internal-key"];
    const value = Array.isArray(presented) ? presented[0] : presented;
    let match: OwnerHostRoute | undefined;
    // Compare against every key so the response time does not depend on which host matched.
    for (const host of deps.hosts) if (value && secretsEqual(value, host.key)) match = host;
    if (!match) throw new HttpError(401, "unauthenticated", "Service authentication failed.");
    return { ...match, id: { harness: match.harness, owner: match.owner.toLowerCase() } };
  };
  const managed = (host: OwnerHostRoute) => {
    if (host.execution !== "managed" || !host.snapshot || !deps.profiles) {
      throw new HttpError(409, "native_host", "GitHub-native sessions use Copilot inference and lifecycle, not managed session grants.");
    }
    return { harness: host.snapshot, profiles: deps.profiles, ...admitHostedHarness(host.snapshot, deps.profiles, host.policy) };
  };
  const epochSchema = z.object({ epoch: z.string().uuid() }).strict();
  const sessionSchema = epochSchema.extend({
    sessionId: z.string().uuid(), resume: z.boolean(), ahpSessionId: z.string().regex(AHP_SESSION_ID).optional(),
  });
  const tokenSchema = epochSchema.extend({ sessionId: z.string().uuid() });

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid host control request.");
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
    const host = hostOf(request);
    const body = parse(z.object({
      ownerUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      // Optional for hosts built before per-harness hosting; when present they must agree with the key's host.
      harness: z.string().max(100).optional(),
      computeId: z.string().uuid().optional(),
    }).strict(), request.body);
    if (body.harness !== undefined && body.harness !== host.harness) {
      throw new HttpError(403, "host_mismatch", "The host's configured harness does not match its service key.");
    }
    if (host.execution === "managed") {
      managed(host);
      const problem = ownerHostPolicyProblem(host);
      if (problem) throw new HttpError(problem.code === "hosting_mode_mismatch" ? 409 : 422, problem.code, problem.message);
    }
    return perform(() => deps.store.acquire(host.id, leaseSeconds, body.ownerUserId, host.execution, body.computeId));
  });
  app.post("/internal/host/connection", async (request) => {
    const host = hostOf(request);
    const body = parse(epochSchema.extend({ token: z.string().min(32).max(200) }), request.body);
    return { authorized: await deps.store.consumeConnection(host.id, body.epoch, body.token) };
  });
  app.post("/internal/host/heartbeat", async (request) => {
    const host = hostOf(request);
    const body = parse(epochSchema.extend({
      environmentId: z.string().max(200).optional(),
      serverKey: z.object({
        keyId: z.string().min(1).max(200), algorithm: z.enum(["x25519-sealedbox", "hpke-x25519-hkdf-sha256-aes256gcm"]),
        publicKey: z.string().min(1).max(1000),
      }).strict().optional(),
    }), request.body);
    await perform(() => deps.store.heartbeat(host.id, body.epoch, leaseSeconds, body.environmentId, body.serverKey));
    return { closedSessions: host.execution === "managed"
      ? (await deps.store.list(host.id)).filter((session) => session.closed).map((session) => session.id)
      : [] };
  });
  app.post("/internal/host/release", async (request) => {
    const host = hostOf(request);
    const body = parse(epochSchema, request.body);
    await deps.store.release(host.id, body.epoch);
    return { released: true };
  });
  app.post("/internal/host/session", async (request) => {
    const host = hostOf(request);
    const body = parse(sessionSchema, request.body);
    const defaults = managed(host);
    const session = await perform(() => deps.store.session(host.id, body.epoch, body.sessionId, body.resume, {
      harness: defaults.harness, model: defaults.model, tokenBudget: defaults.tokenBudget,
    }, body.ahpSessionId));
    const current = admitHostedHarness(session.harness, defaults.profiles, host.policy);
    if (current.model !== session.model) throw new HttpError(403, "host_policy_rejected", "The retained session model is no longer approved.");
    return session;
  });
  app.post("/internal/host/token", async (request) => {
    const host = hostOf(request);
    const body = parse(tokenSchema, request.body);
    const defaults = managed(host);
    const grant = await perform(() => deps.store.grant(host.id, body.epoch, body.sessionId));
    const current = admitHostedHarness(grant.session.harness, defaults.profiles, host.policy);
    if (current.model !== grant.session.model || current.tokenBudget < grant.session.tokenBudget) {
      throw new HttpError(403, "host_policy_rejected", "The retained session requires limits no longer approved by policy.");
    }
    const token = await signSessionCapability(deps.signingKey, {
      sub: body.sessionId, jti: grant.jti, session: body.sessionId, epoch: body.epoch,
      prn: host.id.owner, mdl: [...new Set([grant.session.model, ...(grant.session.harness.definition.agents ?? []).flatMap((agent) => agent.model ? [agent.model] : [])])],
      tok: grant.session.tokenBudget, expiresAt: grant.expiresAt,
    });
    return { token };
  });
}
