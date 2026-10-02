import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const ASSETS: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
};

/** The console is static and talks only to this API; it has no server-side session or secrets. */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

/** Serves the job console at `/` (index) and `/console/*` (assets). */
export function registerConsole(app: FastifyInstance): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  const files = new Map(Object.keys(ASSETS).map((name) => [name, readFileSync(join(root, name))]));
  const routes: Record<string, string> = {
    "/": "index.html",
    "/console/app.js": "app.js",
    "/console/app.css": "app.css",
  };
  for (const [path, name] of Object.entries(routes)) {
    app.get(path, async (_request, reply) =>
      reply.headers({ ...SECURITY_HEADERS, "content-type": ASSETS[name]! }).send(files.get(name)),
    );
  }
}
