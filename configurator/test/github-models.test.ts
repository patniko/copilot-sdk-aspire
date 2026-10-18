import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { discoverGitHubModels, type GitHubModelLister, GitHubModelsError } from "../server/github-models.js";
import { capture } from "../server/process.js";

vi.mock("../server/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/process.js")>()),
  capture: vi.fn(),
}));

const githubToken = "github_pat_test-only-inference-token-0001";
const listing = [
  { id: "auto", name: "Auto" },
  { id: "gpt-5.4", name: "GPT-5.4", policy: { state: "enabled" }, billing: { multiplier: 1 } },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", billing: { multiplier: 1.5 } },
  { id: "disabled-model", name: "Disabled", policy: { state: "disabled" } },
  { id: "unconfigured-model", name: "Unconfigured", policy: { state: "unconfigured" } },
];

describe("discoverGitHubModels", () => {
  it("lists usable models with their github/ routed names", async () => {
    const lister = vi.fn<GitHubModelLister>().mockResolvedValue(listing);
    expect(await discoverGitHubModels(githubToken, lister)).toEqual([
      { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", routedAs: "github/claude-sonnet-5.5", multiplier: 1.5 },
      { id: "gpt-5.4", name: "GPT-5.4", routedAs: "github/gpt-5.4", policyState: "enabled", multiplier: 1 },
    ]);
    expect(lister).toHaveBeenCalledWith(githubToken);
  });

  it("reports SDK failures without their raw message", async () => {
    const lister: GitHubModelLister = async () => {
      throw new Error(`401 for token ${githubToken}`);
    };
    const error = await discoverGitHubModels(githubToken, lister).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubModelsError);
    expect((error as GitHubModelsError).statusCode).toBe(502);
    expect((error as Error).message).not.toContain(githubToken);
  });
});

describe("GitHub inference routes", () => {
  const port = 4998;
  const token = "test-only-configurator-token";
  const headers = { host: `127.0.0.1:${port}`, "x-configurator-token": token };
  let root: string;
  let secretsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "configurator-github-models-test-"));
    secretsPath = join(root, "secrets.json");
    vi.mocked(capture).mockReset();
    vi.mocked(capture).mockResolvedValue({ code: 0, stdout: `${secretsPath}\n`, stderr: "", timedOut: false });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores the token write-only and discovers models with it", async () => {
    const lister = vi.fn<GitHubModelLister>().mockResolvedValue(listing);
    const app = await buildApp({ root, token, port, githubModelLister: lister });
    try {
      const missing = await app.inject({ method: "GET", url: "/api/github-inference/models", headers });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toMatch(/token/i);
      expect(lister).not.toHaveBeenCalled();

      const saved = await app.inject({ method: "PUT", url: "/api/settings/github-inference-token", headers, payload: { token: githubToken } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().githubInferenceCredentialStored).toBe(true);
      expect(saved.body).not.toContain(githubToken);
      expect(JSON.parse(await readFile(secretsPath, "utf8"))["Parameters:github-inference-token"]).toBe(githubToken);

      const settings = await app.inject({ method: "GET", url: "/api/settings", headers });
      expect(settings.body).not.toContain(githubToken);

      const models = await app.inject({ method: "GET", url: "/api/github-inference/models", headers });
      expect(models.statusCode).toBe(200);
      expect(models.json().models.map((m: { routedAs: string }) => m.routedAs)).toEqual(["github/claude-sonnet-5.5", "github/gpt-5.4"]);
      expect(models.body).not.toContain(githubToken);
      expect(lister).toHaveBeenCalledWith(githubToken);

      const cleared = await app.inject({ method: "PUT", url: "/api/settings/github-inference-token", headers, payload: { token: "" } });
      expect(cleared.json().githubInferenceCredentialStored).toBe(false);
      expect(JSON.parse(await readFile(secretsPath, "utf8"))).not.toHaveProperty("Parameters:github-inference-token");
    } finally {
      await app.close();
    }
  });

  it.each([["short"], ["has whitespace in the middle of token"], ["x".repeat(401)]])("rejects an invalid token %#", async (value) => {
    await writeFile(secretsPath, "{}", "utf8");
    const app = await buildApp({ root, token, port });
    try {
      const response = await app.inject({ method: "PUT", url: "/api/settings/github-inference-token", headers, payload: { token: value } });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({});
    } finally {
      await app.close();
    }
  });

  it("returns a non-secret 502 when the SDK fails", async () => {
    await writeFile(secretsPath, JSON.stringify({ "Parameters:github-inference-token": githubToken }), "utf8");
    const app = await buildApp({
      root,
      token,
      port,
      githubModelLister: async () => {
        throw new Error(`bad credentials ${githubToken}`);
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/github-inference/models", headers });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatch(/Copilot/);
      expect(response.body).not.toContain(githubToken);
    } finally {
      await app.close();
    }
  });
});
