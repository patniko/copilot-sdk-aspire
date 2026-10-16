import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import type { RemoteMcpSession, RemoteMcpToolDescriptor } from "@copilot-agent/service-defaults";
import { combineSignals } from "./web-fetch.js";

/**
 * Exposes described remote MCP tools as SDK tools bound to one conversation's MCP session. Only tools
 * the session approved (operator catalog ∩ harness request) are returned. The runtime's normal
 * custom-tool permission flow still applies; use {@link remoteMcpToolFor} to present such a request
 * as an MCP prompt. Results are already redacted and bounded by the session. `signal` is the
 * conversation activation's lifetime: aborting it cancels in-flight calls.
 */
export function remoteMcpTools(descriptors: readonly RemoteMcpToolDescriptor[], session: RemoteMcpSession, signal?: AbortSignal): Tool[] {
  const approved = new Set(session.toolNames);
  return descriptors.filter((descriptor) => approved.has(descriptor.name)).map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    handler: async (args, invocation): Promise<ToolResultObject> => {
      const outcome = await session.call(descriptor.name, args, combineSignals(invocation.signal, signal));
      return { resultType: outcome.ok ? "success" : "failure", textResultForLlm: outcome.text };
    },
  }));
}

/** Finds the remote MCP tool behind an exposed tool name, for permission prompts (`server:tool`, read-only hint). */
export function remoteMcpToolFor(descriptors: readonly RemoteMcpToolDescriptor[], toolName: string): Pick<RemoteMcpToolDescriptor, "server" | "tool" | "readOnly"> | undefined {
  const name = toolName.startsWith("custom:") ? toolName.slice("custom:".length) : toolName;
  const descriptor = descriptors.find((entry) => entry.name === name);
  return descriptor ? { server: descriptor.server, tool: descriptor.tool, readOnly: descriptor.readOnly } : undefined;
}
