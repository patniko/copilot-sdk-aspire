import { describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../server/process.js", () => ({
  capture,
  parseJsonOutput: (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  },
}));

const { StatusService } = await import("../server/status.js");

describe("Azure discovery", () => {
  const status = new StatusService({ root: ".", aspireEnv: () => ({}) });
  const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

  it("lists enabled subscriptions by name", async () => {
    capture.mockResolvedValueOnce(
      ok([
        { id: "2", name: "Zeta", tenantId: "t", isDefault: false, state: "Enabled" },
        { id: "1", name: "Alpha", tenantId: "t", isDefault: true, state: "Enabled" },
        { id: "3", name: "Off", tenantId: "t", state: "Disabled" },
      ]),
    );
    expect((await status.subscriptions()).map((s) => s.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("lists only physical regions, grouped by geography", async () => {
    capture.mockResolvedValueOnce(
      ok([
        { name: "westus2", displayName: "West US 2", metadata: { regionType: "Physical", geographyGroup: "US" } },
        { name: "eastus", displayName: "East US", metadata: { regionType: "Physical", geographyGroup: "US" } },
        { name: "northeurope", displayName: "North Europe", metadata: { regionType: "Physical", geographyGroup: "Europe" } },
        { name: "unitedstates", displayName: "United States", metadata: { regionType: "Logical" } },
      ]),
    );
    expect((await status.locations()).map((l) => l.name)).toEqual(["northeurope", "eastus", "westus2"]);
  });

  it("reports resource group failures", async () => {
    capture.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "ERROR: Please run 'az login'" });
    await expect(status.resourceGroups("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/az login/);
  });
});
