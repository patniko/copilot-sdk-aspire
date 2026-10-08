import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import type { HarnessDetail, HarnessDocument } from "../server/types.js";

const platformRoot = join(import.meta.dirname, "..", "..");
const token = "harness-version-save-test-token";
const port = 4998;
const headers = { host: `127.0.0.1:${port}`, "x-configurator-token": token };
let root: string;
let app: FastifyInstance;
let original: HarnessDocument;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-version-save-"));
  await cp(join(platformRoot, "examples", "customer-config"), root, { recursive: true });
  app = await buildApp({ root: platformRoot, workspaceRoot: root, token, port });
  const created = await app.inject({
    method: "POST", url: "/api/harnesses", headers, payload: { mode: "new", name: "version-save-test" },
  });
  expect(created.statusCode).toBe(200);
  original = created.json<HarnessDetail>().document;
});

afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

function saveVersion(document: HarnessDocument) {
  return app.inject({
    method: "POST",
    url: "/api/harnesses",
    headers,
    payload: { mode: "version", name: document.manifest.name, from: original.folder, version: document.manifest.version, document },
  });
}

describe("saving edited harness versions", () => {
  it("keeps the original and saves the complete draft in a new version folder", async () => {
    const before = await readFile(join(root, "harnesses", original.folder, "harness.json"), "utf8");
    const draft = structuredClone(original);
    draft.manifest.version = "1.1.0";
    draft.manifest.description = "Edited before saving as a new version.";
    draft.instructions = "Follow the new instructions.";
    draft.skills = [{ name: "review-checklist", description: "Review checklist.", content: "Check the result." }];
    const response = await saveVersion(draft);
    expect(response.statusCode).toBe(200);
    expect(response.json<HarnessDetail>().document).toMatchObject({
      folder: "version-save-test@1.1.0",
      manifest: { version: "1.1.0", description: draft.manifest.description },
      instructions: draft.instructions + "\n",
      skills: draft.skills,
    });
    expect(await readFile(join(root, "harnesses", original.folder, "harness.json"), "utf8")).toBe(before);
    const reread = await app.inject({ method: "GET", url: `/api/harnesses/${original.folder}`, headers });
    expect(reread.json<HarnessDetail>().document).toEqual(original);
  });

  it("does not overwrite a version that already exists", async () => {
    const folder = "version-save-test@1.1.0";
    const before = await readFile(join(root, "harnesses", folder, "harness.json"), "utf8");
    const draft = structuredClone(original);
    draft.manifest.version = "1.1.0";
    draft.manifest.description = "Must not overwrite.";
    expect((await saveVersion(draft)).statusCode).toBe(409);
    expect(await readFile(join(root, "harnesses", folder, "harness.json"), "utf8")).toBe(before);
  });

  it("rejects duplicate name/version even when the target folder does not exist", async () => {
    expect((await saveVersion(structuredClone(original))).statusCode).toBe(422);
    await expect(readFile(join(root, "harnesses", "version-save-test@1.0.0", "harness.json"))).rejects.toThrow();
  });

  it("rejects invalid drafts before writing any version", async () => {
    const draft = structuredClone(original);
    draft.manifest.version = "2.0.0";
    draft.instructions = "";
    expect((await saveVersion(draft)).statusCode).toBe(422);
    await expect(readFile(join(root, "harnesses", "version-save-test@2.0.0", "harness.json"))).rejects.toThrow();
  });

  it("rejects a draft belonging to another harness", async () => {
    const draft = structuredClone(original);
    draft.manifest.version = "2.0.0";
    draft.folder = "another-harness";
    expect((await saveVersion(draft)).statusCode).toBe(400);
    draft.folder = original.folder;
    draft.manifest.name = "another-harness";
    expect((await saveVersion(draft)).statusCode).toBe(400);
  });

  it("still supports copying a saved version without supplying a draft", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/harnesses", headers,
      payload: { mode: "version", name: original.manifest.name, from: original.folder, version: "1.2.0" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<HarnessDetail>().document).toMatchObject({
      manifest: { version: "1.2.0", description: original.manifest.description },
      instructions: original.instructions,
    });
  });

  it("updates the selected folder and version number in place when requested", async () => {
    const draft = structuredClone(original);
    draft.manifest.version = "3.0.0";
    draft.manifest.description = "Replacement in the same folder.";
    const response = await app.inject({
      method: "PUT", url: `/api/harnesses/${original.folder}`, headers, payload: { document: draft },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<HarnessDetail>().document).toMatchObject({
      folder: original.folder, manifest: { version: "3.0.0", description: draft.manifest.description },
    });
    await expect(readFile(join(root, "harnesses", "version-save-test@3.0.0", "harness.json"))).rejects.toThrow();
  });

  it("rejects an in-place change that would duplicate another version", async () => {
    const before = await readFile(join(root, "harnesses", original.folder, "harness.json"), "utf8");
    const draft = structuredClone(original);
    draft.manifest.version = "1.1.0";
    const response = await app.inject({
      method: "PUT", url: `/api/harnesses/${original.folder}`, headers, payload: { document: draft },
    });
    expect(response.statusCode).toBe(422);
    expect(await readFile(join(root, "harnesses", original.folder, "harness.json"), "utf8")).toBe(before);
  });
});
