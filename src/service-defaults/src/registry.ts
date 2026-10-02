import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ExecutionPolicy,
  ExecutionProfile,
  HarnessDefinition,
  type HarnessSnapshot,
} from "@copilot-agent/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ConfigError, optionalEnv } from "./config.js";

/** Root containing harnesses/, execution-profiles/ and policy/. */
export function configRoot(): string {
  return resolve(optionalEnv("CONFIG_ROOT", process.cwd()));
}

/** Canonical JSON with sorted keys, used for digests and idempotency hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  return ajv;
}

/**
 * Loads file-published harnesses. On disk, `harness.json` matches the harness contract except
 * that `instructionsFile` (relative to the harness directory) replaces `instructions`.
 */
export async function loadHarnesses(root = configRoot()): Promise<Map<string, HarnessSnapshot[]>> {
  const directory = join(root, "harnesses");
  const registry = new Map<string, HarnessSnapshot[]>();
  const ajv = createAjv();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const harnessDir = join(directory, entry.name);
    const manifest = JSON.parse(await readFile(join(harnessDir, "harness.json"), "utf8")) as Record<string, unknown>;
    const { instructionsFile, ...rest } = manifest;
    if (typeof instructionsFile !== "string" || instructionsFile.includes("..")) {
      throw new ConfigError(`Harness '${entry.name}' must declare a relative instructionsFile.`);
    }
    const instructions = await readFile(join(harnessDir, instructionsFile), "utf8");
    const parsed = HarnessDefinition.safeParse({ ...rest, instructions });
    if (!parsed.success) {
      throw new ConfigError(`Harness '${entry.name}' is invalid: ${parsed.error.message}`);
    }
    const definition = parsed.data;
    for (const [label, schema] of [
      ["input", definition.input.schema],
      ["output", definition.output.schema],
    ] as const) {
      try {
        ajv.compile(schema);
      } catch (error) {
        throw new ConfigError(`Harness '${definition.name}' ${label} schema is invalid: ${(error as Error).message}`);
      }
    }
    const snapshot: HarnessSnapshot = { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
    const versions = registry.get(definition.name) ?? [];
    if (versions.some((v) => v.definition.version === definition.version)) {
      throw new ConfigError(`Harness '${definition.name}' version ${definition.version} is published twice.`);
    }
    versions.push(snapshot);
    versions.sort((a, b) => compareSemver(b.definition.version, a.definition.version));
    registry.set(definition.name, versions);
  }
  return registry;
}

export async function loadProfiles(root = configRoot()): Promise<Map<string, ExecutionProfile>> {
  const directory = join(root, "execution-profiles");
  const profiles = new Map<string, ExecutionProfile>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const raw = JSON.parse(await readFile(join(directory, entry.name, "profile.json"), "utf8")) as unknown;
    const parsed = ExecutionProfile.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`Execution profile '${entry.name}' is invalid: ${parsed.error.message}`);
    }
    profiles.set(parsed.data.id, parsed.data);
  }
  return profiles;
}

export async function loadPolicy(root = configRoot()): Promise<ExecutionPolicy> {
  const file = optionalEnv("EXECUTION_POLICY_FILE", join(root, "policy", "execution-policy.json"));
  const parsed = ExecutionPolicy.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) {
    throw new ConfigError(`Execution policy is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
