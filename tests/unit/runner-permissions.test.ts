import { describe, expect, it, vi } from "vitest";
import { PermissionPrompt, type InputResponseBody, type PermissionsConfig } from "@copilot-agent/contracts";
import { buildPermissionHandler, permissionPromptFor } from "../../src/harness-hosting/src/permissions.js";

type PermissionRequestForTest = Parameters<typeof permissionPromptFor>[0];
const request = (value: Record<string, unknown>) => value as unknown as PermissionRequestForTest;

async function decide(
  permissions: PermissionsConfig | undefined,
  req: PermissionRequestForTest,
  response: InputResponseBody = { kind: "expired" },
) {
  const ask = vi.fn(async () => response);
  const result = await buildPermissionHandler(permissions, ask)(req, { sessionId: "s" });
  return { result, ask };
}

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

  it("remembers approved permission kind for the rest of the attempt", async () => {
    const response: InputResponseBody = { kind: "permission", approved: true, scope: "kind" };
    const ask = vi.fn(async () => response);
    const handler = buildPermissionHandler({ default: "ask" }, ask);
    const first = await handler(request({ kind: "write", fileName: "a.txt", diff: "+a", intention: "write" }), { sessionId: "s" });
    const second = await handler(request({ kind: "write", fileName: "b.txt", diff: "+b", intention: "write" }), { sessionId: "s" });
    expect(first).toEqual({ kind: "approve-once", approvedInteractively: true });
    expect(second).toEqual({ kind: "approve-once" });
    expect(ask).toHaveBeenCalledTimes(1);
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
