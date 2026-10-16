import { describe, expect, it } from "vitest";
import { SharedWorkerLimits } from "@copilot-agent/contracts";
import { residencyVictim, type ResidencyCandidate } from "../../src/session-host/src/residency.js";

const limits = SharedWorkerLimits.parse({ residentSessions: 3, residentSessionsPerHarness: 2, harnesses: { solo: { residentSessions: 1 } } });
const resident = (id: string, harness: string, lastActivity: number, idle = true): ResidencyCandidate => ({ id, harness, lastActivity, idle });
const reservations = (entries: ResidencyCandidate[]) => new Map(entries.map((entry) => [entry.id, entry.harness]));

describe("shared worker residency", () => {
  it("makes room within a harness at its own ceiling by evicting that harness's least recently active idle session", () => {
    const residents = [resident("a1", "alpha", 1), resident("a2", "alpha", 2), resident("b1", "beta", 0)];
    expect(residencyVictim(limits, reservations(residents), residents, "a3", "alpha")).toBe("a1");
    const busy = [resident("a1", "alpha", 1, false), resident("a2", "alpha", 2), resident("b1", "beta", 0)];
    expect(residencyVictim(limits, reservations(busy), busy, "a3", "alpha")).toBe("a2");
  });

  it("never displaces another harness's sessions when a busy harness is at its ceiling", () => {
    const residents = [resident("a1", "alpha", 1, false), resident("a2", "alpha", 2, false), resident("b1", "beta", 0)];
    expect(() => residencyVictim(limits, reservations(residents), residents, "a3", "alpha"))
      .toThrow(expect.objectContaining({ code: "quota_exceeded", message: expect.stringContaining("for this harness") }));
    // Another harness under its own ceiling still fits by taking the oldest idle slot.
    expect(residencyVictim(limits, reservations(residents), residents, "b2", "beta")).toBe("b1");
  });

  it("uses per-harness overrides, ignores the activating session itself, and fits without eviction when there is room", () => {
    const solo = [resident("s1", "solo", 5)];
    expect(residencyVictim(limits, reservations(solo), solo, "s2", "solo")).toBe("s1");
    expect(residencyVictim(limits, reservations(solo), solo, "s1", "solo")).toBeUndefined();
    expect(residencyVictim(limits, reservations(solo), solo, "a1", "alpha")).toBeUndefined();
  });

  it("counts sessions that are still opening, and refuses when the worker is full of busy sessions", () => {
    const opening = new Map([["a1", "alpha"], ["a2", "alpha"]]);
    expect(() => residencyVictim(limits, opening, [], "a3", "alpha")).toThrow(expect.objectContaining({ code: "quota_exceeded" }));
    const full = [resident("a1", "alpha", 1, false), resident("b1", "beta", 2, false), resident("c1", "gamma", 3, false)];
    expect(() => residencyVictim(limits, reservations(full), full, "d1", "delta"))
      .toThrow(expect.objectContaining({ code: "quota_exceeded", message: "The shared worker is at resident capacity." }));
  });
});
