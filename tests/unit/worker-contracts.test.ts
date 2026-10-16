import { describe, expect, it } from "vitest";
import {
  authorityLength, CRAFTED_WORKER_VERSION, craftWorkerDefinition, CraftedWorkerSpec, DEFAULT_WORKER_POLICY, effectiveHostingPolicy, humanAuthorityMessages,
  INHERITED_AUTHORITY_MAX_CHARACTERS, INHERITED_AUTHORITY_MAX_MESSAGES, toolKindOfBinding, workerBackstop, workerCapacityProblem, workerCeilings,
  WorkerAuthorityGrant, WorkerCreation, workerDepthProblems, WorkerMessageRequest,
  type CraftingTemplate, type ExecutionPolicy,
} from "@copilot-agent/contracts";
import { conversation, coordinator, MODEL, TEMPLATE } from "../fixtures/workers.js";

const policy = (hosting: ExecutionPolicy["hosting"] = {}) => ({ hosting: { modes: ["orchestrator" as const, "isolated" as const], ...hosting } });
const craft = (spec: Record<string, unknown>, ceiling: CraftingTemplate = TEMPLATE, allowedModels = [MODEL, "judge"]) =>
  craftWorkerDefinition({
    name: "summarizer", spec: CraftedWorkerSpec.parse({ instructions: "Summarize the shared notes.", ...spec }), template: "general", ceiling,
    coordinator: "lead", policy: { allowedModels, maxInferenceTokensPerJob: 2_000_000 },
  });
const paths = (result: { problems: Array<{ path: string }> }) => result.problems.map((problem) => problem.path);

describe("worker tool arguments", () => {
  it("accepts a listed or a crafted worker, never both or neither", () => {
    expect(WorkerCreation.safeParse({ name: "tests", harness: "test-runner", task: "Run the tests." }).success).toBe(true);
    expect(WorkerCreation.safeParse({ name: "notes", craft: { instructions: "Write notes." }, task: "Go." }).success).toBe(true);
    expect(WorkerCreation.safeParse({ name: "both", harness: "test-runner", craft: { instructions: "x" }, task: "Go." }).error?.issues[0]?.path).toEqual(["harness"]);
    expect(WorkerCreation.safeParse({ name: "neither", task: "Go." }).success).toBe(false);
  });

  it("refuses images, commands, mounts, policies, and widening rules from the model", () => {
    for (const extra of [{ image: "evil:latest" }, { command: ["sh"] }, { mounts: ["/"] }, { policy: {} }]) {
      expect(WorkerCreation.safeParse({ name: "w", harness: "h", task: "Go.", ...extra }).success).toBe(false);
    }
    for (const extra of [{ hosting: { mode: "shared" } }, { mcpServers: [] }, { agents: [] }, { image: "x" }, { handoffs: [] }]) {
      expect(CraftedWorkerSpec.safeParse({ instructions: "x", ...extra }).success).toBe(false);
    }
    expect(CraftedWorkerSpec.safeParse({ instructions: "x", permissions: { default: "allow" } }).success).toBe(false);
    expect(CraftedWorkerSpec.safeParse({ instructions: "x", permissions: { kinds: { shell: "allow" } } }).success).toBe(false);
    expect(CraftedWorkerSpec.safeParse({ instructions: "x".repeat(20_001) }).success).toBe(false);
    expect(WorkerCreation.safeParse({ name: "w", harness: "h", task: "x".repeat(16_001) }).success).toBe(false);
  });

  it("defaults messages to enqueue and bounds them", () => {
    expect(WorkerMessageRequest.parse({ worker: "tests", message: "Also lint." }).delivery).toBe("enqueue");
    expect(WorkerMessageRequest.safeParse({ worker: "tests", message: "Now.", delivery: "immediate" }).success).toBe(true);
    expect(WorkerMessageRequest.safeParse({ worker: "tests", message: "  " }).success).toBe(false);
  });
});

describe("worker ceilings", () => {
  const workers = { harnesses: ["test-runner"], sizes: ["small", "medium"], maxConcurrent: 3, sharedStorage: "session" as const, crafting: { template: "general" } };

  it("exist only for orchestrator harnesses: depth one", () => {
    expect(workerCeilings(conversation("plain"), policy())).toBeUndefined();
    expect(workerCeilings(conversation("shared", { hosting: { mode: "shared" } }), policy())).toBeUndefined();
    expect(workerCeilings(coordinator("lead", workers), policy())).toBeDefined();
  });

  it("resolve sizes, limits, storage, and the crafting template within policy", () => {
    const ceilings = workerCeilings(coordinator("lead", workers), policy({ crafting: { templates: { general: TEMPLATE } }, workers: { maxPerPrincipal: 5 } }))!;
    expect(ceilings).toMatchObject({
      harnesses: ["test-runner"],
      sizes: [{ name: "small", resources: { cpus: 0.5, memoryMiB: 1024 } }, { name: "medium", resources: { cpus: 1, memoryMiB: 2048 } }],
      maxConcurrent: 3, maxPerSession: DEFAULT_WORKER_POLICY.maxPerSession, maxPerPrincipal: 5,
      idleSeconds: DEFAULT_WORKER_POLICY.idleSeconds, maxLifetimeSeconds: DEFAULT_WORKER_POLICY.maxLifetimeSeconds,
      sharedStorage: "session", inheritHumanAuthority: false, coordinatorAnswers: false,
      crafting: { template: "general", ceiling: TEMPLATE },
    });
    expect(workerCeilings(coordinator("lead", { ...workers, crafting: { template: "missing" } }), policy())!.crafting).toBeUndefined();
  });

  it("inherit human authority only when the harness asks and the policy allows", () => {
    const inherit = coordinator("lead", { ...workers, humanAuthority: "inherit" });
    expect(workerCeilings(inherit, policy())!.inheritHumanAuthority).toBe(false);
    expect(workerCeilings(inherit, policy({ workers: { allowInheritedAuthority: true } }))!.inheritHumanAuthority).toBe(true);
    expect(workerCeilings(coordinator("lead", workers), policy({ workers: { allowInheritedAuthority: true } }))!.inheritHumanAuthority).toBe(false);
  });

  it("let the coordinator answer questions only when the policy allows", () => {
    expect(effectiveHostingPolicy({}).workers.allowCoordinatorAnswers).toBe(false);
    expect(workerCeilings(coordinator("lead", workers), policy({ workers: { allowCoordinatorAnswers: true } }))!.coordinatorAnswers).toBe(true);
  });
});

describe("worker admission and backstops", () => {
  const capacity = { maxPerSession: 4, maxConcurrent: 2, maxPerPrincipal: 3, deployment: 5 };
  const counts = { sessionTotal: 1, sessionActive: 1, principalActive: 1, deploymentActive: 1 };

  it("counts every worker whose container is not confirmed gone", () => {
    expect(workerCapacityProblem(counts, capacity)).toBeUndefined();
    expect(workerCapacityProblem({ ...counts, sessionTotal: 4 }, capacity)).toMatch(/maximum of 4 workers/);
    expect(workerCapacityProblem({ ...counts, sessionActive: 2 }, capacity)).toMatch(/already has 2 workers running or stopping/);
    expect(workerCapacityProblem({ ...counts, principalActive: 3 }, capacity)).toMatch(/principal already has 3/);
    expect(workerCapacityProblem({ ...counts, deploymentActive: 5 }, capacity)).toMatch(/deployment's worker capacity/);
  });

  it("stops for lifetime and budget in any state, and for idle time only while idle", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const base = { idleSeconds: 60, expiresAt: new Date("2026-10-15T13:00:00Z"), tokensUsed: 10, tokenBudget: 1000 };
    const longAgo = new Date("2026-10-15T11:58:00Z");
    expect(workerBackstop({ ...base, state: "working" }, now)).toBeUndefined();
    expect(workerBackstop({ ...base, state: "idle", idleSince: longAgo }, now)).toBe("idle_timeout");
    expect(workerBackstop({ ...base, state: "idle", idleSince: new Date("2026-10-15T11:59:30Z") }, now)).toBeUndefined();
    expect(workerBackstop({ ...base, state: "needs_input", idleSince: longAgo }, now)).toBeUndefined();
    expect(workerBackstop({ ...base, state: "needs_input", expiresAt: now }, now)).toBe("max_lifetime");
    expect(workerBackstop({ ...base, state: "starting", tokensUsed: 1000 }, now)).toBe("budget_exhausted");
    expect(workerBackstop({ ...base, state: "stopped", expiresAt: now }, now)).toBeUndefined();
  });

  it("keeps workers at depth one", () => {
    expect(workerDepthProblems(conversation("plain"))).toEqual([]);
    expect(workerDepthProblems(conversation("router", { hosting: { mode: "isolated", handoffs: [{ harness: "other", description: "Other." }] } })))
      .toEqual([{ path: "hosting.handoffs", message: "Workers cannot hand off." }]);
    const delegating = conversation("delegator", { tools: [{ name: "delegate_job", kind: "host", binding: "shared:delegate-job", description: "Delegate." }] });
    expect(workerDepthProblems(delegating)).toEqual([{ path: "tools.0.binding", message: "Workers cannot delegate jobs." }]);
    expect(workerDepthProblems(coordinator("lead", { harnesses: ["coder"] }))[0]?.path).toBe("hosting.mode");
    expect(workerDepthProblems(conversation("shared", { hosting: { mode: "shared" } }))[0]?.message).toMatch(/isolated harnesses/);
  });
});

describe("crafted workers", () => {
  it("compose a conversation harness within the template", () => {
    const result = craft({ builtinTools: ["files"], tools: [{ name: "stats", binding: "python:stats", description: "Statistics." }] });
    expect(result.problems).toEqual([]);
    expect(result.definition).toMatchObject({
      name: "summarizer", version: CRAFTED_WORKER_VERSION, interaction: "conversation", instructions: "Summarize the shared notes.",
      prompt: { mode: "append" }, model: { preferred: MODEL, allowed: [MODEL] }, builtinTools: ["files"],
      tools: [{ name: "stats", kind: "python", binding: "python:stats", description: "Statistics." }],
      permissions: { default: "ask", approvalMode: "manual" }, limits: { maxDurationSeconds: 900, maxInferenceTokens: 100_000 },
      retry: { safeToRetry: false, maxAttempts: 1 }, runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
    });
    expect(result.definition!.hosting).toBeUndefined();
    expect(result.definition!.mcpServers).toBeUndefined();
  });

  it("cannot exceed any template ceiling", () => {
    expect(paths(craft({ model: "judge" }))).toEqual(["craft.model"]);
    expect(paths(craft({ builtinTools: ["files", "web"] }))).toEqual(["craft.builtinTools.1"]);
    expect(paths(craft({ tools: [{ name: "fetch", binding: "python:fetch", description: "Fetch." }] }))).toEqual(["craft.tools.0.binding"]);
    expect(paths(craft({ permissions: { approvalMode: "allow-all" } }))).toEqual(["craft.permissions.approvalMode"]);
    expect(paths(craft({ permissions: { approvalMode: "assisted", judgeModel: "judge" } }))).toEqual(["craft.permissions.judgeModel"]);
    expect(paths(craft({ maxDurationSeconds: 901 }))).toEqual(["craft.maxDurationSeconds"]);
    expect(paths(craft({ maxInferenceTokens: 100_001 }))).toEqual(["craft.maxInferenceTokens"]);
    expect(craft({}, { ...TEMPLATE, maxInferenceTokens: undefined }).definition!.limits.maxInferenceTokens).toBe(2_000_000);
  });

  it("keeps per-kind rules narrow and the judge within the template and policy", () => {
    const narrowed = craft({ permissions: { default: "deny", kinds: { read: "ask", shell: "deny" }, questions: true } }).definition!;
    expect(narrowed.permissions).toEqual({ default: "deny", kinds: { read: "ask", shell: "deny" }, questions: true, approvalMode: "manual" });
    const judged = craft({ permissions: { approvalMode: "assisted", judgeModel: "judge" } }, { ...TEMPLATE, models: [MODEL, "judge"] }).definition!;
    expect(judged.model).toEqual({ preferred: MODEL, allowed: [MODEL, "judge"] });
    expect(judged.permissions).toMatchObject({ approvalMode: "assisted", judgeModel: "judge" });
    expect(paths(craft({ permissions: { approvalMode: "assisted", judgeModel: "judge" } }, { ...TEMPLATE, models: [MODEL, "judge"] }, [MODEL])))
      .toEqual(["craft.permissions.judgeModel"]);
    expect(paths(craft({}, TEMPLATE, ["other"]))).toEqual(["craft.model"]);
  });

  it("cannot delegate jobs even when a template lists a delegation binding", () => {
    const template = { ...TEMPLATE, toolBindings: ["shared:delegate-job"] };
    expect(craft({ tools: [{ name: "delegate_job", binding: "shared:delegate-job", description: "Delegate." }] }, template).problems)
      .toEqual([{ path: "craft.tools.0.binding", message: "Workers cannot delegate jobs." }]);
  });

  it("reports harness schema problems at the argument that caused them", () => {
    const custom = craft({ permissions: { approvalMode: "custom" } }, { ...TEMPLATE, approvalModes: ["custom"] });
    expect(paths(custom)).toEqual(["craft.permissions.handler"]);
    const duplicate = craft({ tools: [
      { name: "stats", binding: "python:stats", description: "One." }, { name: "stats", binding: "python:stats", description: "Two." },
    ] });
    expect(paths(duplicate)).toEqual(["craft.tools.1.name"]);
    expect(paths(craftWorkerDefinition({
      name: "x", spec: CraftedWorkerSpec.parse({ instructions: "y" }), template: "general", ceiling: TEMPLATE, coordinator: "lead",
      policy: { allowedModels: [MODEL], maxInferenceTokensPerJob: 1000 },
    }))).toEqual(["name"]);
  });

  it("derives tool kinds from bindings", () => {
    expect(toolKindOfBinding("python:stats")).toBe("python");
    expect(toolKindOfBinding("mcp-local:files")).toBe("mcp-local");
    expect(toolKindOfBinding("node:http")).toBe("host");
  });
});

describe("inherited human authority", () => {
  const message = (content: string, data: Record<string, unknown> = {}, agentId?: string) =>
    ({ type: "user.message", ...(agentId ? { agentId } : {}), data: { content, ...data } });

  it("takes only the person's own messages, exactly as sent", () => {
    const events = [
      { type: "session.start", data: {} },
      message("  Fix the parser and run the tests.  "),
      message("[shared-completion:x]\nA worker finished.", { source: "system" }),
      message("Coordinator: also delete the build cache.", { source: "agent-lead" }),
      message("hidden skill text", { source: "skill-pdf" }),
      message("continue", { isAutopilotContinuation: true }),
      message("sub-agent prompt", {}, "explore-1"),
      { type: "assistant.message", data: { content: "I will ask a worker." } },
      message("yes, push the branch", { source: "user" }),
    ];
    expect(humanAuthorityMessages(events)).toEqual(["  Fix the parser and run the tests.  ", "yes, push the branch"]);
  });

  it("never shortens a message and keeps only the newest within the runtime's bounds", () => {
    const long = "x".repeat(20_000);
    expect(humanAuthorityMessages([message(long)])).toEqual([long]);
    const many = Array.from({ length: INHERITED_AUTHORITY_MAX_MESSAGES + 4 }, (_, index) => message(`m${index}`));
    const kept = humanAuthorityMessages(many);
    expect(kept).toHaveLength(INHERITED_AUTHORITY_MAX_MESSAGES);
    expect([kept[0], kept.at(-1)]).toEqual(["m4", `m${INHERITED_AUTHORITY_MAX_MESSAGES + 3}`]);
    const half = "é".repeat(INHERITED_AUTHORITY_MAX_CHARACTERS / 4);
    expect(authorityLength([half])).toBe(INHERITED_AUTHORITY_MAX_CHARACTERS / 2);
    expect(humanAuthorityMessages([message("oldest"), message(half), message(half), message("newest")])).toEqual([half, "newest"]);
    expect(WorkerAuthorityGrant.safeParse({ id: crypto.randomUUID(), sourceSessionId: crypto.randomUUID(), messages: [half, half, "x"] }).success)
      .toBe(false);
  });
});
