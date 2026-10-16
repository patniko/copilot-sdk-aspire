import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import type { HarnessDefinition } from "@copilot-agent/contracts";
import type { SharedApprovalPlan } from "../../src/session-host/src/admission.js";
import { workspaceDraftsHandler, type CustomPermissionHandler } from "../../src/session-host/src/permission-handlers.js";
import { SharedPermissionPolicy, type ToolRule } from "../../src/session-host/src/permissions.js";
import { approvalManagedSettings } from "../../src/session-host/src/service.js";

const rules = new Map<string, ToolRule>([
  ["read_workspace_file", { kind: "read", quietUnderAsk: true, target: (args) => (args as { path?: string }).path }],
  ["write_workspace_file", { kind: "write", target: (args) => (args as { path?: string }).path }],
  ["web_fetch", { kind: "url", target: (args) => (args as { url?: string }).url }],
  ["mcp_docs_search_search", { kind: "mcp", quietUnderAsk: true }],
  ["mcp_docs_search_delete", { kind: "mcp", target: () => "docs-search:delete" }],
  ["update_task_list", {}],
]);
const manual: SharedApprovalPlan = { mode: "manual", initial: "manual", available: ["manual"] };
const policy = (permissions: HarnessDefinition["permissions"], approval: SharedApprovalPlan = manual, handler?: CustomPermissionHandler, handlerTimeoutMs?: number) => {
  const events: string[] = [];
  return {
    events,
    policy: new SharedPermissionPolicy({
      harness: "fixture", sessionId: "session", principal: "alice", definition: { permissions }, approval, rules,
      builtins: new Set(["ask_user", "task"]), ...(handler ? { handler } : {}), ...(handlerTimeoutMs ? { handlerTimeoutMs } : {}),
      report: (event) => events.push(event),
    }),
  };
};
const tool = (toolName: string, args: unknown = {}): PermissionRequest => ({ kind: "custom-tool", toolName, toolDescription: "Fixture.", args } as PermissionRequest);
const ask = { default: "ask" as const, kinds: { write: "ask" as const, url: "ask" as const, read: "ask" as const } };

describe("shared permission policy", () => {
  it("decides deny and allow rules before the runtime raises any request", () => {
    const { policy: rulesOnly } = policy({ default: "deny", kinds: { read: "allow", write: "deny", url: "ask" } });
    expect(rulesOnly.preToolUse("custom:read_workspace_file")).toEqual({ permissionDecision: "allow" });
    expect(rulesOnly.preToolUse("write_workspace_file")).toMatchObject({ permissionDecision: "deny" });
    expect(rulesOnly.preToolUse("mcp_docs_search_delete")).toMatchObject({ permissionDecision: "deny" });
    expect(rulesOnly.preToolUse("web_fetch")).toBeUndefined();
    expect(rulesOnly.preToolUse("update_task_list")).toEqual({ permissionDecision: "allow" });
    expect(rulesOnly.preToolUse("builtin:ask_user")).toBeUndefined();
    expect(rulesOnly.preToolUse("bash")).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("not admitted") });
    // Omitted permissions deny every kind, as in batch runners.
    const { policy: none } = policy(undefined);
    for (const name of ["read_workspace_file", "write_workspace_file", "web_fetch", "mcp_docs_search_search"]) {
      expect(none.preToolUse(name)?.permissionDecision, name).toBe("deny");
    }
  });

  it("runs workspace reads and read-only MCP tools under ask without a prompt, like the Copilot CLI", () => {
    const { policy: asking } = policy(ask);
    expect(asking.preToolUse("read_workspace_file")).toEqual({ permissionDecision: "allow" });
    expect(asking.preToolUse("mcp_docs_search_search")).toEqual({ permissionDecision: "allow" });
    expect(asking.preToolUse("mcp_docs_search_delete")).toBeUndefined();
    expect(asking.preToolUse("write_workspace_file")).toBeUndefined();
  });

  it("leaves requests that need a person to the runtime's effective mode, never approving them itself", async () => {
    for (const mode of ["manual", "assisted", "allow-all"] as const) {
      const { policy: asking } = policy(ask, { mode, initial: mode, available: [mode] });
      expect(await asking.handle(tool("write_workspace_file", { path: "notes.md" }), { sessionId: "session" }), mode).toEqual({ kind: "no-result" });
      expect(await asking.handle(tool("web_fetch", { url: "https://example.com" }), { sessionId: "session" }), mode).toEqual({ kind: "no-result" });
    }
    const { policy: rulesOnly } = policy({ default: "deny", kinds: { write: "allow", url: "deny" } });
    expect(await rulesOnly.handle(tool("write_workspace_file"), { sessionId: "session" })).toEqual({ kind: "approve-once" });
    expect(await rulesOnly.handle(tool("web_fetch"), { sessionId: "session" })).toMatchObject({ kind: "reject" });
    expect(await rulesOnly.handle(tool("unknown_tool"), { sessionId: "session" })).toMatchObject({ kind: "reject" });
    expect(await rulesOnly.handle({ kind: "shell", fullCommandText: "ls" } as unknown as PermissionRequest, { sessionId: "session" }))
      .toMatchObject({ kind: "reject", feedback: expect.stringContaining("shared placement") });
  });

  it("lets a registered custom handler approve, deny, or ask a person", async () => {
    const custom: SharedApprovalPlan = { mode: "custom", initial: "manual", available: ["manual"], handler: "workspace-drafts" };
    const { policy: drafts } = policy(ask, custom, workspaceDraftsHandler);
    expect(await drafts.handle(tool("write_workspace_file", { path: "drafts/plan.md" }), { sessionId: "session" })).toEqual({ kind: "approve-once" });
    expect(await drafts.handle(tool("write_workspace_file", { path: "final/plan.md" }), { sessionId: "session" }))
      .toEqual({ kind: "reject", feedback: "Only files under drafts/ may be changed without a person." });
    expect(await drafts.handle(tool("web_fetch", { url: "https://example.com" }), { sessionId: "session" })).toEqual({ kind: "no-result" });
    const seen: unknown[] = [];
    const recording: CustomPermissionHandler = { description: "Records.", decide: (request) => { seen.push(request); return { decision: "approve" }; } };
    await policy(ask, custom, recording).policy.handle(tool("mcp_docs_search_delete", { id: 1 }), { sessionId: "session" });
    expect(seen).toEqual([{ harness: "fixture", sessionId: "session", principal: "alice", tool: "mcp_docs_search_delete", kind: "mcp", target: "docs-search:delete" }]);
  });

  it("denies when the custom handler is missing, fails, is slow, or returns no valid decision", async () => {
    const custom: SharedApprovalPlan = { mode: "custom", initial: "manual", available: ["manual"], handler: "fixture" };
    const request = tool("write_workspace_file", { path: "drafts/a.md" });
    expect(await policy(ask, custom).policy.handle(request, { sessionId: "session" })).toMatchObject({ kind: "reject" });
    const failing = policy(ask, custom, { description: "Fails.", decide: () => { throw new Error("handler bug"); } });
    expect(await failing.policy.handle(request, { sessionId: "session" })).toMatchObject({ kind: "reject", feedback: expect.stringContaining("failed or did not answer") });
    expect(failing.events).toEqual(["session.permission_handler_failed"]);
    let aborted = false;
    const slow = policy(ask, custom, {
      description: "Never answers.",
      decide: (_request, { signal }) => new Promise((resolve) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve({ decision: "approve" }), 5_000); }),
    }, 50);
    const started = Date.now();
    expect(await slow.policy.handle(request, { sessionId: "session" })).toMatchObject({ kind: "reject" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    const invalid = policy(ask, custom, { description: "Invalid.", decide: () => ({ decision: "maybe" }) as never });
    expect(await invalid.policy.handle(request, { sessionId: "session" })).toMatchObject({ kind: "reject" });
    expect(invalid.events).toEqual(["session.permission_handler_invalid"]);
  });

  it("keeps the runtime out of approval modes the harness's policy does not allow", () => {
    expect(approvalManagedSettings({ mode: "manual", initial: "manual", available: ["manual"] }))
      .toEqual({ permissions: { disableBypassPermissionsMode: "disable", disableAssistedPermissionsMode: true } });
    expect(approvalManagedSettings({ mode: "assisted", initial: "assisted", available: ["manual", "assisted"] }))
      .toEqual({ permissions: { disableBypassPermissionsMode: "disable" } });
    expect(approvalManagedSettings({ mode: "manual", initial: "manual", available: ["manual", "assisted", "allow-all"] })).toBeUndefined();
  });
});
