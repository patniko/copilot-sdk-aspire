import { followAssistedApproval, type PermissionHandler, type PermissionRequest, type PermissionRequestResult } from "@github/copilot-sdk";
import { permissionModeFor, type HarnessDefinition, type PermissionMode } from "@copilot-agent/contracts";
import type { SharedApprovalPlan } from "./admission.js";
import type { CustomPermissionDecision, CustomPermissionHandler, CustomPermissionRequest } from "./permission-handlers.js";

export type ToolPermissionKind = CustomPermissionRequest["kind"];
/** A pre-tool hook decision; no decision lets the runtime raise its normal permission request. */
export interface PreToolDecision {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason?: string;
}

/** How the harness's permission rules apply to one application tool. A tool without a kind needs no permission. */
export interface ToolRule {
  kind?: ToolPermissionKind;
  /** Runs under `ask` without a prompt, as the Copilot CLI runs workspace reads and read-only MCP tools. */
  quietUnderAsk?: boolean;
  /** What a call targets (a workspace path, URL, or `server:tool`), for custom handlers. */
  target?: (args: unknown) => string | undefined;
}

/**
 * Answers a request with the runtime judge's verdict when it approves, and defers everything else to `fallback`. The
 * SDK's `followAssistedApproval` approves, attributed to `assisted_approval`, only requests the judge approved, never
 * hooks, managed confirmations, or sandbox bypasses.
 */
export type JudgeResponder = (fallback?: PermissionHandler) => PermissionHandler;

export interface SharedPermissionContext {
  harness: string;
  sessionId: string;
  principal: string;
  definition: Pick<HarnessDefinition, "permissions">;
  approval: SharedApprovalPlan;
  /** Application tools by model-facing name. */
  rules: ReadonlyMap<string, ToolRule>;
  /** Built-in runtime tools the session admits, by bare name. */
  builtins: ReadonlySet<string>;
  /** The registered handler for the `custom` approval mode. */
  handler?: CustomPermissionHandler;
  handlerTimeoutMs?: number;
  report?: (event: string) => void;
  /** Follows the runtime judge's verdict; defaults to the SDK's `followAssistedApproval`, and `null` asks a person. */
  followJudge?: JudgeResponder | null;
}

const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;
const ALLOW: PreToolDecision = { permissionDecision: "allow" };
const bare = (name: string) => name.replace(/^(?:custom|builtin):/, "");
const reject = (feedback: string): PermissionRequestResult => ({ kind: "reject", feedback });

/** The harness's per-kind rule for a tool kind; `mcp` and unknown kinds use the default rule. */
export function ruleFor(definition: Pick<HarnessDefinition, "permissions">, kind: ToolPermissionKind): PermissionMode {
  return permissionModeFor(definition.permissions, kind);
}

/**
 * Applies a shared session's permission rules (docs/HOSTING-MODES-PLAN.md, section 3, "Approval modes"). Per-kind
 * `deny` and `allow` rules decide first, before the runtime raises any request, so a runtime in `allow-all` cannot
 * bypass a `deny`. A request the rules send to a person reaches the runtime's permission flow: `custom` asks the
 * registered handler. In every other mode the worker follows the runtime judge's verdict when the runtime attaches one
 * (`assisted`), which the AHP host cannot do while no client has the session open, and otherwise answers `no-result`
 * so the attached client decides. It never rejects on the judge's behalf, which would pre-empt the attached person.
 * The application never approves on a person's behalf, and with nobody attached a request the judge did not approve
 * does not run.
 */
export class SharedPermissionPolicy {
  constructor(private readonly context: SharedPermissionContext) {}

  /** The pre-tool decision, after the caller has confirmed the turn's execution grant. */
  preToolUse(toolName: string): PreToolDecision | undefined {
    const name = bare(toolName);
    const rule = this.context.rules.get(name);
    if (!rule) {
      return this.context.builtins.has(name)
        ? undefined
        : { permissionDecision: "deny", permissionDecisionReason: "The tool is not admitted for this harness." };
    }
    if (!rule.kind) return ALLOW;
    const mode = ruleFor(this.context.definition, rule.kind);
    if (mode === "deny") return { permissionDecision: "deny", permissionDecisionReason: "Denied by the harness permission rules." };
    if (mode === "allow" || rule.quietUnderAsk) return ALLOW;
    return undefined;
  }

  readonly handle: PermissionHandler = async (request, invocation) => {
    if (request.kind !== "custom-tool" && request.kind !== "hook") {
      return reject("This kind of request is not available in shared placement.");
    }
    const name = bare(request.toolName);
    const rule = this.context.rules.get(name);
    if (!rule) return reject("The tool is not admitted for this harness.");
    if (!rule.kind) return { kind: "approve-once" };
    const mode = ruleFor(this.context.definition, rule.kind);
    if (mode === "deny") return reject("Denied by the harness permission rules.");
    if (mode === "allow" || rule.quietUnderAsk) return { kind: "approve-once" };
    if (this.context.approval.mode === "custom") return this.#custom(request, name, rule.kind, rule.target);
    const follow = this.context.followJudge === undefined ? followAssistedApproval : this.context.followJudge;
    return follow ? follow()(request, invocation) : { kind: "no-result" };
  };

  async #custom(request: PermissionRequest, tool: string, kind: ToolPermissionKind, target?: ToolRule["target"]): Promise<PermissionRequestResult> {
    const handler = this.context.handler;
    if (!handler) return reject("The harness's permission handler is not available, so the request was denied.");
    const args = request.kind === "custom-tool" ? request.args : request.kind === "hook" ? request.toolArgs : undefined;
    let resolved: string | undefined;
    try { resolved = target?.(args); }
    catch { resolved = undefined; }
    const input: CustomPermissionRequest = {
      harness: this.context.harness, sessionId: this.context.sessionId, principal: this.context.principal,
      tool, kind, ...(resolved ? { target: resolved.slice(0, 2048) } : {}),
    };
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const decision = await Promise.race([
        Promise.resolve().then(() => handler.decide(input, { signal: controller.signal })),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => {
            controller.abort();
            fail(new Error("The permission handler did not answer in time."));
          }, this.context.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS);
        }),
      ]);
      return this.#result(decision);
    } catch {
      this.context.report?.("session.permission_handler_failed");
      return reject("The permission handler failed or did not answer in time, so the request was denied.");
    } finally {
      clearTimeout(timer);
    }
  }

  #result(decision: CustomPermissionDecision): PermissionRequestResult {
    switch (decision?.decision) {
      case "approve": return { kind: "approve-once" };
      case "ask": return { kind: "no-result" };
      case "deny":
        return reject(typeof decision.reason === "string" && decision.reason.trim()
          ? decision.reason.slice(0, 500)
          : "Denied by the harness's permission handler.");
      default:
        this.context.report?.("session.permission_handler_invalid");
        return reject("The permission handler returned no valid decision, so the request was denied.");
    }
  }
}
