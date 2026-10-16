import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest, Tool } from "@github/copilot-sdk";
import type { HandoffRecord } from "@copilot-agent/job-store";
import { HandoffRefusal, type SharedApprovalPlan } from "../../src/session-host/src/admission.js";
import { handoffTools, type HandoffOffer } from "../../src/session-host/src/handoff-tools.js";
import { workspaceDraftsHandler } from "../../src/session-host/src/permission-handlers.js";
import { SharedPermissionPolicy, type ToolRule } from "../../src/session-host/src/permissions.js";
import type { SharedActivationContext } from "../../src/session-host/src/runtime.js";
import { handoffOutcome } from "../../src/session-host/src/service.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "../integration/fixtures/shared-harness.js";

const offer = (overrides: Partial<HandoffOffer> = {}): HandoffOffer => ({
  harness: "coding-agent", description: "Changes that need a real checkout.", approval: "ask", history: "summary", ...overrides,
});
const context = { runtimeSessionId: "runtime-session" } as SharedActivationContext;
const invoke = (tool: Tool, args: unknown, invocation: Record<string, unknown> = {}) =>
  tool.handler!(args, { sessionId: "runtime-session", toolCallId: "call-1", toolName: tool.name, arguments: args, ...invocation } as never);

describe("transfer tools", () => {
  it("offer one tool per target that validates its payload before any effect and is reserved for the root agent", async () => {
    const run = vi.fn(async () => "Handoff accepted.");
    const tools = handoffTools([offer(), offer({ harness: "notes", approval: "allow", history: "none" })], context, run);
    expect(tools.map(({ tool }) => tool.name)).toEqual(["transfer_to_coding_agent", "transfer_to_notes"]);
    expect(tools[0]!.tool.description).toContain("Changes that need a real checkout.");
    expect(tools[0]!.tool.description).toContain("after the person approves");
    expect(tools[0]!.tool.description).toContain("pass a self-contained summary");
    expect(tools[1]!.tool.description).not.toContain("after the person approves");
    expect(tools[0]!.rule).toEqual({ handoff: { approval: "ask", prompt: expect.stringContaining("coding-agent") } });
    expect(JSON.stringify(tools[0]!.tool.parameters)).toContain("summary");
    expect(JSON.stringify(tools[1]!.tool.parameters)).not.toContain("summary");
    await expect(invoke(tools[0]!.tool, { reason: "Needs a checkout." })).rejects.toThrow(/Invalid handoff arguments: summary/);
    await expect(invoke(tools[1]!.tool, { reason: "Notes.", summary: "Not accepted for none." })).rejects.toThrow(/Invalid handoff arguments/);
    await expect(invoke(tools[1]!.tool, { reason: "Notes." }, { agentId: "sub-agent" })).rejects.toThrow(/root agent/);
    await expect(invoke(tools[1]!.tool, { reason: "Notes." }, { sessionId: "other-session" })).rejects.toThrow(/root agent/);
    expect(run).not.toHaveBeenCalled();
    expect(await invoke(tools[0]!.tool, { reason: "Needs a checkout.", summary: "The person wants a fix." })).toBe("Handoff accepted.");
    expect(run).toHaveBeenCalledWith(offer(), { reason: "Needs a checkout.", summary: "The person wants a fix." }, expect.objectContaining({ toolCallId: "call-1" }));
  });

  it("ask a person in every approval mode, and never let the judge or a custom handler approve", async () => {
    const rules = new Map<string, ToolRule>([
      ["transfer_to_coding_agent", { handoff: { approval: "ask", prompt: "Transfer to coding-agent?" } }],
      ["transfer_to_notes", { handoff: { approval: "allow", prompt: "Transfer to notes?" } }],
    ]);
    const judge = vi.fn(() => async () => ({ kind: "approve-once" as const }));
    const handler = { ...workspaceDraftsHandler, decide: vi.fn(async () => ({ decision: "approve" as const })) };
    for (const approval of [
      { mode: "manual", initial: "manual", available: ["manual"] },
      { mode: "assisted", initial: "assisted", available: ["manual", "assisted"] },
      { mode: "allow-all", initial: "allow-all", available: ["manual", "allow-all"] },
      { mode: "custom", initial: "manual", available: ["manual"], handler: "workspace-drafts" },
    ] satisfies SharedApprovalPlan[]) {
      const policy = new SharedPermissionPolicy({
        harness: "triage", sessionId: "session", principal: "alice", definition: { permissions: { default: "allow" } }, approval,
        rules, builtins: new Set(), handler, followJudge: judge,
      });
      // The hook asks even under allow-all, so the runtime raises a request a person answers.
      expect(policy.preToolUse("custom:transfer_to_coding_agent"), approval.mode).toEqual({ permissionDecision: "ask", permissionDecisionReason: "Transfer to coding-agent?" });
      expect(policy.preToolUse("transfer_to_notes"), approval.mode).toEqual({ permissionDecision: "allow" });
      for (const kind of ["hook", "custom-tool"] as const) {
        const request = { kind, toolName: "transfer_to_coding_agent", toolArgs: {}, args: {} } as unknown as PermissionRequest;
        expect(await policy.handle(request, { sessionId: "session" }), `${approval.mode} ${kind}`).toEqual({ kind: "no-result" });
        expect(await policy.handle({ ...request, toolName: "transfer_to_notes" } as PermissionRequest, { sessionId: "session" })).toEqual({ kind: "approve-once" });
      }
    }
    expect(judge).not.toHaveBeenCalled();
    expect(handler.decide).not.toHaveBeenCalled();
  });

  it("returns the recorded outcome, and fails the call when the handoff was refused", () => {
    const record = (state: HandoffRecord["state"], error?: { code: "handoff_unavailable"; message: string }) => ({
      state, target: { name: "coding-agent" }, history: "summary", view: { ...(error ? { error } : {}) },
    }) as HandoffRecord;
    expect(handoffOutcome(record("accepted"))).toMatch(/^Handoff accepted: coding-agent takes over .* \(summary history\)/);
    expect(handoffOutcome(record("committed"))).toContain("already handed off to coding-agent");
    expect(() => handoffOutcome(record("refused", { code: "handoff_unavailable", message: "No host." })))
      .toThrow("Handoff refused (handoff_unavailable): No host. You remain in control of the conversation.");
    expect(() => handoffOutcome(record("failed"))).toThrow(/handoff_failed/);
  });
});

describe("handoff admission on the shared worker", () => {
  const triage = sharedHarness("triage", {
    hosting: {
      mode: "shared",
      handoffs: [
        { harness: "notes", description: "Notes.", approval: "allow" },
        { harness: "coder", description: "Code." },
        { harness: "summarized", description: "Summaries.", history: "summary" },
      ],
    },
  });
  const notes = sharedHarness("notes", { limits: { maxDurationSeconds: 30, maxInferenceTokens: 900_000 } });
  const coder = sharedHarness("coder", { hosting: undefined });
  const summarized = sharedHarness("summarized");
  const policy = { hosting: { modes: ["isolated" as const, "shared" as const], handoffs: { approval: ["ask" as const, "allow" as const] } } };
  const refusal = async (operation: Promise<unknown>) => {
    const error = await operation.then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(HandoffRefusal);
    return { code: (error as HandoffRefusal).code, message: (error as HandoffRefusal).message, prerequisite: (error as HandoffRefusal).prerequisite };
  };

  it("checks a listed target and admits it under its own policy without raising the session's aggregate ceilings", async () => {
    const registry = await sharedRegistry([triage, notes, coder, summarized], policy);
    const admission = sharedAdmission(registry, { sessionLimits: { tokenBudget: 400_000, maxJobs: 8, maxContinuations: 6 } });
    const session = await admission.admit("alice", { harness: "triage", label: "" });
    const checked = await admission.handoff({ principal: "alice", session: { ...session, limits: { ...session.limits, tokenBudget: 50_000 } }, from: "shared", target: "notes" });
    expect(checked).toMatchObject({ target: { name: "notes", version: "1.0.0", digest: notes.digest, mode: "shared" }, placement: "shared", history: "full", approval: "allow" });
    expect(checked.definition.harness).toMatchObject({ name: "notes", mode: "shared", digest: notes.digest });
    expect(checked.definition.limits).toMatchObject({ tokenBudget: 50_000, maxJobs: 8, maxContinuations: 6, maxTurnSeconds: 30 });
    expect(checked.definition.limits.turnTokenBudget).toBeLessThanOrEqual(50_000);
    expect(await admission.handoffOffers(triage.definition, "shared")).toEqual([
      { harness: "notes", description: "Notes.", approval: "allow", history: "full" },
      { harness: "coder", description: "Code.", approval: "ask", history: "summary" },
      { harness: "summarized", description: "Summaries.", approval: "ask", history: "summary" },
    ]);
  });

  it("refuses unlisted, unpublished, disallowed, unavailable, one-way, and out-of-ceiling targets with explicit codes", async () => {
    const registry = await sharedRegistry([triage, notes, coder, summarized], policy);
    const admission = sharedAdmission(registry);
    const session = await admission.admit("alice", { harness: "triage", label: "" });
    expect(await refusal(admission.handoff({ principal: "alice", session, from: "shared", target: "other" }))).toMatchObject({ code: "handoff_not_allowed" });
    // An isolated target needs session containers, which this worker's deployment lacks.
    expect(await refusal(admission.handoff({ principal: "alice", session, from: "shared", target: "coder" })))
      .toMatchObject({ code: "handoff_unavailable", prerequisite: { kind: "host" } });
    // From a container, a shared target is refused before anything else.
    expect(await refusal(admission.handoff({ principal: "alice", session, from: "container", target: "notes" }))).toMatchObject({ code: "handoff_one_way" });
    expect(await refusal(admission.handoff({ principal: "alice", session, from: "shared", target: "notes", pinned: { version: "2.0.0", digest: notes.digest } })))
      .toMatchObject({ code: "handoff_not_allowed", message: expect.stringContaining("no longer published") });
    // Current policy decides: the target's mode, the approval, and the history.
    const narrowed = await sharedRegistry([triage, notes, coder, summarized], policy, { notes: { hosting: { modes: ["isolated"] } } });
    expect(await refusal(sharedAdmission(narrowed).handoff({ principal: "alice", session, from: "shared", target: "notes" })))
      .toMatchObject({ code: "handoff_not_allowed", message: expect.stringContaining("does not allow shared hosting for 'notes'") });
    const askOnly = await sharedRegistry([triage, notes, coder, summarized], { hosting: { modes: ["isolated", "shared"] } });
    expect(await refusal(sharedAdmission(askOnly).handoff({ principal: "alice", session, from: "shared", target: "notes" })))
      .toMatchObject({ code: "handoff_not_allowed", message: expect.stringContaining("'allow' approval") });
    const noSummaries = await sharedRegistry([triage, notes, coder, summarized], { hosting: { ...policy.hosting, handoffs: { ...policy.hosting.handoffs, history: ["full", "none"] } } });
    expect(await refusal(sharedAdmission(noSummaries).handoff({ principal: "alice", session, from: "shared", target: "summarized" })))
      .toMatchObject({ code: "handoff_not_allowed", message: expect.stringContaining("'summary' history") });
    // A crafted harness is never published, so it cannot be a target even when a definition names it.
    expect(await refusal(admission.handoff({ principal: "alice", session: { ...session, harness: { ...session.harness!, definition: {
      ...session.harness!.definition!, hosting: { mode: "shared", handoffs: [{ harness: "crafted-target", description: "Never published." }] },
    } } }, from: "shared", target: "crafted-target" }))).toMatchObject({ code: "handoff_not_allowed", message: expect.stringContaining("not a published harness") });
  });

  it("refuses a harness tool that takes a transfer tool's name", async () => {
    const shadow = sharedHarness("shadowing", {
      tools: [{ name: "transfer_to_notes", kind: "host", binding: "shared:get-job", description: "Shadow." }],
      hosting: { mode: "shared", handoffs: [{ harness: "notes", description: "Notes." }] },
    });
    const registry = await sharedRegistry([shadow, notes], policy);
    const error = await sharedAdmission(registry).admit("alice", { harness: "shadowing", label: "" }).then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ statusCode: 422, code: "policy_rejected", details: { path: "tools.0.name" } });
  });
});
