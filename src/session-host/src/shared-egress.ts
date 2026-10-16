import type { Tool } from "@github/copilot-sdk";
import type { PermissionMode } from "@copilot-agent/contracts";
import {
  EgressFilter, environmentSecretResolver, internalEndpointsFromEnvironment, RemoteMcpCatalogClient,
  type InternalEndpoint, type RemoteMcpRefusal, type RemoteMcpReport, type RemoteMcpServerConfigInput, type RemoteMcpToolDescriptor,
  type SecretResolver,
} from "@copilot-agent/service-defaults";
import { remoteMcpTools } from "./remote-mcp-tools.js";
import { webFetchTool } from "./web-fetch.js";

/** One conversation activation. Aborting `signal` cancels its in-flight requests and ends its MCP sessions. */
export interface SharedEgressContext {
  sessionId: string;
  signal: AbortSignal;
}

/** A remote MCP server a harness requested, with the effective operator policy entry for it. */
export interface SharedMcpServer {
  /** Catalog name: the harness's `mcpServers[].server`. */
  name: string;
  /** The effective policy's `mcpServers[name]`: url, auth, approved tools, and `allowPrivateNetwork`. `auth.secret` is resolved here. */
  policy: RemoteMcpServerConfigInput;
  /** The harness's `mcpServers[].tools`. Only tools the policy also approves are exposed. */
  tools: string[];
}

export interface SharedMcpConnection {
  /** SDK custom tools named `mcp_<server>_<tool>` (or a stable hashed form). */
  tools: Tool[];
  /** For permission prompts; see `remoteMcpToolFor`. */
  descriptors: RemoteMcpToolDescriptor[];
  /** Requested servers or tools the policy does not approve. They are not exposed. */
  refused: RemoteMcpRefusal[];
  /** Ends this activation's MCP sessions. Also runs when the context signal aborts. */
  close(): Promise<void>;
}

/** The surface a shared worker uses to give a conversation filtered web access and remote MCP tools. */
export interface SharedEgress {
  /** The filtered replacement for the runtime's built-in `web_fetch`. `urlRule` is the harness `url` permission mode. */
  webFetch(ctx: SharedEgressContext & { urlRule: PermissionMode }): Tool;
  /** Remote MCP tools for one activation. Pass all of the harness's servers in one call so tool names are checked together. */
  connectMcp(servers: readonly SharedMcpServer[], ctx: SharedEgressContext): Promise<SharedMcpConnection>;
}

export interface SharedEgressOptions {
  /** Defaults to a filter that also refuses this deployment's service-discovery and connection-string endpoints. */
  egress?: EgressFilter;
  /** More internal endpoints for the default filter, such as the worker's own public listener. */
  internal?: InternalEndpoint[];
  /** Defaults to `MCP_SECRET_<UPPER_SNAKE>` environment variables, as Aspire secret parameters arrive locally. */
  secrets?: SecretResolver;
  /** Identifiers and outcomes only: never URLs, arguments, results, or credentials. */
  report?: RemoteMcpReport;
}

/** One per shared worker process. */
export function createSharedEgress(options: SharedEgressOptions = {}): SharedEgress {
  const egress = options.egress ?? new EgressFilter({ internal: [...internalEndpointsFromEnvironment(), ...(options.internal ?? [])] });
  const secrets = options.secrets ?? environmentSecretResolver();
  const report = options.report ?? (() => undefined);
  const clients = new Map<string, RemoteMcpCatalogClient>();
  return {
    webFetch: (ctx) => webFetchTool({ egress, urlRule: ctx.urlRule, signal: ctx.signal, report }),
    connectMcp: async (servers, ctx) => {
      const catalog = Object.fromEntries(servers.map((server) => [server.name, server.policy]));
      // Effective policies can differ per harness; reuse one client, and its cached tool lists, per catalog.
      const key = JSON.stringify(catalog);
      let client = clients.get(key);
      if (!client) {
        client = new RemoteMcpCatalogClient({ catalog, egress, secrets, report });
        clients.set(key, client);
      }
      const selections = servers.map((server) => ({ server: server.name, tools: server.tools }));
      const described = await client.describe(selections, ctx.signal);
      const session = client.session(selections);
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= session.close());
      ctx.signal.addEventListener("abort", () => { void close(); }, { once: true });
      return { tools: remoteMcpTools(described.tools, session, ctx.signal), descriptors: described.tools, refused: described.refused, close };
    },
  };
}
