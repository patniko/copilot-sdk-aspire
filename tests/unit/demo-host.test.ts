import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DemoHostSettings } from "@copilot-agent/contracts";
import { admitHostedHarness, loadHarnesses, loadPolicy, loadProfiles, signSessionCapability, verifyCapability, verifyInferenceCapability } from "@copilot-agent/service-defaults";
import { randomUUID } from "node:crypto";
import { buildSessionOptions, RESULT_CONTRACT } from "../../src/harness-hosting/src/session-config.js";
import { hostPermissionHandler, hostToolGuard } from "../../src/agent-host/src/policy.js";
import { Admission } from "../../src/agent-api/src/admission.js";
import { OwnerConfiguration } from "../../src/agent-host/src/protocol.js";

const root = join(import.meta.dirname, "..", "..");
const customerConfigRoot = join(root, "examples", "customer-config");
const [harnesses, policy, profiles] = await Promise.all([
  loadHarnesses(customerConfigRoot),
  loadPolicy(customerConfigRoot),
  loadProfiles(root),
]);
const harness = harnesses.get("interactive-demo")![0]!;

describe("opt-in demo host", () => {
  it("keeps GitHub-native execution independent of managed factory and provider settings", () => {
    const native = {
      execution: "github-native", transport: "github", owner: "alice", ownerUserId: 1,
      computeId: randomUUID(), dataDirectory: "workspace", githubToken: "test-credential".repeat(3),
    };
    expect(OwnerConfiguration.safeParse(native).success).toBe(true);
    expect(OwnerConfiguration.safeParse({ ...native, gatewayUrl: "https://gateway.example" }).success).toBe(false);
    expect(OwnerConfiguration.safeParse({ ...native, transport: "both" }).success).toBe(false);
    expect(OwnerConfiguration.safeParse({ ...native, githubToken: undefined }).success).toBe(false);
  });
  it("requires an owner and never defaults to public hosting", () => {
    expect(DemoHostSettings.parse({}).transport).toBe("disabled");
    expect(DemoHostSettings.safeParse({ transport: "both" }).success).toBe(false);
    expect(DemoHostSettings.safeParse({ transport: "direct", owner: "alice", harness: "../outside" }).success).toBe(false);
  });

  it("admits conversation harnesses separately from jobs", () => {
    expect(admitHostedHarness(harness, profiles, policy).model).toBe("grok-4.6");
    expect(() => new Admission({ harnesses, profiles, policies: { base: policy, overrides: new Map() } }).admit({
      harness: { name: "interactive-demo" }, input: {},
    })).toThrow(/Conversation harnesses/);
    expect(() => admitHostedHarness(harnesses.get("dataset-analyst")![0]!, profiles, policy)).toThrow(/conversation harness/);
  });

  it("keeps the batch result contract out of a conversation", () => {
    const conversation = buildSessionOptions(harness.definition, [], "skills", "conversation");
    expect(conversation.systemMessage).toMatchObject({ content: harness.definition.instructions });
    expect(JSON.stringify(conversation)).not.toContain(RESULT_CONTRACT);
    expect(JSON.stringify(buildSessionOptions(harness.definition, [], "skills"))).toContain("Result contract");
  });

  it("vetoes unadvertised tools and denied kinds before human approval", () => {
    const definition = { ...harness.definition, permissions: { default: "deny" as const } };
    expect(hostToolGuard(definition, ["builtin:bash"], "bash")?.permissionDecision).toBe("deny");
    expect(hostToolGuard(harness.definition, ["builtin:bash"], "client:bash")?.permissionDecision).toBe("deny");
    expect(hostToolGuard(harness.definition, ["builtin:bash"], "bash")?.permissionDecision).toBe("ask");
    expect(hostToolGuard(harness.definition, [], "web_fetch")?.permissionDecision).toBe("deny");
  });

  it("never fabricates approval for ask permissions", async () => {
    const handler = hostPermissionHandler(harness.definition);
    expect(await handler({
      kind: "shell", fullCommandText: "echo demo", intention: "demo",
      canOfferSessionApproval: false, commands: [], hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [],
    }, { sessionId: randomUUID() }))
      .toEqual({ kind: "no-result" });
  });

  it("uses separate, validated session tokens rather than fake jobs", async () => {
    const key = "test-only-signing-key-".repeat(4);
    const id = randomUUID();
    const token = await signSessionCapability(key, {
      sub: id, session: id, epoch: randomUUID(), jti: randomUUID(), prn: "alice",
      mdl: ["grok-4.6"], tok: 1000, expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await verifyInferenceCapability(key, token)).toMatchObject({ kind: "hosted-session", session: id });
    await expect(verifyCapability(key, token)).rejects.toThrow();
    await expect(verifyInferenceCapability("other-key".repeat(8), token)).rejects.toThrow();
  });
});
