import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  connectionProblem, effectiveHostingPolicy, evaluateHosting, HOSTING_TRANSPORTS, policyFor, SessionContainerSettings,
  SharedPrincipalBindings, SharedWorkerLimits,
  type ExecutionProfile, type HarnessSnapshot, type HostingDeployment, type HostingTarget, type PolicySet, type SessionCreation,
  type SessionView, type SharedConnection,
} from "@copilot-agent/contracts";
import { StoreError, type AllocationStore, type SessionContainerStore, type SessionDirectory } from "@copilot-agent/job-store";
import { hostingError, HttpError } from "@copilot-agent/service-defaults";

export interface ContainerSessionDependencies {
  store: SessionContainerStore;
  allocations: AllocationStore;
  directory: SessionDirectory;
  harnesses: Map<string, HarnessSnapshot[]>;
  profiles: Map<string, ExecutionProfile>;
  policies: PolicySet;
  /** Operator binding of API principals to numeric GitHub accounts, shared with the shared worker. */
  principals: Record<string, number>;
  settings: SessionContainerSettings;
  limits: SharedWorkerLimits;
  /** What this deployment provides; must include `sessionContainers`. */
  deployment: HostingDeployment;
  /** Public broker origin. Omitted: clients connect directly to the container's published loopback ingress. */
  brokerUrl?: string;
  /** Longest a connection request waits for a container to become ready. */
  connectWaitSeconds?: number;
}

/** `POST /v1/sessions/{id}/connection`; session containers serve direct WSS only. */
const ConnectionRequest = z.object({ transport: z.enum(HOSTING_TRANSPORTS).default("direct") }).strict();

/**
 * Mode-1 sessions: an isolated conversation harness gets its own session container on connection, which stops when
 * idle and is reallocated from the session's retained volume on the next connection. Views are placement-agnostic.
 */
export class ContainerSessionService {
  readonly #principals: Record<string, number>;
  readonly #settings: SessionContainerSettings;
  readonly #limits: SharedWorkerLimits;

  constructor(private readonly deps: ContainerSessionDependencies) {
    this.#principals = SharedPrincipalBindings.parse(deps.principals);
    this.#settings = SessionContainerSettings.parse(deps.settings);
    this.#limits = SharedWorkerLimits.parse(deps.limits);
    if (!deps.deployment.sessionContainers) throw new Error("The deployment description must include session containers.");
    if (deps.brokerUrl) publicEndpoint(deps.brokerUrl, "");
  }

  private identity(principal: string): number {
    const identity = this.#principals[principal];
    if (!identity) throw new HttpError(404, "not_found", "Conversations are not configured for this principal.");
    return identity;
  }

  /** Admits the harness's hosting under its current effective policy and this deployment, or throws its first problem. */
  private evaluate(snapshot: HarnessSnapshot, principal: string) {
    const policy = policyFor(this.deps.policies, snapshot.definition.name);
    const lookup = (harness: string): HostingTarget | undefined => {
      const latest = this.deps.harnesses.get(harness)?.[0];
      return latest ? { definition: latest.definition, policy: policyFor(this.deps.policies, harness) } : undefined;
    };
    const evaluation = evaluateHosting({ definition: snapshot.definition, policy, profiles: this.deps.profiles, deployment: this.deps.deployment, lookup, principal });
    if (evaluation.interaction !== "conversation") {
      throw new HttpError(422, "policy_rejected", "Sessions need an interaction: conversation harness; batch harnesses run as jobs.", { path: "interaction" });
    }
    const problem = connectionProblem(evaluation, "direct");
    if (problem) throw hostingError(problem);
    if (evaluation.placement !== "container") {
      throw hostingError({ code: "hosting_unavailable", message: `${evaluation.mode} sessions are not served by session containers.`,
        prerequisite: { kind: "host", name: "shared-worker" } });
    }
    return { policy, evaluation };
  }

  async create(principal: string, request: SessionCreation): Promise<SessionView> {
    const identity = this.identity(principal);
    const versions = this.deps.harnesses.get(request.harness!.name) ?? [];
    const snapshot = request.harness!.version ? versions.find((entry) => entry.definition.version === request.harness!.version) : versions[0];
    if (!snapshot) throw new HttpError(404, "harness_not_found", "The harness or version is not published.");
    const { policy } = this.evaluate(snapshot, principal);
    const definition = snapshot.definition;
    const model = [definition.model.preferred, ...definition.model.allowed].find((name) => policy.allowedModels.includes(name))!;
    const hosting = effectiveHostingPolicy(policy);
    const size = hosting.defaultSize;
    const record = await store(() => this.deps.store.create(principal, identity, request.label, {
      harness: snapshot, model, tokenBudget: Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob),
      maxTurnSeconds: Math.min(policy.maxDurationSeconds, definition.limits.maxDurationSeconds),
      size, resources: hosting.sizes[size]!, idleSeconds: this.#settings.idleSeconds,
    }, this.#limits.retainedSessionsPerPrincipal));
    return (await this.view(principal, record.id))!;
  }

  async owns(principal: string, id: string): Promise<boolean> {
    return (await this.deps.store.get(principal, id)) !== undefined;
  }

  async view(principal: string, id: string): Promise<SessionView | undefined> {
    return this.deps.directory.get(principal, this.identity(principal), id);
  }

  async list(principal: string): Promise<SessionView[]> {
    return store(() => this.deps.directory.list(principal, this.identity(principal)));
  }

  async close(principal: string, id: string): Promise<{ closed: true }> {
    const record = await this.deps.store.get(principal, id);
    if (!record || record.githubUserId !== this.identity(principal) || !(await this.deps.store.close(principal, id))) {
      throw new HttpError(404, "not_found", "The conversation was not found.");
    }
    return { closed: true };
  }

  /**
   * Ensures the session has a ready container, requesting one from its retained volume when it is dormant, then
   * issues a one-use ticket bound to that allocation. Narrowed policy blocks new containers, not running ones.
   */
  async connect(principal: string, id: string, body: unknown = {}): Promise<SharedConnection> {
    const parsed = ConnectionRequest.safeParse(body ?? {});
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid connection request.");
    const record = await this.deps.store.get(principal, id);
    if (!record || record.closed || record.githubUserId !== this.identity(principal)) throw new HttpError(404, "not_found", "The conversation was not found.");
    if (parsed.data.transport !== "direct") {
      const { evaluation } = this.evaluate(record.harness, principal);
      throw hostingError(connectionProblem(evaluation, parsed.data.transport) ?? {
        code: "hosting_unavailable", message: "Session containers accept direct WSS connections only.", prerequisite: { kind: "transport", name: parsed.data.transport },
      });
    }
    const deadline = Date.now() + Math.min(this.deps.connectWaitSeconds ?? 120, this.#settings.startupSeconds + 10) * 1000;
    let requested: string | undefined;
    for (;;) {
      const allocation = await this.deps.store.allocation(principal, id);
      const active = allocation && allocation.state !== "retired" ? allocation : undefined;
      if (active?.ready) {
        const ticket = await store(() => this.deps.store.issueTicket(principal, id, active.id));
        return {
          sessionId: id, destination: "container", ahpSessionId: id, token: ticket.token, expiresAt: ticket.expiresAt, serverKey: ticket.serverKey,
          url: this.deps.brokerUrl ? publicEndpoint(this.deps.brokerUrl, id) : publicEndpoint(`ws://${ticket.ingress.host.includes(":") ? `[${ticket.ingress.host}]` : ticket.ingress.host}:${ticket.ingress.port}`, id),
        };
      }
      if (!active) {
        if (requested && allocation?.id === requested) {
          throw new HttpError(503, "container_unavailable", `The session container could not start: ${allocation.error ?? "it stopped before becoming ready."}`);
        }
        this.evaluate(record.harness, principal);
        const created = await store(() => this.deps.allocations.request({
          sessionId: id, principal, purpose: "session", size: record.size, resources: record.resources,
          volumes: [{ purpose: "session", sessionId: id, target: "/data", readOnly: false }],
          idleSeconds: record.idleSeconds, startupSeconds: this.#settings.startupSeconds, maxLifetimeSeconds: this.#settings.maxLifetimeSeconds,
        }, this.#limits));
        requested = created.id;
      }
      if (Date.now() > deadline) throw new HttpError(503, "container_starting", "The session container is still starting; retry the connection shortly.");
      await delay(250);
    }
  }
}

function publicEndpoint(origin: string, id: string): string {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || !["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid session connection endpoint.");
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Unencrypted session connections are restricted to loopback.");
  }
  url.pathname = id ? `/sessions/${id}` : "/";
  return url.href;
}

async function store<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof StoreError) {
      throw new HttpError({ not_found: 404, quota_exceeded: 429, invalid_request: 400, invalid_state: 409, idempotency_conflict: 409 }[error.code], error.code, error.message);
    }
    throw error;
  }
}
