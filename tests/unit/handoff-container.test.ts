import { describe, expect, it, vi } from "vitest";
import { policyFor, SharedSessionLimits, SharedWorkerLimits, type HandoffPayload, type PromotionState } from "@copilot-agent/contracts";
import type { HandoffRecord, HandoffStore } from "@copilot-agent/job-store";
import { policyDigest } from "@copilot-agent/service-defaults";
import { containerHandoffTarget, HandoffMoves, type MoveLedger, type MovePromotion } from "../../src/session-host/src/handoff-container.js";
import { sharedHarness, sharedRegistry } from "../integration/fixtures/shared-harness.js";

const payload: HandoffPayload = { reason: "Needs a shell.", summary: "Fix the build." };

describe("handoff targets in a session container", () => {
  it("admits the target as session containers do, without raising the conversation's aggregate budget", async () => {
    const coder = sharedHarness("coder", { hosting: { mode: "isolated" }, model: { preferred: "other", allowed: ["other", "fixture"] }, limits: { maxDurationSeconds: 900, maxInferenceTokens: 400_000 } });
    const registry = await sharedRegistry([coder], { maxDurationSeconds: 600 });
    const policy = policyFor(registry.policies, "coder");
    const ceilings = SharedSessionLimits.parse({ tokenBudget: 300_000, maxTurnSeconds: 1200 });
    const current = SharedSessionLimits.parse({ tokenBudget: 250_000, maxJobs: 3, maxContinuations: 3 });
    const admitted = containerHandoffTarget({ snapshot: coder, policy, ceilings, idleSeconds: 120, current });
    expect(admitted.snapshot).toBe(coder);
    expect(admitted.definition).toMatchObject({
      model: "fixture",
      harness: { name: "coder", version: "1.0.0", digest: coder.digest, mode: "isolated", policyDigest: policyDigest(policy) },
      limits: { tokenBudget: 250_000, turnTokenBudget: 250_000, maxTurnSeconds: 600, idleSeconds: 120, maxJobs: 0, maxContinuations: 0 },
    });
    expect(admitted.definition.harness?.definition).toBeUndefined();
    expect(admitted.size).toBe("small");
    expect(admitted.resources).toEqual(expect.objectContaining({ cpus: expect.any(Number), memoryMiB: expect.any(Number) }));
    const wider = containerHandoffTarget({ snapshot: coder, policy, ceilings, idleSeconds: 120, current: SharedSessionLimits.parse({ tokenBudget: 900_000 }) });
    expect(wider.definition.limits.tokenBudget).toBe(300_000);
    const unapproved = sharedHarness("coder", { hosting: { mode: "isolated" }, model: { preferred: "other", allowed: ["other"] } });
    expect(() => containerHandoffTarget({ snapshot: unapproved, policy, ceilings, idleSeconds: 120, current })).toThrow(/models/);
  });
});

/** An in-memory handoff ledger with just what the move driver uses. */
function ledgers(handoff: HandoffRecord) {
  let current = { ...handoff };
  let promotion: MovePromotion | undefined;
  const requests: Parameters<MoveLedger["request"]>[0][] = [];
  const failures: string[] = [];
  const ledger: MoveLedger = {
    request: vi.fn(async (input) => {
      requests.push(input);
      promotion ??= { id: "33333333-3333-4333-8333-333333333333", requestKey: input.requestKey, state: "requested", fromGeneration: 1 };
      return { promotion, created: requests.length === 1 };
    }),
    byId: vi.fn(async () => promotion),
    fail: vi.fn(async (_id, code) => { failures.push(code); promotion = { ...promotion!, state: "failed" }; }),
    hasCapacity: vi.fn(async () => true),
  };
  const store = {
    attachMove: vi.fn(async (_id: string, promotionId: string) => (current = { ...current, promotionId })),
    settleMove: vi.fn(async () => {
      if (promotion?.state === "committed") current = { ...current, state: "committed", toGeneration: 2 };
      if (promotion?.state === "failed") current = { ...current, state: "failed" };
      return current;
    }),
    fail: vi.fn(async (_id: string, code: string) => (current = { ...current, state: "failed", view: { ...current.view, error: { code, message: "" } } } as HandoffRecord)),
    byId: vi.fn(async () => current),
  };
  return {
    ledger, store: store as unknown as HandoffStore, requests, failures,
    settle: (state: PromotionState) => { promotion = { ...promotion!, state }; },
    replace: (value: MovePromotion) => { promotion = value; },
  };
}

const record = (history: HandoffRecord["history"]): HandoffRecord => ({
  id: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", principal: "alice", requestKey: "call-1",
  state: "accepted", fromGeneration: 1, fromPlacement: "shared", source: { name: "triage", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
  target: { name: "coder", version: "1.0.0", digest: `sha256:${"c".repeat(64)}`, mode: "isolated" }, toPlacement: "container", history,
  approval: "ask", approvedBy: "person", payload, notified: false, prepared: false, view: {} as HandoffRecord["view"],
});

describe("moving a conversation into its handoff target's container", () => {
  it("records one promotion of kind handoff with the target, the runtime session, the history, and the notice, then settles from it", async () => {
    const coder = sharedHarness("coder", { hosting: { mode: "isolated" } });
    const registry = await sharedRegistry([coder]);
    const target = containerHandoffTarget({
      snapshot: coder, policy: policyFor(registry.policies, "coder"), ceilings: SharedSessionLimits.parse({}), idleSeconds: 60, current: SharedSessionLimits.parse({}),
    });
    for (const history of ["summary", "full"] as const) {
      const handoff = record(history);
      const fake = ledgers(handoff);
      const begin = vi.fn();
      const settled = vi.fn();
      const moves = new HandoffMoves({
        handoffs: fake.store, ledger: fake.ledger, driver: { begin }, limits: SharedWorkerLimits.parse({}), report: () => {}, settled, pollMs: 5,
      });
      await moves.start(handoff, { target, runtimeSessionId: "44444444-4444-4444-8444-444444444444", notice: "[handoff:x]\nNotice." });
      expect(fake.requests).toEqual([expect.objectContaining({
        principal: "alice", sessionId: handoff.sessionId, source: "tool", requestKey: `handoff:${handoff.id}`, reason: "Needs a shell.",
        kind: "handoff", runtimeSessionId: "44444444-4444-4444-8444-444444444444", history: history === "full", notice: "[handoff:x]\nNotice.",
        size: target.size, resources: target.resources, target: { harness: coder, definition: target.definition },
      })]);
      expect(begin).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
      expect(moves.watching(handoff.id)).toBe(true);
      // Starting again (a recovered worker) finds the same promotion and starts nothing new.
      await moves.start(handoff, { target, runtimeSessionId: "44444444-4444-4444-8444-444444444444", notice: "[handoff:x]\nNotice." });
      expect(begin).toHaveBeenCalledTimes(1);
      fake.settle("committed");
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(expect.objectContaining({ state: "committed" })));
      expect(moves.watching(handoff.id)).toBe(false);
      await moves.stop();
    }
  });

  it("never moves while another promotion owns the conversation, and fails a move recorded against a later segment", async () => {
    const coder = sharedHarness("coder", { hosting: { mode: "isolated" } });
    const registry = await sharedRegistry([coder]);
    const target = containerHandoffTarget({
      snapshot: coder, policy: policyFor(registry.policies, "coder"), ceilings: SharedSessionLimits.parse({}), idleSeconds: 60, current: SharedSessionLimits.parse({}),
    });
    const busy = ledgers(record("summary"));
    busy.replace({ id: "55555555-5555-4555-8555-555555555555", requestKey: "tool:promote", state: "moving", fromGeneration: 1 });
    const settled = vi.fn();
    const begin = vi.fn();
    const moves = new HandoffMoves({ handoffs: busy.store, ledger: busy.ledger, driver: { begin }, limits: SharedWorkerLimits.parse({}), report: () => {}, settled, pollMs: 5 });
    await moves.start(record("summary"), { target, runtimeSessionId: "44444444-4444-4444-8444-444444444444", notice: "n" });
    expect(begin).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", view: expect.objectContaining({ error: { code: "handoff_busy", message: "" } }) }));
    const later = ledgers(record("summary"));
    later.replace({ id: "66666666-6666-4666-8666-666666666666", requestKey: `handoff:${record("summary").id}`, state: "requested", fromGeneration: 2 });
    const failedMoves = new HandoffMoves({ handoffs: later.store, ledger: later.ledger, driver: { begin }, limits: SharedWorkerLimits.parse({}), report: () => {}, settled, pollMs: 5 });
    await failedMoves.start(record("summary"), { target, runtimeSessionId: "44444444-4444-4444-8444-444444444444", notice: "n" });
    expect(later.failures).toEqual(["session_changed"]);
    expect(begin).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" })));
    await failedMoves.stop();
  });
});
