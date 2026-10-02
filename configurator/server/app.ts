import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { bumpPatch, compareVersions, Repo, RepoError, templateHarness } from "./repo.js";
import { deployEnvironment, Settings, SettingsError } from "./settings.js";
import { StatusService } from "./status.js";
import { TaskConflictError, TaskRunner, type TaskStep } from "./tasks.js";
import { TryError, TryService } from "./try.js";
import type { HarnessDetail, HarnessDocument, HarnessSummary, Issue, TaskKind, TryTarget, WorkspaceInfo } from "./types.js";
import { effectiveLimits, harnessDigest, validateHarness, validatePolicy, type ValidationContext } from "./validate.js";

export interface AppOptions {
  root: string;
  token: string;
  port: number;
  /** Built UI to serve; omit in --dev mode where Vite serves the UI. */
  staticDir?: string;
  /** Extra allowed browser origins (the Vite dev server in --dev mode). */
  devOrigins?: string[];
}

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const UI_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { root } = options;
  const repo = new Repo(root);
  let aspireExtraEnv: Record<string, string> = {};
  const aspireEnv = () => ({ ...process.env, ...aspireExtraEnv });
  const settings = new Settings(root, aspireEnv);
  const refreshAspireEnv = async () => {
    const nuget = await settings.nugetServiceIndex();
    aspireExtraEnv = nuget ? { ASPIRE_CLI_NUGET_SERVICE_INDEX: nuget } : {};
  };
  await refreshAspireEnv();
  const status = new StatusService({ root, aspireEnv });
  const tasks = new TaskRunner(root, aspireEnv);
  const tryService = new TryService(root, settings, status);

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${options.port}`,
    `http://localhost:${options.port}`,
    ...(options.devOrigins ?? []),
  ]);
  const expectedToken = Buffer.from(options.token);

  // DNS-rebinding and cross-site protection, then a per-launch token for every API call.
  app.addHook("onRequest", async (request, reply) => {
    if (!allowedHosts.has(String(request.headers.host ?? ""))) {
      return reply.status(421).send({ error: "Unexpected Host header." });
    }
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.status(403).send({ error: "Cross-origin requests are not allowed." });
    }
    if (request.url.startsWith("/api/")) {
      const presented = Buffer.from(String(request.headers["x-configurator-token"] ?? ""));
      if (presented.length !== expectedToken.length || !timingSafeEqual(presented, expectedToken)) {
        return reply.status(401).send({ error: "Missing or invalid configurator token. Reopen the URL printed by `pnpm configure`." });
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Invalid input.",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (error instanceof RepoError || error instanceof TryError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (error instanceof SettingsError) {
      return reply.status(400).send({ error: error.message });
    }
    if (error instanceof TaskConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: (error as Error).message });
    }
    console.error(error);
    return reply.status(500).send({ error: (error as Error).message || "Internal error" });
  });

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  async function context(document: HarnessDocument, all?: HarnessDocument[]): Promise<ValidationContext> {
    const [policy, profiles, documents] = await Promise.all([repo.readPolicy(), repo.listProfiles(), all ?? repo.listHarnesses()]);
    let committed: ValidationContext["committed"];
    if (await repo.harnessExists(document.folder)) {
      const manifestPath = repo.harnessManifestPath(document.folder);
      const manifest = await repo.headContent(manifestPath);
      if (manifest) {
        const instructionsPath = join(repo.harnessesDir, document.folder, document.manifest.instructionsFile ?? "instructions.md");
        committed = { manifest, instructions: await repo.headContent(instructionsPath) };
      }
    }
    return { policy, profiles, all: documents, committed };
  }

  async function detail(document: HarnessDocument): Promise<HarnessDetail> {
    const ctx = await context(document);
    return {
      document,
      issues: validateHarness(document, ctx),
      effective: effectiveLimits(document, ctx.policy),
      digest: harnessDigest(document),
    };
  }

  async function workspace(): Promise<WorkspaceInfo> {
    const [documents, profiles, rawPolicy, git] = await Promise.all([
      repo.listHarnesses(),
      repo.listProfiles(),
      repo.readPolicyRaw(),
      repo.gitInfo(),
    ]);
    const { policy, issues: policyIssues } = validatePolicy(rawPolicy, profiles);
    if (!policy) {
      throw new RepoError(500, `policy/execution-policy.json is invalid: ${policyIssues.map((i) => i.message).join("; ")}`);
    }
    const latest = new Map<string, string>();
    for (const d of documents) {
      const current = latest.get(d.manifest.name);
      if (!current || compareVersions(d.manifest.version, current) > 0) {
        latest.set(d.manifest.name, d.manifest.version);
      }
    }
    const summaries: HarnessSummary[] = [];
    for (const d of documents) {
      const issues = validateHarness(d, await context(d, documents));
      summaries.push({
        folder: d.folder,
        name: d.manifest.name,
        version: d.manifest.version,
        description: d.manifest.description ?? "",
        latest: latest.get(d.manifest.name) === d.manifest.version,
        modified: git.modified.has(d.folder),
        untracked: git.untracked.has(d.folder),
        errors: issues.filter((i) => i.level === "error").length,
        warnings: issues.filter((i) => i.level === "warning").length,
        digest: harnessDigest(d),
      });
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version));
    return {
      root,
      harnesses: summaries,
      profiles,
      bindings: repo.bindings(profiles),
      policy,
      policyIssues,
      git: { branch: git.branch, changedConfig: git.changedConfig },
    };
  }

  async function check(): Promise<{ ok: boolean; errors: Array<Issue & { scope: string }>; warnings: number }> {
    const ws = await workspace();
    const errors: Array<Issue & { scope: string }> = ws.policyIssues
      .filter((i) => i.level === "error")
      .map((i) => ({ ...i, scope: "policy" }));
    const documents = await repo.listHarnesses();
    let warnings = ws.policyIssues.length - errors.length;
    for (const d of documents) {
      const issues = validateHarness(d, await context(d, documents));
      errors.push(...issues.filter((i) => i.level === "error").map((i) => ({ ...i, scope: `harnesses/${d.folder}` })));
      warnings += issues.filter((i) => i.level === "warning").length;
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  // ---------------------------------------------------------------------------
  // Workspace, harnesses, policy
  // ---------------------------------------------------------------------------

  app.get("/api/session", async () => ({ root, port: options.port }));
  app.get("/api/workspace", async () => workspace());
  app.get("/api/check", async () => check());

  app.get("/api/harnesses/:folder", async (request) => detail(await repo.readHarness(folderParam(request))));

  const DocumentBody = z.object({ document: z.object({ folder: z.string(), manifest: z.record(z.string(), z.unknown()), instructions: z.string() }) });

  app.post("/api/harnesses/validate", async (request) => {
    const { document } = DocumentBody.parse(request.body);
    return detail(document as unknown as HarnessDocument);
  });

  app.put("/api/harnesses/:folder", async (request) => {
    const folder = folderParam(request);
    const { document } = DocumentBody.parse(request.body);
    const doc = { ...(document as unknown as HarnessDocument), folder };
    const result = await detail(doc);
    const errors = result.issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
      throw new RepoError(422, `Fix ${errors.length} error(s) before saving: ${errors[0]!.path} — ${errors[0]!.message}`);
    }
    await repo.writeHarness(doc);
    return detail(await repo.readHarness(folder));
  });

  app.post("/api/harnesses", async (request) => {
    const body = z
      .object({
        mode: z.enum(["new", "version", "duplicate"]),
        name: z.string().regex(SLUG, "Use lowercase letters, digits, and hyphens (2-63 characters)."),
        from: z.string().optional(),
        version: z.string().regex(SEMVER).optional(),
      })
      .parse(request.body);
    const [policy, profiles, documents] = await Promise.all([repo.readPolicy(), repo.listProfiles(), repo.listHarnesses()]);
    let document: HarnessDocument;
    if (body.mode === "new") {
      if (documents.some((d) => d.manifest.name === body.name)) {
        throw new RepoError(409, `A harness named '${body.name}' already exists. Create a new version instead.`);
      }
      const approved = profiles.filter((p) => policy.allowedProfiles.includes(p.id)).map((p) => p.id);
      document = templateHarness(body.name, policy.allowedModels[0] ?? "gpt-4.1", approved);
    } else {
      if (!body.from) {
        throw new RepoError(400, "Choose a harness to copy.");
      }
      const source = await repo.readHarness(body.from);
      const sameName = documents.filter((d) => d.manifest.name === source.manifest.name);
      const highest = sameName.map((d) => d.manifest.version).sort(compareVersions).at(-1) ?? source.manifest.version;
      const name = body.mode === "duplicate" ? body.name : source.manifest.name;
      if (body.mode === "duplicate" && documents.some((d) => d.manifest.name === name)) {
        throw new RepoError(409, `A harness named '${name}' already exists.`);
      }
      const version = body.version ?? (body.mode === "duplicate" ? "1.0.0" : bumpPatch(highest));
      document = {
        folder: name,
        instructions: source.instructions,
        manifest: { ...structuredClone(source.manifest), name, version },
      };
    }
    let folder = document.manifest.name;
    if (await repo.harnessExists(folder)) {
      folder = `${document.manifest.name}@${document.manifest.version}`;
    }
    if (await repo.harnessExists(folder)) {
      throw new RepoError(409, `harnesses/${folder} already exists.`);
    }
    document.folder = folder;
    await repo.writeHarness(document);
    return detail(document);
  });

  app.delete("/api/harnesses/:folder", async (request) => {
    const folder = folderParam(request);
    await repo.readHarness(folder);
    await repo.deleteHarness(folder);
    return { deleted: folder };
  });

  app.get("/api/policy", async () => {
    const profiles = await repo.listProfiles();
    return validatePolicy(await repo.readPolicyRaw(), profiles);
  });

  app.post("/api/policy/validate", async (request) => validatePolicy((request.body as { policy?: unknown })?.policy, await repo.listProfiles()));

  app.put("/api/policy", async (request) => {
    const result = validatePolicy((request.body as { policy?: unknown })?.policy, await repo.listProfiles());
    const errors = result.issues.filter((i) => i.level === "error");
    if (!result.policy || errors.length > 0) {
      throw new RepoError(422, `Fix ${errors.length} error(s) before saving: ${errors[0]?.message ?? "invalid policy"}`);
    }
    await repo.writePolicy(result.policy);
    return validatePolicy(result.policy, await repo.listProfiles());
  });

  // ---------------------------------------------------------------------------
  // Settings, status, discovery
  // ---------------------------------------------------------------------------

  app.get("/api/settings", async () => settings.read());
  app.put("/api/settings/local", async (request) => {
    await settings.writeLocal(request.body);
    await refreshAspireEnv();
    return settings.read();
  });
  app.put("/api/settings/targets", async (request) => {
    await settings.writeTargets(request.body);
    return settings.read();
  });

  app.get("/api/status/environment", async (request) =>
    status.environment((request.query as { refresh?: string }).refresh === "1"),
  );
  app.get("/api/status/local", async () => status.local());
  app.get("/api/status/azure", async () => status.azure(await settings.target(undefined)));

  app.get("/api/foundry/accounts", async (request) => {
    const subscription = z.string().uuid().parse((request.query as { subscription?: string }).subscription);
    return { accounts: await status.foundryAccounts(subscription) };
  });
  app.get("/api/foundry/deployments", async (request) => {
    const q = z
      .object({
        subscription: z.string().uuid(),
        resourceGroup: z.string().regex(/^[A-Za-z0-9._-]{1,90}$/),
        account: z.string().regex(/^[A-Za-z0-9-]{2,64}$/),
      })
      .parse(request.query);
    return { deployments: await status.foundryDeployments(q.subscription, q.resourceGroup, q.account) };
  });

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  const aspire = (...args: string[]) => ({ tool: "aspire", args: [...args, "--non-interactive", "--nologo"], label: `aspire ${args.join(" ")}` });

  async function steps(kind: TaskKind): Promise<{ title: string; steps: TaskStep[]; redact: string[] }> {
    switch (kind) {
      case "test-unit":
        return { title: "Unit tests", steps: [{ tool: "pnpm", args: ["test:unit"], label: "pnpm test:unit" }], redact: [] };
      case "test-all":
        return { title: "All tests", steps: [{ tool: "pnpm", args: ["test"], label: "pnpm test" }], redact: [] };
      case "build":
        return { title: "Build", steps: [{ tool: "pnpm", args: ["build"], label: "pnpm build" }], redact: [] };
      case "local-start":
        return {
          title: "Start local stack",
          steps: [
            { tool: "pnpm", args: ["build"], label: "pnpm build" },
            aspire("start", "--apphost", "apphost.mts"),
          ],
          redact: [],
        };
      case "local-stop":
        return { title: "Stop local stack", steps: [aspire("stop", "--apphost", "apphost.mts")], redact: [] };
      case "local-restart-api":
        return {
          title: "Reload harnesses (restart agent-api)",
          steps: [aspire("resource", "agent-api", "restart", "--apphost", "apphost.mts")],
          redact: [],
        };
      case "publish":
      case "deploy": {
        const target = await settings.target(undefined);
        const info = await settings.read();
        const env = deployEnvironment(target, info.local);
        const step =
          kind === "deploy"
            ? aspire("deploy", "--apphost", "apphost.mts")
            : aspire("publish", "--apphost", "apphost.mts", "--output-path", "artifacts/deployment");
        return {
          title: kind === "deploy" ? `Deploy to ${target.name} (${target.resourceGroup})` : `Generate Bicep for ${target.name}`,
          steps: [{ ...step, env }],
          redact: [(await settings.devApiKey()) ?? ""],
        };
      }
      case "az-login": {
        const target = await settings.target(undefined).catch(() => undefined);
        const args = target ? ["login", "--tenant", target.tenantId] : ["login"];
        return { title: "Azure sign-in", steps: [{ tool: "az", args, label: `az ${args.join(" ")}` }], redact: [] };
      }
      default:
        throw new RepoError(400, `Unknown task '${kind}'.`);
    }
  }

  app.get("/api/tasks", async () => ({ tasks: tasks.list() }));
  app.post("/api/tasks", async (request) => {
    const { kind } = z
      .object({
        kind: z.enum(["test-unit", "test-all", "build", "local-start", "local-stop", "local-restart-api", "publish", "deploy", "az-login"]),
      })
      .parse(request.body);
    if (kind === "deploy" || kind === "publish") {
      const result = await check();
      if (!result.ok) {
        throw new RepoError(422, `Configuration has ${result.errors.length} error(s); fix them before deploying.`);
      }
    }
    const plan = await steps(kind);
    return tasks.start(kind, plan.title, plan.steps, plan.redact);
  });
  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const after = Number.parseInt((request.query as { after?: string }).after ?? "0", 10) || 0;
    const result = tasks.lines(id, after);
    return result ?? reply.status(404).send({ error: "Task not found." });
  });
  app.post("/api/tasks/:id/cancel", async (request) => ({ cancelled: tasks.cancel((request.params as { id: string }).id) }));

  // ---------------------------------------------------------------------------
  // Try it
  // ---------------------------------------------------------------------------

  const tryTarget = (request: FastifyRequest): TryTarget => z.enum(["local", "azure"]).parse((request.params as { target: string }).target);
  const jobId = (request: FastifyRequest) => z.string().uuid().parse((request.params as { id: string }).id);
  const relay = async (reply: FastifyReply, promise: Promise<{ status: number; body: unknown }>) => {
    const result = await promise;
    return reply.status(result.status).send(result.body ?? null);
  };

  app.get("/api/try/:target/info", async (request) => {
    const connection = await tryService.connection(tryTarget(request), true);
    return { apiUrl: connection.apiUrl };
  });
  app.post("/api/try/:target/key", async (request) => ({ key: (await tryService.connection(tryTarget(request))).key }));
  app.get("/api/try/:target/harnesses", async (request, reply) =>
    relay(reply, tryService.forward(tryTarget(request), "GET", "/v1/harnesses")),
  );
  app.post("/api/try/:target/jobs", async (request, reply) =>
    relay(reply, tryService.forward(tryTarget(request), "POST", "/v1/jobs", request.body)),
  );
  app.get("/api/try/:target/jobs/:id", async (request, reply) =>
    relay(reply, tryService.forward(tryTarget(request), "GET", `/v1/jobs/${jobId(request)}`)),
  );
  app.get("/api/try/:target/jobs/:id/events", async (request, reply) => {
    const after = Number.parseInt((request.query as { after?: string }).after ?? "0", 10) || 0;
    return relay(reply, tryService.forward(tryTarget(request), "GET", `/v1/jobs/${jobId(request)}/events?after=${after}`));
  });
  app.post("/api/try/:target/jobs/:id/cancel", async (request, reply) =>
    relay(reply, tryService.forward(tryTarget(request), "POST", `/v1/jobs/${jobId(request)}:cancel`)),
  );

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  if (options.staticDir) {
    const staticDir = options.staticDir;
    app.get("/*", async (request, reply) => {
      const path = request.url.split("?")[0] ?? "/";
      if (path.startsWith("/api/")) {
        return reply.status(404).send({ error: "Not found." });
      }
      const relative = path === "/" || !extname(path) ? "index.html" : normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
      const file = join(staticDir, relative);
      if (!file.startsWith(staticDir + sep) && file !== join(staticDir, "index.html")) {
        return reply.status(404).send();
      }
      try {
        const content = await readFile(file);
        return reply
          .headers({ ...UI_HEADERS, "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" })
          .send(content);
      } catch {
        return reply.status(404).send();
      }
    });
  }

  return app;
}

function folderParam(request: FastifyRequest): string {
  const folder = (request.params as { folder: string }).folder;
  if (!/^[a-z][a-z0-9-]{1,62}(@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?$/.test(folder)) {
    throw new RepoError(400, "Invalid harness folder.");
  }
  return folder;
}
