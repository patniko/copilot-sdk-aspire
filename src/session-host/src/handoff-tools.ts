import type { ToolInvocation } from "@github/copilot-sdk";
import { z } from "zod";
import { handoffArguments, type HandoffHistory, type HandoffPayload, type HostingApproval } from "@copilot-agent/contracts";
import { handoffToolName } from "@copilot-agent/service-defaults";
import type { SharedActivationContext } from "./runtime.js";
import type { SharedTool } from "./tools.js";

/** One predefined target as this activation offers it: its approval, and the history it would receive from here. */
export interface HandoffOffer {
  harness: string;
  description: string;
  approval: HostingApproval;
  history: HandoffHistory;
  /** The target runs in its own session container: the conversation moves there, one way. */
  container?: boolean;
}

/** Performs one transfer after its arguments validated: checks, approval, and the ledger. Resolves with the model's text. */
export type HandoffRunner = (offer: HandoffOffer, payload: HandoffPayload, invocation: ToolInvocation) => Promise<string>;

const HISTORY_NOTE: Record<HandoffHistory, string> = {
  full: "It sees this whole conversation.",
  summary: "It does not see this conversation: pass a self-contained summary.",
  none: "It does not see this conversation; only your reason is passed.",
};

/**
 * The `transfer_to_<harness>` tools for an activation's predefined handoff targets (docs/HOSTING-MODES-PLAN.md, section
 * 7.5). Each describes its target and takes a small payload, validated before any effect; only the root agent can hand
 * off. With `ask` approval the attached person approves every call, whatever the session's approval mode.
 */
export function handoffTools(offers: readonly HandoffOffer[], context: SharedActivationContext, run: HandoffRunner): SharedTool[] {
  return offers.map((offer): SharedTool => {
    const schema = handoffArguments(offer.history);
    const name = handoffToolName(offer.harness);
    const moves = offer.container ? " The conversation moves into its own container, with a shell and the workspace files, and never comes back here." : "";
    return {
      rule: {
        handoff: {
          approval: offer.approval,
          prompt: `Transfer this conversation to the ${offer.harness} harness (${offer.history} history). It takes over from the current agent.${moves}`,
        },
      },
      tool: {
        name,
        description: [
          offer.description,
          `Transfers control of this conversation to the '${offer.harness}' harness${offer.approval === "ask" ? " after the person approves" : ""}; it takes over when your turn ends.${moves}`,
          HISTORY_NOTE[offer.history],
        ].join(" ").slice(0, 2000),
        parameters: z.toJSONSchema(schema),
        handler: async (value, invocation) => {
          if (invocation.sessionId !== context.runtimeSessionId || invocation.agentId) throw new Error("Only the root agent can hand off this conversation.");
          const parsed = schema.safeParse(value);
          if (!parsed.success) {
            throw new Error(`Invalid handoff arguments: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ")}`);
          }
          return run(offer, parsed.data, invocation);
        },
      },
    };
  });
}
