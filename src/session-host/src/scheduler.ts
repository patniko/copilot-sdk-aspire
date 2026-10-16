import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SharedWorkerLimits } from "@copilot-agent/contracts";
import { SharedStore, StoreError, type SessionFileLease, type SharedTurn } from "@copilot-agent/job-store";

interface WaitingTurn {
  lease: SessionFileLease;
  controller: AbortController;
  operationKey: string;
  turn?: SharedTurn;
  timer?: NodeJS.Timeout;
}
interface Entry {
  state: WaitingTurn;
  ready: Promise<SharedTurn>;
  finish?: Promise<void>;
}

/** Local waits backed by durable FIFO admission; a token callback never starts an unadmitted model turn. */
export class SharedTurnScheduler {
  readonly #entries = new Map<string, Entry>();
  constructor(
    private readonly store: SharedStore,
    private readonly limits: SharedWorkerLimits,
    private readonly expire: (lease: SessionFileLease) => Promise<void>,
    private readonly report: (event: string, id: string) => void,
  ) {}

  busy(id: string): boolean { return this.#entries.has(id); }

  current(lease: SessionFileLease): SharedTurn {
    const entry = this.#entries.get(lease.id);
    if (!entry || entry.state.lease.epoch !== lease.epoch || entry.state.lease.principal !== lease.principal
      || entry.state.controller.signal.aborted || entry.finish || entry.state.turn?.state !== "running") {
      throw new StoreError("invalid_state", "The conversation has no active execution turn.");
    }
    return entry.state.turn;
  }

  async acquire(lease: SessionFileLease, signal: AbortSignal, source: "user" | "completion" | "handoff" = "user", operationKey: string = randomUUID()): Promise<SharedTurn> {
    signal.throwIfAborted();
    const existing = this.#entries.get(lease.id);
    if (existing) {
      if (existing.state.lease.epoch !== lease.epoch || existing.state.lease.principal !== lease.principal) {
        throw new StoreError("invalid_state", "Another activation owns this conversation turn.");
      }
      if (source !== "user" && existing.state.operationKey !== operationKey) {
        throw new StoreError("quota_exceeded", "The conversation is busy; completion delivery must wait.");
      }
      if (existing.finish) {
        await existing.finish;
        return this.acquire(lease, signal, source, operationKey);
      }
      return existing.ready;
    }
    const state: WaitingTurn = { lease, controller: new AbortController(), operationKey };
    const ready = this.wait(state, signal, source, operationKey);
    this.#entries.set(lease.id, { state, ready });
    return ready;
  }

  async finish(lease: SessionFileLease, interrupted = false): Promise<void> {
    const entry = this.#entries.get(lease.id);
    if (!entry || entry.state.lease.epoch !== lease.epoch || entry.state.lease.principal !== lease.principal) return;
    if (!entry.finish) entry.finish = this.finishEntry(entry, interrupted);
    return entry.finish;
  }

  private async wait(state: WaitingTurn, signal: AbortSignal, source: "user" | "completion" | "handoff", operationKey: string): Promise<SharedTurn> {
    const combined = AbortSignal.any([signal, state.controller.signal, AbortSignal.timeout(this.limits.queueWaitSeconds * 1000)]);
    let queued: SharedTurn | undefined;
    try {
      queued = await this.store.enqueueTurn(state.lease, operationKey, source, this.limits);
      if (queued.state !== "queued" && queued.state !== "running") {
        throw new StoreError("invalid_state", "This turn operation has already finished; it cannot be replayed.");
      }
      while (true) {
        combined.throwIfAborted();
        const started = await this.store.startTurn(state.lease, queued.id, this.limits);
        if (started) {
          combined.throwIfAborted();
          state.turn = started;
          state.timer = setTimeout(() => {
            state.controller.abort(new Error("The shared turn deadline expired."));
            void this.expire(state.lease).catch(() => this.report("session.deadline_cleanup_failed", state.lease.id));
          }, Math.max(0, Date.parse(started.deadline!) - Date.now()));
          return started;
        }
        await delay(100, undefined, { signal: combined });
      }
    } catch (error) {
      this.report(combined.aborted ? "session.turn_cancelled" : "session.turn_admission_failed", state.lease.id);
      try { if (queued) await this.store.finishTurn(state.lease, queued.id, true); }
      finally { if (this.#entries.get(state.lease.id)?.state === state) this.#entries.delete(state.lease.id); }
      throw error;
    }
  }

  private async finishEntry(entry: Entry, interrupted: boolean): Promise<void> {
    const { state } = entry;
    clearTimeout(state.timer);
    try {
      if (!state.turn) {
        state.controller.abort(new Error("The waiting turn was cancelled."));
        try { await entry.ready; }
        catch (error) { if (!state.controller.signal.aborted) throw error; }
      }
      if (state.turn) await this.store.finishTurn(state.lease, state.turn.id, interrupted);
    } finally {
      if (this.#entries.get(state.lease.id) === entry) this.#entries.delete(state.lease.id);
    }
  }
}
