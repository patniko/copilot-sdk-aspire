import { describe, expect, it } from "vitest";
import { HarnessDefinition, SharedSessionDefinition, type ExecutionPolicy, type HarnessSnapshot } from "@copilot-agent/contracts";
import { canonicalJson, HttpError, policyDigest, sha256Hex } from "@copilot-agent/service-defaults";
import { approvalPlan, SharedAdmission } from "../../src/session-host/src/admission.js";
import { SharedConfiguration } from "../../src/session-host/src/configuration.js";
import { sharedAdmission, sharedHarness, sharedRegistry } from "../integration/fixtures/shared-harness.js";

const failure = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => undefined, (reason: unknown) => reason);
  expect(error, "expected a refusal").toBeInstanceOf(HttpError);
  const http = error as HttpError;
  return { status: http.statusCode, code: http.code, details: http.details as Record<string, unknown> | undefined, message: http.message };
};
const child = (): HarnessSnapshot => {
  const definition = HarnessDefinition.parse({
    ...sharedHarness("unused").definition, name: "batch-child", interaction: undefined, hosting: undefined,
    instructions: "Batch work.", description: "A batch harness.",
  });
  return { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
};
const delegating = () => sharedHarness("coordinator", {
  tools: [{ name: "delegate_job", kind: "host", binding: "shared:delegate-job", description: "Delegate container work." }],
});

describe("shared admission", () => {
  it("snapshots the admitted harness with its effective model, limits, and delegation targets", async () => {
    const coordinator = delegating();
    const registry = await sharedRegistry([coordinator, child(), sharedHarness("plain")],
      { maxInferenceTokensPerJob: 50_000, maxDurationSeconds: 120 });
    const admission = sharedAdmission(registry, { sessionLimits: { tokenBudget: 80_000, turnTokenBudget: 60_000, maxTurnSeconds: 300 }, delegation: ["batch-child", "missing", "plain"] });
    const definition = await admission.admit("alice", { harness: "coordinator", label: "" });
    expect(definition.model).toBe("fixture");
    expect(definition.limits).toMatchObject({ tokenBudget: 50_000, turnTokenBudget: 50_000, maxTurnSeconds: 120 });
    expect(definition.harness).toMatchObject({
      name: "coordinator", version: "1.0.0", digest: coordinator.digest, mode: "shared",
      policyDigest: policyDigest(registry.policies.base),
    });
    expect(definition.harness?.definition).toEqual(coordinator.definition);
    // Only published batch harnesses are delegation targets; a conversation harness or a missing name is skipped.
    expect(definition.delegation?.harnesses.map((ref) => ref.name)).toEqual(["batch-child"]);
    expect((await admission.admit("alice", { harness: "plain", label: "" })).delegation).toBeUndefined();
    expect(SharedSessionDefinition.parse(JSON.parse(JSON.stringify(definition)))).toEqual(definition);
  });

  it("refuses unknown, batch, isolated, disallowed, and unavailable harnesses with explicit errors", async () => {
    const registry = await sharedRegistry([
      sharedHarness("plain"),
      sharedHarness("isolated", { hosting: undefined }),
      sharedHarness("target"),
      sharedHarness("handing-off", { hosting: { mode: "shared", handoffs: [{ harness: "target", description: "Target." }] } }),
      child(),
    ], {}, { plain: { hosting: { modes: ["isolated"] } } });
    const admission = sharedAdmission(registry);
    expect(await failure(admission.admit("alice", { harness: "missing", label: "" }))).toMatchObject({ status: 404, code: "harness_not_found" });
    expect(await failure(admission.admit("alice", { harness: "isolated", version: "9.9.9", label: "" }))).toMatchObject({ status: 404 });
    expect(await failure(admission.admit("alice", { harness: "batch-child", label: "" }))).toMatchObject({ status: 422, code: "policy_rejected" });
    expect(await failure(admission.admit("alice", { harness: "plain", label: "" }))).toMatchObject({
      status: 422, code: "hosting_mode_not_allowed", details: { path: "hosting.mode" },
    });
    expect(await failure(admission.admit("alice", { harness: "isolated", label: "" }))).toMatchObject({
      status: 409, code: "hosting_unavailable", details: { prerequisite: { kind: "host", name: "isolated-host" } },
    });
    expect(await failure(admission.admit("alice", { harness: "handing-off", label: "" }))).toMatchObject({
      status: 409, code: "hosting_unavailable", details: { prerequisite: { kind: "feature", name: "handoffs" } },
    });
  });

  it("refuses unapproved MCP servers and tools, reserved names, unknown handlers, and approval modes policy disallows", async () => {
    const catalog = { "docs-search": { url: "https://mcp.example.com/docs", tools: ["search"] } };
    const registry = await sharedRegistry([
      sharedHarness("unknown-server", { mcpServers: [{ server: "other", tools: ["search"] }] }),
      sharedHarness("unknown-tool", { mcpServers: [{ server: "docs-search", tools: ["admin_reset"] }] }),
      sharedHarness("reserved", { tools: [{ name: "web_fetch", kind: "host", binding: "shared:get-job", description: "Shadow." }] }),
      sharedHarness("not-in-process", { tools: [{ name: "stats", kind: "host", binding: "python:stats", description: "Stats." }] }),
      sharedHarness("custom", { permissions: { default: "ask", approvalMode: "custom", handler: "missing-handler" } }),
      sharedHarness("allow-all", { permissions: { default: "ask", approvalMode: "allow-all" } }),
      sharedHarness("assisted", { permissions: { default: "ask", approvalMode: "assisted", judgeModel: "fixture" } }),
    ], { mcpServers: catalog, approvalModes: ["manual", "assisted", "custom"], permissionHandlers: ["missing-handler"], allowedModels: ["fixture"] });
    const admission = sharedAdmission(registry);
    expect(await failure(admission.admit("alice", { harness: "unknown-server", label: "" }))).toMatchObject({ status: 422, code: "policy_rejected", details: { path: "mcpServers.0.server" } });
    expect(await failure(admission.admit("alice", { harness: "unknown-tool", label: "" }))).toMatchObject({ status: 422, details: { path: "mcpServers.0.tools.0" } });
    expect(await failure(admission.admit("alice", { harness: "reserved", label: "" }))).toMatchObject({ status: 422, details: { path: "tools.0.name" } });
    expect(await failure(admission.admit("alice", { harness: "not-in-process", label: "" }))).toMatchObject({ status: 422, details: { path: "tools.0.binding" } });
    expect(await failure(admission.admit("alice", { harness: "allow-all", label: "" }))).toMatchObject({
      status: 422, code: "policy_rejected", details: { path: "permissions.approvalMode" },
    });
    // The profile does not provide the handler, so evaluation refuses it before the worker's own check.
    expect(await failure(admission.admit("alice", { harness: "custom", label: "" }))).toMatchObject({ status: 422, details: { path: "permissions.handler" } });
    expect((await admission.admit("alice", { harness: "assisted", label: "" })).harness?.mode).toBe("shared");
  });

  it("requires the worker to implement the selected custom handler", async () => {
    const registry = await sharedRegistry([sharedHarness("custom", { permissions: { default: "ask", approvalMode: "custom", handler: "workspace-drafts" } })],
      { approvalModes: ["manual", "custom"], permissionHandlers: ["workspace-drafts"] });
    expect((await sharedAdmission(registry).admit("alice", { harness: "custom", label: "" })).harness?.name).toBe("custom");
    const without = new SharedAdmission({
      configuration: SharedConfiguration.fixed(registry), sessionLimits: (await sharedAdmission(registry).admit("alice", { harness: "custom", label: "" })).limits,
      delegationHarnesses: [], permissionHandlers: new Set(),
    });
    expect(await failure(without.admit("alice", { harness: "custom", label: "" }))).toMatchObject({ status: 422, details: { path: "permissions.handler" } });
  });

  it("re-checks a retained session against current policy before activation and connection", async () => {
    const harness = sharedHarness("plain");
    const registry = await sharedRegistry([harness]);
    const admitted = await sharedAdmission(registry).admit("alice", { harness: "plain", label: "" });
    const plan = await sharedAdmission(registry).activation(admitted, "alice");
    expect(plan).toMatchObject({ model: "fixture", harness: { name: "plain", digest: harness.digest }, approval: { mode: "manual", initial: "manual", available: ["manual"] } });
    expect(await failure(sharedAdmission(registry).activation(SharedSessionDefinition.parse({ model: "fixture", instructions: "Legacy.", allowedHarnesses: [], limits: admitted.limits }))))
      .toMatchObject({ status: 409, code: "invalid_state" });
    const tampered = { ...admitted, harness: { ...admitted.harness!, definition: { ...admitted.harness!.definition!, instructions: "Changed." } } };
    expect(await failure(sharedAdmission(registry).activation(tampered))).toMatchObject({ status: 409, code: "invalid_state" });
    const narrowed = await sharedRegistry([harness], { hosting: { modes: ["isolated"] } });
    expect(await failure(sharedAdmission(narrowed).activation(admitted))).toMatchObject({ status: 422, code: "hosting_mode_not_allowed" });
    const revoked = await sharedRegistry([harness], { allowedModels: ["fixture", "other"] });
    expect(await failure(sharedAdmission(revoked).activation({ ...admitted, model: "other-model" }))).toMatchObject({ status: 409, code: "policy_revoked" });
    await sharedAdmission(registry).connectable(admitted, "direct", "alice");
    expect(await failure(sharedAdmission(registry).connectable(admitted, "github", "alice"))).toMatchObject({ status: 422, code: "transport_unsupported" });
    const githubOnly = await sharedRegistry([harness], { hosting: { modes: ["isolated", "shared"], transports: ["github"] } });
    expect(await failure(sharedAdmission(githubOnly).connectable(admitted, "direct", "alice"))).toMatchObject({ status: 422, code: "transport_not_allowed" });
  });

  it("offers attached clients only the runtime approval modes policy allows", () => {
    const harness = (permissions?: HarnessDefinition["permissions"]) => sharedHarness("modes", permissions ? { permissions } : {}).definition;
    const policy = (approvalModes?: ExecutionPolicy["approvalModes"]) => ({ approvalModes }) as ExecutionPolicy;
    expect(approvalPlan(harness(), policy())).toEqual({ mode: "manual", initial: "manual", available: ["manual"] });
    expect(approvalPlan(harness({ default: "ask", approvalMode: "assisted", judgeModel: "fixture" }), policy(["manual", "assisted"])))
      .toEqual({ mode: "assisted", initial: "assisted", available: ["manual", "assisted"], judgeModel: "fixture" });
    expect(approvalPlan(harness({ default: "ask" }), policy(["manual", "assisted", "allow-all", "custom"])))
      .toEqual({ mode: "manual", initial: "manual", available: ["manual", "assisted", "allow-all"] });
    // A custom handler stays in charge: allow-all would let the runtime approve without consulting it.
    expect(approvalPlan(harness({ default: "ask", approvalMode: "custom", handler: "workspace-drafts" }), policy(["manual", "allow-all", "custom"])))
      .toEqual({ mode: "custom", initial: "manual", available: ["manual"], handler: "workspace-drafts" });
    expect(approvalPlan(harness(), policy(["custom"]))).toEqual({ mode: "manual", initial: "manual", available: ["manual"] });
    expect(approvalPlan(harness(), policy(["assisted"]))).toEqual({ mode: "manual", initial: "assisted", available: ["assisted"] });
  });

  it("serves new sessions from reloaded configuration and keeps the last valid one when an edit is invalid", async () => {
    const first = await sharedRegistry([sharedHarness("plain")]);
    const second = await sharedRegistry([sharedHarness("plain"), sharedHarness("added")]);
    const loads = [first, second];
    const events: string[] = [];
    let fail = false;
    const configuration = new SharedConfiguration(async () => {
      if (fail) throw new Error("invalid edit");
      return loads.shift() ?? second;
    }, (event) => events.push(event), 0);
    expect((await configuration.current()).harnesses.has("added")).toBe(false);
    expect((await configuration.current()).harnesses.has("added")).toBe(true);
    fail = true;
    expect((await configuration.current()).harnesses.has("added")).toBe(true);
    expect(events).toEqual(["shared.configuration_reload_failed"]);
    await expect(new SharedConfiguration(async () => { throw new Error("invalid"); }).current()).rejects.toThrow("invalid");
  });
});
