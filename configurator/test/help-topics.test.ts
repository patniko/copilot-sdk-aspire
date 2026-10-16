import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { help } from "../src/help.js";

const sourceRoot = join(import.meta.dirname, "..", "src");

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? sources(join(directory, entry.name)) : Promise.resolve(entry.name.endsWith(".tsx") ? [join(directory, entry.name)] : []))),
  );
  return nested.flat();
}

describe("help topics", () => {
  it("has an entry for every help topic the UI references, so no ? button silently disappears", async () => {
    const referenced = new Set<string>();
    for (const file of await sources(sourceRoot)) {
      for (const match of (await readFile(file, "utf8")).matchAll(/\b(?:help|topic)="([^"]+)"/g)) referenced.add(match[1]!);
    }
    expect([...referenced].filter((topic) => !help[topic])).toEqual([]);
    for (const topic of ["hosting.mode", "permissions.approvalMode", "mcpServers", "policy.hosting.modes", "policy.mcpServers.auth"]) {
      expect(referenced.has(topic)).toBe(true);
    }
  });
});
