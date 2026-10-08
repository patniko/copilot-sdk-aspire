import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CopilotClient } from "@github/copilot-sdk";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { HostStore, JobStore, migrate } from "@copilot-agent/job-store";
import { loadPolicy } from "@copilot-agent/service-defaults";
import { buildDispatcher } from "../../src/job-dispatcher/src/server.js";

describe.skipIf(process.env.DEMO_GITHUB_HOST_TESTS !== "1")("GitHub-native host in Docker", () => {
  it("registers without managed factories and restores the environment and workspace", async () => {
    const githubToken = process.env.DEMO_TEST_GITHUB_TOKEN;
    const owner = process.env.DEMO_TEST_GITHUB_OWNER?.toLowerCase();
    if (!githubToken || !owner) throw new Error("Provide explicit GitHub credentials for this opt-in integration test.");
    const docker = (...args: string[]) => execFileSync("docker", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DEMO_HOST_GITHUB_TOKEN: githubToken },
    }).trim();
    const pool = new pg.Pool({ connectionString: inject("databaseUrl") });
    await migrate(pool);
    await pool.query("TRUNCATE demo_host, hosted_sessions, hosted_connection_tickets CASCADE");
    const policy = await loadPolicy(join(import.meta.dirname, "..", "..", "examples", "customer-config"));
    const store = new HostStore(pool);
    const serviceKey = randomUUID().repeat(2);
    const signingKey = randomUUID().repeat(2);
    const dispatcher = buildDispatcher({
      store: new JobStore(pool), hostStore: store, policies: { base: policy, overrides: new Map() },
      executorKey: "unused".repeat(8), gatewayKey: "unused-gateway".repeat(4), signingKey,
      host: { store, key: serviceKey, owner, execution: "github-native", policy, signingKey },
    });
    await dispatcher.listen({ host: "0.0.0.0", port: 0 });
    const managementHome = await mkdtemp(join(tmpdir(), "github-host-management-"));
    const management = new CopilotClient({
      mode: "empty", gitHubToken: githubToken, useLoggedInUser: false,
      baseDirectory: managementHome, workingDirectory: managementHome, logLevel: "error",
    });
    const volume = `github-host-test-${randomUUID()}`;
    docker("volume", "create", volume);
    const environments = new Set<string>();
    let container: string | undefined;
    const logs = () => {
      const result = spawnSync("docker", ["logs", "--tail", "80", container!], { encoding: "utf8" });
      let text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      for (const secret of [githubToken, serviceKey, signingKey]) text = text.split(secret).join("[redacted]");
      return text.replace(/https?:\/\/\S+/g, "[url]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
    };
    async function start(): Promise<{ environmentId: string }> {
      container = docker("run", "-d", "--platform", "linux/amd64", "-p", "127.0.0.1::8080", "-v", `${volume}:/data`,
        ...(process.env.DEMO_HOST_TEST_SOURCE === "1"
          ? ["-v", `${join(import.meta.dirname, "..", "..", "src", "agent-host", "dist")}:/app/src/agent-host/dist:ro`] : []),
        "-e", "DEMO_HOST_TRANSPORT=github", "-e", `DEMO_HOST_OWNER=${owner}`,
        "-e", "DEMO_HOST_GITHUB_TOKEN", "-e", `DEMO_HOST_KEY=${serviceKey}`,
        "-e", "DEMO_HOST_HARNESS=not-a-managed-harness", "-e", "LOG_LEVEL=error",
        "-e", `JOB_DISPATCHER_URL=http://host.docker.internal:${(dispatcher.server.address() as AddressInfo).port}`,
        process.env.DEMO_GITHUB_HOST_TEST_IMAGE ?? "copilot-aspire-agent-host:native-demo");
      const endpoint = `http://${docker("port", container, "8080/tcp").split("\n")[0]}`;
      const deadline = Date.now() + 90_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (docker("inspect", "--format", "{{.State.Running}}", container!) !== "true") {
          throw new Error("GitHub-native host exited before readiness.");
        }
        const response = await fetch(`${endpoint}/health`).catch(() => undefined);
        if (response?.status === 200) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error("GitHub-native host did not become ready within 90 seconds.");
      const info: unknown = await (await fetch(endpoint)).json();
      expect(info).toMatchObject({ execution: "github-native", transport: "github", ready: true });
      if (!info || typeof info !== "object" || !("environmentId" in info) || typeof info.environmentId !== "string") {
        throw new Error("The native host did not publish its environment ID.");
      }
      environments.add(info.environmentId);
      return { environmentId: info.environmentId };
    }
    try {
      const first = await start();
      await management.start();
      const { environment } = await management.rpc.environments.get(first);
      expect(environment.id).toBe(first.environmentId);
      expect(await store.status(owner)).toMatchObject({ execution: "github-native", online: true, environmentId: first.environmentId });
      await expect(store.issueConnection(owner)).rejects.toThrow(/not ready/);
      const epoch = (await pool.query<{ epoch: string }>("SELECT epoch FROM demo_host WHERE id = 1")).rows[0]!.epoch;
      const unsupported = await dispatcher.inject({
        method: "POST", url: "/internal/host/session", headers: { "x-internal-key": serviceKey },
        payload: { epoch, sessionId: randomUUID(), resume: false },
      });
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json()).toMatchObject({ error: { code: "native_host" } });
      expect(docker("exec", "-u", "10001", container!, "node", "-e",
        "try{require('node:fs').readFileSync('/proc/1/environ');process.exitCode=1}catch(e){if(e.code!=='EACCES')throw e;console.log('protected')}")).toBe("protected");
      docker("exec", "-u", "10001", container!, "node", "-e",
        "require('node:fs').writeFileSync('/data/github-native/workspace/retained.txt','native-persistence')");
      docker("stop", "--time", "25", container!);
      docker("rm", container!);
      container = undefined;
      const second = await start();
      expect(second.environmentId).toBe(first.environmentId);
      expect(docker("exec", "-u", "10001", container!, "node", "-e",
        "process.stdout.write(require('node:fs').readFileSync('/data/github-native/workspace/retained.txt','utf8'))")).toBe("native-persistence");
    } catch (error) {
      if (container) {
        process.stderr.write(`${logs()}\n`);
      }
      throw error;
    } finally {
      if (container) {
        docker("stop", "--time", "25", container);
        docker("rm", container);
      }
      for (const environmentId of environments) await management.rpc.environments.delete({ environmentId });
      await management.stop();
      await rm(managementHome, { recursive: true, force: true });
      docker("volume", "rm", volume);
      await dispatcher.close();
      await pool.end();
    }
  }, 240_000);
});
