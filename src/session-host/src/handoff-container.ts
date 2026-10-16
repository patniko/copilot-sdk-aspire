import { setTimeout as delay } from "node:timers/promises";
import {
  effectiveHostingPolicy, SharedSessionDefinition, SharedSessionLimits,
  type ContainerSize, type ExecutionPolicy, type HarnessSnapshot, type PromotionErrorCode, type PromotionState, type SharedWorkerLimits,
} from "@copilot-agent/contracts";
import type { HandoffRecord, HandoffStore } from "@copilot-agent/job-store";
import { HttpError, policyDigest } from "@copilot-agent/service-defaults";

/** A handoff target admitted to run in its own session container. */
export interface ContainerHandoffTarget {
  /** The target's published snapshot, which the container runs. */
  snapshot: HarnessSnapshot;
  /** The session definition the cutover installs: the target's model and limits under session-container rules. */
  definition: SharedSessionDefinition;
  size: string;
  resources: ContainerSize;
}

/**
 * Admits a handoff target that runs in a session container the way `POST /v1/sessions` admits an isolated harness
 * there: the first model its policy approves, the policy's default size, and the shared worker's session ceilings with
 * the container's idle stop. A container enforces the aggregate budget and the turn deadline but no separate per-turn
 * budget, and runs no delegated jobs. A handoff never raises the conversation's aggregate token budget.
 */
export function containerHandoffTarget(input: {
  snapshot: HarnessSnapshot;
  policy: ExecutionPolicy;
  /** The operator's session ceilings (Aspire `hybrid-session-limits`). */
  ceilings: SharedSessionLimits;
  /** The session containers' idle stop. */
  idleSeconds: number;
  /** The conversation's current limits. */
  current: SharedSessionLimits;
}): ContainerHandoffTarget {
  const { definition } = input.snapshot;
  const model = [definition.model.preferred, ...definition.model.allowed].find((name) => input.policy.allowedModels.includes(name));
  if (!model) throw new HttpError(422, "policy_rejected", "None of the target's models are approved by the operator policy.", { path: "model" });
  const hosting = effectiveHostingPolicy(input.policy);
  const size = hosting.defaultSize;
  const resources = hosting.sizes[size];
  if (!resources) throw new HttpError(422, "policy_rejected", `The default size '${size}' is not in the operator's size catalog.`);
  const tokenBudget = Math.min(
    definition.limits.maxInferenceTokens, input.policy.maxInferenceTokensPerJob, input.ceilings.tokenBudget, input.current.tokenBudget,
  );
  const limits = SharedSessionLimits.parse({
    ...input.ceilings,
    tokenBudget,
    turnTokenBudget: Math.min(tokenBudget, 1_000_000),
    maxTurnSeconds: Math.min(definition.limits.maxDurationSeconds, input.policy.maxDurationSeconds, input.ceilings.maxTurnSeconds),
    idleSeconds: input.idleSeconds,
    maxJobs: 0,
    maxContinuations: 0,
  });
  return {
    snapshot: input.snapshot,
    definition: SharedSessionDefinition.parse({
      model,
      limits,
      harness: {
        name: definition.name, version: definition.version, digest: input.snapshot.digest, mode: "isolated", policyDigest: policyDigest(input.policy),
      },
    }),
    size,
    resources,
  };
}

/** A promotion as a move needs to see it. */
export interface MovePromotion {
  id: string;
  requestKey: string;
  state: PromotionState;
  fromGeneration: number;
}

/** The promotion ledger operations a move into a container uses: those of `PromotionStore`. */
export interface MoveLedger {
  request(input: {
    principal: string; sessionId: string; source: "tool"; requestKey: string; reason?: string;
    size: string; resources: ContainerSize; kind: "handoff"; runtimeSessionId: string;
    target: { harness: HarnessSnapshot; definition: SharedSessionDefinition };
    /** Whether the snapshot carries the runtime history (`full`), or only the workspace. */
    history: boolean;
    /** Sent once by the container as the target's first turn, after the cutover. */
    notice: string;
  }): Promise<{ promotion: MovePromotion; created: boolean }>;
  byId(id: string): Promise<MovePromotion | undefined>;
  fail(id: string, code: PromotionErrorCode, message: string): Promise<unknown>;
  hasCapacity(principal: string, limits: SharedWorkerLimits): Promise<boolean>;
}

/** The promotion driver (`SharedPromotions`): it closes the source's activation, snapshots storage, and starts the container. */
export interface MoveDriver {
  begin(promotionId: string): void;
}

export interface HandoffMovesOptions {
  handoffs: HandoffStore;
  ledger: MoveLedger;
  driver: MoveDriver;
  limits: SharedWorkerLimits;
  report: (event: string, id: string) => void;
  /** A move settled: the handoff committed (the target runs in its container) or failed (the source is in control again). */
  settled: (handoff: HandoffRecord) => void;
  /** Interval between checks while a move is under way; one second by default. */
  pollMs?: number;
}

/** What a move into the target's container carries. */
export interface HandoffMove {
  target: ContainerHandoffTarget;
  /** The runtime session the container runs: the source's for `full` history, otherwise a new one. */
  runtimeSessionId: string;
  notice: string;
}

/**
 * Moves conversations into their handoff target's own session container (docs/HOSTING-MODES-PLAN.md, section 7.5).
 * A move is a promotion of kind `handoff`: the promotion machinery snapshots the conversation's storage (the workspace,
 * and the runtime history only for `full`), starts the target's container, and commits the cutover when the container
 * is ready, installing the target's definition and segment. The handoff then settles from that promotion's outcome;
 * until then the conversation admits no turns. A failure before the cutover leaves the source in control.
 */
export class HandoffMoves {
  readonly #watching = new Map<string, Promise<void>>();
  #stopping = false;

  constructor(private readonly options: HandoffMovesOptions) {}

  /** Whether the deployment has room for one more session container for `principal` now. */
  hasCapacity(principal: string): Promise<boolean> {
    return this.options.ledger.hasCapacity(principal, this.options.limits);
  }

  /**
   * Starts the move of an accepted handoff whose source turn has ended: records its promotion, links it to the
   * handoff, starts it, and settles the handoff when it ends. Starting again finds the same promotion by request key.
   */
  async start(handoff: HandoffRecord, move: HandoffMove): Promise<void> {
    const { handoffs, ledger } = this.options;
    const requestKey = `handoff:${handoff.id}`;
    const { promotion } = await ledger.request({
      principal: handoff.principal, sessionId: handoff.sessionId, source: "tool", requestKey, reason: handoff.payload.reason,
      size: move.target.size, resources: move.target.resources, kind: "handoff", runtimeSessionId: move.runtimeSessionId,
      target: { harness: move.target.snapshot, definition: move.target.definition }, history: handoff.history === "full", notice: move.notice,
    });
    if (promotion.requestKey !== requestKey) {
      // The conversation already has another promotion: this handoff never moves.
      await handoffs.fail(handoff.id, "handoff_busy", "A promotion of this conversation is in progress.");
      this.options.settled((await handoffs.byId(handoff.id))!);
      return;
    }
    await handoffs.attachMove(handoff.id, promotion.id);
    if (promotion.fromGeneration !== handoff.fromGeneration && promotion.state !== "committed" && promotion.state !== "failed") {
      await ledger.fail(promotion.id, "session_changed", "The conversation moved before the handoff could start.");
    } else if (promotion.state === "requested" && !this.#watching.has(handoff.id)) {
      this.options.driver.begin(promotion.id);
    }
    this.watch(handoff.id);
  }

  /** Settles a handoff from its move once that move commits or fails; concurrent calls share one watch. */
  watch(handoffId: string): void {
    if (this.#watching.has(handoffId) || this.#stopping) return;
    const run = (async () => {
      for (;;) {
        const handoff = await this.options.handoffs.settleMove(handoffId);
        if (handoff.state !== "accepted") {
          this.options.report(`session.handoff_${handoff.state}`, handoff.sessionId);
          this.options.settled(handoff);
          return;
        }
        if (this.#stopping) return;
        await delay(this.options.pollMs ?? 1_000);
      }
    })()
      .catch(() => this.options.report("session.handoff_move_unsettled", handoffId))
      .finally(() => this.#watching.delete(handoffId));
    this.#watching.set(handoffId, run);
  }

  /** Whether this worker is settling the handoff's move. */
  watching(handoffId: string): boolean { return this.#watching.has(handoffId); }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#watching.values()]);
  }
}
