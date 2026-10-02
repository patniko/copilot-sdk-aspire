import { execFileSync } from "node:child_process";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let containerId: string | undefined;

/** Starts a disposable PostgreSQL container unless TEST_DATABASE_URL points at one. */
export async function setup(project: TestProject): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    containerId = execFileSync(
      "docker",
      ["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_DB=jobs", "-p", "127.0.0.1::5432", "postgres:17-alpine"],
      { encoding: "utf8" },
    ).trim();
    const mapping = execFileSync("docker", ["port", containerId, "5432/tcp"], { encoding: "utf8" }).trim().split("\n")[0]!;
    const port = mapping.slice(mapping.lastIndexOf(":") + 1);
    url = `postgresql://postgres:test@127.0.0.1:${port}/jobs`;
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      break;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  project.provide("databaseUrl", url);
}

export async function teardown(): Promise<void> {
  if (containerId) {
    execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
  }
}
