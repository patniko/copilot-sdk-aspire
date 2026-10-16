import { permissionModeFor, type HarnessDefinition } from "@copilot-agent/contracts";
import type { PermissionHandler } from "@github/copilot-sdk";

const READ_TOOLS = new Set(["view", "glob", "grep"]);
const WRITE_TOOLS = new Set(["create", "edit", "apply_patch"]);
const SHELL_TOOLS = new Set(["bash", "read_bash", "write_bash", "stop_bash", "list_bash", "powershell", "read_powershell", "write_powershell", "stop_powershell", "list_powershell"]);

/** The harness permission kind that governs a built-in tool, or undefined when no per-kind rule covers it. */
export function hostToolKind(toolName: string): "read" | "write" | "shell" | "url" | undefined {
  const name = toolName.replace(/^builtin:/, "");
  return READ_TOOLS.has(name) ? "read" : WRITE_TOOLS.has(name) ? "write" : SHELL_TOOLS.has(name) ? "shell" : name === "web_fetch" ? "url" : undefined;
}

export function hostToolGuard(
  definition: HarnessDefinition,
  availableTools: readonly string[],
  toolName: string,
): { permissionDecision: "deny" | "ask"; permissionDecisionReason: string } | undefined {
  const names = new Set(availableTools.flatMap((name) => [name, name.replace(/^(builtin|custom):/, "")]));
  if (!names.has(toolName)) return { permissionDecision: "deny", permissionDecisionReason: "Tool not admitted by the host harness." };
  if (definition.tools.some((tool) => tool.name === toolName || `custom:${tool.name}` === toolName)) return undefined;
  const kind = hostToolKind(toolName);
  if (kind && permissionModeFor(definition.permissions, kind) === "deny") {
    return { permissionDecision: "deny", permissionDecisionReason: "Denied by the host permission policy." };
  }
  if (kind && permissionModeFor(definition.permissions, kind) === "ask") {
    return { permissionDecision: "ask", permissionDecisionReason: "The host requires review for this action." };
  }
  return undefined;
}

/**
 * The AHP participant owns human prompts; the application never fabricates approval. A pre-tool hook confirmation
 * (`kind: "hook"`) exists because hostToolGuard asked a person to review the gated tool, so the gated tool's rule
 * applies, not the harness default that a `hook` kind would otherwise fall back to: a person decides unless that
 * rule denies.
 */
export function hostPermissionHandler(definition: HarnessDefinition): PermissionHandler {
  return (request) => {
    if (request.kind === "hook") {
      const kind = hostToolKind(request.toolName);
      return kind && permissionModeFor(definition.permissions, kind) === "deny"
        ? { kind: "reject", feedback: "Denied by the host permission policy." }
        : { kind: "no-result" };
    }
    const mode = permissionModeFor(definition.permissions, request.kind);
    if (mode === "deny") return { kind: "reject", feedback: "Denied by the host permission policy." };
    if (mode === "allow") return { kind: "approve-once" };
    return { kind: "no-result" };
  };
}
