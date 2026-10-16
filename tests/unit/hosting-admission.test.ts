import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectionProblem,
  evaluateHosting,
  type ExecutionPolicy,
  type ExecutionProfile,
  type HarnessDefinition,
  HOSTING_ERROR_STATUS,
  HostingDeployment,
  type HostingEvaluationInput,
  HostingOverview,
  HarnessHostingView,
  SHARED_WORKER_FEATURES,
  WORKER_CONTAINER_FEATURES,
} from "@copilot-agent/contracts";
import type { JobEventListener, JobStore } from "@copilot-agent/job-store";
import {
  Admission,
  admitHostedHarness,
  ApiKeyAuthenticator,
  DEMO_HOST_FEATURES,
  hostingError,
  HttpError,
  loadHarnesses,
  loadPolicySet,
  loadProfiles,
} from "@copilot-agent/service-defaults";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { buildApi } from "../../src/agent-api/src/server.js";

const root = join(import.meta.dirname, "..", "..");
const examples = join(root, "examples", "customer-config");
const [harnesses, profiles, policies] = await Promise.all([loadHarnesses(examples), loadProfiles(root), loadPolicySet(examples)]);
const profile = profiles.get("node-ts-agent")!;

const policy: ExecutionPolicy = {
  ...policies.base,
  approvalModes: ["manual", "assisted", "allow-all", "custom"],
  permissionHandlers: ["acme-approvals"],
  mcpServers: { "docs-search": { url: "https://mcp.example.com/docs", auth: { secret: "docs-search-token" }, tools: ["search"] } },
  hosting: {
    modes: ["isolated", "shared", "promotable", "orchestrator"],
    workers: { allowInheritedAuthority: true },
    crafting: { templates: { general: { toolBindings: [], builtinTools: ["files"], models: ["grok-4.6"], approvalModes: ["manual"], maxDurationSeconds: 600, sizes: ["small"] } } },
  },
};

const conversation = (name: string, overrides: Partial<HarnessDefinition> = {}): HarnessDefinition => ({
  schemaVersion: "1",
  name,
  version: "1.0.0",
  description: "A conversation harness.",
  interaction: "conversation",
  instructions: "Help.",
  model: { preferred: "grok-4.6", allowed: ["grok-4.6"] },
  tools: [],
  input: { schema: { type: "object" } },
  output: { schema: { type: "object" } },
  limits: { maxDurationSeconds: 60, maxInferenceTokens: 1000 },
  retry: { safeToRetry: false, maxAttempts: 1 },
  runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
  ...overrides,
});

const evaluate = (definition: HarnessDefinition, deployment: HostingDeployment, extra: Partial<HostingEvaluationInput> = {}) =>
  evaluateHosting({ definition, policy, profiles, deployment, ...extra });
const summary = (evaluation: ReturnType<typeof evaluateHosting>) => ({
  status: evaluation.status,
  problems: evaluation.problems.map((problem) => `${problem.code}${problem.prerequisite ? ` ${problem.prerequisite.kind}:${problem.prerequisite.name}` : ""}${problem.path ? ` @${problem.path}` : ""}`),
});
const transports = (evaluation: ReturnType<typeof evaluateHosting>) =>
  Object.fromEntries(evaluation.transports.map((view) => [view.transport, view.available ? "available" : `${view.problem?.code}${view.problem?.prerequisite ? ` ${view.problem.prerequisite.name}` : ""}`]));

const none: HostingDeployment = { executor: "pool", isolatedHosts: [] };
const demoHost = (harness: string, both = true): HostingDeployment => ({
  executor: "pool",
  isolatedHosts: [{ harness, owner: "dev", transports: both ? ["direct", "github"] : ["direct"], features: [] }],
});
const sharedWorker: HostingDeployment = { executor: "pool", isolatedHosts: [], sharedWorker: { transports: ["direct"], features: [] } };

describe("hosting evaluation", () => {
  it("places batch harnesses on the executor", () => {
    const batch = harnesses.get("dataset-analyst")![0]!.definition;
    expect(evaluate(batch, none)).toMatchObject({ interaction: "batch", mode: "isolated", placement: "executor", status: "ready", transports: [] });
    expect(summary(evaluate(batch, { isolatedHosts: [] }))).toEqual({ status: "unavailable", problems: ["hosting_unavailable host:executor"] });
  });

  it("serves an isolated harness from its demo host, to its owner only", () => {
    const demo = harnesses.get("interactive-demo")![0]!.definition;
    const owner = evaluate(demo, demoHost("interactive-demo"), { principal: "dev" });
    expect(owner).toMatchObject({ interaction: "conversation", mode: "isolated", placement: "container", status: "ready", problems: [] });
    expect(transports(owner)).toEqual({ direct: "available", github: "available" });
    const other = evaluate(demo, demoHost("interactive-demo"), { principal: "alice" });
    expect(other.status).toBe("ready");
    expect(transports(other)).toEqual({ direct: "hosting_unavailable session-containers", github: "relay_owner_only" });
    expect(connectionProblem(other, "github")?.code).toBe("relay_owner_only");
    expect(connectionProblem(owner, "github")).toBeUndefined();
    const containers = evaluate(demo, { ...demoHost("interactive-demo", false), sessionContainers: { transports: ["direct"], features: [] } }, { principal: "alice" });
    expect(transports(containers)).toEqual({ direct: "available", github: "hosting_unavailable github" });
  });

  it("names the missing isolated host when no host serves the harness", () => {
    const chat = conversation("chat");
    const evaluation = evaluate(chat, demoHost("interactive-demo"));
    expect(summary(evaluation)).toEqual({ status: "unavailable", problems: ["hosting_unavailable host:isolated-host"] });
    expect(transports(evaluation)).toEqual({ direct: "hosting_unavailable direct", github: "hosting_unavailable github" });
    expect(connectionProblem(evaluation, "direct")?.code).toBe("hosting_unavailable");
  });

  it("rejects a disallowed mode before anything else", () => {
    const shared = conversation("chat", { hosting: { mode: "shared" }, mcpServers: [{ server: "missing", tools: ["x1"] }] });
    const evaluation = evaluateHosting({ definition: shared, policy: policies.base, profiles, deployment: none });
    expect(summary(evaluation)).toEqual({
      status: "not_allowed",
      problems: ["hosting_mode_not_allowed @hosting.mode", "policy_rejected @mcpServers.0.server", "hosting_unavailable host:shared-worker"],
    });
    const problem = connectionProblem(evaluation, "direct")!;
    expect(problem.code).toBe("hosting_mode_not_allowed");
    expect(HOSTING_ERROR_STATUS[problem.code]).toBe(422);
  });

  it("names the shared worker as the prerequisite for shared hosting", () => {
    const shared = conversation("chat", { hosting: { mode: "shared" } });
    const missing = evaluate(shared, none);
    expect(summary(missing)).toEqual({ status: "unavailable", problems: ["hosting_unavailable host:shared-worker"] });
    expect(missing.placement).toBe("shared");
    expect(missing.problems[0]?.message).toBe("Shared hosting needs the shared worker.");
    const ready = evaluate(shared, sharedWorker, { principal: "alice" });
    expect(summary(ready)).toEqual({ status: "ready", problems: [] });
    expect(transports(ready)).toEqual({ direct: "available", github: "transport_unsupported" });
    expect(connectionProblem(ready, "github")?.code).toBe("transport_unsupported");
    expect(connectionProblem(ready, "direct")).toBeUndefined();
  });

  it("reports transports the policy does not allow", () => {
    const shared = conversation("chat", { hosting: { mode: "shared" } });
    const githubOnly = { ...policy, hosting: { ...policy.hosting, transports: ["github" as const] } };
    const evaluation = evaluateHosting({ definition: shared, policy: githubOnly, profiles, deployment: sharedWorker });
    expect(summary(evaluation)).toEqual({ status: "rejected", problems: ["transport_not_allowed @hosting.mode"] });
    expect(transports(evaluation)).toEqual({ direct: "transport_not_allowed", github: "transport_unsupported" });
    const isolated = evaluateHosting({
      definition: harnesses.get("interactive-demo")![0]!.definition,
      policy: { ...policies.base, hosting: { transports: ["direct"] } },
      profiles,
      deployment: demoHost("interactive-demo"),
      principal: "dev",
    });
    expect(transports(isolated)).toEqual({ direct: "available", github: "transport_not_allowed" });
  });

  it("requires hosts to implement the features a harness requests", () => {
    const chat = conversation("chat", {
      hosting: { mode: "shared", handoffs: [{ harness: "interactive-demo", description: "Hand off." }] },
      mcpServers: [{ server: "docs-search", tools: ["search"] }],
      permissions: { default: "ask", approvalMode: "assisted" },
    });
    expect(summary(evaluate(chat, sharedWorker))).toEqual({
      status: "unavailable",
      problems: [
        "hosting_unavailable feature:remote-mcp @mcpServers",
        "hosting_unavailable feature:approval-modes @permissions.approvalMode",
        "hosting_unavailable feature:handoffs @hosting.handoffs",
      ],
    });
    const capable: HostingDeployment = { ...sharedWorker, sharedWorker: { transports: ["direct"], features: ["remote-mcp", "approval-modes", "handoffs"] } };
    expect(summary(evaluate(chat, capable))).toEqual({ status: "ready", problems: [] });
    const isolated = conversation("chat", { mcpServers: [{ server: "docs-search", tools: ["search"] }] });
    expect(summary(evaluate(isolated, demoHost("chat")))).toEqual({ status: "unavailable", problems: ["hosting_unavailable feature:remote-mcp @mcpServers"] });
    expect(summary(evaluate(isolated, { ...demoHost("chat"), sessionContainers: { transports: ["direct"], features: ["remote-mcp"] } })))
      .toEqual({ status: "ready", problems: [] });
  });

  it("requires a registered handler and host support for custom approvals", () => {
    const custom = (handler: string) => conversation("chat", { permissions: { default: "ask", approvalMode: "custom", handler } });
    const withHandler = new Map<string, ExecutionProfile>([["node-ts-agent", { ...profile, permissionHandlers: ["acme-approvals"] }]]);
    expect(summary(evaluate(custom("acme-approvals"), demoHost("chat"), { profiles: withHandler }))).toEqual({
      status: "unavailable",
      problems: ["hosting_unavailable feature:custom-approval @permissions.approvalMode"],
    });
    expect(summary(evaluate(custom("acme-approvals"), demoHost("chat")))).toEqual({
      status: "rejected",
      problems: ["policy_rejected @permissions.handler", "hosting_unavailable feature:custom-approval @permissions.approvalMode"],
    });
    expect(summary(evaluate(custom("other"), demoHost("chat"), { profiles: withHandler })).problems[0]).toBe("policy_rejected @permissions.handler");
  });

  it("names every prerequisite for promotion and orchestration", () => {
    expect(summary(evaluate(conversation("chat", { hosting: { mode: "promotable" } }), sharedWorker))).toEqual({
      status: "unavailable",
      problems: ["hosting_unavailable feature:promotion @hosting.mode", "hosting_unavailable host:session-containers"],
    });
    const promotable: HostingDeployment = {
      ...sharedWorker,
      sharedWorker: { transports: ["direct"], features: ["promotion"] },
      sessionContainers: { transports: ["direct"], features: [] },
    };
    expect(summary(evaluate(conversation("chat", { hosting: { mode: "promotable" } }), promotable))).toEqual({ status: "ready", problems: [] });
    const lead = conversation("lead", {
      hosting: { mode: "orchestrator", workers: { harnesses: [], crafting: { template: "general" }, humanAuthority: "inherit", sharedStorage: "session" } },
    });
    expect(summary(evaluate(lead, sharedWorker))).toEqual({ status: "unavailable", problems: ["hosting_unavailable host:worker-containers"] });
    expect(summary(evaluate(lead, { ...sharedWorker, workerContainers: { features: [] } }))).toEqual({
      status: "unavailable",
      problems: [
        "hosting_unavailable feature:crafted-workers @hosting.workers.crafting",
        "hosting_unavailable feature:inherited-authority @hosting.workers.humanAuthority",
        "hosting_unavailable feature:shared-storage @hosting.workers.sharedStorage",
      ],
    });
    expect(summary(evaluate(lead, { ...sharedWorker, workerContainers: { features: ["crafted-workers", "inherited-authority", "shared-storage"] } })))
      .toEqual({ status: "ready", problems: [] });
  });

  it("checks worker and handoff targets through the registry", () => {
    const lookup = (name: string) => {
      const found = harnesses.get(name)?.[0];
      return found ? { definition: found.definition, policy } : undefined;
    };
    const lead = conversation("lead", {
      hosting: {
        mode: "orchestrator",
        workers: { harnesses: ["interactive-demo", "dataset-analyst", "missing"] },
        handoffs: [{ harness: "interactive-demo", description: "Hand off." }],
      },
    });
    const evaluation = evaluate(lead, { ...sharedWorker, workerContainers: { features: [] }, sharedWorker: { transports: ["direct"], features: ["handoffs"] } }, { lookup });
    expect(summary(evaluation)).toEqual({
      status: "rejected",
      problems: ["policy_rejected @hosting.workers.harnesses.1", "policy_rejected @hosting.workers.harnesses.2"],
    });
    const isolatedOnly = (name: string) => (name === "interactive-demo" ? { definition: harnesses.get(name)![0]!.definition, policy: { hosting: { modes: ["shared" as const] } } } : lookup(name));
    expect(evaluate(lead, sharedWorker, { lookup: isolatedOnly }).problems.map((problem) => problem.message)).toEqual(expect.arrayContaining([
      "The operator policy does not allow isolated hosting for worker harness 'interactive-demo'.",
      "The operator policy does not allow isolated hosting for handoff target 'interactive-demo'.",
    ]));
  });

  it("resolves effective settings for the view", () => {
    const evaluation = evaluate(conversation("chat", { hosting: { mode: "promotable", promotion: { size: "medium" } } }), none);
    expect(evaluation.effective).toEqual({ mode: "promotable", declared: true, approvalMode: "manual", promotion: { size: "medium", approval: "ask" }, handoffs: [], mcpServers: [] });
  });
});

describe("hosting errors and deployment description", () => {
  it("uses one HTTP status per code", () => {
    expect(HOSTING_ERROR_STATUS).toEqual({
      hosting_mode_not_allowed: 422,
      transport_not_allowed: 422,
      policy_rejected: 422,
      transport_unsupported: 422,
      relay_owner_only: 403,
      hosting_unavailable: 409,
    });
    const error = hostingError({ code: "hosting_unavailable", message: "Shared hosting needs the shared worker.", prerequisite: { kind: "host", name: "shared-worker" } });
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ statusCode: 409, code: "hosting_unavailable", details: { prerequisite: { kind: "host", name: "shared-worker" } } });
    expect(hostingError({ code: "policy_rejected", message: "x", path: "model" }, "host_policy_rejected")).toMatchObject({
      statusCode: 422, code: "host_policy_rejected", details: { path: "model" },
    });
    expect(hostingError({ code: "relay_owner_only", message: "x" }).details).toBeUndefined();
  });

  it("describes today's hosts from deployment configuration", () => {
    const demo = (transport: string) => ({ transport, harness: "interactive-demo", principal: "dev" });
    expect(hostingDeployment({ executor: "pool", sharedWorker: false })).toEqual({ executor: "pool", isolatedHosts: [] });
    expect(hostingDeployment({ executor: "on-demand", demoHost: demo("both"), sharedWorker: true })).toEqual({
      executor: "dedicated",
      isolatedHosts: [{ harness: "interactive-demo", owner: "dev", transports: ["direct", "github"], features: [...DEMO_HOST_FEATURES] }],
      sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] },
    });
    expect(hostingDeployment({ executor: "pool", demoHost: demo("direct"), sharedWorker: false }).isolatedHosts[0]?.transports).toEqual(["direct"]);
    // GitHub-native hosting runs Copilot's own sessions, not the harness.
    expect(hostingDeployment({ executor: "pool", demoHost: demo("github"), sharedWorker: false }).isolatedHosts).toEqual([]);
    expect(hostingDeployment({ executor: "pool", demoHost: demo("disabled"), sharedWorker: false }).isolatedHosts).toEqual([]);
    expect(HostingDeployment.safeParse(hostingDeployment({ executor: "pool", demoHost: demo("both"), sharedWorker: true })).success).toBe(true);
    const orchestrating = hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true, workerContainers: true });
    expect(orchestrating.workerContainers).toEqual({ features: [...WORKER_CONTAINER_FEATURES] });
    expect(HostingDeployment.safeParse(orchestrating).success).toBe(true);
    expect(hostingDeployment({ executor: "on-demand", sharedWorker: true, sessionContainers: true }).workerContainers).toBeUndefined();
  });
});

describe("demo host admission", () => {
  const snapshot = (definition: HarnessDefinition) => ({ definition, digest: "sha256:test" });

  it("still admits the shipped interactive harness", () => {
    expect(admitHostedHarness(harnesses.get("interactive-demo")![0]!, profiles, policies.base)).toEqual({ model: "grok-4.6", tokenBudget: 100_000 });
  });

  it("never serves another mode in place of isolated", () => {
    expect(() => admitHostedHarness(snapshot(conversation("chat", { hosting: { mode: "shared" } })), profiles, policy)).toThrow(
      "The demo host serves isolated harnesses; this harness requests shared hosting.",
    );
  });

  it("rejects isolated hosting the policy disallows", () => {
    const shared = { ...policy, hosting: { modes: ["shared" as const] } };
    expect(() => admitHostedHarness(snapshot(conversation("chat")), profiles, shared)).toThrow(
      expect.objectContaining({ statusCode: 422, code: "hosting_mode_not_allowed" }),
    );
  });

  it("refuses harness features the demo host does not implement instead of ignoring them", () => {
    const requests: Array<Partial<HarnessDefinition>> = [
      { mcpServers: [{ server: "docs-search", tools: ["search"] }] },
      { permissions: { default: "ask", approvalMode: "assisted" } },
      { permissions: { default: "ask", approvalMode: "allow-all" } },
      { hosting: { mode: "isolated", handoffs: [{ harness: "interactive-demo", description: "Hand off." }] } },
    ];
    for (const request of requests) {
      expect(() => admitHostedHarness(snapshot(conversation("chat", request)), profiles, policy)).toThrow(
        expect.objectContaining({ statusCode: 409, code: "hosting_unavailable" }),
      );
    }
    expect(() => admitHostedHarness(snapshot(conversation("chat", { permissions: { default: "ask", approvalMode: "assisted" } })), profiles, policies.base))
      .toThrow(expect.objectContaining({ statusCode: 422, code: "host_policy_rejected", message: "The operator policy does not allow the 'assisted' approval mode." }));
  });

  it("keeps batch admission unchanged for jobs", () => {
    const admission = new Admission({ harnesses, profiles, policies });
    expect(admission.admit({ harness: { name: "text-summarizer" }, input: { request: "Summarize this text." } }).model).toBe("grok-4.6");
  });
});

describe("agent-api hosting view", () => {
  const devKey = "dev-key-0123456789abcdefghijkl";
  const aliceKey = "alice-key-0123456789abcdefghij";
  const app = buildApi({
    store: { ping: async () => undefined } as unknown as JobStore,
    listener: {} as JobEventListener,
    admission: new Admission({ harnesses, profiles, policies }),
    authenticator: new ApiKeyAuthenticator(`dev:${devKey};alice:${aliceKey}`),
    harnesses,
    maxOpenJobsPerPrincipal: 10,
    console: false,
    hosting: {
      harnesses,
      profiles,
      policies,
      deployment: hostingDeployment({
        executor: "pool",
        demoHost: { transport: "both", harness: "interactive-demo", principal: "dev" },
        sharedWorker: true,
      }),
    },
  });
  const get = (url: string, key?: string) => app.inject({ method: "GET", url, headers: key ? { "x-api-key": key } : {} });

  it("requires a caller key", async () => {
    expect((await get("/v1/hosting")).statusCode).toBe(401);
    expect((await get("/v1/hosting/interactive-demo")).statusCode).toBe(401);
  });

  it("lists every published harness with its hosting view", async () => {
    const response = await get("/v1/hosting", aliceKey);
    expect(response.statusCode).toBe(200);
    const overview = HostingOverview.parse(response.json());
    expect(overview.hosts).toEqual({
      executor: "pool",
      isolatedHosts: [{ harness: "interactive-demo", transports: ["direct", "github"], features: [] }],
      sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] },
    });
    expect(JSON.stringify(overview)).not.toContain('"owner"');
    expect(overview.harnesses.map((view) => `${view.harness}:${view.interaction}:${view.placement}:${view.status}`)).toEqual([
      "copilot-coding-agent:batch:executor:ready",
      "dataset-analyst:batch:executor:ready",
      "hybrid-builder:conversation:container:unavailable",
      "hybrid-coordinator:conversation:shared:ready",
      "hybrid-orchestrator:conversation:shared:unavailable",
      "hybrid-reviewer:conversation:container:unavailable",
      "insights-team:batch:executor:ready",
      "interactive-demo:conversation:container:ready",
      "shared-researcher:conversation:shared:ready",
      "text-summarizer:batch:executor:ready",
    ]);
  });

  it("evaluates transports for the calling principal", async () => {
    const owner = HarnessHostingView.parse((await get("/v1/hosting/interactive-demo", devKey)).json());
    expect(owner.transports.map((view) => [view.transport, view.available])).toEqual([["direct", true], ["github", true]]);
    expect(owner.digest).toBe(harnesses.get("interactive-demo")![0]!.digest);
    expect(owner.ceilings.modes).toEqual(["isolated"]);
    expect(owner.effective).toEqual({ mode: "isolated", declared: false, approvalMode: "manual", handoffs: [], mcpServers: [] });
    const other = HarnessHostingView.parse((await get("/v1/hosting/interactive-demo?version=1.0.0", aliceKey)).json());
    expect(other.transports.map((view) => view.problem?.code)).toEqual(["hosting_unavailable", "relay_owner_only"]);
  });

  it("returns explicit errors for unknown harnesses and versions", async () => {
    expect((await get("/v1/hosting/missing-harness", devKey)).json()).toMatchObject({ error: { code: "harness_not_found" } });
    expect((await get("/v1/hosting/Not_A_Slug", devKey)).statusCode).toBe(404);
    expect((await get("/v1/hosting/interactive-demo?version=9.9.9", devKey)).statusCode).toBe(404);
    expect((await get("/v1/hosting/interactive-demo?version=latest", devKey)).statusCode).toBe(400);
    expect((await get("/v1/hosting/interactive-demo?version=1.0.0&version=1.0.1", devKey)).statusCode).toBe(400);
    expect((await get("/v1/hosting/interactive-demo?_=1", devKey)).statusCode).toBe(200);
  });
});
