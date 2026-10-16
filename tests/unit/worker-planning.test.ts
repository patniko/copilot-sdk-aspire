import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRAFTED_WORKER_VERSION, evaluateHosting, policyFor, WORKER_CONTAINER_FEATURES, WorkerCreation, type HarnessDefinition,
} from "@copilot-agent/contracts";
import {
  craftedWorkerPolicy, HttpError, loadHarnesses, loadPolicySet, loadProfiles, planWorker, policyDigest, type WorkerRegistry,
} from "@copilot-agent/service-defaults";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { conversation, coordinator, MODEL, snapshot, TEMPLATE, workerRegistry } from "../fixtures/workers.js";

const FEATURES = ["approval-modes", "crafted-workers", "inherited-authority", "shared-storage"] as const;
const runner = conversation("test-runner", { builtinTools: ["files", "shell"], permissions: { default: "ask", approvalMode: "assisted" } });
const analyst = conversation("repo-analyst");
const lead = coordinator("lead", {
  harnesses: ["test-runner", "repo-analyst", "router", "delegator", "chat", "ghost"], sizes: ["small", "medium", "large"],
  sharedStorage: "session", humanAuthority: "inherit", crafting: { template: "general" },
});
const router = conversation("router", { hosting: { mode: "isolated", handoffs: [{ harness: "repo-analyst", description: "Analysis." }] } });
const delegator = conversation("delegator", { tools: [{ name: "delegate_job", kind: "host", binding: "shared:delegate-job", description: "Delegate." }] });
const chat = conversation("chat", { hosting: { mode: "shared" } });
const registry = await workerRegistry([runner, analyst, lead, router, delegator, chat]);

function plan(request: Record<string, unknown>, options: { registry?: WorkerRegistry; coordinator?: HarnessDefinition; features?: readonly string[] } = {}) {
  const source = options.registry ?? registry;
  const definition = options.coordinator ?? lead;
  return planWorker(source, { definition, policy: policyFor(source.policies, definition.name) }, WorkerCreation.parse(request),
    { features: (options.features ?? FEATURES) as typeof FEATURES[number][] });
}
function failure(action: () => unknown): HttpError {
  try { action(); } catch (error) { if (error instanceof HttpError) return error; throw error; }
  throw new Error("Expected the plan to be refused.");
}
const path = (error: HttpError) => (error.details as { path?: string } | undefined)?.path;

describe("listed workers", () => {
  it("run the latest published version under the worker's own policy", () => {
    const result = plan({ name: "tests", harness: "test-runner", size: "medium", task: "Run the unit tests." });
    expect(result).toMatchObject({
      name: "tests", source: "listed", harness: { name: "test-runner", version: "1.0.0", digest: snapshot(runner).digest },
      size: "medium", resources: { cpus: 1, memoryMiB: 2048 }, sharedVolume: "read-write", approvalMode: "assisted",
      inheritHumanAuthority: true, coordinatorAnswers: false, model: MODEL, tokenBudget: 200_000, maxTurnSeconds: 600,
      inputTimeoutSeconds: 600, idleSeconds: 900, lifetimeSeconds: 3600, task: "Run the unit tests.",
      capacity: { maxPerSession: 16, maxConcurrent: 4, maxPerPrincipal: 8 },
    });
    expect(result.template).toBeUndefined();
    expect(result.policyDigest).toBe(policyDigest(policyFor(registry.policies, "test-runner")));
  });

  it("default to the first size, inherit authority only for assisted workers, and cap the requested budget", () => {
    const result = plan({ name: "analysis", harness: "repo-analyst", task: "Map the repository.", tokenBudget: 5000, sharedVolume: "read-only" });
    expect(result).toMatchObject({ size: "small", sharedVolume: "read-only", approvalMode: "manual", inheritHumanAuthority: false, tokenBudget: 5000 });
    expect(plan({ name: "analysis", harness: "repo-analyst", task: "x", tokenBudget: 900_000 }).tokenBudget).toBe(200_000);
  });

  it("come only from the coordinator's list of published worker harnesses", () => {
    expect(path(failure(() => plan({ name: "wk", harness: "text-summarizer", task: "x" })))).toBe("harness");
    expect(failure(() => plan({ name: "wk", harness: "ghost", task: "x" })).message).toMatch(/not published/);
  });

  it("stay at depth one and isolated", () => {
    const plain = failure(() => plan({ name: "wk", harness: "repo-analyst", task: "x" }, { coordinator: analyst }));
    expect(plain.message).toMatch(/Only an orchestrator coordinator can start workers/);
    expect(failure(() => plan({ name: "wk", harness: "router", task: "x" })).message).toMatch(/cannot hand off/);
    expect(failure(() => plan({ name: "wk", harness: "delegator", task: "x" })).message).toMatch(/cannot delegate jobs/);
    expect(failure(() => plan({ name: "wk", harness: "chat", task: "x" })).message).toMatch(/run isolated harnesses/);
  });

  it("are refused once the coordinator's current policy no longer allows its hosting request", async () => {
    const withoutMode = await workerRegistry([runner, analyst, lead], {}, { lead: { hosting: { modes: ["isolated"] } } });
    expect(failure(() => plan({ name: "wk", harness: "repo-analyst", task: "x" }, { registry: withoutMode })).message)
      .toMatch(/^The coordinator can no longer start workers: .*orchestrator hosting/);
    const withoutInheritance = await workerRegistry([runner, analyst, lead], {}, { lead: { hosting: { modes: ["orchestrator"] } } });
    const error = failure(() => plan({ name: "wk", harness: "repo-analyst", task: "x" }, { registry: withoutInheritance }));
    expect(error.details).toMatchObject({ path: "harness", field: "hosting.workers.humanAuthority" });
  });

  it("are unavailable when worker containers lack a feature the worker needs", () => {
    const error = failure(() => plan({ name: "tests", harness: "test-runner", task: "x" }, { features: [] }));
    expect(error).toMatchObject({ statusCode: 409, code: "hosting_unavailable" });
    expect(error.details).toMatchObject({ path: "harness", prerequisite: { kind: "feature", name: "approval-modes" } });
    expect(error.message).toMatch(/^Worker harness 'test-runner': /);
  });

  it("use only the coordinator's sizes and shared storage", () => {
    expect(path(failure(() => plan({ name: "wk", harness: "repo-analyst", task: "x", size: "huge" })))).toBe("size");
    const solo = coordinator("solo", { harnesses: ["repo-analyst"], sizes: ["small"] });
    const isolatedRegistry = { ...registry, harnesses: new Map([...registry.harnesses, ["solo", [snapshot(solo)]]]) };
    expect(plan({ name: "wk", harness: "repo-analyst", task: "x" }, { registry: isolatedRegistry, coordinator: solo }).sharedVolume).toBe("none");
    const shared = failure(() => plan({ name: "wk", harness: "repo-analyst", task: "x", sharedVolume: "read-only" }, { registry: isolatedRegistry, coordinator: solo }));
    expect(path(shared)).toBe("sharedVolume");
    expect(path(failure(() => plan({ name: "wk", harness: "repo-analyst", task: "x", size: "medium" }, { registry: isolatedRegistry, coordinator: solo })))).toBe("size");
  });
});

describe("crafted workers", () => {
  it("are composed within the template, recorded with their digest, and never take a published name", () => {
    const result = plan({ name: "notes", craft: { instructions: "Keep concise notes.", builtinTools: ["files"] }, task: "Start the notes." });
    expect(result).toMatchObject({
      name: "notes", source: "crafted", template: "general", size: "small", approvalMode: "manual", inheritHumanAuthority: false,
      harness: { name: "notes", version: CRAFTED_WORKER_VERSION }, tokenBudget: 100_000, maxTurnSeconds: 900,
    });
    expect(result.harness.digest).toBe(snapshot(result.definition).digest);
    expect(result.policyDigest).toBe(policyDigest(craftedWorkerPolicy(policyFor(registry.policies, "lead"))));
    expect(path(failure(() => plan({ name: "repo-analyst", craft: { instructions: "x" }, task: "x" })))).toBe("name");
    const assisted = plan({ name: "judge", craft: { instructions: "x", permissions: { approvalMode: "assisted" } }, task: "x" });
    expect(assisted).toMatchObject({ approvalMode: "assisted", inheritHumanAuthority: true });
  });

  it("cannot exceed the template, including its sizes", () => {
    const widened = failure(() => plan({ name: "web", craft: { instructions: "x", builtinTools: ["web"] }, task: "x" }));
    expect(widened).toMatchObject({ statusCode: 422, code: "policy_rejected" });
    expect(widened.details).toMatchObject({ path: "craft.builtinTools.0", problems: [{ path: "craft.builtinTools.0" }] });
    expect(path(failure(() => plan({ name: "big", craft: { instructions: "x" }, task: "x", size: "large" })))).toBe("size");
    expect(path(failure(() => plan({ name: "slow", craft: { instructions: "x", maxDurationSeconds: 1800 }, task: "x" })))).toBe("craft.maxDurationSeconds");
  });

  it("need a crafting template on the coordinator", () => {
    const listedOnly = coordinator("listed-only", { harnesses: ["repo-analyst"] });
    const source = { ...registry, harnesses: new Map([...registry.harnesses, ["listed-only", [snapshot(listedOnly)]]]) };
    expect(path(failure(() => plan({ name: "notes", craft: { instructions: "x" }, task: "x" }, { registry: source, coordinator: listedOnly })))).toBe("craft");
  });

  it("are checked against the coordinator's effective policy, with the template standing in for isolated hosting", async () => {
    const narrowed = await workerRegistry([runner, analyst, lead], {}, {
      lead: { builtinTools: ["files"], hosting: { modes: ["orchestrator"], workers: { allowInheritedAuthority: true }, crafting: { templates: { general: TEMPLATE } } } },
    });
    expect(craftedWorkerPolicy(policyFor(narrowed.policies, "lead")).hosting?.modes).toEqual(["isolated"]);
    expect(plan({ name: "notes", craft: { instructions: "x", builtinTools: ["files"] }, task: "x" }, { registry: narrowed }).source).toBe("crafted");
    const shell = failure(() => plan({ name: "shell", craft: { instructions: "x", builtinTools: ["shell"] }, task: "x" }, { registry: narrowed }));
    expect(shell).toMatchObject({ statusCode: 422, code: "policy_rejected" });
    expect(shell.message).toMatch(/^The crafted worker: .*'shell' built-in tools/);
    expect(path(shell)).toBe("craft");
  });
});

describe("the shipped orchestrator example", () => {
  it("is ready with worker containers and plans its listed and crafted workers within the example policy", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const examples = join(root, "examples", "customer-config");
    const [harnesses, profiles, policies] = await Promise.all([loadHarnesses(examples), loadProfiles(root), loadPolicySet(examples)]);
    const shipped: WorkerRegistry = { harnesses, profiles, policies };
    const lead = harnesses.get("hybrid-orchestrator")![0]!.definition;
    const policy = policyFor(policies, lead.name);
    const lookup = (name: string) => {
      const found = harnesses.get(name)?.[0];
      return found ? { definition: found.definition, policy: policyFor(policies, name) } : undefined;
    };
    const deployment = (workerContainers: boolean) =>
      hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true, workerContainers });
    expect(evaluateHosting({ definition: lead, policy, profiles, deployment: deployment(true), lookup }))
      .toMatchObject({ mode: "orchestrator", placement: "shared", status: "ready", problems: [] });
    expect(evaluateHosting({ definition: lead, policy, profiles, deployment: deployment(false), lookup }).problems)
      .toEqual([expect.objectContaining({ code: "hosting_unavailable", prerequisite: { kind: "host", name: "worker-containers" } })]);

    const plan = (request: Record<string, unknown>) =>
      planWorker(shipped, { definition: lead, policy }, WorkerCreation.parse(request), { features: WORKER_CONTAINER_FEATURES });
    expect(plan({ name: "build", harness: "hybrid-builder", task: "Build it." })).toMatchObject({
      source: "listed", size: "small", sharedVolume: "read-write", approvalMode: "manual", inheritHumanAuthority: false,
      model: "grok-4.6", tokenBudget: 100_000, capacity: { maxConcurrent: 2, maxPerSession: 8, maxPerPrincipal: 4 },
    });
    expect(plan({ name: "review", harness: "hybrid-reviewer", size: "medium", sharedVolume: "read-only", task: "Review it." })).toMatchObject({
      source: "listed", size: "medium", resources: { cpus: 1, memoryMiB: 2048 }, sharedVolume: "read-only", approvalMode: "assisted",
      inheritHumanAuthority: true,
    });
    expect(plan({ name: "notes", craft: { instructions: "Keep notes.", builtinTools: ["files"] }, task: "Take notes." }))
      .toMatchObject({ source: "crafted", template: "notes", size: "small", approvalMode: "manual", tokenBudget: 50_000 });
    expect(failure(() => plan({ name: "runner", craft: { instructions: "Run things.", builtinTools: ["shell"] }, task: "x" })).message)
      .toMatch(/'shell' built-in tools are not in crafting template 'notes'/);
    expect(path(failure(() => plan({ name: "big", harness: "hybrid-builder", size: "large", task: "x" })))).toBe("size");
  });
});