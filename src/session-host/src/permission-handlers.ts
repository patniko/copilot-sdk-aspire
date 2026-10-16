/**
 * Integrator permission handlers for the `custom` approval mode (docs/HOSTING-MODES-PLAN.md, section 3). Handlers
 * are reviewed integrator code with the trust of tool implementations: a harness selects one by name, policy must
 * allow it, and the conversation profile must provide it. A handler decides only requests that the harness's
 * per-kind rules would send to a person; `deny` rules still apply first.
 */

/** One request that would otherwise prompt a person. Arguments are the model's, so treat them as untrusted data. */
export interface CustomPermissionRequest {
  harness: string;
  sessionId: string;
  principal: string;
  /** The model-facing tool name. */
  tool: string;
  /** The harness permission kind that governs the tool; `mcp` uses the default rule. */
  kind: "read" | "write" | "url" | "mcp";
  /** The workspace path, URL, or `server:tool` the request targets, when known. */
  target?: string;
}

export type CustomPermissionDecision =
  | { decision: "approve" }
  | { decision: "deny"; reason?: string }
  | { decision: "ask" };

export interface CustomPermissionHandler {
  readonly description: string;
  decide(request: CustomPermissionRequest, options: { signal: AbortSignal }): CustomPermissionDecision | Promise<CustomPermissionDecision>;
}

/**
 * Sample handler: approves workspace reads, approves writes under `drafts/`, denies other writes, and asks a person
 * for everything else.
 */
export const workspaceDraftsHandler: CustomPermissionHandler = {
  description: "Approves workspace reads and writes under drafts/, denies other writes, and asks a person for everything else.",
  decide: (request) => {
    if (request.kind === "read") return { decision: "approve" };
    if (request.kind === "write") {
      const path = request.target ?? "";
      return /^drafts\/[^/]/.test(path) && !path.split("/").includes("..")
        ? { decision: "approve" }
        : { decision: "deny", reason: "Only files under drafts/ may be changed without a person." };
    }
    return { decision: "ask" };
  },
};

/** Handlers this worker implements, by the name a harness's `permissions.handler` selects. */
export const PERMISSION_HANDLERS: ReadonlyMap<string, CustomPermissionHandler> = new Map([
  ["workspace-drafts", workspaceDraftsHandler],
]);
