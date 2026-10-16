import { followAssistedApproval, type PermissionHandler } from "@github/copilot-sdk";
import { permissionModeFor, type InputRequestBody, type InputResponseBody, type WorkerContainerSpec } from "@copilot-agent/contracts";
import { buildPermissionHandler, permissionPromptFor } from "@copilot-agent/harness-hosting";

const RULE_KINDS = new Set(["read", "write", "shell", "url"]);

/**
 * How a worker decides its permission requests (docs/HOSTING-MODES-PLAN.md, section 3, "Approval modes"). The
 * harness's per-kind `deny` and `allow` rules decide first, so `deny` always wins. Otherwise an `assisted` worker runs
 * what its judge approves; every other request follows the Copilot CLI's defaults and then waits for a person through
 * `ask`. Nobody is attached to a worker, so a request the judge declines goes to a person rather than being rejected,
 * and the coordinator never decides it.
 */
export function workerPermissionHandler(
  spec: Pick<WorkerContainerSpec, "harness" | "approvalMode">,
  workspace: string,
  ask: (request: InputRequestBody) => Promise<InputResponseBody>,
): PermissionHandler {
  const definition = spec.harness.definition;
  // harness-hosting types its handler against the published SDK; the shapes are identical at runtime.
  const person = buildPermissionHandler(definition.permissions, ask, { workspace, workingDirectory: workspace }) as unknown as PermissionHandler;
  const judged = followAssistedApproval(person);
  return async (request, invocation) => {
    const prompt = permissionPromptFor(request as never);
    const rule = permissionModeFor(definition.permissions, RULE_KINDS.has(prompt.type) ? prompt.type : "__default__");
    if (rule === "deny") return { kind: "reject", feedback: "Not permitted by the worker's harness." };
    if (rule === "allow") return { kind: "approve-once" };
    return spec.approvalMode === "assisted" ? judged(request, invocation) : person(request, invocation);
  };
}
