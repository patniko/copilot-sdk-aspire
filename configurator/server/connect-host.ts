import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostConnection } from "./host-client.js";
import { ownerHostCliArguments, ownerHostConnection } from "./owner-host-client.js";
import { Settings } from "./settings.js";
import { StatusService } from "./status.js";
import { TryService } from "./try.js";
import { harnessHosting, sharedConnection } from "./shared-client.js";

/** The harness `--destination shared` connects to, from before hosting was chosen per harness. */
const LEGACY_SHARED_HARNESS = "hybrid-coordinator";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      harness: { type: "string" },
      target: { type: "string", default: "local" },
      transport: { type: "string", default: "direct" },
      destination: { type: "string" },
      cli: { type: "string", default: "copilot" },
      resume: { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log([
      "pnpm host:connect --harness <name> --transport direct|github --target local|azure [--resume <session>] [--label <text>] [--cli <executable>]",
      "  Shared harnesses open a shared conversation; isolated harnesses connect to their per-harness owner host (local only).",
      "pnpm host:connect --destination container|shared ...   (container is the single demo host; shared connects to the hybrid-coordinator harness)",
    ].join("\n"));
    return;
  }
  if (values.target !== "local" && values.target !== "azure") throw new Error("Target must be local or azure.");
  if (values.transport !== "direct" && values.transport !== "github") throw new Error("Transport must be direct or github.");
  if (values.destination !== undefined && values.destination !== "container" && values.destination !== "shared") {
    throw new Error("Destination must be container or shared.");
  }
  if (values.harness !== undefined && values.destination !== undefined) throw new Error("Use either --harness or --destination, not both.");
  if (values.harness !== undefined && !/^[a-z][a-z0-9-]{1,62}$/.test(values.harness)) throw new Error("Name a published harness.");
  if (values.resume && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(values.resume)) throw new Error("Invalid session ID.");
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
  const harness = values.harness ?? (values.destination === "shared" ? LEGACY_SHARED_HARNESS : undefined);
  const api = harness ? await jobs.connection(values.target) : undefined;
  const hosting = harness && api ? await harnessHosting(api, harness) : undefined;
  if (hosting?.placement === "shared" && api && harness) {
    if (values.target !== "local") throw new Error("Shared hosting currently supports local connections only. Azure qualification remains open.");
    const transport = hosting.transports.find((entry) => entry.transport === values.transport);
    if (transport?.problem) throw new Error(`${transport.problem.code}: ${transport.problem.message}`);
    if (!values.resume && hosting.problems[0]) throw new Error(`${hosting.problems[0].code}: ${hosting.problems[0].message}`);
    const connection = await sharedConnection(api, {
      harness, transport: values.transport, ...(values.resume ? { resume: values.resume } : {}), ...(values.label ? { label: values.label } : {}),
    });
    const url = new URL(connection.url);
    env.COPILOT_AHP_SERVER_KEY = JSON.stringify({ endpoint: url.href, ...connection.serverKey });
    url.searchParams.set("tkn", connection.token);
    args.push("--ahp", url.href, "--ahp-authenticate-with-github", "--resume", connection.ahpSessionId);
    console.log(`Connecting to shared conversation ${connection.sessionId} (${harness}) through the connection broker with a one-use ticket. This explicitly authorizes GitHub identity authentication to the provisioned host.`);
    console.log(`Resume later with: pnpm host:connect --harness ${harness} --resume ${connection.sessionId}`);
  } else if (hosting && api && harness && values.harness !== undefined) {
    // An isolated harness: connect to its own owner host over direct WSS or its own relay environment.
    if (values.target !== "local") throw new Error("Per-harness owner hosts are local-only until the Azure stage; use --destination container for the deployed demo host.");
    const info = await ownerHostConnection(api, harness, values.transport, values.resume);
    const launch = ownerHostCliArguments(info, values.resume);
    args.splice(0, args.length, ...launch.args);
    delete env.COPILOT_AHP_SERVER_KEY;
    Object.assign(env, launch.env);
    console.log(info.transport === "direct"
      ? `Connecting to the '${harness}' owner host over direct WSS with a pinned key and a one-use ticket. This explicitly authorizes GitHub identity authentication to that host.`
      : `Connecting through Mission Control to the '${harness}' owner host's own environment.`);
  } else {
    const { info, endpoint } = await hostConnection(values.target, values.transport, { settings, status, jobs });
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
  }
  await new Promise<void>((resolveExit, reject) => {
    const script = /\.(?:cjs|mjs|js)$/i.test(values.cli);
    const child = spawn(script ? process.execPath : values.cli, script ? [resolve(values.cli), ...args] : args, { stdio: "inherit", env, shell: false });
    child.once("error", () => reject(new Error("Could not launch Copilot. Install a compatible AHP-enabled CLI or provide --cli.")));
    child.once("exit", (code) => { process.exitCode = code ?? 1; resolveExit(); });
  });
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Host connection failed.");
  process.exitCode = 1;
});