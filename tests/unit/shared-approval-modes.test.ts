import { describe, expect, it } from "vitest";
import { ApprovalModeRefused, applyApprovalMode, enableAssistedApprovals, recordedApprovalMode } from "../../src/session-host/src/runtime.js";
import { approvalManagedSettings, approvalModeUnavailable } from "../../src/session-host/src/service.js";

/** A runtime session's permission RPCs that apply `accepts` and leave every other mode unchanged. */
function permissions(initial: string, accepts: (mode: string) => boolean = () => true, failing = false) {
  let current = initial;
  const calls: Array<{ mode: string; assistedApprovalModel?: string }> = [];
  return {
    calls,
    rpc: {
      getMode: async () => ({ mode: current }),
      setMode: async (request: { mode: string; assistedApprovalModel?: string }) => {
        calls.push(request);
        if (failing) throw new Error("rpc failed");
        if (accepts(request.mode)) current = request.mode;
        return { success: current === request.mode, mode: current };
      },
    } as never,
  };
}
const changed = (data: Record<string, unknown>) => ({ type: "session.permissions_changed", data });
const all = ["manual", "assisted", "allow-all"] as const;

describe("shared approval modes", () => {
  it("enables the runtime's assisted-approval feature flag in the worker's own environment", () => {
    const environment: NodeJS.ProcessEnv = { AUTO_APPROVAL: "false" };
    enableAssistedApprovals(environment);
    expect(environment.AUTO_APPROVAL).toBe("true");
  });

  it("always states managed settings, disabling exactly the runtime modes the policy does not allow", () => {
    expect(approvalManagedSettings({ mode: "manual", initial: "manual", available: [...all] })).toEqual({ permissions: {} });
    expect(approvalManagedSettings({ mode: "allow-all", initial: "allow-all", available: ["manual", "allow-all"] }))
      .toEqual({ permissions: { disableAssistedPermissionsMode: true } });
  });

  it("reads the mode a resumed session returns to from its history, as the runtime restores it", () => {
    expect(recordedApprovalMode([], all)).toBe("manual");
    expect(recordedApprovalMode([{ type: "user.message", data: { content: "hi" } }, changed({ mode: "assisted" })], all)).toBe("assisted");
    expect(recordedApprovalMode([changed({ mode: "assisted" }), changed({ mode: "manual" })], all)).toBe("manual");
    expect(recordedApprovalMode([changed({ allowAllPermissionMode: "auto" })], all)).toBe("assisted");
    expect(recordedApprovalMode([changed({ allowAllPermissionMode: "on" })], all)).toBe("allow-all");
    expect(recordedApprovalMode([changed({ allowAllPermissions: true })], all)).toBe("allow-all");
    expect(recordedApprovalMode([changed({ mode: "assisted" }), changed({ mode: "constructor" })], all)).toBe("manual");
    // A mode the current policy no longer allows falls back to manual approval.
    expect(recordedApprovalMode([changed({ mode: "allow-all" })], ["manual", "assisted"])).toBe("manual");
  });

  it("applies a session's mode and its judge model, and confirms the runtime holds it", async () => {
    const assisted = permissions("manual");
    await applyApprovalMode(assisted.rpc, "assisted", "judge-model");
    expect(assisted.calls).toEqual([{ mode: "assisted", assistedApprovalModel: "judge-model" }]);
    const manual = permissions("manual");
    await applyApprovalMode(manual.rpc, "manual", "judge-model");
    expect(manual.calls).toEqual([]);
    const restored = permissions("allow-all");
    await applyApprovalMode(restored.rpc, "manual");
    expect(restored.calls).toEqual([{ mode: "manual" }]);
  });

  it("refuses rather than leaving a session in another mode", async () => {
    const withoutFlag = permissions("manual", (mode) => mode !== "assisted");
    await expect(applyApprovalMode(withoutFlag.rpc, "assisted")).rejects.toMatchObject({ name: "ApprovalModeRefused", mode: "assisted", actual: "manual" });
    await expect(applyApprovalMode(permissions("manual", () => true, true).rpc, "allow-all")).rejects.toBeInstanceOf(ApprovalModeRefused);
    const refused = approvalModeUnavailable(new ApprovalModeRefused("assisted", "manual"));
    expect(refused).toMatchObject({ statusCode: 409, code: "hosting_unavailable", details: { prerequisite: { kind: "feature", name: "approval-modes" } } });
    expect(refused.message).toContain("'assisted'");
  });
});
