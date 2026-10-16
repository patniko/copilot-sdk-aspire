import { setTimeout as delay } from "node:timers/promises";
import {
  connectionProblem, effectiveHostingPolicy, evaluateHosting, policyFor, SessionContainerSettings, SharedPrincipalBindings,
  SharedSessionLimits, SharedWorkerLimits,
  type HarnessSnapshot, type HostingTarget, type SharedConnection, type SharedConnectionRequest, type SharedSessionCreation,
  type SharedSessionView,
} from "@copilot-agent/contracts";
import { StoreError, type AllocationStore, type SessionContainerStore, type SessionDirectory } from "@copilot-agent/job-store";
import { hostingError, HttpError, policyDigest, type HostingCatalog } from "@copilot-agent/service-defaults";
import { brokerOrigin } from "./shared-routes.js";

export interface ContainerSessionDependencies {
  store: SessionContainerStore;
  allocations: AllocationStore;
  directory: SessionDirectory;
  /** Published harnesses, profiles, policies, and this deployment, which must include `sessionContainers`. */
  catalog: HostingCatalog;
  /** Operator binding of API principals to numeric GitHub accounts, shared with the shared worker. */
  principals: Record<string, number>;
  settings: SessionContainerSettings;
  limits: SharedWorkerLimits;
  /** Operator ceilings for one session (Aspire `hybrid-session-limits`), as the shared worker applies them. */
  sessionLimits?: SharedSessionLimits;
  /** The connection broker's public origin; clients attach to `/sessions/{id}` there, never to a container directly. */
  brokerUrl: string;
  /** Longest a connection request waits for a container to become ready. */
  connectWaitSeconds?: number;
}

/**
 * Mode-1 sessions: an isolated conversation harness gets its own session container on connection, which stops when
 * idle and is reallocated from the session's retained volume on the next connection. Views are placement-agnostic.
 */
export class ContainerSessionService {
  readonly #principals: Record<string, number>;
  readonly #settings: SessionContainerSettings;
  readonly #limits: SharedWorkerLimits;
  readonly #ceilings: SharedSessionLimits;
  readonly #broker: URL;

  constructor(private readonly deps: ContainerSessionDependencies) {
    this.#principals = SharedPrincipalBindings.parse(deps.principals);
    this.#settings = SessionContainerSettings.parse(deps.settings);
    this.#limits = SharedWorkerLimits.parse(deps.limits);
    this.#ceilings = SharedSessionLimits.parse(deps.sessionLimits ?? {});
    if (!deps.catalog.deployment.sessionContainers) throw new Error("The deployment description must include session containers.");
    this.#broker = brokerOrigin(deps.brokerUrl);
  }

  get catalog(): HostingCatalog { return this.deps.catalog; }

  private identity(principal: string): number {
    const identity = this.#principals[principal];
    if (!identity) throw new HttpError(404, "not_found", "Conversations are not configured for this principal.");
    return identity;
  }

  /**
   * Admits the harness's hosting under its current effective policy and this deployment, or throws its first problem.
   * A `promotable` harness starts shared, so only a session promoted into its container (`promoted`) runs it here.
   */
  private evaluate(snapshot: HarnessSnapshot, principal: string, promoted = false) {
    const { catalog } = this.deps;
    const policy = policyFor(catalog.policies, snapshot.definition.name);
    const lookup = (harness: string): HostingTarget | undefined => {
      const latest = catalog.harnesses.get(harness)?.[0];
      return latest ? { definition: latest.definition, policy: policyFor(catalog.policies, harness) } : undefined;
    };
    const evaluation = evaluateHosting({ definition: snapshot.definition, policy, profiles: catalog.profiles, deployment: catalog.deployment, lookup, principal });
    if (evaluation.interaction !== "conversation") {
      throw new HttpError(422, "policy_rejected", "Batch harnesses run as jobs; create conversations from conversation harnesses.");
    }
    const problem = connectionProblem(evaluation, "direct");
    if (problem) throw hostingError(problem);
    if (evaluation.placement !== "container" && !(promoted && evaluation.mode === "promotable")) {
      throw hostingError({ code: "hosting_unavailable", message: `${evaluation.mode} sessions are not served by session containers.`,
        prerequisite: { kind: "host", name: "shared-worker" } });
    }
    return { policy, evaluation };
  }

  async create(principal: string, request: SharedSessionCreation): Promise<SharedSessionView> {
    const identity = this.identity(principal);
    const versions = this.deps.catalog.harnesses.get(request.harness) ?? [];
    const snapshot = request.version ? versions.find((entry) => entry.definition.version === request.version) : versions[0];
    if (!snapshot) throw new HttpError(404, "harness_not_found", "The requested harness version is not published.");
    const { policy } = this.evaluate(snapshot, principal);
    const { definition } = snapshot;
    const model = [definition.model.preferred, ...definition.model.allowed].find((name) => policy.allowedModels.includes(name));
    if (!model) throw new HttpError(422, "policy_rejected", "None of the harness's models are approved by the operator policy.", { path: "model" });
    const hosting = effectiveHostingPolicy(policy);
    const size = hosting.defaultSize;
    const ceilings = this.#ceilings;
    // The shared worker's budget and deadline rules. A container enforces the aggregate budget and the turn deadline,
    // not a separate per-turn budget, so the reported turn budget is the aggregate one; the idle stop is the idle limit.
    const tokenBudget = Math.min(definition.limits.maxInferenceTokens, policy.maxInferenceTokensPerJob, ceilings.tokenBudget);
    const limits = SharedSessionLimits.parse({
      ...ceilings,
      tokenBudget,
      turnTokenBudget: Math.min(tokenBudget, 1_000_000),
      maxTurnSeconds: Math.min(definition.limits.maxDurationSeconds, policy.maxDurationSeconds, ceilings.maxTurnSeconds),
      idleSeconds: this.#settings.idleSeconds,
    });
    const record = await store(() => this.deps.store.create(principal, identity, request.label, {
      harness: snapshot, model, limits, policyDigest: policyDigest(policy), size, resources: hosting.sizes[size]!,
    }, this.#limits.retainedSessionsPerPrincipal));
    return (await this.view(principal, record.id))!;
  }

  async owns(principal: string, id: string): Promise<boolean> {
    return (await this.deps.store.get(principal, id)) !== undefined;
  }

  /** The committed promotion that moved a shared conversation into this container, if it was promoted. */
  async promotion(principal: string, id: string): Promise<SharedSessionView["promotion"]> {
    const promotion = (await this.view(principal, id))?.promotion;
    return promotion?.state === "committed" ? promotion : undefined;
  }

  async view(principal: string, id: string): Promise<SharedSessionView | undefined> {
    return this.deps.directory.get(principal, this.identity(principal), id);
  }

  async list(principal: string): Promise<SharedSessionView[]> {
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
  async connect(principal: string, id: string, request: SharedConnectionRequest): Promise<SharedConnection> {
    const record = await this.deps.store.get(principal, id);
    if (!record || record.closed || record.githubUserId !== this.identity(principal)) throw new HttpError(404, "not_found", "The conversation was not found.");
    // A promoted `promotable` session runs here from its committed promotion on, including after an idle stop.
    const promoted = async () => (await this.promotion(principal, id)) !== undefined;
    if (request.transport !== "direct") {
      const { evaluation } = this.evaluate(record.harness, principal, await promoted());
      throw hostingError(connectionProblem(evaluation, request.transport) ?? {
        code: "hosting_unavailable", message: "Session containers accept direct WSS connections only.", prerequisite: { kind: "transport", name: request.transport },
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
          sessionId: id, destination: "container", transport: "direct", ahpSessionId: id,
          url: new URL(`/sessions/${id}`, this.#broker).href,
          token: ticket.token, expiresAt: ticket.expiresAt, serverKey: ticket.serverKey,
        };
      }
      if (!active) {
        if (requested && allocation?.id === requested) {
          throw new HttpError(503, "container_unavailable", `The session container could not start: ${allocation.error ?? "it stopped before becoming ready."}`);
        }
        this.evaluate(record.harness, principal, await promoted());
        const created = await store(() => this.deps.allocations.request({
          sessionId: id, principal, purpose: "session", size: record.size, resources: record.resources,
          volumes: [{ purpose: "session", sessionId: id, target: "/data", readOnly: false }],
          idleSeconds: record.limits.idleSeconds, startupSeconds: this.#settings.startupSeconds, maxLifetimeSeconds: this.#settings.maxLifetimeSeconds,
        }, this.#limits));
        requested = created.id;
      }
      if (Date.now() > deadline) throw new HttpError(503, "container_starting", "The session container is still starting; retry the connection shortly.");
      await delay(250);
    }
  }
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