import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostConnection } from "./host-client.js";
import { ownerHostCliArguments, ownerHostConnection } from "./owner-host-client.js";
import { Settings } from "./settings.js";
import { StatusService } from "./status.js";
import { TryService } from "./try.js";
import { sharedConnection } from "./shared-client.js";

const USAGE = [
  "pnpm host:connect --harness <name> [--transport direct|github] [--target local] [--resume <session-id>] [--cli <executable>]",
  "pnpm host:connect --destination container|shared --target local|azure --transport direct|github [--cli <executable>] [--resume <session-id>]",
].join("\n");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "local" },
      transport: { type: "string" },
      destination: { type: "string" },
      harness: { type: "string" },
      cli: { type: "string", default: "copilot" },
      resume: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.target !== "local" && values.target !== "azure") throw new Error("Target must be local or azure.");
  if (values.transport !== undefined && values.transport !== "direct" && values.transport !== "github") throw new Error("Transport must be direct or github.");
  if (values.harness !== undefined) {
    if (values.destination !== undefined) throw new Error("Use either --harness (a per-harness owner host) or --destination, not both.");
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(values.harness)) throw new Error("Invalid harness name.");
    if (values.target !== "local") throw new Error("Per-harness owner hosts are local-only until the Azure stage; use --destination container for the deployed demo host.");
  }
  const destination = values.destination ?? "container";
  const transport = values.transport ?? (values.harness ? undefined : "direct");
  if (destination !== "container" && destination !== "shared") throw new Error("Destination must be container or shared.");
  if (destination === "shared" && (values.target !== "local" || transport !== "direct")) {
    throw new Error("Shared hosting currently supports local direct connections only. Azure and relay qualification remain open.");
  }
  if (values.resume && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(values.resume)) throw new Error("Invalid AHP session ID.");
  const root = resolve(import.meta.dirname, "..", "..");
  let extraEnv: Record<string, string> = {};
  const aspireEnv = () => ({ ...process.env, ...extraEnv });
  const settings = new Settings(root, aspireEnv);
  const nuget = await settings.nugetServiceIndex();
  if (nuget) extraEnv = { ASPIRE_CLI_NUGET_SERVICE_INDEX: nuget };
  const status = new StatusService({ root, aspireEnv });
  const jobs = new TryService(root, settings, status);
  const env = { ...process.env };
  for (const name of ["DEMO_HOST_GITHUB_TOKEN", "DEMO_TEST_GITHUB_TOKEN", "Parameters__demo-host-github-token"]) delete env[name];
  const args = ["--experimental"];
  if (values.harness !== undefined) {
    const info = await ownerHostConnection(await jobs.connection("local"), values.harness, transport as "direct" | "github" | undefined, values.resume);
    const launch = ownerHostCliArguments(info, values.resume);
    args.splice(0, args.length, ...launch.args);
    if (launch.serverKey) env.COPILOT_AHP_SERVER_KEY = launch.serverKey;
    else delete env.COPILOT_AHP_SERVER_KEY;
    console.log(info.transport === "direct"
      ? `Connecting to the '${values.harness}' owner host over direct WSS with a pinned key and a one-use ticket. This explicitly authorizes GitHub identity authentication to that host.`
      : `Connecting through Mission Control to the '${values.harness}' owner host's own environment.`);
  } else if (destination === "shared") {
    const connection = await sharedConnection(await jobs.connection("local"), values.resume);
    const url = new URL(connection.url);
    env.COPILOT_AHP_SERVER_KEY = JSON.stringify({ endpoint: url.href, ...connection.serverKey });
    url.searchParams.set("tkn", connection.token);
    args.push("--ahp", url.href, "--ahp-authenticate-with-github", "--resume", connection.sessionId);
    console.log(`Connecting to shared conversation ${connection.sessionId} with a one-use ticket. This explicitly authorizes GitHub identity authentication to the provisioned host.`);
  } else {
    const { info, endpoint } = await hostConnection(values.target, transport as "direct" | "github", { settings, status, jobs });
    if (transport === "direct") {
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
