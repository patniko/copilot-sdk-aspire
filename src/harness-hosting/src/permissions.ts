import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { permissionModeFor, type InputRequestBody, type InputResponseBody, type PermissionPrompt, type PermissionsConfig } from "@copilot-agent/contracts";
import type { PermissionHandler, PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";

export type AskInput = (request: InputRequestBody) => Promise<InputResponseBody>;

/** Where the attempt runs. The private workspace plays the role of the Copilot CLI's trusted folder. */
export interface PermissionContext {
  workspace: string;
  /** The SDK session's working directory, used to resolve relative paths. */
  workingDirectory: string;
}

const LIMITS = {
  intention: 1000,
  command: 8000,
  path: 1000,
  url: 2000,
  diff: 20_000,
  tool: 200,
  warning: 1000,
  commandName: 100,
  commandNames: 20,
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

/** Command names in a shell request that are not read-only: what an approval for the run covers. */
function commandNamesNeedingApproval(request: PermissionRequest): string[] {
  if (request.kind !== "shell") return [];
  const names: string[] = [];
  for (const command of request.commands ?? []) {
    const name = command.identifier?.trim();
    if (!command.readOnly && name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function permissionPromptFor(request: PermissionRequest): PermissionPrompt {
  const warning = warningFor(request);
  switch (request.kind) {
    case "shell": {
      const prompt: PermissionPrompt = { type: "shell" };
      setIfPresent(prompt, "intention", truncate(request.intention, LIMITS.intention));
      setIfPresent(prompt, "command", truncate(request.fullCommandText, LIMITS.command));
      const names = commandNamesNeedingApproval(request)
        .map((name) => truncate(name, LIMITS.commandName)!)
        .slice(0, LIMITS.commandNames);
      if (names.length) prompt.commandNames = names;
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

/** Resolves symlinks in the longest existing prefix so a link inside the workspace cannot point a path outside it. */
function canonicalPath(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function isWithin(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const SENSITIVE_DIRECTORY_NAMES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube"]);

/** Mirrors the CLI: never widen a read approval to a filesystem root or a credential directory. */
function readApprovalScope(path: string): string {
  const directory = dirname(path);
  const tooBroad = dirname(directory) === directory || SENSITIVE_DIRECTORY_NAMES.has(basename(directory).toLowerCase());
  return tooBroad ? path : directory;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers the agent's permission requests from the harness rules. `ask` follows the Copilot CLI's
 * interactive defaults: reads inside the workspace, read-only shell commands that stay inside it,
 * and read-only MCP tools run without a prompt; everything else waits for a person. Approving
 * "for the run" (scope `kind`) covers similar requests like the CLI's session approvals: the same
 * command names, all file writes, reads in the same folder, the same website, or the same tool.
 */
export function buildPermissionHandler(
  permissions: PermissionsConfig | undefined,
  ask: AskInput,
  context: PermissionContext,
): PermissionHandler {
  const workspace = canonicalPath(context.workspace);
  const workingDirectory = canonicalPath(context.workingDirectory);
  const approved = {
    commands: new Set<string>(),
    writes: false,
    readScopes: [] as string[],
    hosts: new Set<string>(),
    tools: new Set<string>(),
  };

  const resolveFrom = (base: string, path: string) => canonicalPath(isAbsolute(path) ? path : join(base, path));
  const readable = (path: string) => isWithin(workspace, path) || approved.readScopes.some((scope) => isWithin(scope, path));
  const urlsApproved = (urls: Array<{ url: string }> | undefined) =>
    (urls ?? []).every(({ url }) => {
      const host = hostOf(url);
      return host !== undefined && approved.hosts.has(host);
    });

  const runsWithoutPrompt = (request: PermissionRequest, prompt: PermissionPrompt): boolean => {
    if (("managedApprovalRequired" in request && request.managedApprovalRequired) || bypassWarning(request)) return false;
    switch (request.kind) {
      case "read": {
        const target = request.resolvedPath ?? request.path;
        return !!target && readable(resolveFrom(workingDirectory, target));
      }
      case "shell": {
        const commands = request.commands ?? [];
        if (!commands.length) return false;
        if (!commands.every((command) => command.readOnly || approved.commands.has(command.identifier))) return false;
        if (request.hasWriteFileRedirection && !approved.writes) return false;
        if (!urlsApproved(request.possibleUrls)) return false;
        const base = request.resolvedWorkingDirectory ?? workingDirectory;
        return (request.possiblePaths ?? []).every((path) => path === "/dev/null" || isWithin(workspace, resolveFrom(base, path)));
      }
      case "write":
        return approved.writes;
      case "url": {
        const host = hostOf(request.url);
        return host !== undefined && approved.hosts.has(host);
      }
      case "mcp":
        return request.readOnly === true || approved.tools.has(prompt.tool ?? "");
      default:
        return prompt.tool !== undefined && approved.tools.has(prompt.tool);
    }
  };

  const rememberSimilar = (request: PermissionRequest, prompt: PermissionPrompt) => {
    switch (request.kind) {
      case "shell":
        for (const name of commandNamesNeedingApproval(request)) approved.commands.add(name);
        break;
      case "write":
        approved.writes = true;
        break;
      case "read": {
        const target = request.resolvedPath ?? request.path;
        if (target) approved.readScopes.push(readApprovalScope(resolveFrom(workingDirectory, target)));
        break;
      }
      case "url": {
        const host = hostOf(request.url);
        if (host) approved.hosts.add(host);
        break;
      }
      default:
        if (prompt.tool) approved.tools.add(prompt.tool);
    }
  };

  return async (request) => {
    const prompt = permissionPromptFor(request);
    const mode = permissionModeFor(permissions, policyKindFor(prompt));
    if (mode === "allow") return approve();
    if (mode === "deny") return reject("Not permitted by the job policy.");
    if (runsWithoutPrompt(request, prompt)) return approve();

    const response = await ask({ kind: "permission", permission: prompt });
    if (response.kind === "expired") return reject("No approval was given in time.");
    if (response.kind !== "permission") return reject("Denied by the reviewer.");
    if (!response.approved) return reject(response.feedback ?? "Denied by the reviewer.");
    if (response.scope === "kind") rememberSimilar(request, prompt);
    return approve(true);
  };
}
