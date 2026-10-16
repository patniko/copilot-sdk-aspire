import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CopilotClient } from "@github/copilot-sdk";
import { describe, expect, inject, it } from "vitest";
import { JobEventListener, JobStore } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator } from "@copilot-agent/service-defaults";
import { buildApi } from "../../src/agent-api/src/server.js";
import { ownerHostCliArguments, ownerHostConnection } from "../../configurator/server/owner-host-client.js";
import { testGitHubAccount } from "../runtime/account.js";
import { QualificationCli } from "../runtime/cli.js";
import { OwnerHostFixture } from "./fixtures/owner-host-runtime.js";

const enabled = process.env.OWNER_HOST_CLI_TESTS === "1";

describe.skipIf(!enabled)("real Copilot CLI on a per-harness owner host", () => {
  it("attaches over the harness host's own relay environment and over direct WSS through the broker to the same session", async () => {
    const { credential, login } = await testGitHubAccount();
    const fixture = new OwnerHostFixture(inject("databaseUrl"), login, credential);
    const root = await mkdtemp(join(tmpdir(), "owner-host-cli-"));
    const home = await mkdtemp(join(tmpdir(), "owner-host-cli-home-"));
    const management = new CopilotClient({ mode: "empty", gitHubToken: credential, useLoggedInUser: false, baseDirectory: root, workingDirectory: root, logLevel: "error" });
    const apiKey = randomUUID().repeat(2);
    const harness = "interactive-demo";
    const markers = { relay: `RELAY_REPLY_${randomUUID().slice(0, 8)}`, direct: `DIRECT_REPLY_${randomUUID().slice(0, 8)}`, again: `RELAY_AGAIN_${randomUUID().slice(0, 8)}` };
    const questions = { relay: "Confirm that the relay reached this harness host.", direct: "Confirm the same session over direct WSS.", again: "Confirm the relay resumes it too." };
    let cli: QualificationCli | undefined;
    let api: ReturnType<typeof buildApi> | undefined;
    let listener: JobEventListener | undefined;
    const transcript: string[] = [];
    const attach = async (transport: "github" | "direct", sessionId?: string, relayClientOnDirect = false) => {
      const apiUrl = `http://127.0.0.1:${(api!.server.address() as AddressInfo).port}`;
      const info = await ownerHostConnection({ apiUrl, key: apiKey }, harness, transport, sessionId);
      const launch = ownerHostCliArguments(info, sessionId);
      cli = new QualificationCli(root, credential);
      // One private CLI home, like one client machine, leaves the user's own home untouched. It enables the staff-gated
      // client each transport needs; the launcher's own environment turns the relay client off for direct launches,
      // unless this leg keeps it on to check the runtime's own fix.
      const env: Record<string, string> = { ...launch.env };
      if (relayClientOnDirect) delete env.RELAY_CLIENT;
      const flags = transport === "github" ? "RELAY_CLIENT" : relayClientOnDirect ? "AHP_CLIENT,RELAY_CLIENT" : "AHP_CLIENT";
      await cli.launch(launch.args, { COPILOT_HOME: home, COPILOT_CLI_ENABLED_FEATURE_FLAGS: flags, ...env }, info.token ? [info.token] : []);
      return info;
    };
    const turn = async (question: string, marker: string) => {
      await cli!.send(question);
      await cli!.waitFor(marker, 120_000);
      transcript.push(cli!.output);
    };
    fixture.reply = (messages) => {
      const text = JSON.stringify(messages);
      return text.includes(questions.again) ? markers.again : text.includes(questions.direct) ? markers.direct : markers.relay;
    };
    try {
      await fixture.start([{ harness, transport: "both" }]);
      const host = await fixture.startHost({ harness, transport: "both" });
      const brokerUrl = await fixture.startBroker([{ spec: { harness, transport: "both" }, host }]);
      listener = new JobEventListener(fixture.pool);
      await listener.start();
      const policies = { base: fixture.policy, overrides: new Map() };
      api = buildApi({
        store: new JobStore(fixture.pool), listener, admission: new Admission({ harnesses: fixture.harnesses, profiles: fixture.profiles, policies }),
        authenticator: new ApiKeyAuthenticator(`dev:${apiKey}`), harnesses: fixture.harnesses, maxOpenJobsPerPrincipal: 10, console: false,
        hosts: {
          store: fixture.store, harnesses: fixture.harnesses, policies, profiles: fixture.profiles,
          hosts: [{ harness, owner: login.toLowerCase(), principal: "dev", transport: "both", execution: "managed", resource: "host-interactive-demo", legacy: false, url: host.endpoint }],
          brokerUrl,
        },
      });
      await api.listen({ host: "127.0.0.1", port: 0 });

      const relay = await attach("github");
      expect(relay).toMatchObject({ transport: "github", environmentId: host.info.environmentId });
      await turn(questions.relay, markers.relay);
      await cli!.stop();
      // The host records the CLI's own AHP session ID for the session it created; resume uses it on either transport.
      await expect.poll(async () => (await fixture.store.list(fixture.key(harness)))[0]?.ahpSessionId, { timeout: 20_000 }).toBeTruthy();
      const [session] = await fixture.store.list(fixture.key(harness));

      const direct = await attach("direct", session!.ahpSessionId);
      // Direct WSS goes through the connection broker's path for this harness, which exchanges the one-use ticket.
      expect(direct).toMatchObject({ transport: "direct", ahpSessionId: session!.ahpSessionId, url: `${brokerUrl.replace("http:", "ws:")}/hosts/${harness}` });
      await cli!.waitFor(markers.relay, 120_000);
      expect(fixture.broker!.connections).toBe(1);
      await turn(questions.direct, markers.direct);
      expect(JSON.stringify(fixture.requests.at(-1))).toContain(questions.relay);
      await cli!.stop();

      await attach("github", session!.ahpSessionId);
      await cli!.waitFor(markers.direct, 120_000);
      await turn(questions.again, markers.again);
      expect(JSON.stringify(fixture.requests.at(-1))).toContain(questions.direct);
      await cli!.stop();

      // Runtime c8c5839 and later skip relay-resume inference when --ahp names a host, so this home, which attached the
      // session over the relay, resumes it directly even with the relay client on. The launcher still turns the relay
      // client off for direct launches, for older CLIs.
      await attach("direct", session!.ahpSessionId, true);
      await cli!.waitFor(markers.again, 120_000);
      expect(fixture.broker!.connections).toBe(1);
      const sessions = await fixture.store.list(fixture.key(harness));
      expect(sessions.map((entry) => entry.id)).toEqual([session!.id]);
      expect(sessions[0]!.inputTokens).toBeGreaterThan(0);
    } catch (error) {
      let diagnostic = "";
      for (const container of fixture.containers) {
        diagnostic += `--- host ${container.slice(0, 12)}\n${fixture.logs(container)}\n--- host runtime logs\n${fixture.runtimeLogs(container)}\n`;
      }
      const logs = join(home, "logs");
      const files = (await readdir(logs).catch(() => [] as string[])).filter((file) => file.endsWith(".log"));
      const dated = await Promise.all(files.map(async (file) => ({ file, at: (await stat(join(logs, file))).mtimeMs })));
      for (const { file } of dated.sort((a, b) => b.at - a.at).slice(0, 4)) {
        const lines = (await readFile(join(logs, file), "utf8")).split("\n").filter((line) => !line.includes("poll loop error"));
        diagnostic += `--- client log ${file}\n${fixture.redact(lines.slice(-50).join("\n"))}\n`;
      }
      const sessions = await fixture.store.list(fixture.key(harness)).catch(() => []);
      diagnostic += `--- hosted sessions: ${sessions.length}; model requests: ${fixture.requests.length}\n`;
      diagnostic += `${transcript.join("\n----\n")}\n----\n${cli?.output ?? ""}\n---- screen\n${cli?.screen.split("\n").filter((line) => line.trim()).join("\n") ?? ""}`;
      diagnostic = diagnostic.split(credential).join("[redacted]");
      if (process.env.OWNER_HOST_CLI_TRANSCRIPT) await writeFile(process.env.OWNER_HOST_CLI_TRANSCRIPT, diagnostic);
      throw new Error(`Owner host CLI qualification failed:\n${diagnostic.slice(0, 3000)}\n...\n${diagnostic.slice(-6000)}`, { cause: error });
    } finally {
      try { await cli?.stop(); }
      finally {
        try {
          await api?.close();
          await listener?.stop();
          await fixture.close();
        } finally {
          if (fixture.environments.size) {
            await management.start();
            for (const environmentId of fixture.environments) await management.rpc.environments.delete({ environmentId });
          }
          await management.stop();
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    }
  }, 900_000);
});
