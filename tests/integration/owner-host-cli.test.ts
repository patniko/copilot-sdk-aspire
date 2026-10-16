import { mkdtemp, rm } from "node:fs/promises";
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
  it("attaches over the harness host's own relay environment and over direct WSS to the same session", async () => {
    const { credential, login } = await testGitHubAccount();
    const fixture = new OwnerHostFixture(inject("databaseUrl"), login, credential);
    const root = await mkdtemp(join(tmpdir(), "owner-host-cli-"));
    const management = new CopilotClient({ mode: "empty", gitHubToken: credential, useLoggedInUser: false, baseDirectory: root, workingDirectory: root, logLevel: "error" });
    const apiKey = randomUUID().repeat(2);
    const harness = "interactive-demo";
    const markers = { relay: `RELAY_REPLY_${randomUUID().slice(0, 8)}`, direct: `DIRECT_REPLY_${randomUUID().slice(0, 8)}`, again: `RELAY_AGAIN_${randomUUID().slice(0, 8)}` };
    const questions = { relay: "Confirm that the relay reached this harness host.", direct: "Confirm the same session over direct WSS.", again: "Confirm the relay resumes it too." };
    let cli: QualificationCli | undefined;
    let api: ReturnType<typeof buildApi> | undefined;
    let listener: JobEventListener | undefined;
    const transcript: string[] = [];
    const attach = async (transport: "github" | "direct", sessionId?: string) => {
      const apiUrl = `http://127.0.0.1:${(api!.server.address() as AddressInfo).port}`;
      const info = await ownerHostConnection({ apiUrl, key: apiKey }, harness, transport, sessionId);
      const launch = ownerHostCliArguments(info, sessionId);
      cli = new QualificationCli(root, credential);
      await cli.launch(launch.args, launch.serverKey ? { COPILOT_AHP_SERVER_KEY: launch.serverKey } : {}, info.token ? [info.token] : []);
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
      listener = new JobEventListener(fixture.pool);
      await listener.start();
      const policies = { base: fixture.policy, overrides: new Map() };
      api = buildApi({
        store: new JobStore(fixture.pool), listener, admission: new Admission({ harnesses: fixture.harnesses, profiles: fixture.profiles, policies }),
        authenticator: new ApiKeyAuthenticator(`dev:${apiKey}`), harnesses: fixture.harnesses, maxOpenJobsPerPrincipal: 10, console: false,
        hosts: {
          store: fixture.store, harnesses: fixture.harnesses, policies, profiles: fixture.profiles,
          hosts: [{ harness, owner: login.toLowerCase(), principal: "dev", transport: "both", execution: "managed", resource: "host-interactive-demo", legacy: false, url: host.endpoint }],
        },
      });
      await api.listen({ host: "127.0.0.1", port: 0 });

      const relay = await attach("github");
      expect(relay).toMatchObject({ transport: "github", environmentId: host.info.environmentId });
      await turn(questions.relay, markers.relay);
      await cli!.stop();
      const [session] = await fixture.store.list(fixture.key(harness));
      expect(session).toBeDefined();
      expect(session!.ahpSessionId).toBeDefined();

      const direct = await attach("direct", session!.ahpSessionId);
      expect(direct).toMatchObject({ transport: "direct", ahpSessionId: session!.ahpSessionId });
      await cli!.waitFor(markers.relay, 120_000);
      await turn(questions.direct, markers.direct);
      expect(JSON.stringify(fixture.requests.at(-1))).toContain(questions.relay);
      await cli!.stop();

      await attach("github", session!.ahpSessionId);
      await cli!.waitFor(markers.direct, 120_000);
      await turn(questions.again, markers.again);
      expect(JSON.stringify(fixture.requests.at(-1))).toContain(questions.direct);
      const sessions = await fixture.store.list(fixture.key(harness));
      expect(sessions.map((entry) => entry.id)).toEqual([session!.id]);
      expect(sessions[0]!.inputTokens).toBeGreaterThan(0);
    } catch (error) {
      let diagnostic = `${transcript.join("\n----\n")}\n----\n${cli?.output ?? ""}`;
      for (const container of fixture.containers) diagnostic += `\n--- host ${container.slice(0, 12)}\n${fixture.logs(container)}`;
      diagnostic = diagnostic.split(credential).join("[redacted]");
      throw new Error(`Owner host CLI qualification failed:\n${diagnostic.slice(-12_000)}`, { cause: error });
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
        }
      }
    }
  }, 900_000);
});
