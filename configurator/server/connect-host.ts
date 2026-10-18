import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentPlatform, AgentPlatformError, superviseSessionCli, type ManagedSession } from "@copilot-agent/client";
import { hostConnection } from "./host-client.js";
import { harnessConnectRoute, reprovisionSession, routeTargetProblem } from "./connect-route.js";
import { ownerHostCliArguments, ownerHostConnection } from "./owner-host-client.js";
import { Settings } from "./settings.js";
import { StatusService } from "./status.js";
import { TryService } from "./try.js";
import { harnessHosting, sharedConnection } from "./shared-client.js";

/** The harness `--destination shared` connects to, from before hosting was chosen per harness. */
const LEGACY_SHARED_HARNESS = "hybrid-coordinator";

const SESSION_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * The application session `--resume` names, when the API knows it; otherwise `--resume` keeps naming a runtime
 * session on the single demo host.
 */
async function existingSession(api: { apiUrl: string; key: string }, id: string): Promise<ManagedSession | undefined> {
  if (!SESSION_UUID.test(id)) return undefined;
  try {
    return await new AgentPlatform({ apiUrl: api.apiUrl, apiKey: api.key }).session(id);
  } catch (error) {
    if (error instanceof AgentPlatformError && error.status === 404) return undefined;
    throw error;
  }
}

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
      "  Shared harnesses open a shared conversation. Isolated harnesses use your own per-harness owner host when it offers the",
      "  transport, otherwise a session container (direct only); --resume follows the session to where it lives. Local only.",
      "pnpm host:connect --resume <session-uuid> [--transport direct] [--cli <executable>]",
      "  Attaches to an existing conversation wherever it runs, including one created from a code-defined harness",
      "  (see examples/managed-agent). Local only.",
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
  const session = values.resume && values.harness === undefined && values.destination === undefined && values.target === "local"
    ? await existingSession(await jobs.connection(values.target), values.resume)
    : undefined;
  if (session) {
    // A session without a named harness: attach to it directly. Code-defined (inline) sessions have no published
    // harness to route by, and re-provisioning is a new connection for the same session wherever it now runs.
    const kind = session.view.placement === "shared" ? "shared conversation" : "session container";
    const name = session.view.harness ? ` (${session.view.harness.name})` : "";
    console.log(`Connecting to ${kind} ${session.id}${name} through the connection broker with a one-use ticket. This explicitly authorizes GitHub identity authentication to the provisioned host.`);
    process.exitCode = await session.openCli({ cli: values.cli, transport: values.transport, args, env });
    return;
  }
  const harness = values.harness ?? (values.destination === "shared" ? LEGACY_SHARED_HARNESS : undefined);
  const api = harness ? await jobs.connection(values.target) : undefined;
  const hosting = harness && api ? await harnessHosting(api, harness) : undefined;
  // A named harness is routed by the service's hosting view and never reaches the single demo host below, which may
  // serve a different harness; only --destination container connects to that host.
  const route = hosting && api && harness ? await harnessConnectRoute(api, harness, hosting, values.transport, values.resume) : undefined;
  if (values.destination === "shared" && !(route?.kind === "sessions" && route.placement === "shared")) {
    throw new Error(`The '${LEGACY_SHARED_HARNESS}' harness is not hosted as a shared conversation in this deployment.`);
  }
  // Shared with the Hosting page, which disables the same connections.
  const refusal = route && routeTargetProblem(route, values.target);
  if (refusal) throw new Error(refusal);
  if (route?.kind === "sessions" && api && harness) {
    const kind = route.placement === "shared" ? "shared conversation" : "session container";
    const connection = await sharedConnection(api, {
      harness, transport: values.transport, ...(values.resume ? { resume: values.resume } : {}), ...(values.label ? { label: values.label } : {}),
    });
    console.log(`Connecting to ${kind} ${connection.sessionId} (${harness}) through the connection broker with a one-use ticket. This explicitly authorizes GitHub identity authentication to the provisioned host.`);
    console.log(`Resume later with: pnpm host:connect --harness ${harness} --resume ${connection.sessionId}`);
    // The launcher stays attached: when the session moves (for example after promotion), it re-provisions the same
    // session through the same routing and restarts the CLI in this terminal.
    const script = /\.(?:cjs|mjs|js)$/i.test(values.cli);
    const requested = values.transport;
    process.exitCode = await superviseSessionCli({
      command: script ? process.execPath : values.cli, args: [...(script ? [resolve(values.cli)] : []), ...args], env, connection,
      provision: () => reprovisionSession(api, harness, requested, connection.sessionId),
    });
    return;
  } else if (route?.kind === "owner-host" && api && harness) {
    // An isolated harness: connect to its own owner host over direct WSS or its own relay environment.
    const info = await ownerHostConnection(api, harness, values.transport, values.resume);
    const launch = ownerHostCliArguments(info, values.resume);
    args.splice(0, args.length, ...launch.args);
    delete env.COPILOT_AHP_SERVER_KEY;
    Object.assign(env, launch.env);
    console.log(info.transport === "direct"
      ? `Connecting to the '${harness}' owner host over direct WSS with a pinned key and a one-use ticket. This explicitly authorizes GitHub identity authentication to that host.`
      : `Connecting through Mission Control to the '${harness}' owner host's own environment.`);
  } else {
    // --destination container: the single demo host, which serves its own configured harness.
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