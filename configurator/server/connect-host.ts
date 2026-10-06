import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostConnection } from "./host-client.js";
import { Settings } from "./settings.js";
import { StatusService } from "./status.js";
import { TryService } from "./try.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "local" },
      transport: { type: "string", default: "direct" },
      cli: { type: "string", default: "copilot" },
      resume: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("pnpm host:connect --target local|azure --transport direct|github [--cli <executable>] [--resume <AHP-session-id>]");
    return;
  }
  if (values.target !== "local" && values.target !== "azure") throw new Error("Target must be local or azure.");
  if (values.transport !== "direct" && values.transport !== "github") throw new Error("Transport must be direct or github.");
  if (values.resume && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(values.resume)) throw new Error("Invalid AHP session ID.");
  const root = resolve(import.meta.dirname, "..", "..");
  let extraEnv: Record<string, string> = {};
  const aspireEnv = () => ({ ...process.env, ...extraEnv });
  const settings = new Settings(root, aspireEnv);
  const nuget = await settings.nugetServiceIndex();
  if (nuget) extraEnv = { ASPIRE_CLI_NUGET_SERVICE_INDEX: nuget };
  const status = new StatusService({ root, aspireEnv });
  const jobs = new TryService(root, settings, status);
  const { info, endpoint } = await hostConnection(values.target, values.transport, { settings, status, jobs });
  const env = { ...process.env };
  for (const name of ["DEMO_HOST_GITHUB_TOKEN", "DEMO_TEST_GITHUB_TOKEN", "Parameters__demo-host-github-token"]) delete env[name];
  const args = ["--experimental"];
  if (values.transport === "direct") {
    const url = new URL(endpoint!);
    url.searchParams.set("tkn", info.token!);
    env.COPILOT_AHP_SERVER_KEY = JSON.stringify({ endpoint, ...info.serverKey });
    args.push("--ahp", url.href);
    if (values.resume) args.push("--resume", values.resume);
    console.log("Connecting to the demo host with a provisioned key and one-time ticket.");
  } else {
    delete env.COPILOT_AHP_SERVER_KEY;
    args.push("--relay", "--environment-id", info.environmentId!);
    if (values.resume) args.push("--resume", values.resume);
    console.log(info.execution === "github-native"
      ? "Connecting through Mission Control using Copilot's models, permissions, and billing."
      : "Connecting through Mission Control to the managed host.");
  }
  await new Promise<void>((resolveExit, reject) => {
    const script = /\.(?:cjs|mjs|js)$/i.test(values.cli);
    const child = spawn(script ? process.execPath : values.cli, script ? [resolve(values.cli), ...args] : args, { stdio: "inherit", env, shell: false });
    child.once("error", () => reject(new Error("Could not launch Copilot. Install a compatible AHP-enabled CLI or provide --cli.")));
    child.once("exit", (code) => { process.exitCode = code ?? 1; resolveExit(); });
  });
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo host connection failed.");
  process.exitCode = 1;
});
