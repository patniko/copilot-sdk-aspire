import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { capture } from "../server/process.js";
import { LocalSettingsSchema, Settings, SettingsError } from "../server/settings.js";
import { StatusService } from "../server/status.js";

vi.mock("../server/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/process.js")>()),
  capture: vi.fn(),
}));

const captureMock = vi.mocked(capture);
const apiKey = "test-only-generated-api-key";
const local = {
  foundryEndpoint: "https://example.openai.azure.com/openai/v1",
  foundryDeployments: ["test-model"],
  npmRegistry: "",
  pipIndexUrl: "",
  nugetServiceIndex: "",
};
let root: string;
let secretsPath: string;
let settings: Settings;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "configurator-settings-test-"));
  secretsPath = join(root, "secrets.json");
  settings = new Settings(root, () => ({}));
  captureMock.mockReset();
  captureMock.mockResolvedValue({ code: 0, stdout: `${secretsPath}\n`, stderr: "", timedOut: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("Aspire user secrets", () => {
  it("reports invalid endpoint URLs as validation errors instead of throwing", () => {
    expect(LocalSettingsSchema.safeParse({ ...local, foundryEndpoint: "not a URL" }).success).toBe(false);
  });

  it.each(["", "\uFEFF"])("reads generated keys and local parameters with prefix %j", async (prefix) => {
    await writeFile(
      secretsPath,
      prefix + JSON.stringify({
        "Parameters:dev-api-key": apiKey,
        "Parameters:demo-host-github-token": "gho_test-token-that-must-not-be-returned",
        "Parameters:foundry-endpoint": local.foundryEndpoint,
        "Parameters:foundry-deployments": "test-model, second-model",
      }),
      "utf8",
    );

    expect(await settings.devApiKey()).toBe(apiKey);
    const info = await settings.read();
    expect(info.local).toMatchObject({
      foundryEndpoint: local.foundryEndpoint,
      foundryDeployments: ["test-model", "second-model"],
    });
    expect(info.demoHostCredentialStored).toBe(true);
    expect(JSON.stringify(info)).not.toContain(apiKey);
    expect(JSON.stringify(info)).not.toContain("gho_test-token-that-must-not-be-returned");
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith(
      "aspire",
      ["secret", "path", "--apphost", "apphost.mts", "--nologo", "--non-interactive"],
      { cwd: root, env: {}, timeoutMs: 60_000 },
    );
  });

  it.each(["", "\uFEFF"])("preserves generated and unrelated secrets when saving with prefix %j", async (prefix) => {
    const original = {
      "Parameters:dev-api-key": apiKey,
      "Parameters:executor-key": "test-only-executor-key",
      "Parameters:capability-signing-key": "test-only-signing-key",
      "Parameters:pip-index-url": "https://old.example/simple/",
      Other: { enabled: true },
    };
    await writeFile(secretsPath, prefix + JSON.stringify(original), "utf8");

    await settings.writeLocal(local);

    const saved = JSON.parse(await readFile(secretsPath, "utf8"));
    expect(saved).toEqual({
      "Parameters:dev-api-key": apiKey,
      "Parameters:executor-key": "test-only-executor-key",
      "Parameters:capability-signing-key": "test-only-signing-key",
      "Parameters:foundry-endpoint": local.foundryEndpoint,
      "Parameters:foundry-deployments": "test-model",
      Other: { enabled: true },
    });
    expect(await settings.devApiKey()).toBe(apiKey);
  });

  it("allows a genuinely missing secrets file on first setup", async () => {
    expect(await settings.devApiKey()).toBeUndefined();
    const info = await settings.read();
    expect(info.local.foundryEndpoint).toBe("");
    expect(info.demoHostCredentialStored).toBe(false);

    await settings.writeLocal(local);

    expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({
      "Parameters:foundry-endpoint": local.foundryEndpoint,
      "Parameters:foundry-deployments": "test-model",
    });
  });

  it("returns no key when a valid secrets object has no generated key yet", async () => {
    await writeFile(secretsPath, "{}", "utf8");
    expect(await settings.devApiKey()).toBeUndefined();
  });

  it.each([
    ["malformed JSON", `{"Parameters:dev-api-key":"${apiKey}",}`],
    ["malformed JSON after a BOM", `\uFEFF{"Parameters:dev-api-key":"${apiKey}",}`],
    ["empty file", ""],
    ["array", JSON.stringify([{ "Parameters:dev-api-key": apiKey }])],
    ["null", "null"],
    ["string", JSON.stringify(apiKey)],
  ])("reports %s without exposing or overwriting the file", async (_label, content) => {
    await writeFile(secretsPath, content, "utf8");

    await expect(settings.devApiKey()).rejects.toBeInstanceOf(SettingsError);
    await expect(settings.devApiKey()).rejects.not.toThrow(apiKey);
    await expect(settings.read()).rejects.toBeInstanceOf(SettingsError);
    await expect(settings.writeLocal(local)).rejects.toBeInstanceOf(SettingsError);
    expect(await readFile(secretsPath, "utf8")).toBe(content);
    await expect(readFile(settings.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports file read failures instead of treating secrets as missing", async () => {
    await mkdir(secretsPath);
    await expect(settings.devApiKey()).rejects.toBeInstanceOf(SettingsError);
    await expect(settings.writeLocal(local)).rejects.toBeInstanceOf(SettingsError);
    await expect(readFile(settings.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores ANSI formatting in the CLI path output", async () => {
    captureMock.mockResolvedValue({
      code: 0,
      stdout: `CLI notice\n\u001b[32m${secretsPath}\u001b[0m\n`,
      stderr: "",
      timedOut: false,
    });
    await writeFile(secretsPath, JSON.stringify({ "Parameters:dev-api-key": apiKey }), "utf8");
    expect(await settings.devApiKey()).toBe(apiKey);
  });

  it.each([
    ["failure", { code: 1, timedOut: false }],
    ["timeout", { code: null, timedOut: true }],
  ])("rejects CLI %s even if stdout contains a path", async (_label, result) => {
    captureMock.mockResolvedValue({ ...result, stdout: secretsPath, stderr: apiKey });
    await writeFile(secretsPath, JSON.stringify({ "Parameters:dev-api-key": apiKey }), "utf8");
    await expect(settings.devApiKey()).rejects.toBeInstanceOf(SettingsError);
    await expect(settings.devApiKey()).rejects.not.toThrow(apiKey);
    await expect(settings.writeLocal(local)).rejects.toBeInstanceOf(SettingsError);
    expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({ "Parameters:dev-api-key": apiKey });
  });

  it("reports missing CLI path output and retries discovery on the next call", async () => {
    captureMock.mockResolvedValueOnce({ code: 0, stdout: "No path", stderr: "", timedOut: false });
    await expect(settings.devApiKey()).rejects.toBeInstanceOf(SettingsError);
    await writeFile(secretsPath, JSON.stringify({ "Parameters:dev-api-key": apiKey }), "utf8");
    expect(await settings.devApiKey()).toBe(apiKey);
  });
});

describe("GitHub inference settings", () => {
  const githubToken = "github_pat_test-only-inference-token-0001";

  it("reads and writes Copilot models as a comma-joined parameter and removes it when empty", async () => {
    await settings.writeLocal({ ...local, githubInferenceModels: ["claude-sonnet-5.5", "gpt-5.4", "gpt-5.4"] });
    expect(JSON.parse(await readFile(secretsPath, "utf8"))["Parameters:github-inference-models"]).toBe("claude-sonnet-5.5,gpt-5.4");
    expect((await settings.read()).local.githubInferenceModels).toEqual(["claude-sonnet-5.5", "gpt-5.4"]);

    await settings.writeLocal({ ...local, githubInferenceModels: [] });
    expect(JSON.parse(await readFile(secretsPath, "utf8"))).not.toHaveProperty("Parameters:github-inference-models");
    expect((await settings.read()).local.githubInferenceModels).toEqual([]);
  });

  it("rejects prefixed or malformed model IDs", () => {
    expect(LocalSettingsSchema.safeParse({ ...local, githubInferenceModels: ["github/gpt-5.4"] }).success).toBe(false);
    expect(LocalSettingsSchema.safeParse({ ...local, githubInferenceModels: ["gpt 5"] }).success).toBe(false);
    expect(LocalSettingsSchema.safeParse({ ...local, githubInferenceModels: Array.from({ length: 51 }, (_, i) => `m${i}`) }).success).toBe(false);
  });

  it("stores the token write-only and clears it with an empty value", async () => {
    await writeFile(secretsPath, JSON.stringify({ "Parameters:dev-api-key": apiKey }), "utf8");
    expect((await settings.read()).githubInferenceCredentialStored).toBe(false);

    await settings.writeGitHubInferenceToken(githubToken);
    const info = await settings.read();
    expect(info.githubInferenceCredentialStored).toBe(true);
    expect(JSON.stringify(info)).not.toContain(githubToken);
    expect(await settings.githubInferenceToken()).toBe(githubToken);

    await settings.writeLocal(local);
    expect(await settings.githubInferenceToken()).toBe(githubToken);

    await settings.writeGitHubInferenceToken("");
    expect(await settings.githubInferenceToken()).toBeUndefined();
    expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({
      "Parameters:dev-api-key": apiKey,
      "Parameters:foundry-endpoint": local.foundryEndpoint,
      "Parameters:foundry-deployments": "test-model",
    });
  });
});

describe("Try it local connection", () => {
  const port = 4999;
  const token = "test-only-configurator-token";
  const headers = { host: `127.0.0.1:${port}`, "x-configurator-token": token };
  const apiUrl = "http://127.0.0.1:5678";

  beforeEach(() => {
    vi.spyOn(StatusService.prototype, "local").mockResolvedValue({ running: true, apiUrl, resources: [] });
  });

  it("uses a BOM-prefixed key for Try it and explicit Copy API key only", async () => {
    await writeFile(secretsPath, "\uFEFF" + JSON.stringify({ "Parameters:dev-api-key": apiKey }), "utf8");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ harnesses: [] }), { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp({ root, token, port });
    try {
      const info = await app.inject({ method: "GET", url: "/api/try/local/info", headers });
      expect(info.statusCode).toBe(200);
      expect(info.json()).toEqual({ apiUrl });

      const harnesses = await app.inject({ method: "GET", url: "/api/try/local/harnesses", headers });
      expect(harnesses.statusCode).toBe(200);
      expect(harnesses.json()).toEqual({ harnesses: [] });
      expect(fetchMock).toHaveBeenCalledWith(
        `${apiUrl}/v1/harnesses`,
        expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${apiKey}` }) }),
      );
      expect(info.body + harnesses.body).not.toContain(apiKey);

      const copied = await app.inject({ method: "POST", url: "/api/try/local/key", headers });
      expect(copied.statusCode).toBe(200);
      expect(copied.json()).toEqual({ key: apiKey });
    } finally {
      await app.close();
    }
  });

  it("reports unreadable settings instead of telling a healthy stack to start again", async () => {
    await writeFile(secretsPath, `{"Parameters:dev-api-key":"${apiKey}",}`, "utf8");
    const app = await buildApp({ root, token, port });
    try {
      const response = await app.inject({ method: "GET", url: "/api/try/local/info", headers });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/secrets.*JSON/i);
      expect(response.body).not.toContain(apiKey);
      expect(response.body).not.toContain("Start the local stack");
    } finally {
      await app.close();
    }
  });
});
