/**
 * Runs the launcher's session supervisor for the real CLI in this terminal, as `pnpm host:connect` does for an
 * application session, with re-provisioning through the launcher's routing. The promotion gate starts it in a
 * pseudo-terminal through {@link QualificationCli.supervise}; it is not a product entry point.
 */
import { SharedConnection } from "@copilot-agent/contracts";
import { superviseSessionCli } from "../../src/agent-client/src/cli-supervisor.js";
import { reprovisionSession } from "../../configurator/server/connect-route.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const api = { apiUrl: required("SUPERVISED_API_URL"), key: required("SUPERVISED_API_KEY") };
  const harness = required("SUPERVISED_HARNESS");
  const cli = required("SUPERVISED_CLI");
  const connection = SharedConnection.parse(JSON.parse(required("SUPERVISED_CONNECTION")));
  const debug = process.env.SUPERVISED_DEBUG === "1";
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("SUPERVISED_")));
  // Numbered so a terminal that repaints earlier output (Windows ConPTY does) cannot make one event look like two.
  let sequence = 0;
  const note = (message: string) => process.stderr.write(`[launcher] #${++sequence} ${message}\r\n`);
  process.exitCode = await superviseSessionCli({
    command: process.execPath, args: [cli, "--experimental"], env, connection,
    provision: async () => {
      const started = Date.now();
      try {
        const next = await reprovisionSession(api, harness, connection.transport, connection.sessionId);
        if (debug) note(`debug: provisioned ${next.destination} key ${next.serverKey.keyId.slice(0, 12)} in ${Date.now() - started} ms`);
        return next;
      } catch (error) {
        if (debug) note(`debug: provisioning failed in ${Date.now() - started} ms: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
        throw error;
      }
    },
    notify: note,
  });
}

await main().catch((error: unknown) => {
  process.stderr.write(`[launcher] ${error instanceof Error ? error.message : "Supervision failed."}\r\n`);
  process.exitCode = 1;
});
