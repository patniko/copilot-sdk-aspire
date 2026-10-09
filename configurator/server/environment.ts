import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export async function loadLocalEnvironment(root: string): Promise<void> {
  let values: Record<string, string | undefined>;
  try {
    values = parseEnv(await readFile(join(root, ".env.local"), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
}
