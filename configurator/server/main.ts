import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { CUSTOMER_WORKSPACE_DIR, ensureCustomerWorkspace } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const configuratorDir = resolve(here, "..");
const root = resolve(configuratorDir, "..");
const workspaceRoot = join(root, CUSTOMER_WORKSPACE_DIR);
await ensureCustomerWorkspace(root, workspaceRoot);
const dev = process.argv.includes("--dev");
const noOpen = process.argv.includes("--no-open") || process.env.CONFIGURATOR_NO_OPEN === "1";
const preferredPort = Number.parseInt(process.env.CONFIGURATOR_PORT ?? "4280", 10);

async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 20; port++) {
    const free = await new Promise<boolean>((resolvePort) => {
      const probe = createServer();
      probe.once("error", () => resolvePort(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port between ${start} and ${start + 19}.`);
}

const port = await freePort(preferredPort);
const token = randomBytes(24).toString("base64url");
const staticDir = join(configuratorDir, "dist");
if (!dev && !existsSync(join(staticDir, "index.html"))) {
  console.error("The configurator UI is not built. Run `pnpm configure` (it builds first).");
  process.exit(1);
}

const app = await buildApp({
  root,
  workspaceRoot,
  token,
  port,
  staticDir: dev ? undefined : staticDir,
  devOrigins: dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : [],
  githubOAuthClientId: process.env.CONFIGURATOR_GITHUB_CLIENT_ID,
});
await app.listen({ host: "127.0.0.1", port });

const url = dev ? `http://127.0.0.1:5173/?t=${token}` : `http://127.0.0.1:${port}/?t=${token}`;
console.log("");
console.log("  Agent Service Configurator");
console.log(`  Platform:   ${root}`);
console.log(`  Workspace:  ${workspaceRoot}`);
console.log(`  Open:       ${url}`);
console.log("");
console.log("  The URL carries a one-time session token. Press Ctrl+C to stop.");
if (dev) {
  console.log("  Dev mode: start the UI with `pnpm --filter @copilot-agent/configurator exec vite --host 127.0.0.1`.");
}

if (!noOpen) {
  const opener =
    process.platform === "win32"
      ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  opener.on("error", () => undefined);
  opener.unref();
}

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
