/**
 * Managed-agent launcher: define an agent in code, have the platform create and run it, then jump into the Copilot
 * CLI attached to it over AHP. One agent per hosting offering (see agents.ts). Run from the repository root with
 * `pnpm agent:demo -- --mode shared|isolated|promotable|orchestrator`.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { AgentDefinitionError, AgentPlatform, AgentPlatformError, defineAgent, type AgentSpec } from "../../src/agent-client/src/index.js";
import { demoAgent, MODES, type DemoMode } from "./agents.js";

const HYBRID_CLI = "C:\\projects\\copilot-agent-runtime-hybrid\\dist-cli\\index.js";
const HELP = `pnpm agent:demo -- [--mode shared|isolated|promotable|orchestrator] [--model <id>] [--cli <path>] [--label <text>]
                   [--dry-run] [--show-policy-refusal]

  Defines an agent in code for the chosen hosting offering, creates it as a managed session on the local platform, and
  opens the Copilot CLI attached to it.
    shared        multi-tenant: many conversations in one runtime, no container
    isolated      its own session container with a shell (default)
    promotable    starts shared and promotes itself into a container when it needs a shell
    orchestrator  a shared coordinator that starts workers in their own containers
  --dry-run only creates the session and prints how to attach later. --show-policy-refusal first submits variants the
  platform refuses, to show where the limits are enforced. Helpers: pnpm agent:ops -- --help`;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    mode: { type: "string" },
    /** Earlier name for --mode. */
    hosting: { type: "string" },
    model: { type: "string", default: "github/claude-sonnet-5.5" },
    cli: { type: "string", default: existsSync(HYBRID_CLI) ? HYBRID_CLI : "copilot" },
    label: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "show-policy-refusal": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
const mode = (values.mode ?? values.hosting ?? "isolated") as DemoMode;
if (!MODES.includes(mode)) {
  console.error(`--mode must be one of ${MODES.join(", ")}.`);
  process.exit(2);
}
const demo = demoAgent(mode, values.model);
const spec: AgentSpec = demo.spec;

async function main(): Promise<void> {
  const agent = defineAgent(spec);
  const platform = await AgentPlatform.local();

  if (values["show-policy-refusal"]) await showRefusals(platform);

  console.log(`Creating '${agent.name}' (${mode}) on ${platform.apiUrl} ...`);
  const session = await platform.createSession(agent, { label: values.label ?? `${mode} demo` });
  const { view } = session;
  const where = view.placement === "shared"
    ? "shared worker (no container)"
    : `session container${view.container ? ` (${view.container.state}, ${view.container.size})` : ""}`;
  console.log([
    "",
    `  agent      ${agent.name}@${agent.version}`,
    `  digest     ${view.harness?.digest ?? "(not reported)"}`,
    `  model      ${view.model}`,
    `  hosting    ${view.mode} -> ${where}`,
    `  session    ${view.id}`,
    `  budget     ${view.budget.remainingTokens.toLocaleString()} tokens`,
    "",
    wrap(demo.story),
    "",
    "Try:",
    ...demo.prompts.map((prompt) => `  - ${prompt.replaceAll("<id>", view.id)}`),
    "",
    `Attach later with: pnpm host:connect --resume ${view.id} --cli "${values.cli}"`,
    "",
  ].join("\n"));

  if (values["dry-run"]) return;
  console.log("Opening the Copilot CLI on this session over AHP. Exit the CLI to return; the session keeps running.\n");
  process.exitCode = await session.openCli({ cli: values.cli });
}

function wrap(text: string, width = 110): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = ""; }
    line = line ? `${line} ${word}` : word;
  }
  return [...lines, line].join("\n");
}

/** Two refusals: one the schema catches locally, and one only operator policy in the service can make. */
async function showRefusals(platform: AgentPlatform): Promise<void> {
  console.log("1) Shell commands on shared hosting (checked locally by defineAgent):");
  try {
    defineAgent({ ...spec, hosting: "shared", builtinTools: ["files", "shell"] });
  } catch (error) {
    if (!(error instanceof AgentDefinitionError)) throw error;
    console.log(indent(error.message));
  }
  console.log("\n2) A model the operator has not approved (checked by the platform):");
  try {
    const session = await platform.createSession(defineAgent({ ...spec, model: "unapproved/frontier-model" }), { label: "refused" });
    console.log(indent(`Unexpectedly accepted as ${session.id}; closing it.`));
    await session.close();
  } catch (error) {
    if (!(error instanceof AgentPlatformError)) throw error;
    console.log(indent(describe(error)));
  }
  console.log("");
}

function describe(error: AgentPlatformError): string {
  const lines = [`${error.status} ${error.code ?? "error"}: ${error.message}`];
  const details = error.details as { issues?: Array<{ path?: string; message?: string }>; path?: string } | undefined;
  for (const issue of details?.issues ?? []) lines.push(`  - ${issue.path ?? ""}: ${issue.message ?? ""}`);
  if (typeof details?.path === "string") lines.push(`  at ${details.path}`);
  return lines.join("\n");
}

function indent(text: string): string {
  return text.split("\n").map((line) => `   ${line}`).join("\n");
}

await main().catch((error: unknown) => {
  if (error instanceof AgentPlatformError) {
    console.error(describe(error));
    if (error.code === "inline_harnesses_disabled") {
      console.error("Set \"allowInlineHarnesses\": true in .copilot-agent-workspace/policy/execution-policy.json and restart the stack.");
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
