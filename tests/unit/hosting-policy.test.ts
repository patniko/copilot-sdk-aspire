import { describe, expect, it } from "vitest";
import {
  applyPolicyOverride,
  ContainerSize,
  DEFAULT_CONTAINER_SIZES,
  DEFAULT_WORKER_POLICY,
  effectiveApprovalModes,
  effectiveHarnessHosting,
  effectiveHostingPolicy,
  ExecutionContainerSettings,
  ExecutionPolicy,
  ExecutionProfile,
  HARNESS_OVERRIDABLE_POLICY_FIELDS,
  type HarnessDefinition,
  HarnessPolicyOverride,
  hostedProfileViolations,
  hostingPolicyViolations,
  McpServerPolicy,
  policyFor,
  toolPolicyViolations,
  transportsForMode,
} from "@copilot-agent/contracts";

const base: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["m", "judge"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 10_000,
  maxConcurrentAttemptsPerPrincipal: 2,
  maxQueuedJobsPerPrincipal: 10,
  retry: { maxAttempts: 2, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  builtinTools: ["files", "web"],
  permissionModes: ["ask", "allow"],
};

const conversation = (overrides: Partial<HarnessDefinition> = {}): HarnessDefinition => ({
  schemaVersion: "1",
  name: "chat",
  version: "1.0.0",
  description: "A conversation harness.",
  interaction: "conversation",
  instructions: "Help.",
  model: { preferred: "m", allowed: ["m", "judge"] },
  tools: [],
  input: { schema: { type: "object" } },
  output: { schema: { type: "object" } },
  limits: { maxDurationSeconds: 60, maxInferenceTokens: 1000 },
  retry: { safeToRetry: false, maxAttempts: 1 },
  runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
  ...overrides,
});

const issues = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

describe("policy defaults keep today's behavior", () => {
  it("allows isolated hosting, both transports, manual approvals, and no MCP servers when the policy is silent", () => {
    const hosting = effectiveHostingPolicy(base);
    expect(hosting.modes).toEqual(["isolated"]);
    expect(hosting.transports).toEqual(["direct", "github"]);
    expect(hosting.sizes).toEqual(DEFAULT_CONTAINER_SIZES);
    expect(hosting.defaultSize).toBe("small");
    expect(hosting.workers).toEqual(DEFAULT_WORKER_POLICY);
    expect(hosting.workers.allowInheritedAuthority).toBe(false);
    expect(hosting.promotion.approval).toEqual(["ask"]);
    expect(hosting.crafting.templates).toEqual({});
    expect(effectiveApprovalModes(base)).toEqual(["manual"]);
    expect(ExecutionPolicy.parse(base)).toEqual(base);
  });

  it("keeps the default size catalog inside the execution container bounds", () => {
    for (const size of Object.values(DEFAULT_CONTAINER_SIZES)) {
      expect(ExecutionContainerSettings.safeParse({ namespace: "local-namespace", image: "i", ...size }).success).toBe(true);
    }
    for (const bound of [{ cpus: 0.25, memoryMiB: 256 }, { cpus: 8, memoryMiB: 16_384 }]) {
      expect(ContainerSize.safeParse(bound).success).toBe(true);
      expect(ExecutionContainerSettings.safeParse({ namespace: "local-namespace", image: "i", ...bound }).success).toBe(true);
    }
    expect(ContainerSize.safeParse({ cpus: 0.2, memoryMiB: 256 }).success).toBe(false);
    expect(ContainerSize.safeParse({ cpus: 1, memoryMiB: 16_385 }).success).toBe(false);
  });

  it("uses the smallest catalog size when no default is named", () => {
    const hosting = effectiveHostingPolicy({ hosting: { sizes: { wide: { cpus: 4, memoryMiB: 2048 }, tiny: { cpus: 2, memoryMiB: 512 } } } });
    expect(hosting.defaultSize).toBe("tiny");
    expect(effectiveHostingPolicy({ hosting: { sizes: { wide: { cpus: 4, memoryMiB: 2048 } }, defaultSize: "wide" } }).defaultSize).toBe("wide");
  });
});

describe("hosting ceilings schema", () => {
  const parse = (hosting: unknown) => ExecutionPolicy.safeParse({ ...base, hosting });

  it("accepts the plan's illustrative ceilings", () => {
    const result = parse({
      modes: ["isolated", "shared", "promotable", "orchestrator"],
      transports: ["direct", "github"],
      sizes: { small: { cpus: 0.5, memoryMiB: 1024 }, medium: { cpus: 1, memoryMiB: 2048 }, large: { cpus: 2, memoryMiB: 4096 } },
      workers: { maxConcurrentPerSession: 4, maxPerSession: 16, maxPerPrincipal: 8, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: true },
      promotion: { approval: ["ask"] },
      crafting: {
        templates: {
          "general-worker": {
            toolBindings: [], builtinTools: ["files", "shell"], models: ["m"], approvalModes: ["manual"], maxDurationSeconds: 1800, sizes: ["small"],
          },
        },
      },
    });
    expect(issues(result)).toEqual([]);
  });

  it("rejects inconsistent ceilings with field-scoped errors", () => {
    expect(issues(parse({ modes: [] }))).toEqual([expect.stringMatching(/^hosting\.modes:/)]);
    expect(issues(parse({ modes: ["shared", "shared"] }))).toEqual(["hosting.modes: Each value can be listed once."]);
    expect(issues(parse({ transports: ["relay"] }))[0]).toMatch(/^hosting\.transports\.0:/);
    expect(issues(parse({ sizes: {} }))).toEqual(["hosting.sizes: Define between one and eight container sizes."]);
    expect(issues(parse({ sizes: { huge: { cpus: 16, memoryMiB: 1024 } } }))[0]).toMatch(/^hosting\.sizes\.huge\.cpus:/);
    expect(issues(parse({ defaultSize: "xl" }))).toEqual(["hosting.defaultSize: Size 'xl' is not in the size catalog."]);
    expect(issues(parse({ workers: { maxConcurrentPerSession: 8, maxPerSession: 4 } }))).toEqual([
      "hosting.workers.maxConcurrentPerSession: maxConcurrentPerSession cannot exceed maxPerSession.",
    ]);
    expect(issues(parse({ workers: { idleSeconds: 5 } }))[0]).toMatch(/^hosting\.workers\.idleSeconds:/);
    expect(issues(parse({ promotion: { approval: [] } }))[0]).toMatch(/^hosting\.promotion\.approval:/);
    expect(issues(parse({
      crafting: { templates: { general: { toolBindings: [], builtinTools: [], models: ["m"], approvalModes: ["manual"], maxDurationSeconds: 60, sizes: ["xl"] } } },
    }))).toEqual(["hosting.crafting.templates.general.sizes.0: Size 'xl' is not in the size catalog."]);
    expect(issues(parse({ unknown: true }))[0]).toMatch(/^hosting:/);
  });

  it("validates approval modes and permission handler lists", () => {
    expect(ExecutionPolicy.safeParse({ ...base, approvalModes: [] }).success).toBe(false);
    expect(ExecutionPolicy.safeParse({ ...base, approvalModes: ["manual", "manual"] }).success).toBe(false);
    expect(ExecutionPolicy.safeParse({ ...base, approvalModes: ["manual", "assisted", "allow-all", "custom"] }).success).toBe(true);
    expect(ExecutionPolicy.safeParse({ ...base, permissionHandlers: ["Not A Slug"] }).success).toBe(false);
    expect(ExecutionPolicy.safeParse({ ...base, permissionHandlers: ["acme-approvals"] }).success).toBe(true);
  });
});

describe("MCP server catalog", () => {
  const server = { url: "https://mcp.example.com/docs", auth: { secret: "docs-search-token" }, tools: ["search", "fetch_page"] };
  const parse = (value: unknown) => issues(McpServerPolicy.safeParse(value));

  it("accepts approved servers with a secret reference and tool list", () => {
    expect(parse(server)).toEqual([]);
    expect(parse({ ...server, auth: { secret: "docs-search-token", header: "X-Api-Key" } })).toEqual([]);
    expect(parse({ url: "http://127.0.0.1:8931/mcp", tools: ["search"] })).toEqual([]);
    expect(ExecutionPolicy.safeParse({ ...base, mcpServers: { "docs-search": server } }).success).toBe(true);
  });

  it("rejects unsafe or malformed entries", () => {
    expect(parse({ ...server, url: "ftp://mcp.example.com" })[0]).toMatch(/^url:/);
    expect(parse({ ...server, url: "http://mcp.example.com/docs" })).toEqual([
      "url: A server that receives a credential must use https unless allowPrivateNetwork is set.",
    ]);
    expect(parse({ ...server, url: "https://user:pass@mcp.example.com/docs" })).toEqual(["url: Put the credential in auth.secret, not in the URL."]);
    expect(parse({ ...server, url: "https://mcp.example.com/docs#part" })).toEqual(["url: Remove the URL fragment."]);
    expect(parse({ ...server, auth: { secret: "docs-search-token", header: "Host" } })).toEqual(["auth.header: 'Host' is a protocol header."]);
    expect(parse({ ...server, auth: { secret: "Not A Secret Name" } })[0]).toMatch(/^auth\.secret:/);
    expect(parse({ ...server, tools: [] })[0]).toMatch(/^tools:/);
    expect(parse({ ...server, tools: ["search", "search"] })).toEqual(["tools: Each value can be listed once."]);
    expect(parse({ ...server, tools: ["bad tool"] })[0]).toMatch(/^tools\.0:/);
    expect(ExecutionPolicy.safeParse({ ...base, mcpServers: { "Bad Name": server } }).success).toBe(false);
  });

  it("lets an operator allow a private development origin, including credentials over http", () => {
    const local = { url: "http://mcp-fake:8931/mcp", auth: { secret: "docs-search-token" }, tools: ["search"], allowPrivateNetwork: true };
    expect(parse(local)).toEqual([]);
    expect(parse({ ...local, allowPrivateNetwork: false })).toEqual([
      "url: A server that receives a credential must use https unless allowPrivateNetwork is set.",
    ]);
    expect(parse({ ...local, allowPrivateNetwork: "yes" })[0]).toMatch(/^allowPrivateNetwork:/);
    const policy = ExecutionPolicy.parse({ ...base, mcpServers: { local } });
    expect(policy.mcpServers?.local?.allowPrivateNetwork).toBe(true);
    const override = HarnessPolicyOverride.parse({ schemaVersion: "1", harness: "chat", overrides: { mcpServers: { local } } });
    expect(policyFor({ base, overrides: new Map([["chat", override]]) }, "chat").mcpServers?.local?.allowPrivateNetwork).toBe(true);
  });
});

describe("execution profile hosting fields", () => {
  const profile = {
    schemaVersion: "1", id: "node-ts-agent", displayName: "TS", runnerProtocol: "1",
    agent: { language: "typescript", sdk: "sdk", sdkVersion: "1", firstParty: true },
    entrypoint: { command: "node", args: [], directory: "." }, toolchains: [], toolBindings: ["host:lookup", "python:stats"], capabilities: [],
  };

  it("accepts in-process bindings only from the profile's own bindings", () => {
    expect(ExecutionProfile.safeParse({ ...profile, inProcessBindings: ["host:lookup"], permissionHandlers: ["acme-approvals"] }).success).toBe(true);
    expect(issues(ExecutionProfile.safeParse({ ...profile, inProcessBindings: ["host:other"] }))).toEqual([
      "inProcessBindings.0: 'host:other' is not one of this profile's toolBindings.",
    ]);
    expect(ExecutionProfile.safeParse({ ...profile, permissionHandlers: ["Bad"] }).success).toBe(false);
  });
});

describe("per-harness overrides", () => {
  it("can override every new policy field and replaces hosting as a whole", () => {
    for (const field of ["approvalModes", "permissionHandlers", "mcpServers", "hosting"]) {
      expect(HARNESS_OVERRIDABLE_POLICY_FIELDS).toContain(field);
    }
    const withHosting: ExecutionPolicy = { ...base, approvalModes: ["manual", "assisted"], hosting: { modes: ["isolated", "shared"], workers: { maxPerSession: 4 } } };
    const override = HarnessPolicyOverride.parse({
      schemaVersion: "1",
      harness: "chat",
      overrides: { hosting: { modes: ["shared"] }, approvalModes: ["allow-all"], permissionHandlers: ["acme"], mcpServers: {} },
    });
    const effective = applyPolicyOverride(withHosting, override);
    expect(effective.hosting).toEqual({ modes: ["shared"] });
    expect(effectiveHostingPolicy(effective).workers.maxPerSession).toBe(DEFAULT_WORKER_POLICY.maxPerSession);
    expect(effectiveApprovalModes(effective)).toEqual(["allow-all"]);
    expect(effective.permissionHandlers).toEqual(["acme"]);
    expect(effective.mcpServers).toEqual({});
    expect(policyFor({ base: withHosting, overrides: new Map([["chat", override]]) }, "other")).toBe(withHosting);
  });

  it("validates override values with the policy schema", () => {
    const parse = (overrides: unknown) => HarnessPolicyOverride.safeParse({ schemaVersion: "1", harness: "chat", overrides }).success;
    expect(parse({ hosting: { defaultSize: "xl" } })).toBe(false);
    expect(parse({ approvalModes: ["sometimes"] })).toBe(false);
    expect(parse({ mcpServers: { docs: { url: "https://mcp.example.com", tools: [] } } })).toBe(false);
  });
});

describe("tool and approval policy checks", () => {
  const withApprovals: ExecutionPolicy = {
    ...base,
    approvalModes: ["manual", "assisted"],
    permissionHandlers: ["acme-approvals"],
    mcpServers: { "docs-search": { url: "https://mcp.example.com/docs", tools: ["search", "fetch_page"] } },
  };
  const paths = (definition: HarnessDefinition, policy: ExecutionPolicy = withApprovals) => toolPolicyViolations(definition, policy).map((p) => p.path);

  it("enforces approval modes only where a request can reach a person or the mode is explicit", () => {
    expect(paths(conversation({ permissions: { default: "deny" } }), base)).toEqual([]);
    expect(paths(conversation({ permissions: { default: "ask" } }), base)).toEqual([]);
    expect(paths(conversation({ permissions: { default: "ask", approvalMode: "assisted" } }), base)).toEqual(["permissions.approvalMode"]);
    expect(paths(conversation({ permissions: { default: "ask" } }), { ...base, approvalModes: ["assisted"] })).toEqual(["permissions.approvalMode"]);
    expect(paths(conversation({ permissions: { default: "deny" } }), { ...base, approvalModes: ["assisted"] })).toEqual([]);
    expect(paths(conversation({ permissions: { default: "ask", approvalMode: "allow-all" } }))).toEqual(["permissions.approvalMode"]);
    expect(paths(conversation({ permissions: { default: "ask", approvalMode: "assisted", judgeModel: "judge" } }))).toEqual([]);
  });

  it("requires approved judge models and permission handlers", () => {
    expect(paths(conversation({ permissions: { default: "ask", approvalMode: "assisted", judgeModel: "judge" } }), { ...withApprovals, allowedModels: ["m"] }))
      .toEqual(["permissions.judgeModel"]);
    expect(paths(conversation({ permissions: { default: "ask", approvalMode: "custom", handler: "other" } }), { ...withApprovals, approvalModes: ["custom"] }))
      .toEqual(["permissions.handler"]);
    expect(paths(conversation({ permissions: { default: "ask", approvalMode: "custom", handler: "acme-approvals" } }), { ...withApprovals, approvalModes: ["custom"] }))
      .toEqual([]);
  });

  it("allows only catalog servers and their approved tools", () => {
    expect(paths(conversation({ mcpServers: [{ server: "docs-search", tools: ["search"] }] }))).toEqual([]);
    expect(paths(conversation({ mcpServers: [{ server: "unknown", tools: ["search"] }] }))).toEqual(["mcpServers.0.server"]);
    expect(paths(conversation({ mcpServers: [{ server: "docs-search", tools: ["search", "delete_all"] }] }))).toEqual(["mcpServers.0.tools.1"]);
    expect(paths(conversation({ mcpServers: [{ server: "docs-search", tools: ["search"] }] }), base)).toEqual(["mcpServers.0.server"]);
  });
});

describe("hosting policy checks", () => {
  const open: ExecutionPolicy = {
    ...base,
    hosting: {
      modes: ["isolated", "shared", "promotable", "orchestrator"],
      workers: { maxConcurrentPerSession: 3, maxPerSession: 10, allowInheritedAuthority: false },
      crafting: { templates: { general: { toolBindings: [], builtinTools: ["files"], models: ["m"], approvalModes: ["manual"], maxDurationSeconds: 600, sizes: ["small"] } } },
    },
  };
  const check = (hosting: HarnessDefinition["hosting"], policy: ExecutionPolicy = open) =>
    hostingPolicyViolations(conversation(hosting ? { hosting } : {}), policy).map((p) => `${p.code} ${p.path}`);

  it("rejects modes the policy does not allow with hosting_mode_not_allowed", () => {
    expect(check(undefined, base)).toEqual([]);
    expect(check({ mode: "shared" }, base)).toEqual(["hosting_mode_not_allowed hosting.mode"]);
    expect(check({ mode: "orchestrator", workers: { harnesses: ["coder"] } }, base)).toEqual(["hosting_mode_not_allowed hosting.mode"]);
    expect(check(undefined, { ...base, hosting: { modes: ["shared"] } })).toEqual(["hosting_mode_not_allowed hosting.mode"]);
    expect(hostingPolicyViolations({ hosting: { mode: "shared" } }, base)).toEqual([]);
  });

  it("requires a transport the mode supports", () => {
    expect(transportsForMode("isolated")).toEqual(["direct", "github"]);
    expect(transportsForMode("shared")).toEqual(["direct"]);
    expect(check({ mode: "shared" }, { ...open, hosting: { ...open.hosting, transports: ["github"] } })).toEqual(["transport_not_allowed hosting.mode"]);
    expect(check({ mode: "isolated" }, { ...open, hosting: { ...open.hosting, transports: ["github"] } })).toEqual([]);
  });

  it("checks promotion size and approval against the ceilings", () => {
    expect(check({ mode: "promotable" })).toEqual([]);
    expect(check({ mode: "promotable", promotion: { size: "xl" } })).toEqual(["policy_rejected hosting.promotion.size"]);
    expect(check({ mode: "promotable", promotion: { approval: "allow" } })).toEqual(["policy_rejected hosting.promotion.approval"]);
    expect(check({ mode: "promotable", promotion: { approval: "allow" } }, { ...open, hosting: { ...open.hosting, promotion: { approval: ["ask", "allow"] } } })).toEqual([]);
    expect(check({ mode: "promotable" }, { ...open, hosting: { ...open.hosting, promotion: { approval: ["allow"] } } })).toEqual(["policy_rejected hosting.promotion.approval"]);
  });

  it("checks worker sizes, inherited authority, and crafting templates", () => {
    expect(check({ mode: "orchestrator", workers: { harnesses: ["coder"], sizes: ["small", "xl"] } })).toEqual(["policy_rejected hosting.workers.sizes.1"]);
    expect(check({ mode: "orchestrator", workers: { harnesses: ["coder"], humanAuthority: "inherit" } })).toEqual(["policy_rejected hosting.workers.humanAuthority"]);
    const inheriting = { ...open, hosting: { ...open.hosting, workers: { allowInheritedAuthority: true } } };
    expect(check({ mode: "orchestrator", workers: { harnesses: ["coder"], humanAuthority: "inherit" } }, inheriting)).toEqual([]);
    expect(check({ mode: "orchestrator", workers: { harnesses: [], crafting: { template: "general" } } })).toEqual([]);
    expect(check({ mode: "orchestrator", workers: { harnesses: [], crafting: { template: "missing" } } })).toEqual(["policy_rejected hosting.workers.crafting.template"]);
  });

  it("resolves the harness's effective hosting within the ceilings", () => {
    const orchestrator = effectiveHarnessHosting(
      conversation({ hosting: { mode: "orchestrator", workers: { harnesses: ["coder"], maxConcurrent: 8, sizes: ["small", "xl"], sharedStorage: "session", crafting: { template: "general" } } } }),
      open,
    );
    expect(orchestrator.workers).toEqual({
      harnesses: ["coder"], sizes: ["small"], maxConcurrent: 3, maxPerSession: 10, sharedStorage: "session", humanAuthority: "none", craftingTemplate: "general",
    });
    expect(effectiveHarnessHosting(conversation({ hosting: { mode: "orchestrator", workers: { harnesses: ["coder"], maxPerSession: 2 } } }), open).workers)
      .toMatchObject({ sizes: ["small"], maxConcurrent: 2, maxPerSession: 2 });
    expect(effectiveHarnessHosting(conversation({ hosting: { mode: "promotable" } }), open).promotion).toEqual({ size: "small", approval: "ask" });
    const plain = effectiveHarnessHosting(conversation({
      permissions: { default: "ask", approvalMode: "assisted" },
      mcpServers: [{ server: "docs", tools: ["search", "write"] }, { server: "gone", tools: ["x1"] }],
      hosting: { mode: "isolated", handoffs: [{ harness: "coder", description: "Code changes", history: "summary" }, { harness: "triage", description: "Back to triage" }] },
    }), { ...open, mcpServers: { docs: { url: "https://mcp.example.com", tools: ["search"] } } });
    expect(plain).toEqual({
      mode: "isolated",
      declared: true,
      approvalMode: "assisted",
      handoffs: [
        { harness: "coder", description: "Code changes", history: "summary", approval: "ask" },
        { harness: "triage", description: "Back to triage", approval: "ask" },
      ],
      mcpServers: [{ server: "docs", tools: ["search"] }],
    });
    expect(effectiveHarnessHosting(conversation(), base)).toEqual({ mode: "isolated", declared: false, approvalMode: "manual", handoffs: [], mcpServers: [] });
  });
});

describe("conversation profile checks", () => {
  const profile = { id: "node-ts-agent", inProcessBindings: ["host:lookup"], permissionHandlers: ["acme-approvals"] };
  const tools: HarnessDefinition["tools"] = [
    { name: "lookup", kind: "host", description: "Look up.", binding: "host:lookup" },
    { name: "fetch_record", kind: "host", description: "Fetch.", binding: "host:fetch" },
  ];

  it("runs only in-process-safe host bindings on the shared worker", () => {
    expect(hostedProfileViolations(conversation({ tools, hosting: { mode: "shared" } }), profile).map((p) => p.path)).toEqual(["tools.1.binding"]);
    expect(hostedProfileViolations(conversation({ tools, hosting: { mode: "orchestrator", workers: { harnesses: ["coder"] } } }), profile).map((p) => p.path))
      .toEqual(["tools.1.binding"]);
    expect(hostedProfileViolations(conversation({ tools, hosting: { mode: "promotable" } }), profile)).toEqual([]);
    expect(hostedProfileViolations(conversation({ tools }), profile)).toEqual([]);
    expect(hostedProfileViolations(conversation({ tools, hosting: { mode: "shared" } }), { id: "node-ts-agent" }).map((p) => p.path))
      .toEqual(["tools.0.binding", "tools.1.binding"]);
  });

  it("requires the profile to provide a custom permission handler", () => {
    const custom = (handler: string) => conversation({ permissions: { default: "ask", approvalMode: "custom", handler } });
    expect(hostedProfileViolations(custom("acme-approvals"), profile)).toEqual([]);
    expect(hostedProfileViolations(custom("other"), profile).map((p) => p.path)).toEqual(["permissions.handler"]);
    expect(hostedProfileViolations(custom("acme-approvals"), { id: "node-ts-agent" }).map((p) => p.path)).toEqual(["permissions.handler"]);
  });
});
