import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnvironment } from "../server/environment.js";

const keys = ["CONFIGURATOR_TEST_FROM_FILE", "CONFIGURATOR_TEST_EXPLICIT"] as const;

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

describe("local environment loading", () => {
  it("loads .env.local without replacing explicit environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "configurator-env-"));
    try {
      await writeFile(join(root, ".env.local"), [
        "CONFIGURATOR_TEST_FROM_FILE=loaded",
        "CONFIGURATOR_TEST_EXPLICIT=from-file",
        "",
      ].join("\n"));
      process.env.CONFIGURATOR_TEST_EXPLICIT = "explicit";

      await loadLocalEnvironment(root);

      expect(process.env.CONFIGURATOR_TEST_FROM_FILE).toBe("loaded");
      expect(process.env.CONFIGURATOR_TEST_EXPLICIT).toBe("explicit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a missing .env.local file", async () => {
    const root = await mkdtemp(join(tmpdir(), "configurator-env-"));
    try {
      await mkdir(join(root, "empty"));
      await expect(loadLocalEnvironment(join(root, "empty"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
