import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArtifactPath, SHARED_WORKER_BINDINGS, SHARED_WORKER_FEATURES, SharedConnection, SharedConnectionRequest, SharedSessionCreation,
  SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits, sharedHarnessLimits,
} from "@copilot-agent/contracts";
import { loadHarnesses } from "@copilot-agent/service-defaults";

const examples = join(import.meta.dirname, "..", "..", "examples", "customer-config");

describe("shared deployment contracts", () => {
  it("stores the admitted harness snapshot while keeping ledger fields at the top level", async () => {
    const harnesses = await loadHarnesses(examples);
    const coordinator = harnesses.get("hybrid-coordinator")![0]!;
    const child = harnesses.get("text-summarizer")![0]!;
    const parsed = SharedSessionDefinition.parse({
      model: coordinator.definition.model.preferred,
      limits: SharedSessionLimits.parse({}),
      harness: {
        name: coordinator.definition.name, version: coordinator.definition.version, digest: coordinator.digest,
        mode: "shared", definition: coordinator.definition,
      },
      delegation: { harnesses: [{ name: child.definition.name, version: child.definition.version, digest: child.digest }] },
    });
    expect(parsed.harness?.definition?.instructions).toBe(coordinator.definition.instructions);
    expect(parsed.delegation?.harnesses[0]!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Container sessions may keep the snapshot elsewhere; legacy coordinator sessions still parse.
    expect(SharedSessionDefinition.safeParse({ model: "m", limits: SharedSessionLimits.parse({}), harness: { name: "a-b", version: "1.0.0", digest: coordinator.digest, mode: "isolated" } }).success).toBe(true);
    expect(SharedSessionDefinition.parse({ model: "m", instructions: "Coordinator", allowedHarnesses: [], limits: SharedSessionLimits.parse({}) }).harness).toBeUndefined();
    expect(SharedSessionDefinition.safeParse({ model: "m", limits: SharedSessionLimits.parse({}), extra: true }).success).toBe(false);
  });

  it("names a harness on creation and a transport on connection", () => {
    expect(SharedSessionCreation.safeParse({}).success).toBe(false);
    expect(SharedSessionCreation.parse({ harness: "hybrid-coordinator" })).toEqual({ harness: "hybrid-coordinator", label: "" });
    expect(SharedSessionCreation.safeParse({ harness: "Not A Slug" }).success).toBe(false);
    expect(SharedConnectionRequest.parse({})).toEqual({ transport: "direct" });
    expect(SharedConnectionRequest.parse({ transport: "github" }).transport).toBe("github");
    expect(SharedConnectionRequest.safeParse({ transport: "relay" }).success).toBe(false);
    expect(SharedConnection.safeParse({
      sessionId: "00000000-0000-4000-8000-000000000000", destination: "shared", transport: "github", ahpSessionId: "x",
      url: "ws://127.0.0.1/sessions/x", token: "t".repeat(32), expiresAt: new Date().toISOString(),
      serverKey: { keyId: "k", algorithm: "x25519-sealedbox", publicKey: "p" },
    }).success).toBe(false);
  });

  it("bounds every harness by its own per-harness ceilings within the worker limits", () => {
    const limits = SharedWorkerLimits.parse({ residentSessions: 4, activeTurns: 3, queuedTurns: 10, harnesses: { busy: { activeTurns: 2, residentSessions: 9 } } });
    expect(sharedHarnessLimits(limits, "quiet")).toEqual({ residentSessions: 4, activeTurns: 1, queuedTurns: 10 });
    expect(sharedHarnessLimits(limits, "busy")).toEqual({ residentSessions: 4, activeTurns: 2, queuedTurns: 10 });
    expect(sharedHarnessLimits(SharedWorkerLimits.parse({}), "any")).toEqual({ residentSessions: 12, activeTurns: 1, queuedTurns: 24 });
    expect(SharedWorkerLimits.safeParse({ harnesses: { "Not A Slug": {} } }).success).toBe(false);
    expect(SharedWorkerLimits.safeParse({ harnesses: { ok: { activeTurns: 0 } } }).success).toBe(false);
  });

  it("advertises the features and in-process bindings the shared worker implements", () => {
    expect([...SHARED_WORKER_FEATURES].sort()).toEqual(["approval-modes", "custom-approval", "handoffs", "remote-mcp"]);
    expect(SHARED_WORKER_BINDINGS.every((binding) => binding.startsWith("shared:"))).toBe(true);
  });

  it("rejects unsupported controls and enforces finite bounds", () => {
    expect(SharedWorkerLimits.safeParse({ warmContainers: 2 }).success).toBe(false);
    expect(SharedWorkerLimits.safeParse({ activeTurns: 0 }).success).toBe(false);
    expect(SharedSessionLimits.safeParse({ maxJobs: 101 }).success).toBe(false);
    expect(SharedWorkerLimits.parse({ executionContainers: 0 }).executionContainers).toBe(0);
  });

  it("accepts only bounded portable artifact paths", () => {
    expect(ArtifactPath.parse("reports/result.json")).toBe("reports/result.json");
    for (const path of ["../escape", "/absolute", "C:\\escape", ".hidden", "report.", "CON", "one//two", "one/./two"]) {
      expect(ArtifactPath.safeParse(path).success, path).toBe(false);
    }
  });
});
