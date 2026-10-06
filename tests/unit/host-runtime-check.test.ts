import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_GUARD_DIAGNOSTIC, verifyOwnerGuard, type ProbeRuntime } from "../../src/agent-host/src/runtime-check.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "host-qualification-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("runtime owner-guard qualification", () => {
  it("requires the exact structured validation failure, not any startup failure", async () => {
    const expected = Object.assign(new Error(OWNER_GUARD_DIAGNOSTIC), { code: -32603 });
    const client: ProbeRuntime = { start: async () => {}, stop: vi.fn(async () => []),
      startAhpHost: vi.fn(async () => { throw expected; }) };
    await expect(verifyOwnerGuard(directory, () => client)).resolves.toBeUndefined();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
    await expect(verifyOwnerGuard(directory, () => ({
      ...client, startAhpHost: async () => { throw new Error("Connection refused"); },
    }))).rejects.toThrow(/could not be verified/);
  });

  it("disposes an old runtime that silently ignores expected-owner configuration", async () => {
    const dispose = vi.fn(async () => {});
    const stop = vi.fn(async () => []);
    await expect(verifyOwnerGuard(directory, () => ({
      start: async () => {}, stop, startAhpHost: async () => ({ dispose }),
    }))).rejects.toThrow(/ignores expected-owner/);
    expect(dispose).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });
});
