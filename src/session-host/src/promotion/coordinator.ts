import { setTimeout as delay } from "node:timers/promises";
import {
  effectiveHarnessHosting, effectiveHostingPolicy, PROMOTE_SESSION_TOOL,
  type PromotionErrorCode, type PromotionSource, type PromotionView, type SharedWorkerLimits,
} from "@copilot-agent/contracts";
import {
  StoreError, type PromotionContainerSettings, type PromotionRecord, type PromotionStorageAreas, type PromotionStore, type SessionFileStore,
} from "@copilot-agent/job-store";
import type { SharedActivationPlan } from "../admission.js";

export interface SharedPromotionsOptions {
  store: PromotionStore;
  files: SessionFileStore;
  /** The session-container settings the started container runs under. */
  settings: PromotionContainerSettings;
  limits: SharedWorkerLimits;
  /** Closes the session's shared activation, which ends its turn scheduling and AHP connections. */
  deactivate: (id: string) => Promise<void>;
  /** The provider keys and workspace path of the session's storage. */
  storageAreas: (id: string) => Promise<PromotionStorageAreas>;
  /** Delivers a system continuation to the shared conversation, deduplicated by `notificationId`. */
  notify: (principal: string, id: string, notificationId: string, prompt: string) => Promise<unknown>;
  report: (event: string, id: string) => void;
  /** Interval between checks while the container starts; one second by default. */
  pollMs?: number;
  /** How long the container may take to commit the cutover; the startup limit plus a minute by default. */
  readyTimeoutMs?: number;
}

/** A refusal before anything moved: the agent's tool call fails, or the API answers with this code. */
export class PromotionRefused extends Error {
  constructor(readonly code: PromotionErrorCode, message: string) { super(message); }
}

/**
 * Drives one-way promotions from the shared worker (docs/HOSTING-MODES-PLAN.md, section 7.3). A request is recorded
 * and checked against the harness's current policy and the deployment's container capacity while its turn runs; when
 * the turn ends, the shared activation closes, the snapshot is read under a fenced storage lease, and a session
 * container is reserved. The container restores the snapshot and resumes the same session; its readiness commits the
 * cutover in the ledger. Any failure before that leaves the session shared and accepting turns, releases the
 * container, and tells the agent that asked.
 */
export class SharedPromotions {
  readonly #running = new Map<string, Promise<void>>();
  #stopping = false;

  constructor(private readonly options: SharedPromotionsOptions) {}

  /** Records a promotion for the session, or returns the one that already answers this request. */
  async request(input: {
    principal: string; sessionId: string; plan: SharedActivationPlan; source: PromotionSource; requestKey: string; reason?: string;
  }): Promise<{ promotion: PromotionView; created: boolean }> {
    const hosting = effectiveHarnessHosting(input.plan.definition, input.plan.policy);
    if (hosting.mode !== "promotable" || !hosting.promotion) {
      throw new PromotionRefused("promotion_not_allowed", "This conversation's harness is not promotable.");
    }
    const resources = effectiveHostingPolicy(input.plan.policy).sizes[hosting.promotion.size];
    if (!resources) throw new PromotionRefused("promotion_not_allowed", `The promotion size '${hosting.promotion.size}' is not in the operator's size catalog.`);
    const existing = await this.options.store.open(input.sessionId);
    if (!existing && !(await this.options.store.hasCapacity(input.principal, this.options.limits))) {
      throw new PromotionRefused("promotion_capacity", "No session container capacity is available now; the conversation stays in shared placement.");
    }
    const { promotion, created } = await this.options.store.request({
      principal: input.principal, sessionId: input.sessionId, source: input.source, requestKey: input.requestKey,
      reason: input.reason ?? "", size: hosting.promotion.size, resources,
    });
    if (created) this.options.report("session.promotion_requested", input.sessionId);
    return { promotion: promotion.view, created };
  }

  /**
   * The session's turn ended: a requested move starts. This covers promotions and the handoffs that reuse them; a move
   * whose snapshot carries no history (`history` on its record) captures only the workspace, here and on recovery.
   */
  turnEnded(sessionId: string): void {
    void this.options.store.open(sessionId).then((promotion) => {
      if (promotion?.state === "requested") this.#start(promotion);
    }).catch(() => this.options.report("session.promotion_failed", sessionId));
  }

  /** Starts a requested promotion that has no turn to wait for, such as one an API caller asked for. */
  begin(promotionId: string): void {
    void this.options.store.byId(promotionId).then((promotion) => {
      if (promotion?.state === "requested") this.#start(promotion);
    }).catch(() => this.options.report("session.promotion_failed", ""));
  }

  /** Resumes promotions this worker left open, for example after a restart. */
  async recover(): Promise<void> {
    for (const promotion of await this.options.store.unfinished()) {
      if (!this.#running.has(promotion.id)) this.#start(promotion);
    }
  }

  /** Whether a promotion is being driven in this process. */
  running(promotionId: string): boolean { return this.#running.has(promotionId); }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#running.values()]);
  }

  #start(promotion: PromotionRecord): void {
    if (this.#stopping || this.#running.has(promotion.id)) return;
    const run = this.#run(promotion).finally(() => this.#running.delete(promotion.id));
    this.#running.set(promotion.id, run);
  }

  async #run(initial: PromotionRecord): Promise<void> {
    const { store, files } = this.options;
    const id = initial.id;
    const session = initial.sessionId;
    let failure: { code: PromotionErrorCode; message: string } | undefined;
    try {
      let current = initial;
      if (current.state === "requested" || current.state === "moving") {
        current = await store.begin(id);
        this.options.report("session.promotion_moving", session);
        await this.options.deactivate(session);
        const areas = await this.options.storageAreas(session);
        let lease;
        try { lease = await files.acquire(session, current.principal, `promotion:${id}`, 60); }
        catch { throw new PromotionRefused("snapshot_failed", "The conversation's storage is still held by an activation."); }
        try { current = await store.capture(id, lease, areas); }
        catch (error) {
          throw new PromotionRefused("snapshot_failed", error instanceof StoreError ? error.message : "The conversation's snapshot could not be read.");
        } finally { await files.release(lease); }
        this.options.report("session.promotion_snapshot", session);
      }
      if (current.state === "starting" && !current.allocationId) {
        try { await store.allocate(id, this.options.settings, this.options.limits); }
        catch (error) {
          if (error instanceof StoreError && error.code === "quota_exceeded") throw new PromotionRefused("promotion_capacity", error.message);
          throw new PromotionRefused("allocation_failed", error instanceof StoreError ? error.message : "The session container could not be reserved.");
        }
        this.options.report("session.promotion_allocated", session);
      }
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? (this.options.settings.startupSeconds + 60) * 1000);
      for (;;) {
        const latest = await store.byId(id);
        if (!latest || latest.state === "committed") {
          this.options.report("session.promotion_committed", session);
          return;
        }
        if (latest.state === "failed") {
          await this.#notify(latest);
          return;
        }
        const allocation = await store.allocationState(id);
        if (allocation && (allocation.state === "retiring" || allocation.state === "retired")) {
          throw new PromotionRefused("startup_failed", allocation.error ?? "The session container stopped before the cutover.");
        }
        if (Date.now() > deadline) throw new PromotionRefused("promotion_timeout", "The session container did not report ready in time.");
        if (this.#stopping) return;
        await delay(this.options.pollMs ?? 1_000);
      }
    } catch (error) {
      failure = error instanceof PromotionRefused
        ? { code: error.code, message: error.message }
        : { code: "startup_failed", message: "The move to a session container failed." };
    } finally {
      if (failure) {
        await this.options.store.fail(id, failure.code, failure.message)
          .then((promotion) => { this.options.report("session.promotion_failed", session); return this.#notify(promotion); })
          .catch(() => this.options.report("session.promotion_failed", session));
      }
    }
  }

  /**
   * Tells the agent that asked for a failed promotion why it did not happen; the conversation continues where it was.
   * Handoffs are reported to the source agent by the handoff ledger, in handoff terms.
   */
  async #notify(promotion: PromotionRecord): Promise<void> {
    if (promotion.state !== "failed" || promotion.source !== "tool" || promotion.kind !== "promotion" || !(await this.options.store.markNotified(promotion.id))) return;
    await this.options.notify(promotion.principal, promotion.sessionId, `promotion-${promotion.id}`, [
      `The move to a dedicated container that ${PROMOTE_SESSION_TOOL} requested did not happen (${promotion.view.error?.code}): ${promotion.view.error?.message}`,
      "The conversation continues in shared placement, without a shell or a real filesystem. Tell the person, and continue with what is possible here.",
    ].join("\n"));
  }
}
