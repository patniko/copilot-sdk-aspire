import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { it } from "vitest";
import { verifyOwnerGuard } from "../../src/agent-host/src/runtime-check.js";
import { localRuntimeArtifacts } from "./artifacts.js";

it("enforces expected-owner configuration through the compiled hosting-library path", async () => {
  const { launcher, library } = await localRuntimeArtifacts();
  const root = await mkdtemp(join(tmpdir(), "copilot-owner-guard-test-"));
  try {
    await verifyOwnerGuard(root, (home) => {
      const env: Record<string, string> = {
        HOME: home,
        COPILOT_RUNTIME_PROVIDER_LIB: library,
        COPILOT_AHP_EXPECTED_OWNER: "not-json",
      };
      for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        const value = process.env[key];
        if (value) env[key] = value;
      }
      return new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: launcher, env }),
        mode: "empty",
        baseDirectory: home,
        useLoggedInUser: false,
        logLevel: "error",
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
