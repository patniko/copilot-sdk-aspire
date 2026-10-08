import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PermissionPrompt, type InputResponseBody, type PermissionsConfig } from "@copilot-agent/contracts";
import { buildPermissionHandler, permissionPromptFor } from "../../src/harness-hosting/src/permissions.js";

type PermissionRequestForTest = Parameters<typeof permissionPromptFor>[0];
const request = (value: Record<string, unknown>) => value as unknown as PermissionRequestForTest;

const root = mkdtempSync(join(tmpdir(), "runner-permissions-"));
const workspace = join(root, "attempt");
const files = join(workspace, "files");
const outside = join(root, "outside");
mkdirSync(files, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "secret");
symlinkSync(outside, join(files, "escape"), "junction");
const context = { workspace, workingDirectory: files };
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function decide(
  permissions: PermissionsConfig | undefined,
  req: PermissionRequestForTest,
  response: InputResponseBody = { kind: "expired" },
) {
  const ask = vi.fn(async () => response);
  const result = await buildPermissionHandler(permissions, ask, context)(req, { sessionId: "s" });
  return { result, ask };
}

const shell = (fields: Record<string, unknown>) =>
  request({
    kind: "shell",
    intention: "inspect",
    fullCommandText: "cmd",
    commands: [],
    hasWriteFileRedirection: false,
    possiblePaths: [],
    possibleUrls: [],
    canOfferSessionApproval: true,
    ...fields,
  });

describe("runner permission handler", () => {
  it("keeps omitted permissions as deny-all without asking", async () => {
    const { result, ask } = await decide(undefined, request({ kind: "shell", fullCommandText: "echo hi", intention: "test" }));
    expect(result).toEqual({ kind: "reject", feedback: "Not permitted by the job policy." });
    expect(ask).not.toHaveBeenCalled();
  });

  it("allows policy-approved requests without asking", async () => {
    const { result, ask } = await decide(
      { default: "deny", kinds: { shell: "allow" } },
      request({ kind: "shell", fullCommandText: "echo hi", intention: "test" }),
    );
    expect(result).toEqual({ kind: "approve-once" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks, approves interactively, denies, and expires", async () => {
    const shell = request({ kind: "shell", fullCommandText: "npm test", intention: "run tests", warning: "may take time" });
    const approved = await decide({ default: "ask" }, shell, { kind: "permission", approved: true });
    expect(approved.ask).toHaveBeenCalledWith({
      kind: "permission",
      permission: { type: "shell", command: "npm test", intention: "run tests", warning: "may take time" },
    });
    expect(approved.result).toEqual({ kind: "approve-once", approvedInteractively: true });

    await expect(
      decide({ default: "ask" }, shell, { kind: "permission", approved: false, feedback: "nope" }).then((r) => r.result),
    ).resolves.toEqual({ kind: "reject", feedback: "nope" });
    await expect(decide({ default: "ask" }, shell, { kind: "expired" }).then((r) => r.result)).resolves.toEqual({
      kind: "reject",
      feedback: "No approval was given in time.",
    });
  });

  it("remembers approved file writes for the rest of the attempt", async () => {
    const response: InputResponseBody = { kind: "permission", approved: true, scope: "kind" };
    const ask = vi.fn(async () => response);
    const handler = buildPermissionHandler({ default: "ask" }, ask, context);
    const first = await handler(request({ kind: "write", fileName: "a.txt", diff: "+a", intention: "write" }), { sessionId: "s" });
    const second = await handler(request({ kind: "write", fileName: "b.txt", diff: "+b", intention: "write" }), { sessionId: "s" });
    expect(first).toEqual({ kind: "approve-once", approvedInteractively: true });
    expect(second).toEqual({ kind: "approve-once" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  describe("ask follows the Copilot CLI defaults", () => {
    const ask: PermissionsConfig = { default: "ask" };

    it("reads inside the workspace without asking and asks for reads outside it", async () => {
      for (const path of ["notes.md", join(files, "data", "x.csv"), join(workspace, "skills", "s", "SKILL.md")]) {
        const inside = await decide(ask, request({ kind: "read", path, intention: "inspect" }));
        expect(inside.result).toEqual({ kind: "approve-once" });
        expect(inside.ask).not.toHaveBeenCalled();
      }
      for (const path of [join(outside, "secret.txt"), "../../outside/secret.txt", join("escape", "secret.txt")]) {
        const out = await decide(ask, request({ kind: "read", path, intention: "inspect" }));
        expect(out.ask).toHaveBeenCalledTimes(1);
        expect(out.result.kind).toBe("reject");
      }
    });

    it("runs read-only commands that stay in the workspace without asking", async () => {
      const readOnly = await decide(
        ask,
        shell({ fullCommandText: "git status && ls src 2>/dev/null", commands: [{ identifier: "git status", readOnly: true }, { identifier: "ls", readOnly: true }], possiblePaths: ["src", "/dev/null"] }),
      );
      expect(readOnly.result).toEqual({ kind: "approve-once" });
      expect(readOnly.ask).not.toHaveBeenCalled();
    });

    it("asks for commands that change state, redirect output, leave the workspace, reach URLs, or bypass the sandbox", async () => {
      const readOnlyCommand = [{ identifier: "cat", readOnly: true }];
      const cases = [
        shell({ commands: [{ identifier: "npm install", readOnly: false }] }),
        shell({ commands: [], fullCommandText: "unparsed" }),
        shell({ commands: readOnlyCommand, hasWriteFileRedirection: true }),
        shell({ commands: readOnlyCommand, possiblePaths: [join(outside, "secret.txt")] }),
        shell({ commands: readOnlyCommand, possiblePaths: [join("escape", "secret.txt")] }),
        shell({ commands: [{ identifier: "curl", readOnly: true }], possibleUrls: [{ url: "https://example.com" }] }),
        shell({ commands: readOnlyCommand, requestSandboxBypass: true }),
        shell({ commands: readOnlyCommand, managedApprovalRequired: true }),
      ];
      for (const req of cases) {
        const { ask: asked } = await decide(ask, req);
        expect(asked).toHaveBeenCalledTimes(1);
      }
    });

    it("always asks before writing files and fetching URLs", async () => {
      const write = await decide(ask, request({ kind: "write", fileName: "a.txt", diff: "+a", intention: "write" }));
      const url = await decide(ask, request({ kind: "url", url: "https://example.com", intention: "fetch" }));
      expect(write.ask).toHaveBeenCalledTimes(1);
      expect(url.ask).toHaveBeenCalledTimes(1);
    });

    it("runs read-only MCP tools without asking", async () => {
      const readOnly = await decide(ask, request({ kind: "mcp", serverName: "github", toolName: "list_issues", toolTitle: "List", readOnly: true }));
      const mutating = await decide(ask, request({ kind: "mcp", serverName: "github", toolName: "create_issue", toolTitle: "Create", readOnly: false }));
      expect(readOnly.ask).not.toHaveBeenCalled();
      expect(mutating.ask).toHaveBeenCalledTimes(1);
    });

    it("keeps explicit deny rules ahead of the CLI defaults", async () => {
      const { result, ask: asked } = await decide(
        { default: "ask", kinds: { read: "deny", shell: "deny" } },
        shell({ commands: [{ identifier: "ls", readOnly: true }] }),
      );
      expect(result).toEqual({ kind: "reject", feedback: "Not permitted by the job policy." });
      expect(asked).not.toHaveBeenCalled();
      const read = await decide({ default: "ask", kinds: { read: "deny" } }, request({ kind: "read", path: "notes.md", intention: "x" }));
      expect(read.result.kind).toBe("reject");
    });
  });

  describe("approval for the rest of the attempt covers similar requests only", () => {
    const forRun: InputResponseBody = { kind: "permission", approved: true, scope: "kind" };

    it("covers the approved command names, not every command", async () => {
      const ask = vi.fn(async () => forRun);
      const handler = buildPermissionHandler({ default: "ask" }, ask, context);
      const install = shell({ fullCommandText: "npm install", commands: [{ identifier: "npm install", readOnly: false }] });
      expect(permissionPromptFor(install).commandNames).toEqual(["npm install"]);
      await handler(install, { sessionId: "s" });
      await handler(shell({ commands: [{ identifier: "npm install", readOnly: false }, { identifier: "git status", readOnly: true }] }), { sessionId: "s" });
      expect(ask).toHaveBeenCalledTimes(1);
      await handler(shell({ commands: [{ identifier: "rm", readOnly: false }] }), { sessionId: "s" });
      expect(ask).toHaveBeenCalledTimes(2);
    });

    it("lets approved writes cover output redirection", async () => {
      const ask = vi.fn(async () => forRun);
      const handler = buildPermissionHandler({ default: "ask" }, ask, context);
      await handler(request({ kind: "write", fileName: "a.txt", diff: "+a", intention: "write" }), { sessionId: "s" });
      const result = await handler(shell({ commands: [{ identifier: "echo", readOnly: true }], hasWriteFileRedirection: true }), { sessionId: "s" });
      expect(result).toEqual({ kind: "approve-once" });
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it("covers the same website host for fetches and commands", async () => {
      const ask = vi.fn(async () => forRun);
      const handler = buildPermissionHandler({ default: "ask" }, ask, context);
      await handler(request({ kind: "url", url: "https://example.com/a", intention: "fetch" }), { sessionId: "s" });
      await handler(request({ kind: "url", url: "https://EXAMPLE.com/b?q=1", intention: "fetch" }), { sessionId: "s" });
      await handler(shell({ commands: [{ identifier: "curl", readOnly: true }], possibleUrls: [{ url: "https://example.com/c" }] }), { sessionId: "s" });
      expect(ask).toHaveBeenCalledTimes(1);
      await handler(request({ kind: "url", url: "https://other.example.org", intention: "fetch" }), { sessionId: "s" });
      expect(ask).toHaveBeenCalledTimes(2);
    });

    it("covers reads in the approved folder, never a filesystem root", async () => {
      const ask = vi.fn(async () => forRun);
      const handler = buildPermissionHandler({ default: "ask" }, ask, context);
      writeFileSync(join(outside, "other.txt"), "other");
      await handler(request({ kind: "read", path: join(outside, "secret.txt"), intention: "x" }), { sessionId: "s" });
      await handler(request({ kind: "read", path: join(outside, "other.txt"), intention: "x" }), { sessionId: "s" });
      expect(ask).toHaveBeenCalledTimes(1);

      const rootAsk = vi.fn(async () => forRun);
      const rootHandler = buildPermissionHandler({ default: "ask" }, rootAsk, context);
      const systemRoot = join(root, "..").split(/[\\/]/)[0] + (process.platform === "win32" ? "\\" : "/");
      await rootHandler(request({ kind: "read", path: join(systemRoot, "first-file"), intention: "x" }), { sessionId: "s" });
      await rootHandler(request({ kind: "read", path: join(systemRoot, "second-file"), intention: "x" }), { sessionId: "s" });
      expect(rootAsk).toHaveBeenCalledTimes(2);
    });

    it("covers the same tool for MCP and other requests", async () => {
      const ask = vi.fn(async () => forRun);
      const handler = buildPermissionHandler({ default: "ask" }, ask, context);
      const create = request({ kind: "mcp", serverName: "github", toolName: "create_issue", toolTitle: "Create", readOnly: false });
      await handler(create, { sessionId: "s" });
      await handler(create, { sessionId: "s" });
      await handler(request({ kind: "mcp", serverName: "github", toolName: "delete_repo", toolTitle: "Delete", readOnly: false }), { sessionId: "s" });
      expect(ask).toHaveBeenCalledTimes(2);
    });
  });

  it("uses the default rule for mcp and other permission kinds", async () => {
    const mcp = await decide(
      { default: "allow", kinds: { read: "deny", write: "deny", shell: "deny", url: "deny" } },
      request({ kind: "mcp", serverName: "github", toolName: "issues", toolTitle: "List issues", readOnly: true }),
    );
    expect(mcp.result).toEqual({ kind: "approve-once" });

    const other = await decide({ default: "deny" }, request({ kind: "custom-tool", toolName: "danger", toolDescription: "Run danger" }));
    expect(other.result).toEqual({ kind: "reject", feedback: "Not permitted by the job policy." });
  });

  it("maps SDK request fields to contract-safe prompts", () => {
    expect(permissionPromptFor(request({ kind: "read", path: "README.md", intention: "inspect" }))).toEqual({
      type: "read",
      path: "README.md",
      intention: "inspect",
    });
    expect(permissionPromptFor(request({ kind: "url", url: "https://example.com", intention: "fetch" }))).toEqual({
      type: "url",
      url: "https://example.com",
      intention: "fetch",
    });
    expect(permissionPromptFor(request({ kind: "mcp", serverName: "srv", toolName: "tool", toolTitle: "Tool title" }))).toEqual({
      type: "mcp",
      tool: "srv:tool",
      intention: "Tool title",
    });
    expect(permissionPromptFor(request({ kind: "custom-tool", toolName: "host_tool", toolDescription: "Use host tool" }))).toEqual({
      type: "other",
      tool: "host_tool",
      intention: "Use host tool",
    });
    expect(permissionPromptFor(request({ kind: "write", fileName: "new.txt", diff: "", newFileContents: "contents", intention: "create" }))).toEqual({
      type: "write",
      path: "new.txt",
      diff: "contents",
      intention: "create",
    });
  });

  it("truncates prompts to protocol limits and includes sandbox bypass warnings", () => {
    const prompt = permissionPromptFor(
      request({
        kind: "shell",
        fullCommandText: "c".repeat(9000),
        intention: "i".repeat(1200),
        warning: "w".repeat(800),
        requestSandboxBypass: true,
        requestSandboxBypassReason: "b".repeat(800),
      }),
    );
    expect(prompt.command).toHaveLength(8000);
    expect(prompt.intention).toHaveLength(1000);
    expect(prompt.warning).toHaveLength(1000);
    expect(prompt.warning).toContain("Sandbox bypass requested");
    expect(PermissionPrompt.safeParse(prompt).success).toBe(true);

    const write = permissionPromptFor(
      request({ kind: "write", fileName: "p".repeat(1200), diff: "d".repeat(21_000), intention: "write" }),
    );
    expect(write.path).toHaveLength(1000);
    expect(write.diff).toHaveLength(20_000);
    expect(PermissionPrompt.safeParse(write).success).toBe(true);
  });
});
