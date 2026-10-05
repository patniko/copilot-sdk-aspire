import { permissionModeFor, type InputRequestBody, type InputResponseBody, type PermissionPrompt, type PermissionsConfig } from "@copilot-agent/contracts";
import type { PermissionHandler, PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";

export type AskInput = (request: InputRequestBody) => Promise<InputResponseBody>;

const LIMITS = {
  intention: 1000,
  command: 8000,
  path: 1000,
  url: 2000,
  diff: 20_000,
  tool: 200,
  warning: 1000,
} as const;

const POLICY_KINDS = new Set(["read", "write", "shell", "url"]);

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function appendIfPresent(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) parts.push(value);
}

function bypassWarning(request: PermissionRequest): string | undefined {
  if (!("requestSandboxBypass" in request) || !request.requestSandboxBypass) return undefined;
  const reason = "requestSandboxBypassReason" in request ? request.requestSandboxBypassReason : undefined;
  return `Sandbox bypass requested${reason ? `: ${reason}` : "."}`;
}

function warningFor(request: PermissionRequest): string | undefined {
  const warnings: string[] = [];
  if ("warning" in request) appendIfPresent(warnings, request.warning);
  appendIfPresent(warnings, bypassWarning(request));
  return truncate(warnings.join("\n") || undefined, LIMITS.warning);
}

function setIfPresent<K extends keyof PermissionPrompt>(
  prompt: PermissionPrompt,
  key: K,
  value: PermissionPrompt[K] | undefined,
): void {
  if (value !== undefined) prompt[key] = value;
}

function toolName(request: PermissionRequest): string {
  const record = request as unknown as Record<string, unknown>;
  for (const key of ["toolName", "tool_name", "toolTitle", "tool_title", "hookName", "workflowName", "extensionName"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return request.kind;
}

export function permissionPromptFor(request: PermissionRequest): PermissionPrompt {
  const warning = warningFor(request);
  switch (request.kind) {
    case "shell": {
      const prompt: PermissionPrompt = { type: "shell" };
      setIfPresent(prompt, "intention", truncate(request.intention, LIMITS.intention));
      setIfPresent(prompt, "command", truncate(request.fullCommandText, LIMITS.command));
      setIfPresent(prompt, "warning", warning);
      return prompt;
    }
    case "write": {
      const prompt: PermissionPrompt = { type: "write" };
      setIfPresent(prompt, "intention", truncate(request.intention, LIMITS.intention));
      setIfPresent(prompt, "path", truncate(request.fileName, LIMITS.path));
      setIfPresent(prompt, "diff", truncate(request.diff || request.newFileContents, LIMITS.diff));
      setIfPresent(prompt, "warning", warning);
      return prompt;
    }
    case "read": {
      const prompt: PermissionPrompt = { type: "read" };
      setIfPresent(prompt, "intention", truncate(request.intention, LIMITS.intention));
      setIfPresent(prompt, "path", truncate(request.path, LIMITS.path));
      setIfPresent(prompt, "warning", warning);
      return prompt;
    }
    case "url": {
      const prompt: PermissionPrompt = { type: "url" };
      setIfPresent(prompt, "intention", truncate(request.intention, LIMITS.intention));
      setIfPresent(prompt, "url", truncate(request.url, LIMITS.url));
      setIfPresent(prompt, "warning", warning);
      return prompt;
    }
    case "mcp": {
      const prompt: PermissionPrompt = { type: "mcp" };
      setIfPresent(prompt, "tool", truncate(`${request.serverName}:${request.toolName}`, LIMITS.tool));
      setIfPresent(prompt, "intention", truncate(request.toolTitle, LIMITS.intention));
      return prompt;
    }
    default: {
      const record = request as unknown as Record<string, unknown>;
      const prompt: PermissionPrompt = { type: "other" };
      setIfPresent(prompt, "tool", truncate(toolName(request), LIMITS.tool));
      const intention =
        typeof record.intention === "string"
          ? record.intention
          : typeof record.toolDescription === "string"
            ? record.toolDescription
            : undefined;
      setIfPresent(prompt, "intention", truncate(intention, LIMITS.intention));
      setIfPresent(prompt, "warning", warning);
      return prompt;
    }
  }
}

function policyKindFor(prompt: PermissionPrompt): string {
  return POLICY_KINDS.has(prompt.type) ? prompt.type : "__default__";
}

function approve(approvedInteractively = false): PermissionRequestResult {
  return approvedInteractively ? { kind: "approve-once", approvedInteractively: true } : { kind: "approve-once" };
}

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

export function buildPermissionHandler(permissions: PermissionsConfig | undefined, ask: AskInput): PermissionHandler {
  const approvedKinds = new Set<PermissionPrompt["type"]>();
  return async (request) => {
    const prompt = permissionPromptFor(request);
    if (approvedKinds.has(prompt.type)) return approve();

    const mode = permissionModeFor(permissions, policyKindFor(prompt));
    if (mode === "allow") return approve();
    if (mode === "deny") return reject("Not permitted by the job policy.");

    const response = await ask({ kind: "permission", permission: prompt });
    if (response.kind === "expired") return reject("No approval was given in time.");
    if (response.kind !== "permission") return reject("Denied by the reviewer.");
    if (!response.approved) return reject(response.feedback ?? "Denied by the reviewer.");
    if (response.scope === "kind") approvedKinds.add(prompt.type);
    return approve(true);
  };
}
