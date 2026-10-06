import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { HarnessDefinition, InputResponseSubmission, parseSkillMarkdown, renderSkillMarkdown } from "@copilot-agent/contracts";
import { canonicalJson } from "@copilot-agent/service-defaults";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { mapPlannerPlan } from "./import.js";
import { bumpPatch, compareVersions, Repo, RepoError } from "./repo.js";
import { deployEnvironment, Settings, SettingsError } from "./settings.js";
import { StatusService } from "./status.js";
import { TaskConflictError, TaskRunner, type TaskStep } from "./tasks.js";
import { createFromTemplate, listTemplates } from "./templates.js";
import { TryError, TryService } from "./try.js";
import type { HarnessChange, HarnessChanges, HarnessDetail, HarnessDocument, HarnessSummary, Issue, TaskKind, TryTarget, WorkspaceInfo } from "./types.js";
import {
  decisions,
  definitionOf,
  effectiveLimits,
  harnessDigest,
  requiredCapabilitiesOf,
  validateHarness,
  validatePolicy,
  type ValidationContext,
} from "./validate.js";

export interface AppOptions {
  /** Platform source repository used for builds, profiles, tools and deployment. */
  root: string;
  /** Customer-authored harness and policy workspace. Defaults to root for isolated tests. */
  workspaceRoot?: string;
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
  const workspaceRoot = options.workspaceRoot ?? root;
  const repo = new Repo(workspaceRoot, root);
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
      const manifest = await repo.exampleContent(manifestPath);
      if (manifest) {
        const instructionsPath = join(repo.harnessesDir, document.folder, document.manifest.instructionsFile ?? "instructions.md");
        const committedSkills: Record<string, string> = {};
        const names = new Set(document.skills.map((skill) => skill.name));
        try {
          const parsed = JSON.parse(manifest) as { skills?: unknown };
          for (const name of skillNames(parsed.skills)) {
            names.add(name);
          }
        } catch {
          // Keep the current skill names only.
        }
        await Promise.all(
          [...names].map(async (name) => {
            const content = await repo.exampleContent(join(repo.harnessesDir, document.folder, "skills", name, "SKILL.md"));
            if (content !== undefined) {
              committedSkills[name] = content;
            }
          }),
        );
        committed = { manifest, instructions: await repo.exampleContent(instructionsPath), skills: committedSkills };
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
      decisions: decisions(document, ctx),
      requiredCapabilities: requiredCapabilitiesOf(document),
    };
  }

  async function workspace(): Promise<WorkspaceInfo> {
    const [documents, profiles, rawPolicy, changes] = await Promise.all([
      repo.listHarnesses(),
      repo.listProfiles(),
      repo.readPolicyRaw(),
      repo.changeInfo(),
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
        modified: changes.modified.has(d.folder),
        untracked: changes.untracked.has(d.folder),
        errors: issues.filter((i) => i.level === "error").length,
        warnings: issues.filter((i) => i.level === "warning").length,
        digest: harnessDigest(d),
      });
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version));
    return {
      root: workspaceRoot,
      platformRoot: root,
      harnesses: summaries,
      profiles,
      bindings: repo.bindings(profiles),
      policy,
      policyIssues,
      changes: { items: changes.items },
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
  app.put("/api/settings/demo-host-credential", async (request, reply) => {
    const body = z.object({ token: z.string().max(16_384).refine((token) => token === "" || token.length >= 20) }).strict().parse(request.body);
    await settings.writeDemoHostGitHubToken(body.token);
    reply.header("cache-control", "no-store");
    return { stored: body.token !== "" };
  });
  app.get("/api/workspace", async () => workspace());
  app.get("/api/check", async () => check());
  app.get("/api/templates", async () => {
    const [policy, profiles] = await Promise.all([repo.readPolicy(), repo.listProfiles()]);
    return { templates: listTemplates(policy, profiles) };
  });

  app.get("/api/harnesses/:folder", async (request) => detail(await repo.readHarness(folderParam(request))));

  const SkillBody = z.object({ name: z.string(), description: z.string(), content: z.string() });
  const DocumentBody = z.object({
    document: z.object({
      folder: z.string(),
      manifest: z.record(z.string(), z.unknown()),
      instructions: z.string(),
      skills: z.array(SkillBody).default([]),
    }),
  });

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
        mode: z.enum(["new", "version", "duplicate", "import"]),
        name: z.string().regex(SLUG, "Use lowercase letters, digits, and hyphens (2-63 characters)."),
        from: z.string().optional(),
        version: z.string().regex(SEMVER).optional(),
        template: z.enum(["structured-answer", "data-analysis", "skill-guided", "agent-team", "copilot-coding"]).optional(),
        document: z.unknown().optional(),
      })
      .parse(request.body);
    const [policy, profiles, documents] = await Promise.all([repo.readPolicy(), repo.listProfiles(), repo.listHarnesses()]);
    let document: HarnessDocument;
    if (body.mode === "new") {
      if (documents.some((d) => d.manifest.name === body.name)) {
        throw new RepoError(409, `A harness named '${body.name}' already exists. Create a new version instead.`);
      }
      const template = listTemplates(policy, profiles).find((entry) => entry.id === (body.template ?? "structured-answer"));
      if (!template || template.profiles.length === 0) {
        throw new RepoError(422, `Template '${body.template ?? "structured-answer"}' has no approved execution profile.`);
      }
      document = createFromTemplate(body.template ?? "structured-answer", body.name, policy.allowedModels[0] ?? "gpt-4.1", template.profiles, policy);
    } else if (body.mode === "import") {
      if (documents.some((d) => d.manifest.name === body.name)) {
        throw new RepoError(409, `A harness named '${body.name}' already exists.`);
      }
      const parsed = DocumentBody.parse({ document: body.document }).document as unknown as HarnessDocument;
      document = {
        folder: body.name,
        instructions: parsed.instructions,
        skills: parsed.skills ?? [],
        manifest: {
          ...structuredClone(parsed.manifest),
          name: body.name,
          version: parsed.manifest.version || "1.0.0",
          instructionsFile: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(String(parsed.manifest.instructionsFile ?? ""))
            ? parsed.manifest.instructionsFile
            : "instructions.md",
        },
      };
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
        skills: structuredClone(source.skills),
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
    return detail(await repo.readHarness(folder));
  });

  app.delete("/api/harnesses/:folder", async (request) => {
    const folder = folderParam(request);
    await repo.readHarness(folder);
    await repo.deleteHarness(folder);
    return { deleted: folder };
  });

  app.post("/api/import/planner", async (request) => {
    const body = z.object({ plan: z.unknown(), name: z.string().max(200).optional() }).parse(request.body);
    const size = Buffer.byteLength(JSON.stringify(body.plan), "utf8");
    if (size > 1024 * 1024) {
      throw new RepoError(400, "Planner import payload must be 1 MB or smaller.");
    }
    if (!body.plan || typeof body.plan !== "object" || Array.isArray(body.plan)) {
      throw new RepoError(400, "Planner import payload must be an object.");
    }
    const [policy, profiles, documents] = await Promise.all([repo.readPolicy(), repo.listProfiles(), repo.listHarnesses()]);
    const { document, report } = mapPlannerPlan(body.plan as Record<string, unknown>, body.name, policy, profiles);
    const ctx = await context(document, [...documents, document]);
    return { document, report, issues: validateHarness(document, ctx) };
  });

  app.get("/api/harnesses/:folder/export", async (request) => {
    const document = await repo.readHarness(folderParam(request));
    const parsed = HarnessDefinition.safeParse(definitionOf(document));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new RepoError(422, `${first?.path.join(".") || "(root)"} — ${first?.message ?? "Invalid harness."}`);
    }
    return { definition: parsed.data, digest: harnessDigest(document)! };
  });

  app.get("/api/harnesses/:folder/changes", async (request): Promise<HarnessChanges> => {
    const folder = folderParam(request);
    const document = await repo.readHarness(folder);
    const committedManifestText = await repo.exampleContent(repo.harnessManifestPath(folder));
    if (committedManifestText === undefined) {
      return { committed: false, changes: [] };
    }
    const changes: HarnessChange[] = [];
    let committedManifest: unknown;
    try {
      committedManifest = JSON.parse(committedManifestText);
    } catch {
      committedManifest = {};
    }
    diffValues(committedManifest, manifestForChanges(document), "", changes);

    const committedInstructionsFile =
      isRecord(committedManifest) && typeof committedManifest.instructionsFile === "string" ? committedManifest.instructionsFile : undefined;
    const instructionsFile = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(committedInstructionsFile ?? "")
      ? committedInstructionsFile!
      : document.manifest.instructionsFile;
    const committedInstructions = await repo.exampleContent(join(repo.harnessesDir, folder, instructionsFile));
    compareText("instructions", committedInstructions, document.instructions, changes);

    const names = new Set([...skillNames(isRecord(committedManifest) ? committedManifest.skills : undefined), ...document.skills.map((skill) => skill.name)]);
    await Promise.all(
      [...names].map(async (name) => {
        const committed = await repo.exampleContent(join(repo.harnessesDir, folder, "skills", name, "SKILL.md"));
        const current = document.skills.find((skill) => skill.name === name);
        compareText(
          `skills.${name}`,
          committed === undefined ? undefined : normalizedSkillText(name, committed),
          current ? renderSkillMarkdown(current) : undefined,
          changes,
        );
      }),
    );

    return { committed: true, changes: collapseChanges(changes) };
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
        const hostTransport = target.demoHost?.transport;
        const githubToken = hostTransport === "github" || hostTransport === "both" ? await settings.demoHostGitHubToken() : undefined;
        if ((hostTransport === "github" || hostTransport === "both") && !githubToken) {
          throw new SettingsError("Set the demo-host-github-token Aspire secret for the selected owner before deploying Mission Control hosting.");
        }
        if (githubToken) env["Parameters__demo-host-github-token"] = githubToken;
        const step =
          kind === "deploy"
            ? aspire("deploy", "--apphost", "apphost.mts")
            : aspire("publish", "--apphost", "apphost.mts", "--output-path", "artifacts/deployment");
        return {
          title: kind === "deploy" ? `Deploy to ${target.name} (${target.resourceGroup})` : `Generate Bicep for ${target.name}`,
          steps: [{ ...step, env }],
          redact: [(await settings.devApiKey()) ?? "", githubToken ?? ""],
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
  // Approvals and questions from running agents, answered through the selected service.
  app.get("/api/try/:target/input-requests", async (request, reply) => {
    const state = z.enum(["pending", "all"]).catch("pending").parse((request.query as { state?: string }).state);
    return relay(reply, tryService.forward(tryTarget(request), "GET", `/v1/input-requests?state=${state}&limit=50`));
  });
  app.get("/api/try/:target/jobs/:id/input-requests", async (request, reply) =>
    relay(reply, tryService.forward(tryTarget(request), "GET", `/v1/jobs/${jobId(request)}/input-requests`)),
  );
  app.post("/api/try/:target/jobs/:id/input-requests/:requestId/respond", async (request, reply) => {
    const requestId = z.string().uuid().parse((request.params as { requestId: string }).requestId);
    const body = InputResponseSubmission.parse(request.body);
    return relay(
      reply,
      tryService.forward(tryTarget(request), "POST", `/v1/jobs/${jobId(request)}/input-requests/${requestId}/respond`, body),
    );
  });

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function skillNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string" && SLUG.test(item)))];
}

function manifestForChanges(document: HarnessDocument): HarnessDocument["manifest"] {
  const manifest = { ...document.manifest };
  if (document.skills.length > 0) {
    manifest.skills = document.skills.map((skill) => skill.name);
  } else {
    delete manifest.skills;
  }
  return manifest;
}

function normalizedText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizedSkillText(name: string, text: string): string {
  const parsed = parseSkillMarkdown(text);
  return renderSkillMarkdown({ name, description: parsed.description ?? "", content: parsed.content });
}

function compareText(path: string, before: string | undefined, after: string | undefined, changes: HarnessChange[]): void {
  if (before === undefined && after === undefined) {
    return;
  }
  if (before === undefined) {
    changes.push({ path, change: "added" });
    return;
  }
  if (after === undefined) {
    changes.push({ path, change: "removed" });
    return;
  }
  if (normalizedText(before) !== normalizedText(after)) {
    changes.push({ path, change: "changed" });
  }
}

function diffValues(before: unknown, after: unknown, path: string, changes: HarnessChange[], depth = 0): void {
  if (canonicalJson(before) === canonicalJson(after)) {
    return;
  }
  if (before === undefined) {
    changes.push({ path, change: "added" });
    return;
  }
  if (after === undefined) {
    changes.push({ path, change: "removed" });
    return;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    diffArrays(Array.isArray(before) ? before : [], Array.isArray(after) ? after : [], path, changes, depth);
    return;
  }
  if (isRecord(before) && isRecord(after) && depth < 3) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      diffValues(before[key], after[key], path ? `${path}.${key}` : key, changes, depth + 1);
    }
    return;
  }
  changes.push({ path, change: "changed" });
}

function diffArrays(before: unknown[], after: unknown[], path: string, changes: HarnessChange[], depth: number): void {
  const all = [...before, ...after];
  const named = all.length > 0 && all.every((item) => isRecord(item) && typeof item.name === "string");
  if (!named) {
    changes.push({ path, change: "changed" });
    return;
  }
  const beforeByName = new Map(before.map((item) => [(item as { name: string }).name, item]));
  const afterByName = new Map(after.map((item) => [(item as { name: string }).name, item]));
  const names = new Set([...beforeByName.keys(), ...afterByName.keys()]);
  for (const name of [...names].sort()) {
    diffValues(beforeByName.get(name), afterByName.get(name), `${path}.${name}`, changes, depth + 1);
  }
}

function collapseChanges(changes: HarnessChange[]): HarnessChange[] {
  const byPath = new Map<string, HarnessChange>();
  for (const change of changes) {
    if (change.path) {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
