import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { ensureCustomerWorkspace } from "../server/workspace.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const token = "test-token-0123456789abcdef";
const port = 4999;
let root: string;
let platformRoot: string;
let app: FastifyInstance;

const headers = (extra: Record<string, string> = {}) => ({ host: `127.0.0.1:${port}`, "x-configurator-token": token, ...extra });

describe("customer workspace bootstrap", () => {
  it("seeds missing directories without overwriting customer files", async () => {
    const temp = await mkdtemp(join(tmpdir(), "workspace-bootstrap-"));
    const platform = join(temp, "platform");
    const workspace = join(temp, "workspace");
    try {
      await mkdir(join(platform, "examples", "customer-config", "harnesses", "sample"), { recursive: true });
      await mkdir(join(platform, "examples", "customer-config", "policy"), { recursive: true });
      await writeFile(join(platform, "examples", "customer-config", "harnesses", "sample", "harness.json"), "example");
      await writeFile(join(platform, "examples", "customer-config", "policy", "execution-policy.json"), "policy");
      await mkdir(join(workspace, "harnesses", "sample"), { recursive: true });
      await writeFile(join(workspace, "harnesses", "sample", "harness.json"), "customer");

      await ensureCustomerWorkspace(platform, workspace);

      expect(await readFile(join(workspace, "harnesses", "sample", "harness.json"), "utf8")).toBe("customer");
      expect(await readFile(join(workspace, "policy", "execution-policy.json"), "utf8")).toBe("policy");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "configurator-test-"));
  platformRoot = join(root, "platform");
  await cp(join(repoRoot, "examples", "customer-config"), join(platformRoot, "examples", "customer-config"), { recursive: true });
  await cp(join(repoRoot, "execution-profiles"), join(platformRoot, "execution-profiles"), { recursive: true });
  await cp(join(repoRoot, "examples", "customer-config", "harnesses"), join(root, "harnesses"), { recursive: true });
  await cp(join(repoRoot, "examples", "customer-config", "policy"), join(root, "policy"), { recursive: true });
  app = await buildApp({ root: platformRoot, workspaceRoot: root, token, port });
});

afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

describe("request security", () => {
  it("requires the session token for API calls", async () => {
    const response = await app.inject({ method: "GET", url: "/api/workspace", headers: { host: `127.0.0.1:${port}` } });
    expect(response.statusCode).toBe(401);
  });

  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/workspace", headers: headers({ host: `attacker.example:${port}` }) });
    expect(response.statusCode).toBe(421);
  });

  it("rejects cross-origin browser requests", async () => {
    const response = await app.inject({ method: "GET", url: "/api/workspace", headers: headers({ origin: "https://attacker.example" }) });
    expect(response.statusCode).toBe(403);
  });

  it("serves the workspace with a valid token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/workspace", headers: headers({ origin: `http://127.0.0.1:${port}` }) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.harnesses.map((h: { name: string }) => h.name)).toContain("dataset-analyst");
    expect(body.profiles.map((p: { id: string }) => p.id)).toEqual(["node-ts-agent", "python-agent"]);
  });

  it("reports when GitHub OAuth device sign-in is not configured", async () => {
    const response = await app.inject({ method: "GET", url: "/api/settings/demo-host-oauth", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false });
  });

  it("rejects harness folder traversal", async () => {
    const response = await app.inject({ method: "GET", url: "/api/harnesses/..%2Fpolicy", headers: headers() });
    expect(response.statusCode).toBe(400);
  });

  it("only runs tasks from the fixed catalog", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tasks", headers: headers(), payload: { kind: "rm -rf" } });
    expect(response.statusCode).toBe(400);
  });

  it("serves the UI with a restrictive content security policy and 404s unknown API paths", async () => {
    const staticApp = await buildApp({
      root: platformRoot,
      workspaceRoot: root,
      token,
      port,
      staticDir: join(repoRoot, "configurator", "dist"),
    });
    try {
      const page = await staticApp.inject({ method: "GET", url: "/", headers: { host: `127.0.0.1:${port}` } });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      const unknown = await staticApp.inject({ method: "GET", url: "/api/nope", headers: headers() });
      expect(unknown.statusCode).toBe(404);
      const traversal = await staticApp.inject({ method: "GET", url: "/..%2F..%2Fpackage.json", headers: { host: `127.0.0.1:${port}` } });
      expect(traversal.statusCode).toBe(404);
    } finally {
      await staticApp.close();
    }
  });
});

describe("harness lifecycle", () => {
  it("creates a valid harness from the template", async () => {
    const response = await app.inject({ method: "POST", url: "/api/harnesses", headers: headers(), payload: { mode: "new", name: "test-harness" } });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.document.folder).toBe("test-harness");
    expect(detail.issues.filter((i: { level: string }) => i.level === "error")).toEqual([]);
    const written = JSON.parse(await readFile(join(root, "harnesses", "test-harness", "harness.json"), "utf8"));
    expect(written).toMatchObject({ name: "test-harness", version: "1.0.0", instructionsFile: "instructions.md" });
  });

  it("refuses a second harness with the same name", async () => {
    const response = await app.inject({ method: "POST", url: "/api/harnesses", headers: headers(), payload: { mode: "new", name: "test-harness" } });
    expect(response.statusCode).toBe(409);
  });

  it("creates a new version in its own folder", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/harnesses",
      headers: headers(),
      payload: { mode: "version", name: "test-harness", from: "test-harness" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().document).toMatchObject({ folder: "test-harness@1.0.1", manifest: { version: "1.0.1" } });
  });

  it("refuses to save a harness with errors and leaves the file unchanged", async () => {
    const before = await readFile(join(root, "harnesses", "test-harness", "harness.json"), "utf8");
    const detail = (await app.inject({ method: "GET", url: "/api/harnesses/test-harness", headers: headers() })).json();
    detail.document.manifest.model = { preferred: "unapproved-model", allowed: ["unapproved-model"] };
    const response = await app.inject({ method: "PUT", url: "/api/harnesses/test-harness", headers: headers(), payload: { document: detail.document } });
    expect(response.statusCode).toBe(422);
    expect(await readFile(join(root, "harnesses", "test-harness", "harness.json"), "utf8")).toBe(before);
  });

  it("saves valid edits", async () => {
    const detail = (await app.inject({ method: "GET", url: "/api/harnesses/test-harness", headers: headers() })).json();
    detail.document.manifest.description = "Edited by a test.";
    detail.document.instructions = "Answer briefly.";
    const response = await app.inject({ method: "PUT", url: "/api/harnesses/test-harness", headers: headers(), payload: { document: detail.document } });
    expect(response.statusCode).toBe(200);
    expect(await readFile(join(root, "harnesses", "test-harness", "instructions.md"), "utf8")).toBe("Answer briefly.\n");
  });

  it("round-trips skills and removes deleted skill folders", async () => {
    const detail = (await app.inject({ method: "GET", url: "/api/harnesses/test-harness", headers: headers() })).json();
    detail.document.manifest.skills = ["stale-skill"];
    detail.document.skills = [{ name: "writing-checklist", description: "Checklist.", content: "# Checklist\n\n- Be clear." }];
    const saved = await app.inject({ method: "PUT", url: "/api/harnesses/test-harness", headers: headers(), payload: { document: detail.document } });
    expect(saved.statusCode).toBe(200);
    const manifest = JSON.parse(await readFile(join(root, "harnesses", "test-harness", "harness.json"), "utf8"));
    expect(manifest.skills).toEqual(["writing-checklist"]);
    expect(await readFile(join(root, "harnesses", "test-harness", "skills", "writing-checklist", "SKILL.md"), "utf8")).toContain(
      "name: writing-checklist",
    );
    const reread = (await app.inject({ method: "GET", url: "/api/harnesses/test-harness", headers: headers() })).json();
    expect(reread.document.skills).toEqual([
      { name: "writing-checklist", description: "Checklist.", content: "# Checklist\n\n- Be clear." },
    ]);

    reread.document.skills = [];
    const removed = await app.inject({ method: "PUT", url: "/api/harnesses/test-harness", headers: headers(), payload: { document: reread.document } });
    expect(removed.statusCode).toBe(200);
    const withoutSkill = JSON.parse(await readFile(join(root, "harnesses", "test-harness", "harness.json"), "utf8"));
    expect(withoutSkill.skills).toBeUndefined();
    await expect(readFile(join(root, "harnesses", "test-harness", "skills", "writing-checklist", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("exports resolved harness definitions", async () => {
    const response = await app.inject({ method: "GET", url: "/api/harnesses/insights-team/export", headers: headers() });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.digest).toMatch(/^sha256:/);
    expect(body.definition.skills.map((skill: { name: string }) => skill.name)).toEqual(["insight-review"]);
  });

  it("reports changes against git HEAD", async () => {
    const detail = (await app.inject({ method: "GET", url: "/api/harnesses/text-summarizer", headers: headers() })).json();
    detail.document.manifest.description = "Edited summary harness.";
    const save = await app.inject({ method: "PUT", url: "/api/harnesses/text-summarizer", headers: headers(), payload: { document: detail.document } });
    expect(save.statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: "/api/harnesses/text-summarizer/changes", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ committed: true, changes: expect.arrayContaining([expect.objectContaining({ path: "description" })]) });
  });

  it("deletes a version", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/harnesses/test-harness@1.0.1", headers: headers() });
    expect(response.statusCode).toBe(200);
    const workspace = (await app.inject({ method: "GET", url: "/api/workspace", headers: headers() })).json();
    expect(workspace.harnesses.map((h: { folder: string }) => h.folder)).not.toContain("test-harness@1.0.1");
  });
});

describe("templates and imports", () => {
  it("lists templates and creates a harness from a selected template", async () => {
    const templates = await app.inject({ method: "GET", url: "/api/templates", headers: headers() });
    expect(templates.statusCode).toBe(200);
    expect(templates.json().templates.map((t: { id: string }) => t.id)).toEqual([
      "structured-answer",
      "data-analysis",
      "skill-guided",
      "agent-team",
      "copilot-coding",
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/api/harnesses",
      headers: headers(),
      payload: { mode: "new", name: "team-template", template: "agent-team" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().document).toMatchObject({ manifest: { prompt: { mode: "customize" }, agents: expect.any(Array) } });
  });

  it("maps Harness Builder planner imports without writing them", async () => {
    const plan = {
      schemaVersion: 2,
      name: "Legacy Insights Plan",
      preset: "research",
      clientMode: "cli",
      inventory: { files: 12 },
      prompt: {
        mode: "customize",
        content: "Answer the imported request.",
        sections: [
          { name: "identity", action: "replace", content: "You are an imported specialist." },
          { name: "tone", action: "preserve" },
          { name: "guidelines", action: "append", content: "" },
        ],
      },
      tools: { read_file: { action: "keep" } },
      customTools: [{ id: "sql", name: "SQL Lookup", terminal: "python sql.py" }],
      mcpServers: [{ id: "docs", name: "Docs MCP", url: "https://example.invalid", tools: [{ name: "search", wireName: "search" }] }],
      agents: [{ id: "analyst", name: "Analyst", description: "Looks at data.", prompt: "Review the data.", model: "unapproved-model", tools: ["read_file", "sql"] }],
      rootExcludedTools: ["edit_file"],
      context: { workspace: "repo", skillDirectories: ["skills"] },
      policy: { permissionMode: "ask" },
      model: {
        id: "unapproved-model",
        provider: "azure",
        endpoint: "https://example.invalid",
        credentialEnv: "KEY",
        wireApi: "responses",
        reasoningEffort: "xhigh",
        contextTier: "long_context",
      },
      identity: { name: "legacy" },
      session: { maxTurns: 4 },
      events: { onTool: true },
      evaluation: { rubric: "short" },
      target: { kind: "local" },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/import/planner",
      headers: headers(),
      payload: { plan, name: "imported-plan" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.document.manifest.name).toBe("imported-plan");
    expect(body.report.needsWork.join("\n")).toContain("Model 'unapproved-model' is not approved");
    expect(body.report.needsWork.join("\n")).toContain("Custom tool 'SQL Lookup'");
    expect(body.report.needsWork.join("\n")).toContain("Sub-agent analyst: tools read_file, sql need harness tool bindings.");
    expect(body.report.notApplicable.join("\n")).toContain("preserve is the default");
    expect(body.report.notApplicable.join("\n")).toContain("inference gateway");
    expect(body.issues.filter((issue: { level: string }) => issue.level === "error")).toEqual([]);
    await expect(readFile(join(root, "harnesses", "imported-plan", "harness.json"), "utf8")).rejects.toThrow();
  });

  it("creates the Copilot coding agent from its template", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/harnesses",
      headers: headers(),
      payload: { mode: "new", name: "coder", template: "copilot-coding" },
    });
    expect(created.statusCode).toBe(200);
    const detail = created.json();
    expect(detail.document.manifest).toMatchObject({
      prompt: { mode: "append" },
      builtinTools: ["files", "shell", "web", "agents"],
      permissions: { default: "ask", questions: true },
      retry: { safeToRetry: false },
    });
    expect(detail.document.manifest.permissions.kinds).toBeUndefined();
    expect(detail.issues.filter((issue: { level: string }) => issue.level === "error")).toEqual([]);
    expect(detail.requiredCapabilities).toEqual(expect.arrayContaining(["builtin-tools", "interactive", "prompt-sections"]));
    expect(detail.decisions.map((d: { title: string }) => d.title).join("\n")).toContain("Copilot CLI approvals for: read, write, shell, url");
  });

  it("maps a coding plan with allow-all to built-in tools and yolo permissions", async () => {
    const plan = {
      schemaVersion: 2,
      name: "Yolo Coder",
      clientMode: "copilot-cli",
      inventory: "coding-defaults",
      prompt: { mode: "default", content: "Fix the bug." },
      tools: { bash: { action: "keep" }, view: { action: "keep" }, web_fetch: { action: "override" } },
      policy: { permissionMode: "allow-all", preToolHook: true },
    };
    const response = await app.inject({ method: "POST", url: "/api/import/planner", headers: headers(), payload: { plan } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.document.manifest.builtinTools).toEqual(["files", "shell", "web", "agents"]);
    expect(body.document.manifest.permissions).toMatchObject({ default: "allow" });
    expect(body.report.mapped.join("\n")).toContain("allow-all");
    expect(body.report.needsWork.join("\n")).toContain("override");
    expect(body.report.notApplicable.join("\n")).toContain("hooks");
  });
});

describe("policy", () => {
  it("rejects a policy that approves an unknown profile", async () => {
    const current = (await app.inject({ method: "GET", url: "/api/policy", headers: headers() })).json().policy;
    const response = await app.inject({
      method: "PUT",
      url: "/api/policy",
      headers: headers(),
      payload: { policy: { ...current, allowedProfiles: ["missing-profile"] } },
    });
    expect(response.statusCode).toBe(422);
  });

  it("saves, applies, reports, and removes a per-harness override", async () => {
    const save = await app.inject({
      method: "PUT",
      url: "/api/policy/overrides/dataset-analyst",
      headers: headers(),
      payload: { overrides: { maxDurationSeconds: 45, allowedModels: ["grok-4.6"] } },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ harness: "dataset-analyst", effective: { maxDurationSeconds: 45 }, issues: [] });
    const file = JSON.parse(await readFile(join(root, "policy", "harnesses", "dataset-analyst.json"), "utf8"));
    expect(file).toEqual({ schemaVersion: "1", harness: "dataset-analyst", overrides: { maxDurationSeconds: 45, allowedModels: ["grok-4.6"] } });

    const detail = (await app.inject({ method: "GET", url: "/api/harnesses/dataset-analyst", headers: headers() })).json();
    expect(detail.effective.maxDurationSeconds).toBe(Math.min(45, detail.document.manifest.limits.maxDurationSeconds));
    expect(detail.policy.overridden.sort()).toEqual(["allowedModels", "maxDurationSeconds"]);
    expect(detail.decisions.map((d: { title: string }) => d.title)).toContain("Operator policy override for this harness");
    const other = (await app.inject({ method: "GET", url: "/api/harnesses/text-summarizer", headers: headers() })).json();
    expect(other.policy.overridden).toEqual([]);

    const workspace = (await app.inject({ method: "GET", url: "/api/workspace", headers: headers() })).json();
    expect(workspace.policyOverrides).toEqual([{ harness: "dataset-analyst", fields: ["allowedModels", "maxDurationSeconds"], errors: 0 }]);
    expect(workspace.changes.items).toContain("A policy/harnesses/dataset-analyst.json");

    const removed = await app.inject({ method: "DELETE", url: "/api/policy/overrides/dataset-analyst", headers: headers() });
    expect(removed.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/policy/overrides/dataset-analyst", headers: headers() })).json();
    expect(after.override).toBeUndefined();
    expect(after.effective.maxDurationSeconds).toBe(workspace.policy.maxDurationSeconds);
  });

  it("rejects global-only fields and overrides for unknown harnesses", async () => {
    const globalField = await app.inject({
      method: "PUT",
      url: "/api/policy/overrides/dataset-analyst",
      headers: headers(),
      payload: { overrides: { leaseSeconds: 60 } },
    });
    expect(globalField.statusCode).toBe(422);
    const unknown = await app.inject({
      method: "PUT",
      url: "/api/policy/overrides/no-such-harness",
      headers: headers(),
      payload: { overrides: { maxDurationSeconds: 30 } },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toMatch(/No harness named/);
    const traversal = await app.inject({ method: "GET", url: "/api/policy/overrides/..%2Fpolicy", headers: headers() });
    expect(traversal.statusCode).toBe(400);
  });

  it("blocks deployment checks on an orphaned override file", async () => {
    await mkdir(join(root, "policy", "harnesses"), { recursive: true });
    const orphan = join(root, "policy", "harnesses", "renamed-away.json");
    await writeFile(orphan, JSON.stringify({ schemaVersion: "1", harness: "renamed-away", overrides: { maxDurationSeconds: 30 } }));
    try {
      const check = (await app.inject({ method: "GET", url: "/api/check", headers: headers() })).json();
      expect(check.ok).toBe(false);
      expect(check.errors).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "policy/harnesses/renamed-away.json" })]));
    } finally {
      await rm(orphan, { force: true });
    }
  });
});

describe("deployment targets", () => {
  it("rejects values that could reach a command line", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings/targets",
      headers: headers(),
      payload: {
        targets: [
          {
            name: "prod",
            tenantId: "00000000-0000-0000-0000-000000000000",
            subscriptionId: "00000000-0000-0000-0000-000000000000",
            location: "westus2",
            resourceGroup: "rg & calc.exe",
            foundryAccount: "acct",
            foundryResourceGroup: "rg",
            foundryEndpoint: "https://acct.openai.azure.com/openai/v1",
            foundryDeployments: ["gpt"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues.map((i: { path: string }) => i.path)).toContain("targets.0.resourceGroup");
  });
});
