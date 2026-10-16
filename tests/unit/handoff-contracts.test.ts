import { describe, expect, it } from "vitest";
import {
  conversationPolicyProblems,
  type ExecutionPolicy,
  type ExecutionProfile,
  effectiveHostingPolicy,
  handoffArguments,
  handoffFailureNotice,
  handoffHistoryFor,
  handoffMoveError,
  handoffNotice,
  handoffNoticeMarker,
  HANDOFF_NOTICE_MAX,
  HANDOFF_PAYLOAD_LIMITS,
  HandoffView,
  HarnessDefinition,
  hostingCeilingsOf,
  HostingPolicy,
  hostingPolicyViolations,
  hostingReferenceViolations,
  placementMoveAllowed,
  placementsOf,
  startingPlacement,
  type HostingTarget,
} from "@copilot-agent/contracts";
import { handoffToolName } from "@copilot-agent/service-defaults";

const base: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["m"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 10_000,
  maxConcurrentAttemptsPerPrincipal: 2,
  maxQueuedJobsPerPrincipal: 10,
  retry: { maxAttempts: 2, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  permissionModes: ["ask", "allow"],
  hosting: { modes: ["isolated", "shared", "promotable"] },
};

const conversation = (name: string, hosting?: HarnessDefinition["hosting"]): HarnessDefinition => HarnessDefinition.parse({
  schemaVersion: "1", name, version: "1.0.0", description: "A conversation harness.", interaction: "conversation",
  ...(hosting ? { hosting } : {}), instructions: "Help.", model: { preferred: "m", allowed: ["m"] }, tools: [],
  input: { schema: { type: "object" } }, output: { schema: { type: "object" } },
  limits: { maxDurationSeconds: 60, maxInferenceTokens: 1000 }, retry: { safeToRetry: false, maxAttempts: 1 },
  runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
});

const profile: ExecutionProfile = {
  id: "node-ts-agent", runnerProtocolVersion: 1, language: "typescript", image: "node", command: ["node"],
  capabilities: ["cancel", "structured-result"], toolBindings: [], builtinToolGroups: [],
} as unknown as ExecutionProfile;

/** A registry of published targets: shared, isolated, and promotable harnesses under `base`. */
const registry = new Map<string, HostingTarget>([
  ["notes", { definition: conversation("notes", { mode: "shared" }), policy: base }],
  ["coder", { definition: conversation("coder"), policy: base }],
  ["grower", { definition: conversation("grower", { mode: "promotable" }), policy: base }],
  ["batch", { definition: { ...conversation("batch"), interaction: undefined }, policy: base }],
]);
const lookup = (name: string) => registry.get(name);

describe("handoff placements and default history", () => {
  it("starts isolated harnesses in a container and every other mode on the shared worker, and never moves back", () => {
    expect(startingPlacement("isolated")).toBe("container");
    for (const mode of ["shared", "promotable", "orchestrator"] as const) expect(startingPlacement(mode)).toBe("shared");
    expect(placementsOf("promotable")).toEqual(["shared", "container"]);
    expect(placementsOf("isolated")).toEqual(["container"]);
    expect(placementMoveAllowed("container", "shared")).toBe(false);
    expect(placementMoveAllowed("shared", "container")).toBe(true);
    expect(placementMoveAllowed("container", "container")).toBe(true);
  });

  it("defaults to full history within one placement and a summary across placements (D12)", () => {
    expect(handoffHistoryFor(undefined, "shared", "shared")).toBe("full");
    expect(handoffHistoryFor(undefined, "container", "container")).toBe("full");
    expect(handoffHistoryFor(undefined, "shared", "container")).toBe("summary");
    expect(handoffHistoryFor("none", "shared", "shared")).toBe("none");
  });
});

describe("handoff ceilings in the operator policy", () => {
  it("allows asking a person and every history policy by default, and reports them in the ceilings", () => {
    expect(effectiveHostingPolicy(base).handoffs).toEqual({ approval: ["ask"], history: ["full", "summary", "none"] });
    expect(hostingCeilingsOf({ ...base, hosting: { handoffs: { approval: ["ask", "allow"], history: ["summary"] } } }).handoffs)
      .toEqual({ approval: ["ask", "allow"], history: ["summary"] });
    expect(HostingPolicy.safeParse({ handoffs: { approval: [] } }).success).toBe(false);
    expect(HostingPolicy.safeParse({ handoffs: { history: ["full", "full"] } }).success).toBe(false);
    expect(HostingPolicy.safeParse({ handoffs: { maxPerSession: 2 } }).success).toBe(false);
  });

  it("rejects approvals and explicit history the policy does not allow, at the handoff's field", () => {
    const source = (handoffs: NonNullable<HarnessDefinition["hosting"]>["handoffs"]) => conversation("triage", { mode: "shared", handoffs });
    const paths = (definition: HarnessDefinition, policy: ExecutionPolicy) => hostingPolicyViolations(definition, policy).map((problem) => problem.path);
    expect(paths(source([{ harness: "notes", description: "Notes." }]), base)).toEqual([]);
    expect(paths(source([{ harness: "notes", description: "Notes.", approval: "allow" }]), base)).toEqual(["hosting.handoffs.0.approval"]);
    const automatic = { ...base, hosting: { ...base.hosting, handoffs: { approval: ["allow" as const] } } };
    expect(paths(source([{ harness: "notes", description: "Notes." }]), automatic)).toEqual(["hosting.handoffs.0.approval"]);
    const summaries = { ...base, hosting: { ...base.hosting, handoffs: { history: ["summary" as const, "none" as const] } } };
    expect(paths(source([{ harness: "notes", description: "Notes.", history: "full" }, { harness: "coder", description: "Code.", history: "none" }]), summaries))
      .toEqual(["hosting.handoffs.0.history"]);
  });

  it("checks the default history against the source's and target's placements, and refuses targets a container cannot reach", () => {
    const summaries = { ...base, hosting: { ...base.hosting, handoffs: { history: ["summary" as const, "none" as const] } } };
    const check = (definition: HarnessDefinition, policy: ExecutionPolicy = base) =>
      hostingReferenceViolations(definition, lookup, policy).map((problem) => `${problem.path}: ${problem.message}`);
    // Shared to shared defaults to full history, which this policy refuses; shared to a container defaults to a summary.
    expect(check(conversation("triage", { mode: "shared", handoffs: [{ harness: "notes", description: "Notes." }] }), summaries))
      .toEqual([expect.stringMatching(/^hosting\.handoffs\.0\.history: The default history for 'notes' \(full\)/)]);
    expect(check(conversation("triage", { mode: "shared", handoffs: [{ harness: "coder", description: "Code." }] }), summaries)).toEqual([]);
    // A promotable source reaches a shared target only before promotion, so only its shared default counts.
    expect(check(conversation("triage", { mode: "promotable", handoffs: [{ harness: "notes", description: "Notes." }] }), summaries))
      .toEqual([expect.stringMatching(/\(full\)/)]);
    expect(check(conversation("triage", { mode: "promotable", handoffs: [{ harness: "coder", description: "Code." }] }), summaries))
      .toEqual([expect.stringMatching(/\(full\)/)]);
    // An isolated source runs in a container, which never moves back to shared placement.
    expect(check(conversation("coder-two", { mode: "isolated", handoffs: [{ harness: "notes", description: "Notes." }] })))
      .toEqual([expect.stringMatching(/^hosting\.handoffs\.0\.harness: .*never moves back to shared placement/)]);
    expect(check(conversation("coder-two", { mode: "isolated", handoffs: [{ harness: "grower", description: "Grow." }] })))
      .toEqual([expect.stringMatching(/never moves back/)]);
    expect(check(conversation("coder-two", { mode: "isolated", handoffs: [{ harness: "coder", description: "Code." }] }))).toEqual([]);
    expect(check(conversation("triage", { mode: "shared", handoffs: [{ harness: "batch", description: "Batch." }, { harness: "ghost", description: "Gone." }] })))
      .toEqual([expect.stringMatching(/not a conversation harness/), expect.stringMatching(/not a published harness/)]);
  });

  it("reports handoff problems as policy rejections in conversation admission", () => {
    const problems = conversationPolicyProblems(
      conversation("triage", { mode: "shared", handoffs: [{ harness: "notes", description: "Notes.", approval: "allow" }] }),
      base, new Map([["node-ts-agent", profile]]), lookup,
    ).filter((problem) => problem.path?.startsWith("hosting.handoffs"));
    expect(problems).toEqual([expect.objectContaining({ code: "policy_rejected", path: "hosting.handoffs.0.approval" })]);
  });
});

describe("the handoff payload and notices", () => {
  it("requires a bounded reason, a summary only for summary history, and nothing else", () => {
    expect(handoffArguments("summary").safeParse({ reason: "Code.", summary: "The person wants a fix." }).success).toBe(true);
    expect(handoffArguments("summary").safeParse({ reason: "Code." }).success).toBe(false);
    expect(handoffArguments("full").safeParse({ reason: "Code.", summary: "Extra." }).success).toBe(false);
    expect(handoffArguments("none").safeParse({ reason: "  " }).success).toBe(false);
    expect(handoffArguments("none").safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    expect(handoffArguments("none").safeParse({ reason: "Code.", target: "other" }).success).toBe(false);
    expect(handoffArguments("summary").safeParse({ reason: "Code.", summary: "y".repeat(8001) }).success).toBe(false);
    expect(handoffArguments("none").parse({ reason: "  Trimmed.  " })).toEqual({ reason: "Trimmed." });
    // Tabs and line breaks are text; other control characters and broken Unicode are not.
    expect(handoffArguments("summary").safeParse({ reason: "Code.", summary: "Goal:\n\t- fix the build\r\n" }).success).toBe(true);
    expect(handoffArguments("none").safeParse({ reason: "Code\u0000." }).success).toBe(false);
    expect(handoffArguments("none").safeParse({ reason: "Code\u001b[31m." }).success).toBe(false);
    expect(handoffArguments("none").safeParse({ reason: "Broken \ud800 text." }).success).toBe(false);
    expect(handoffArguments("none").safeParse({ reason: "Emoji \ud83d\ude00 text." }).success).toBe(true);
  });

  it("keeps every notice within its bound, even for a payload that escaping doubles", () => {
    const payload = { reason: "\"".repeat(HANDOFF_PAYLOAD_LIMITS.reason), summary: "\\\n".repeat(HANDOFF_PAYLOAD_LIMITS.summary / 2) };
    expect(handoffArguments("summary").safeParse(payload).success).toBe(true);
    const notice = handoffNotice({
      id: "11111111-1111-4111-8111-111111111111", source: "s".repeat(64), target: "t".repeat(64), history: "full", payload: { reason: payload.reason },
      move: { previousWorkspace: "/w".repeat(256) },
    });
    const summary = handoffNotice({ id: "11111111-1111-4111-8111-111111111111", source: "s".repeat(64), target: "t".repeat(64), history: "summary", payload, move: {} });
    for (const text of [notice, summary]) expect(text.length).toBeLessThanOrEqual(HANDOFF_NOTICE_MAX);
    expect(summary.length).toBeGreaterThan(17_000);
  });

  it("tells a target in its own container that the workspace came with it, and maps the old path only with full history", () => {
    const payload = { reason: "Needs a shell.", summary: "Fix the build." };
    const full = handoffNotice({
      id: "11111111-1111-4111-8111-111111111111", source: "triage", target: "coder", history: "full", payload, move: { previousWorkspace: "C:\\Worker\\Anchors\\S" },
    });
    expect(full).toContain("You run in your own container");
    expect(full).toContain("Earlier messages name the workspace as C:\\Worker\\Anchors\\S");
    const summary = handoffNotice({
      id: "11111111-1111-4111-8111-111111111111", source: "triage", target: "coder", history: "summary", payload, move: { previousWorkspace: "C:\\Worker\\Anchors\\S" },
    });
    expect(summary).toContain("workspace files came with it");
    expect(summary).not.toContain("C:\\Worker");
    expect(handoffNotice({ id: "11111111-1111-4111-8111-111111111111", source: "triage", target: "notes", history: "summary", payload })).not.toContain("container");
  });

  it("maps a failed move into the target's container to a handoff error", () => {
    expect(handoffMoveError("promotion_capacity", "No capacity.")).toEqual({ code: "handoff_unavailable", message: "No capacity." });
    expect(handoffMoveError("session_changed", "Closed.")).toEqual({ code: "session_changed", message: "Closed." });
    expect(handoffMoveError("startup_failed", "Image missing.")).toEqual({
      code: "handoff_failed", message: "The move into the target's container failed (startup_failed): Image missing.",
    });
    expect(handoffMoveError("restore_failed", "x".repeat(600)).message.length).toBeLessThanOrEqual(500);
  });

  it("passes the payload to the target as untrusted data, filtered by the history policy", () => {
    const payload = { reason: "Needs a checkout.", summary: "SECRET_SUMMARY" };
    const summary = handoffNotice({ id: "11111111-1111-4111-8111-111111111111", source: "triage", target: "coder", history: "summary", payload });
    expect(summary.startsWith(handoffNoticeMarker("11111111-1111-4111-8111-111111111111"))).toBe(true);
    expect(summary).toContain("untrusted data");
    expect(summary).toContain("SECRET_SUMMARY");
    expect(summary).toContain("do not see the earlier conversation");
    const none = handoffNotice({ id: "11111111-1111-4111-8111-111111111111", source: "triage", target: "coder", history: "none", payload });
    expect(none).toContain("Needs a checkout.");
    expect(none).not.toContain("SECRET_SUMMARY");
    expect(handoffNotice({ id: "11111111-1111-4111-8111-111111111111", source: "triage", target: "coder", history: "full", payload }))
      .toContain("You can see the earlier conversation above.");
    expect(handoffFailureNotice({ id: "11111111-1111-4111-8111-111111111111", target: "coder", code: "handoff_unavailable", message: "No host." }))
      .toContain("You remain in control");
  });

  it("names transfer tools after their target, within 64 characters, stably", () => {
    expect(handoffToolName("coding-agent")).toBe("transfer_to_coding_agent");
    const long = `a${"b-".repeat(30)}c`;
    const name = handoffToolName(long);
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^transfer_to_a[a-z0-9_]+_[a-f0-9]{10}$/);
    expect(handoffToolName(long)).toBe(name);
    expect(handoffToolName(`${long}d`)).not.toBe(name);
  });

  it("describes handoffs to their owner without exposing internals", () => {
    const view = HandoffView.parse({
      id: "11111111-1111-4111-8111-111111111111", state: "committed",
      source: { name: "triage", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
      target: { name: "notes", version: "1.0.0", digest: `sha256:${"b".repeat(64)}`, mode: "shared" },
      history: "summary", approval: "ask", approvedBy: "person", reason: "Notes.", summary: "A summary.",
      from: { generation: 1, placement: "shared" }, to: { generation: 2, placement: "shared", ahpSessionId: "22222222-2222-4222-8222-222222222222" },
      requestedAt: new Date().toISOString(), committedAt: new Date().toISOString(),
    });
    expect(view.to?.ahpSessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(HandoffView.safeParse({ ...view, lease: "secret" }).success).toBe(false);
  });
});
