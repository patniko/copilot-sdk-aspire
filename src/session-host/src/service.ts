import { randomUUID } from "node:crypto";
import {
  handoffFailureNotice, handoffNotice, handoffNoticeMarker, SharedPrincipalBindings, SharedWorkerLimits,
  type ConnectionTicket, type HandoffPayload, type HostingTransport, type SharedSessionCreation,
} from "@copilot-agent/contracts";
import type { ManagedSettings, ToolInvocation } from "@github/copilot-sdk";
import {
  HandoffStore, SessionFileStore, SharedStore, StoreError,
  type HandoffRecord, type HandoffRequest, type SessionFileLease, type SharedSessionRecord, type SharedTurn,
} from "@copilot-agent/job-store";
import { handoffToolName, readServerKey, type AhpProxyTarget } from "@copilot-agent/service-defaults";
import { HandoffRefusal, type SharedActivationPlan, type SharedAdmission, type SharedApprovalPlan } from "./admission.js";
import type { HandoffOffer } from "./handoff-tools.js";
import { sharedSessionSettings } from "./harness-session.js";
import { residencyVictim } from "./residency.js";
import type { CustomPermissionHandler } from "./permission-handlers.js";
import { SharedPermissionPolicy, type ToolRule } from "./permissions.js";
import { SharedSessionRuntime, type SharedActivationContext } from "./runtime.js";
import { SharedTurnScheduler } from "./scheduler.js";
import { sharedToolset, type SharedToolkitOptions } from "./toolkit.js";

/** How long a transfer tool waits for the runtime to report who approved its permission request. */
const DECISION_WAIT_MS = 3_000;

interface Resident {
  context: SharedActivationContext;
  record: SharedSessionRecord;
  harness: string;
  controller: AbortController;
  lastActivity: number;
  policy?: SharedPermissionPolicy;
  connection?: Awaited<ReturnType<SharedSessionRuntime["open"]>>;
  closing?: Promise<void>;
  /** The accepted handoff whose cutover follows this activation's current turn; no new turns start meanwhile. */
  handoff?: string;
  /** Who answered recent permission requests, by tool call: the runtime's `permission.completed` decision source. */
  decisions: Map<string, { source?: string; approved: boolean }>;
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
  /** The handoff ledger; required for harnesses with handoff targets. */
  handoffs?: HandoffStore;
}

/** Managed settings that keep the runtime from entering an approval mode the harness's policy does not allow. */
export function approvalManagedSettings(approval: SharedApprovalPlan): ManagedSettings | undefined {
  const permissions = {
    ...(approval.available.includes("allow-all") ? {} : { disableBypassPermissionsMode: "disable" }),
    ...(approval.available.includes("assisted") ? {} : { disableAssistedPermissionsMode: true }),
  };
  return Object.keys(permissions).length ? { permissions } : undefined;
}

/** What the source's transfer tool returns for a recorded handoff; a refusal is a tool error and the source keeps control. */
export function handoffOutcome(handoff: HandoffRecord): string {
  if (handoff.state === "refused" || handoff.state === "failed") {
    const error = handoff.view.error;
    throw new Error(`Handoff refused (${error?.code ?? "handoff_failed"}): ${error?.message ?? "The handoff did not complete."} You remain in control of the conversation.`);
  }
  if (handoff.state === "committed") return `This conversation was already handed off to ${handoff.target.name}.`;
  return `Handoff accepted: ${handoff.target.name} takes over this conversation when your turn ends (${handoff.history} history). `
    + `Tell the person in one short sentence that ${handoff.target.name} will continue, then end your turn without calling more tools.`;
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
  /** Handoff cutovers in progress, by handoff. */
  readonly #cutovers = new Map<string, Promise<void>>();
  /** Handoff notices being delivered, by session. */
  readonly #notices = new Map<string, Promise<void>>();
  /** Sessions whose handoff notice waits for the conversation to be idle, with their principal. */
  readonly #noticeRetries = new Map<string, string>();
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
    let row = await this.get(principal, id);
    if (row.view.closed) throw new StoreError("not_found", "The shared conversation is closed.");
    await this.options.admission.connectable(row.definition, transport, principal);
    await this.ensure(principal, id);
    // A handoff may have started a new segment while the session activated; attach to the current one.
    row = await this.get(principal, id);
    this.#notify(principal, id);
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
    if (!resident || resident.closing || resident.handoff || this.busy(id)) throw new StoreError("quota_exceeded", "The conversation is busy; completion delivery must wait.");
    const marker = `shared-completion:${notificationId}`;
    if (await this.#runtime.hasSystemMessage(id, marker)) return "already-delivered";
    await this.#system(resident, id, "completion", marker, `[${marker}]\n${prompt}`);
    return "delivered";
  }

  /** Starts a system-originated turn with `prompt`; the turn settles when the runtime reports the session idle. */
  async #system(resident: Resident, id: string, source: "completion" | "handoff", operationKey: string, prompt: string): Promise<void> {
    const signal = AbortSignal.any([resident.controller.signal, resident.context.signal]);
    await this.#scheduler.acquire(resident.context.lease, signal, source, operationKey);
    try {
      signal.throwIfAborted();
      await this.#runtime.sendSystem(id, prompt);
    } catch (error) {
      await this.#scheduler.finish(resident.context.lease, true);
      throw error;
    }
  }

  async ensure(principal: string, id: string): Promise<void> {
    if (this.#stopping) throw new StoreError("invalid_state", "The shared service is stopping.");
    let row = await this.get(principal, id);
    if (row.view.closed) throw new StoreError("not_found", "The shared conversation is closed.");
    if (row.placement !== "shared") throw new StoreError("not_found", "The conversation runs in a session container; connect through the application API.");
    const opening = this.#opening.get(id);
    if (opening) return opening;
    const resident = this.#residents.get(id);
    if (resident?.closing) await resident.closing;
    else if (resident?.connection && !resident.controller.signal.aborted) return;
    // Finish a handoff a previous activation accepted before opening either harness.
    const pending = await this.options.handoffs?.open(id);
    if (pending) {
      await this.#cutover(pending.id);
      if (this.#residents.get(id)?.connection || this.#opening.has(id)) return this.#opening.get(id);
      row = await this.get(principal, id);
      if (row.view.closed) throw new StoreError("not_found", "The shared conversation is closed.");
    }
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
    const handoffs = plan.definition.hosting?.handoffs?.length ? this.options.handoffs : undefined;
    if (plan.definition.hosting?.handoffs?.length && !handoffs) throw new Error("Handoffs are not configured on this shared worker.");
    const offers = handoffs ? await this.options.admission.handoffOffers(plan.definition, "shared") : [];
    const offerByTool = new Map<string, HandoffOffer>();
    const { segment } = row.view;
    // The segment a handoff started prepares its storage once, under the activation's lease, before its runtime opens.
    const started = segment.generation > 1 ? await this.options.handoffs?.forSegment(row.id, segment.generation) : undefined;
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
        activation = { context, record: row, harness, controller: new AbortController(), lastActivity: Date.now(), decisions: new Map() };
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
        runtimeSessionId: segment.ahpSessionId, generation: segment.generation,
        ...(started && !started.prepared
          ? { prepare: async (lease: SessionFileLease) => { await this.options.handoffs!.prepareStorage(started.id, lease, this.#runtime.handoffAreas(started.id)); } }
          : {}),
        configuration: `${plan.harness.digest}|${plan.model}`,
        settings: { ...settings, managedSettings: approvalManagedSettings(plan.approval) },
        approval: { initial: plan.approval.initial, available: plan.approval.available, ...(plan.approval.judgeModel ? { judgeModel: plan.approval.judgeModel } : {}) },
        tools: async (context) => {
          const resident = bind(context);
          const toolset = await sharedToolset(plan, row, context, () => this.#scheduler.current(context.lease), this.options.toolkit ?? {}, handoffs ? {
            offers, run: (offer, payload, invocation) => this.#transfer(resident, row, plan, offer, payload, invocation),
          } : undefined);
          for (const offer of offers) offerByTool.set(handoffToolName(offer.harness), offer);
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
            // After an accepted handoff only the turn that accepted it may continue; the target takes the next one.
            if (resident.handoff && !this.#scheduler.busy(row.id)) throw new Error("The conversation is moving to another harness.");
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
            if (resident.handoff) {
              return { permissionDecision: "deny", permissionDecisionReason: "This conversation is being handed off; end your turn without calling more tools." };
            }
            const policy = resident.policy;
            if (!policy) return { permissionDecision: "deny", permissionDecisionReason: "The conversation is not ready." };
            const decision = policy.preToolUse(toolName);
            if (decision?.permissionDecision === "deny") return decision;
            // Do not ask a person to approve a handoff that current policy or this deployment would refuse.
            const offer = offerByTool.get(toolName.replace(/^custom:/, ""));
            if (offer) {
              const refusal = await this.#handoffPrecheck(row, offer);
              if (refusal) return { permissionDecision: "deny", permissionDecisionReason: refusal };
            }
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
          if (event.type === "permission.completed" && event.data.toolCallId) {
            if (resident.decisions.size >= 64) resident.decisions.delete(resident.decisions.keys().next().value!);
            resident.decisions.set(event.data.toolCallId, { source: event.data.decisionSource, approved: event.data.result.kind.startsWith("approved") });
          }
          if (event.type === "session.idle" && !event.agentId) {
            resident.lastActivity = Date.now();
            void this.#scheduler.finish(context.lease).then(() => {
              if (resident.handoff) void this.#cutover(resident.handoff).catch(() => this.options.report("session.handoff_cutover_failed", row.id));
            }, () => {
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

  /** Why a handoff would be refused now, before a person is asked to approve it; undefined when it can go ahead. */
  async #handoffPrecheck(row: SharedSessionRecord, offer: HandoffOffer): Promise<string | undefined> {
    try {
      await this.options.admission.handoff({ principal: row.principal, session: row.definition, from: "shared", target: offer.harness });
      return undefined;
    } catch (error) {
      if (error instanceof HandoffRefusal) return `Handoff refused (${error.code}): ${error.message} You remain in control of the conversation.`;
      throw error;
    }
  }

  /**
   * One transfer tool call (docs/HOSTING-MODES-PLAN.md, section 7.5). Repeated calls return the recorded outcome. The
   * target is checked against current policy and this deployment, and with `ask` approval the call must have been
   * approved by a person through the attached client, never by the runtime's judge, a policy, or a handler. Then the
   * ledger records it: refused leaves the source in control; accepted moves control when this turn ends.
   */
  async #transfer(resident: Resident, row: SharedSessionRecord, plan: SharedActivationPlan, offer: HandoffOffer, payload: HandoffPayload, invocation: ToolInvocation): Promise<string> {
    const handoffs = this.options.handoffs!;
    const recorded = await handoffs.byRequest(row.id, invocation.toolCallId);
    if (recorded) return handoffOutcome(recorded);
    if (resident.handoff) throw new Error("This conversation is already being handed off; end your turn.");
    let refusal: HandoffRequest["refusal"];
    let checked: Awaited<ReturnType<SharedAdmission["handoff"]>> | undefined;
    try {
      checked = await this.options.admission.handoff({ principal: row.principal, session: row.definition, from: "shared", target: offer.harness });
    } catch (error) {
      if (!(error instanceof HandoffRefusal)) throw error;
      refusal = { code: error.code, message: error.message, ...(error.prerequisite ? { prerequisite: error.prerequisite } : {}) };
    }
    let approvedBy: "person" | "policy" | undefined;
    if (checked) {
      if (checked.approval === "allow") approvedBy = "policy";
      else if (await this.#approvedByPerson(resident, invocation.toolCallId)) approvedBy = "person";
      else refusal = { code: "handoff_declined", message: "This handoff needs the approval of the person attached to the conversation, and no person approved it." };
    }
    const { handoff } = await handoffs.request({
      principal: row.principal, sessionId: row.id, requestKey: invocation.toolCallId,
      fromGeneration: row.view.segment.generation, fromPlacement: "shared", source: plan.harness,
      target: checked ? checked.target : { name: offer.harness },
      ...(checked ? { toPlacement: checked.placement } : {}),
      history: checked?.history ?? offer.history, approval: checked?.approval ?? offer.approval,
      ...(approvedBy && !refusal ? { approvedBy } : {}), payload,
      ...(refusal ? { refusal } : {}),
    });
    this.options.report(`session.handoff_${handoff.state}`, row.id);
    if (handoff.state === "accepted") resident.handoff = handoff.id;
    return handoffOutcome(handoff);
  }

  /** Whether the runtime reports that a person approved this tool call's permission request. */
  async #approvedByPerson(resident: Resident, toolCallId: string): Promise<boolean> {
    const deadline = Date.now() + DECISION_WAIT_MS;
    let decision = resident.decisions.get(toolCallId);
    while (!decision && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      decision = resident.decisions.get(toolCallId);
    }
    decision ??= await this.#runtime.permissionDecision(resident.record.id, toolCallId).catch(() => undefined);
    this.options.report(`session.handoff_decision.${decision ? `${decision.approved ? "approved" : "declined"}_by_${decision.source ?? "unattributed"}` : "missing"}`, resident.record.id);
    return decision?.approved === true && decision.source === "human_response";
  }

  /** Completes an accepted handoff once its turn has ended; concurrent callers share one cutover. */
  #cutover(handoffId: string): Promise<void> {
    let running = this.#cutovers.get(handoffId);
    if (!running) {
      running = this.#runCutover(handoffId).finally(() => this.#cutovers.delete(handoffId));
      this.#cutovers.set(handoffId, running);
    }
    return running;
  }

  /**
   * The same-placement cutover: re-check the pinned target under current policy, commit the target's segment in the
   * ledger (the broker then closes attached clients with "moved"), close the source's activation, and open the
   * target's, which prepares storage and receives the handoff notice as its first turn. A failed re-check fails the
   * handoff and leaves the source in control.
   */
  async #runCutover(handoffId: string): Promise<void> {
    const handoffs = this.options.handoffs;
    const handoff = await handoffs?.byId(handoffId);
    if (!handoffs || !handoff || handoff.state !== "accepted" || handoff.fromPlacement !== "shared") return;
    const { sessionId: id, principal } = handoff;
    // The turn that accepted the handoff is still running; its idle event starts the cutover again.
    if (this.#scheduler.busy(id) && this.#residents.has(id)) return;
    const row = await this.options.store.get(principal, id);
    const release = async (code: Parameters<HandoffStore["fail"]>[1], message: string) => {
      await handoffs.fail(handoffId, code, message);
      this.options.report("session.handoff_failed", id);
      const resident = this.#residents.get(id);
      if (resident?.handoff === handoffId) resident.handoff = undefined;
      if (row && !row.view.closed) this.#notify(principal, id);
    };
    if (!row || row.view.closed || row.placement !== "shared" || row.view.segment.generation !== handoff.fromGeneration) {
      return release("session_changed", "The conversation closed or moved before the handoff completed.");
    }
    let checked: Awaited<ReturnType<SharedAdmission["handoff"]>>;
    try {
      checked = await this.options.admission.handoff({
        principal, session: row.definition, from: "shared", target: handoff.target.name,
        pinned: { version: handoff.target.version!, digest: handoff.target.digest! },
      });
    } catch (error) {
      if (!(error instanceof HandoffRefusal)) throw error;
      return release(error.code, error.message);
    }
    if (checked.placement !== "shared" || checked.history !== handoff.history) {
      return release("handoff_unavailable", "The target can no longer start in this conversation's placement with the accepted history.");
    }
    const ahpSessionId = handoff.history === "full" ? row.view.segment.ahpSessionId : randomUUID();
    try {
      await handoffs.commitShared(handoffId, { definition: checked.definition, ahpSessionId });
    } catch (error) {
      if (error instanceof StoreError && error.code === "invalid_state") {
        const resident = this.#residents.get(id);
        if (resident?.handoff === handoffId) resident.handoff = undefined;
        this.options.report("session.handoff_failed", id);
        return;
      }
      throw error;
    }
    this.options.report("session.handoff_committed", id);
    await this.deactivate(id);
    if (this.#stopping) return;
    await this.ensure(principal, id);
    this.#notify(principal, id);
  }

  /** Delivers a pending handoff notice to the session in the background: the target's first turn, or a failure to the source. */
  #notify(principal: string, id: string): void {
    if (!this.options.handoffs || this.#notices.has(id) || this.#stopping) return;
    const delivery = this.#deliverNotice(principal, id)
      .then((delivered) => {
        if (delivered) this.#noticeRetries.delete(id);
        else this.#noticeRetries.set(id, principal);
      }, () => {
        this.#noticeRetries.set(id, principal);
        this.options.report("session.handoff_notice_deferred", id);
      })
      .finally(() => this.#notices.delete(id));
    this.#notices.set(id, delivery);
  }

  /** Delivers the session's pending handoff notice; false when it must wait because the conversation is busy. */
  async #deliverNotice(principal: string, id: string): Promise<boolean> {
    const handoffs = this.options.handoffs!;
    const row = await this.get(principal, id);
    if (row.view.closed || row.placement !== "shared") return true;
    const generation = row.view.segment.generation;
    const started = generation > 1 ? await handoffs.forSegment(id, generation) : undefined;
    const pending = started && !started.notified ? started : await handoffs.unnotifiedFailure(id, generation);
    if (!pending) return true;
    if (this.busy(id)) return false;
    await this.ensure(principal, id);
    const resident = this.#residents.get(id);
    if (!resident?.connection || resident.closing || resident.handoff || this.busy(id)) return false;
    const marker = handoffNoticeMarker(pending.id);
    if (!(await this.#runtime.hasSystemMessage(id, marker))) {
      const notice = pending.state === "committed"
        ? handoffNotice({ id: pending.id, source: pending.source.name, target: pending.target.name, history: pending.history, payload: pending.payload })
        : handoffFailureNotice({
          id: pending.id, target: pending.target.name, code: pending.view.error?.code ?? "handoff_failed", message: pending.view.error?.message ?? "",
        });
      await this.#system(resident, id, "handoff", `handoff:${pending.id}`, notice);
    }
    await handoffs.markNotified(pending.id);
    return true;
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
    // A handoff whose turn ended without its cutover (a lost activation or a restart) moves now, and notices that had to
    // wait for a busy conversation are retried.
    for (const handoff of await this.options.handoffs?.pending("shared") ?? []) {
      if (this.#cutovers.has(handoff.id) || this.busy(handoff.sessionId)) continue;
      void this.#cutover(handoff.id).catch(() => this.options.report("session.handoff_cutover_failed", handoff.sessionId));
    }
    for (const [id, principal] of this.#noticeRetries) {
      if (!this.busy(id)) this.#notify(principal, id);
    }
    this.#healthy = true;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    for (const resident of this.#residents.values()) resident.controller.abort(new Error("The shared service is stopping."));
    await Promise.allSettled([...this.#opening.values()]);
    await this.#maintenance;
    await Promise.allSettled([...this.#cutovers.values(), ...this.#notices.values()]);
    try { await Promise.all([...this.#residents.keys()].map((id) => this.deactivate(id))); }
    finally { await this.#runtime.stop(); }
  }
}
