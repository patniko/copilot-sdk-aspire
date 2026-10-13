import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, inject, it } from "vitest";

it.skipIf(process.env.HYBRID_CONTAINER_TESTS !== "1")("runs retained shared conversations inside the packaged Linux worker image", async () => {
  const database = new URL(inject("databaseUrl"));
  if (["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)) database.hostname = "host.docker.internal";
  const fixture = join(import.meta.dirname, "fixtures", "shared-image.mjs");
  try {
    const result = await promisify(execFile)("docker", [
      "run", "--rm", "--entrypoint", "node",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "--env", "TEST_DATABASE_URL",
      "--mount", `type=bind,source=${fixture},target=/app/checks.mjs,readonly`,
      process.env.HYBRID_SESSION_IMAGE ?? "copilot-hybrid-session-host:local", "checks.mjs",
    ], { encoding: "utf8", timeout: 90_000, env: { ...process.env, TEST_DATABASE_URL: database.href } });
    expect(result.stdout).toContain("Linux shared image passed");
  } catch (error) {
    // Do not expose a database URL through a child-process error's diagnostic fields.
    const detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.split(database.href).join("[redacted]") : "Container command failed.";
    throw new Error(`Packaged shared worker qualification failed: ${detail}`);
  }
}, 100_000);
