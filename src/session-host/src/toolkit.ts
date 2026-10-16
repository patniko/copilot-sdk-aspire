import type { Tool } from "@github/copilot-sdk";
import { permissionModeFor, SHARED_WORKER_BINDINGS } from "@copilot-agent/contracts";
import type { SharedSessionRecord, SharedTurn } from "@copilot-agent/job-store";
import type { SharedActivationPlan } from "./admission.js";
import type { ToolRule } from "./permissions.js";
import { remoteMcpToolFor } from "./remote-mcp-tools.js";
import type { SharedActivationContext } from "./runtime.js";
import type { SharedEgress } from "./shared-egress.js";
import { delegationTools, taskListTools, workspaceTools, type DelegationDependencies, type SharedTool } from "./tools.js";

export interface SharedToolkitOptions {
  /** Filtered web access and remote MCP; required for harnesses that request either. */
  egress?: SharedEgress;
  /** One-shot container delegation; required for harnesses that request the delegation bindings. */
  delegation?: DelegationDependencies;
}

export interface SharedToolset {
  tools: Tool[];
  rules: Map<string, ToolRule>;
}

const DELEGATION = new Set<string>(SHARED_WORKER_BINDINGS);
const urlOf = (args: unknown) => (args && typeof args === "object" && "url" in args && typeof args.url === "string" ? args.url : undefined);

/**
 * The base tool set for one shared activation (docs/HOSTING-MODES-PLAN.md, section 7.2): workspace files for `files`,
 * filtered `web_fetch` for `web`, approved remote MCP tools, the task list, and the harness's in-process host bindings.
 * Remote MCP sessions end with the activation.
 */
export async function sharedToolset(
  plan: SharedActivationPlan,
  session: SharedSessionRecord,
  context: SharedActivationContext,
  currentTurn: () => SharedTurn,
  options: SharedToolkitOptions,
): Promise<SharedToolset> {
  const { definition } = plan;
  const entries: SharedTool[] = [];
  if (definition.builtinTools?.includes("files")) entries.push(...workspaceTools(context));
  entries.push(...taskListTools(context));
  const egressContext = { sessionId: session.id, signal: context.signal };
  if (definition.builtinTools?.includes("web")) {
    if (!options.egress) throw new Error("Web access needs the shared worker's egress filter.");
    entries.push({
      tool: options.egress.webFetch({ ...egressContext, urlRule: permissionModeFor(definition.permissions, "url") }),
      rule: { kind: "url", target: urlOf },
    });
  }
  if (definition.mcpServers?.length) {
    if (!options.egress) throw new Error("Remote MCP tools need the shared worker's egress filter.");
    const catalog = plan.policy.mcpServers ?? {};
    const connection = await options.egress.connectMcp(definition.mcpServers.map(({ server, tools }) => {
      const policy = Object.hasOwn(catalog, server) ? catalog[server] : undefined;
      if (!policy) throw new Error("A requested remote MCP server is not in the operator catalog.");
      return { name: server, policy, tools };
    }), egressContext);
    for (const tool of connection.tools) {
      const remote = remoteMcpToolFor(connection.descriptors, tool.name);
      // A remote server's read-only hint is untrusted, so remote tools never run quietly under `ask`.
      entries.push({
        tool,
        rule: { kind: "mcp", target: () => (remote ? `${remote.server}:${remote.tool}` : undefined) },
      });
    }
  }
  const bindings = definition.tools.filter((tool) => tool.kind === "host" && DELEGATION.has(tool.binding));
  if (bindings.length) {
    if (!options.delegation) throw new Error("Container delegation is not configured on this shared worker.");
    entries.push(...delegationTools(bindings, session, plan.delegation, context, currentTurn, options.delegation));
  }
  const rules = new Map<string, ToolRule>();
  for (const entry of entries) {
    if (rules.has(entry.tool.name)) throw new Error(`Two shared tools are named '${entry.tool.name}'.`);
    rules.set(entry.tool.name, entry.rule);
  }
  return { tools: entries.map((entry) => entry.tool), rules };
}
