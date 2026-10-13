import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactPath, SharedSessionDefinition, SharedSessionLimits, SharedWorkerLimits } from "@copilot-agent/contracts";
import { loadHarnesses } from "@copilot-agent/service-defaults";

describe("shared deployment contracts", () => {
  it("accepts the registry's actual prefixed harness digests", async () => {
    const harnesses = await loadHarnesses(join(import.meta.dirname, "..", "..", "examples", "customer-config"));
    const harness = harnesses.get("text-summarizer")![0]!;
    const parsed = SharedSessionDefinition.parse({
      model: harness.definition.model.preferred, instructions: "Coordinator",
      allowedHarnesses: [{ name: harness.definition.name, version: harness.definition.version, digest: harness.digest }],
      limits: SharedSessionLimits.parse({}),
    });
    expect(parsed.allowedHarnesses[0]!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
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
