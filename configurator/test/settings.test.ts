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
    expect(JSON.stringify(info)).not.toContain(apiKey);
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
    expect((await settings.read()).local.foundryEndpoint).toBe("");

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
