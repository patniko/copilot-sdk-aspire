import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.env.HYBRID_CONTAINER_TESTS !== "1")("rejects unsafe output trees in the actual Linux executor image", async () => {
  const fixture = join(import.meta.dirname, "fixtures", "artifact-safety.mjs");
  const result = await promisify(execFile)("docker", [
    "run", "--rm", "--entrypoint", "node", "--network", "none",
    "--mount", `type=bind,source=${fixture},target=/checks.mjs,readonly`,
    process.env.HYBRID_EXECUTOR_IMAGE ?? "copilot-hybrid-executor:local", "/checks.mjs",
  ], { encoding: "utf8", timeout: 60_000 });
  expect(result.stdout).toContain("Artifact safety passed");
}, 70_000);
