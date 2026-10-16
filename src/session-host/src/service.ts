import type { SessionConfig } from "@github/copilot-sdk";
import { SharedPrincipalBindings, SharedSessionDefinition, SharedWorkerLimits, type ConnectionTicket } from "@copilot-agent/contracts";
import { SessionFileStore, SharedStore, StoreError, type SessionFileLease, type SharedSessionRecord, type SharedTurn } from "@copilot-agent/job-store";
import { readServerKey, type AhpProxyTarget } from "@copilot-agent/service-defaults";
import { SharedSessionRuntime, type SharedActivationContext } from "./runtime.js";
import { SharedTurnScheduler } from "./scheduler.js";

interface Resident {
  context: SharedActivationContext;
  record: SharedSessionRecord;
  controller: AbortController;
  lastActivity: number;
  toolNames: ReadonlySet<string>;
  connection?: Awaited<ReturnType<SharedSessionRuntime["open"]>>;
  closing?: Promise<void>;
}
export interface SharedServiceOptions {
  root: string;
  store: SharedStore;
  files: SessionFileStore;
  principals: Record<string, number>;
  definition: SharedSessionDefinition;
  limits: SharedWorkerLimits;
  gatewayUrl: string;
  mintToken: (lease: SessionFileLease, turn: SharedTurn) => Promise<string>;
  report: (event: string, id: string) => void;
  tools?: (record: SharedSessionRecord, context: SharedActivationContext, currentTurn: () => SharedTurn) => NonNullable<SessionConfig["tools"]>;
}

/**
 * One shared runtime owner. Callers receive activation-bound one-use tickets, which only the connection broker
 * consumes; native listener secrets never leave this process.
 */
export class SharedSessionService {
  readonly #runtime: SharedSessionRuntime;
  readonly #scheduler: SharedTurnScheduler;
  readonly #residents = new Map<string, Resident>();
  readonly #opening = new Map<string, Promise<void>>();
  #timer?: NodeJS.Timeout;
  #maintenance?: Promise<void>;
  #stopping = false;
  #healthy = false;

  constructor(private readonly options: SharedServiceOptions) {
    options.principals = SharedPrincipalBindings.parse(options.principals);
    options.definition = SharedSessionDefinition.parse(options.definition);
    options.limits = SharedWorkerLimits.parse(options.limits);
    this.#runtime = new SharedSessionRuntime(options.root, options.files, (event, id) => {
      options.report(event, id);
      if (event === "session.storage_lease_lost" || event === "session.host_exited") {
        void this.deactivate(id).catch(() => options.report("session.deactivation_failed", id));
      }
    }, options.limits.residentSessions);
    this.#scheduler = new SharedTurnScheduler(options.store, options.limits, async (lease) => {
      if (this.#residents.get(lease.id)?.context.lease.epoch === lease.epoch) await this.deactivate(lease.id);
    }, options.report);
  }

  get healthy(): boolean { return this.#healthy && !this.#stopping; }
  get residentCount(): number { return this.#residents.size; }
  busy(id: string): boolean { return this.#scheduler.busy(id) || this.#opening.has(id); }
  activation(principal: string, id: string): SessionFileLease {
    const resident = this.#residents.get(id);
    if (!resident?.connection || resident.record.principal !== principal || resident.closing || resident.controller.signal.aborted) {
      throw new StoreError("not_found", "The conversation activation is unavailable.");
    }
    return resident.context.lease;
  }

  async start(): Promise<void> {
    await this.#runtime.start();
    await this.maintain();
    this.#timer = setInterval(() => {
      if (this.#maintenance || this.#stopping) return;
      this.#maintenance = this.maintain().catch(() => {
        this.#healthy = false;
        this.options.report("shared.maintenance_failed", "");
      }).finally(() => { this.#maintenance = undefined; });
    }, 1_000);
  }

  private identity(principal: string): number {
    const identity = this.options.principals[principal];
    if (!identity) throw new StoreError("not_found", "The shared destination is not configured for this principal.");
    return identity;
  }

  async create(principal: string, label: string): Promise<SharedSessionRecord["view"]> {
    if (this.#stopping) throw new StoreError("invalid_state", "The shared service is stopping.");
    const row = await this.options.store.create(principal, this.identity(principal), label, this.options.definition, this.options.limits.retainedSessionsPerPrincipal);
    return row.view;
  }

  async list(principal: string): Promise<SharedSessionRecord["view"][]> {
    await this.options.store.checkIdentity(principal, this.identity(principal));
    return this.options.store.list(principal);
  }

  async get(principal: string, id: string): Promise<SharedSessionRecord> {
    const identity = this.identity(principal);
    const row = await this.options.store.get(principal, id);
    if (!row || row.githubUserId !== identity) throw new StoreError("not_found", "The shared conversation was not found.");
    return row;
  }

  /** Activates the session and issues a one-use ticket; the API adds the broker URL. */
  async connection(principal: string, id: string): Promise<ConnectionTicket> {
    await this.ensure(principal, id);
    return { sessionId: id, ...(await this.options.store.issueTicket(principal, id)) };
  }

  /**
   * Resolves a connection the broker forwarded after consuming a ticket for `epoch`. A replaced, closing, or evicted
   * activation refuses it, so a ticket attaches only to the activation it was issued for.
   */
  async resolveForwarded(path: string, epoch: string | undefined): Promise<AhpProxyTarget | undefined> {
    const match = /^\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
    const resident = match ? this.#residents.get(match[1]!.toLowerCase()) : undefined;
    if (!epoch || !resident?.connection || resident.closing || resident.controller.signal.aborted || resident.context.lease.epoch !== epoch) {
      return undefined;
    }
    resident.lastActivity = Date.now();
    return { token: resident.connection.token, targetPort: Number(new URL(resident.connection.url).port) };
  }

  async close(principal: string, id: string, cancelChildren: boolean): Promise<void> {
    await this.get(principal, id);
    await this.options.store.close(principal, id, cancelChildren);
    await this.#opening.get(id);
    await this.deactivate(id);
  }

  async continueConversation(principal: string, id: string, notificationId: string, prompt: string): Promise<"delivered" | "already-delivered"> {
    await this.ensure(principal, id);
    const resident = this.#residents.get(id);
    if (!resident || resident.closing || this.busy(id)) throw new StoreError("quota_exceeded", "The conversation is busy; completion delivery must wait.");
    const marker = `shared-completion:${notificationId}`;
    if (await this.#runtime.hasSystemMessage(id, marker)) return "already-delivered";
    const signal = AbortSignal.any([resident.controller.signal, resident.context.signal]);
    await this.#scheduler.acquire(resident.context.lease, signal, "completion", marker);
    try {
      signal.throwIfAborted();
      await this.#runtime.sendSystem(id, `[${marker}]\n${prompt}`);
      return "delivered";
    } catch (error) {
      await this.#scheduler.finish(resident.context.lease, true);
      throw error;
    }
  }

  async ensure(principal: string, id: string): Promise<void> {
    if (this.#stopping) throw new StoreError("invalid_state", "The shared service is stopping.");
    const row = await this.get(principal, id);
    if (row.view.closed) throw new StoreError("not_found", "The shared conversation is closed.");
    const opening = this.#opening.get(id);
    if (opening) return opening;
    const resident = this.#residents.get(id);
    if (resident?.closing) await resident.closing;
    else if (resident?.connection && !resident.controller.signal.aborted) return;
    const operation = this.activate(row);
    this.#opening.set(id, operation);
    try { await operation; }
    finally { if (this.#opening.get(id) === operation) this.#opening.delete(id); }
  }

  private async activate(row: SharedSessionRecord): Promise<void> {
    if (new Set([...this.#residents.keys(), ...this.#opening.keys()]).size >= this.options.limits.residentSessions) {
      const idle = [...this.#residents.values()].filter((entry) => !this.busy(entry.record.id) && !entry.closing)
        .sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (!idle) throw new StoreError("quota_exceeded", "The shared worker is at resident capacity.");
      await this.deactivate(idle.record.id);
    }
    let activation: Resident | undefined;
    const bind = (context: SharedActivationContext): Resident => {
      if (!activation) {
        if (this.#residents.has(row.id)) throw new Error("Another activation is already resident.");
        activation = { context, record: row, controller: new AbortController(), lastActivity: Date.now(), toolNames: new Set() };
        this.#residents.set(row.id, activation);
      }
      if (this.#residents.get(row.id) !== activation || activation.context.lease.epoch !== context.lease.epoch
        || activation.controller.signal.aborted) throw new Error("The activation context is no longer active.");
      return activation;
    };
    try {
      const connection = await this.#runtime.open({
        id: row.id, principal: row.principal, githubUserId: row.githubUserId,
        model: row.definition.model, instructions: row.definition.instructions,
        tools: (context) => {
          const resident = bind(context);
          const tools = this.options.tools?.(row, context, () => this.#scheduler.current(context.lease)) ?? [];
          resident.toolNames = new Set(tools.flatMap((tool) => [tool.name, `custom:${tool.name}`]));
          return tools;
        },
        provider: (context) => ({
          type: "openai", baseUrl: this.options.gatewayUrl, wireApi: "completions",
          bearerTokenProvider: async () => {
            const resident = bind(context);
            const signal = AbortSignal.any([context.signal, resident.controller.signal]);
            signal.throwIfAborted();
            resident.lastActivity = Date.now();
            const turn = await this.#scheduler.acquire(context.lease, signal);
            signal.throwIfAborted();
            return this.options.mintToken(context.lease, turn);
          },
        }),
        hooks: (context) => ({
          onPreToolUse: async ({ toolName }) => {
            const resident = bind(context);
            if (!resident.toolNames.has(toolName)) return { permissionDecision: "deny", permissionDecisionReason: "Only the coordinator's registered application tools are permitted." };
            if (resident.controller.signal.aborted) return { permissionDecision: "deny", permissionDecisionReason: "The conversation is deactivating." };
            try {
              await this.options.store.grant(context.lease, this.#scheduler.current(context.lease).id);
              return { permissionDecision: "allow" };
            } catch (error) {
              this.options.report("session.tool_grant_refused", row.id);
              if (!(error instanceof StoreError)) throw error;
              return { permissionDecision: "deny", permissionDecisionReason: "The conversation has no active execution grant." };
            }
          },
        }),
        onActivity: (context) => { bind(context).lastActivity = Date.now(); },
        onEvent: (context, event) => {
          const resident = this.#residents.get(row.id);
          if (!resident || resident.context.lease.epoch !== context.lease.epoch) return;
          if (["user.message", "assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete"].includes(event.type)) {
            resident.lastActivity = Date.now();
          }
          if (event.type === "session.idle" && !event.agentId) {
            resident.lastActivity = Date.now();
            void this.#scheduler.finish(context.lease).catch(() => {
              this.options.report("session.turn_settlement_failed", row.id);
              void this.deactivate(row.id).catch(() => this.options.report("session.deactivation_failed", row.id));
            });
          }
        },
      });
      const resident = this.#residents.get(row.id);
      if (!resident || this.#stopping || resident.controller.signal.aborted) throw new Error("The shared activation was cancelled.");
      const key = await readServerKey(Number(new URL(connection.url).port), connection.token);
      await this.options.store.publish(connection.lease, key);
      resident.connection = connection;
    } catch (error) {
      try { await this.deactivate(row.id); }
      finally { this.options.report("session.activation_failed", row.id); }
      throw error;
    }
  }

  async deactivate(id: string): Promise<void> {
    const resident = this.#residents.get(id);
    if (!resident) return;
    if (!resident.closing) {
      resident.controller.abort(new Error("The shared activation is closing."));
      resident.closing = (async () => {
        try { await this.#scheduler.finish(resident.context.lease, true); }
        finally {
          await this.#runtime.close(id);
          if (this.#residents.get(id) === resident) this.#residents.delete(id);
        }
      })().catch((error) => {
        resident.closing = undefined;
        this.#healthy = false;
        this.options.report("session.deactivation_failed", id);
        throw error;
      });
    }
    return resident.closing;
  }

  async maintain(): Promise<void> {
    for (const lease of await this.options.store.recover()) {
      if (this.#residents.get(lease.id)?.context.lease.epoch === lease.epoch) await this.deactivate(lease.id);
    }
    for (const resident of this.#residents.values()) {
      if (this.#opening.has(resident.record.id)) continue;
      const row = await this.options.store.get(resident.record.principal, resident.record.id);
      if (resident.controller.signal.aborted || !row || row.view.closed || (!this.busy(row.id) && Date.now() - resident.lastActivity >= row.definition.limits.idleSeconds * 1000)) {
        await this.deactivate(resident.record.id);
      }
    }
    this.#healthy = true;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    for (const resident of this.#residents.values()) resident.controller.abort(new Error("The shared service is stopping."));
    await Promise.allSettled([...this.#opening.values()]);
    await this.#maintenance;
    try { await Promise.all([...this.#residents.keys()].map((id) => this.deactivate(id))); }
    finally { await this.#runtime.stop(); }
  }
}
