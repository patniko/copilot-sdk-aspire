import {
  SharedPrincipalBindings, SharedWorkerLimits,
  type ConnectionTicket, type HostingTransport, type SharedSessionCreation,
} from "@copilot-agent/contracts";
import type { ManagedSettings } from "@github/copilot-sdk";
import { SessionFileStore, SharedStore, StoreError, type SessionFileLease, type SharedSessionRecord, type SharedTurn } from "@copilot-agent/job-store";
import { readServerKey, type AhpProxyTarget } from "@copilot-agent/service-defaults";
import type { SharedActivationPlan, SharedAdmission, SharedApprovalPlan } from "./admission.js";
import { sharedSessionSettings } from "./harness-session.js";
import { residencyVictim } from "./residency.js";
import type { CustomPermissionHandler } from "./permission-handlers.js";
import { SharedPermissionPolicy, type ToolRule } from "./permissions.js";
import { SharedSessionRuntime, type SharedActivationContext } from "./runtime.js";
import { SharedTurnScheduler } from "./scheduler.js";
import { sharedToolset, type SharedToolkitOptions } from "./toolkit.js";

interface Resident {
  context: SharedActivationContext;
  record: SharedSessionRecord;
  harness: string;
  controller: AbortController;
  lastActivity: number;
  policy?: SharedPermissionPolicy;
  connection?: Awaited<ReturnType<SharedSessionRuntime["open"]>>;
  closing?: Promise<void>;
}
export interface SharedServiceOptions {
  root: string;
  store: SharedStore;
  files: SessionFileStore;
  principals: Record<string, number>;
  /** Admits sessions from published harnesses and re-checks them against current policy on activation. */
  admission: SharedAdmission;
  limits: SharedWorkerLimits;
  gatewayUrl: string;
  mintToken: (lease: SessionFileLease, turn: SharedTurn) => Promise<string>;
  report: (event: string, id: string) => void;
  /** Egress and delegation for the base tool set. */
  toolkit?: SharedToolkitOptions;
  /** Handlers for the `custom` approval mode, by name. */
  permissionHandlers?: ReadonlyMap<string, CustomPermissionHandler>;
  permissionHandlerTimeoutMs?: number;
}

/** Managed settings that keep the runtime from entering an approval mode the harness's policy does not allow. */
export function approvalManagedSettings(approval: SharedApprovalPlan): ManagedSettings | undefined {
  const permissions = {
    ...(approval.available.includes("allow-all") ? {} : { disableBypassPermissionsMode: "disable" }),
    ...(approval.available.includes("assisted") ? {} : { disableAssistedPermissionsMode: true }),
  };
  return Object.keys(permissions).length ? { permissions } : undefined;
}

/**
 * One shared runtime owner serving many harnesses. Callers receive activation-bound one-use tickets, which only the
 * connection broker consumes; native listener secrets never leave this process. Each session runs its admitted
 * harness snapshot under the harness's current effective policy.
 */
export class SharedSessionService {
  readonly #runtime: SharedSessionRuntime;
  readonly #scheduler: SharedTurnScheduler;
  readonly #residents = new Map<string, Resident>();
  readonly #opening = new Map<string, Promise<void>>();
  /** The harness of every opening or resident session: the per-harness residency reservations. */
  readonly #harnessOf = new Map<string, string>();
  #timer?: NodeJS.Timeout;
  #maintenance?: Promise<void>;
  #stopping = false;
  #healthy = false;

  constructor(private readonly options: SharedServiceOptions) {
    options.principals = SharedPrincipalBindings.parse(options.principals);
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
  /** Resident sessions by harness, for operators and tests. */
  residentsByHarness(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const resident of this.#residents.values()) counts[resident.harness] = (counts[resident.harness] ?? 0) + 1;
    return counts;
  }
  busy(id: string): boolean { return this.#scheduler.busy(id) || this.#opening.has(id); }
  /** The approval mode the runtime reports in force for a resident conversation. */
  async approvalMode(principal: string, id: string): Promise<string> {
    this.activation(principal, id);
    return this.#runtime.approvalMode(id);
  }
  /** Asks the runtime for an approval mode, as an attached client's switch does; returns the mode in force afterwards. */
  async requestApprovalMode(principal: string, id: string, mode: Parameters<SharedSessionRuntime["requestApprovalMode"]>[1]): Promise<string> {
    this.activation(principal, id);
    return this.#runtime.requestApprovalMode(id, mode);
  }
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

  async create(principal: string, request: SharedSessionCreation): Promise<SharedSessionRecord["view"]> {
    if (this.#stopping) throw new StoreError("invalid_state", "The shared service is stopping.");
    const identity = this.identity(principal);
    const definition = await this.options.admission.admit(principal, request);
    const row = await this.options.store.create(principal, identity, request.label, definition, this.options.limits.retainedSessionsPerPrincipal);
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

  /** Activates the session and issues a one-use ticket over `transport`; the API adds the broker URL. */
  async connection(principal: string, id: string, transport: HostingTransport = "direct"): Promise<ConnectionTicket> {
    const row = await this.get(principal, id);
    if (row.view.closed) throw new StoreError("not_found", "The shared conversation is closed.");
    await this.options.admission.connectable(row.definition, transport, principal);
    await this.ensure(principal, id);
    return { sessionId: id, ahpSessionId: row.view.segment.ahpSessionId, ...(await this.options.store.issueTicket(principal, id)) };
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
    if (row.placement !== "shared") throw new StoreError("not_found", "The conversation runs in a session container; connect through the application API.");
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

  /** An idle resident to evict so `harness` fits, or undefined when it fits now; throws when nothing can be evicted. */
  #capacityVictim(id: string, harness: string): string | undefined {
    const residents = [...this.#residents.values()].map((entry) => ({
      id: entry.record.id, harness: entry.harness, lastActivity: entry.lastActivity, idle: !this.busy(entry.record.id) && !entry.closing,
    }));
    return residencyVictim(this.options.limits, this.#harnessOf, residents, id, harness);
  }

  private async activate(row: SharedSessionRecord): Promise<void> {
    const plan = await this.options.admission.activation(row.definition, row.principal);
    const harness = plan.harness.name;
    for (;;) {
      const victim = this.#capacityVictim(row.id, harness);
      if (!victim) break;
      await this.deactivate(victim);
    }
    this.#harnessOf.set(row.id, harness);
    let activation: Resident | undefined;
    const bind = (context: SharedActivationContext): Resident => {
      if (!activation) {
        if (this.#residents.has(row.id)) throw new Error("Another activation is already resident.");
        activation = { context, record: row, harness, controller: new AbortController(), lastActivity: Date.now() };
        this.#residents.set(row.id, activation);
      }
      if (this.#residents.get(row.id) !== activation || activation.context.lease.epoch !== context.lease.epoch
        || activation.controller.signal.aborted) throw new Error("The activation context is no longer active.");
      return activation;
    };
    const settings = sharedSessionSettings(plan.definition);
    try {
      const connection = await this.#runtime.open({
        id: row.id, principal: row.principal, githubUserId: row.githubUserId, model: plan.model,
        configuration: `${plan.harness.digest}|${plan.model}`,
        settings: { ...settings, managedSettings: approvalManagedSettings(plan.approval) },
        approval: { initial: plan.approval.initial, available: plan.approval.available, ...(plan.approval.judgeModel ? { judgeModel: plan.approval.judgeModel } : {}) },
        tools: async (context) => {
          const resident = bind(context);
          const toolset = await sharedToolset(plan, row, context, () => this.#scheduler.current(context.lease), this.options.toolkit ?? {});
          resident.policy = this.#policy(plan, row, toolset.rules, new Set(settings.builtinTools));
          return toolset.tools;
        },
        permissions: (context) => async (request, invocation) => {
          const policy = bind(context).policy;
          if (!policy) return { kind: "reject", feedback: "The conversation is not ready." };
          return policy.handle(request, invocation);
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
            if (resident.controller.signal.aborted) return { permissionDecision: "deny", permissionDecisionReason: "The conversation is deactivating." };
            const policy = resident.policy;
            if (!policy) return { permissionDecision: "deny", permissionDecisionReason: "The conversation is not ready." };
            const decision = policy.preToolUse(toolName);
            if (decision?.permissionDecision === "deny") return decision;
            try {
              await this.options.store.grant(context.lease, this.#scheduler.current(context.lease).id);
            } catch (error) {
              this.options.report("session.tool_grant_refused", row.id);
              if (!(error instanceof StoreError)) throw error;
              return { permissionDecision: "deny", permissionDecisionReason: "The conversation has no active execution grant." };
            }
            return decision;
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
      finally {
        if (!this.#residents.has(row.id)) this.#harnessOf.delete(row.id);
        this.options.report("session.activation_failed", row.id);
      }
      throw error;
    }
  }

  #policy(plan: SharedActivationPlan, row: SharedSessionRecord, rules: Map<string, ToolRule>, builtins: Set<string>): SharedPermissionPolicy {
    const handler = plan.approval.handler ? this.options.permissionHandlers?.get(plan.approval.handler) : undefined;
    return new SharedPermissionPolicy({
      harness: plan.harness.name, sessionId: row.id, principal: row.principal, definition: plan.definition,
      approval: plan.approval, rules, builtins,
      ...(handler ? { handler } : {}),
      ...(this.options.permissionHandlerTimeoutMs ? { handlerTimeoutMs: this.options.permissionHandlerTimeoutMs } : {}),
      report: (event) => this.options.report(event, row.id),
    });
  }

  async deactivate(id: string): Promise<void> {
    const resident = this.#residents.get(id);
    if (!resident) {
      if (!this.#opening.has(id)) this.#harnessOf.delete(id);
      return;
    }
    if (!resident.closing) {
      resident.controller.abort(new Error("The shared activation is closing."));
      resident.closing = (async () => {
        try { await this.#scheduler.finish(resident.context.lease, true); }
        finally {
          await this.#runtime.close(id);
          if (this.#residents.get(id) === resident) {
            this.#residents.delete(id);
            this.#harnessOf.delete(id);
          }
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
