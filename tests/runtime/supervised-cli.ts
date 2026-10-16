/**
 * Runs the launcher's session supervisor for the real CLI in this terminal, as `pnpm host:connect` does for an
 * application session, with re-provisioning through the launcher's routing. The promotion gate starts it in a
 * pseudo-terminal through {@link QualificationCli.supervise}; it is not a product entry point.
 */
import { SharedConnection } from "@copilot-agent/contracts";
import { superviseSessionCli } from "../../configurator/server/cli-supervisor.js";
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("SUPERVISED_")));
  process.exitCode = await superviseSessionCli({
    command: process.execPath, args: [cli, "--experimental"], env, connection,
    provision: () => reprovisionSession(api, harness, connection.transport, connection.sessionId),
    notify: (message) => process.stderr.write(`[launcher] ${message}\r\n`),
  });
}

await main().catch((error: unknown) => {
  process.stderr.write(`[launcher] ${error instanceof Error ? error.message : "Supervision failed."}\r\n`);
  process.exitCode = 1;
});
