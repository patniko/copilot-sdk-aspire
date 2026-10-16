import { z } from "zod";
import { PROMOTE_SESSION_TOOL, type PromotionView } from "@copilot-agent/contracts";
import type { SharedTool } from "../tools.js";

const PromoteArgs = z.object({ reason: z.string().trim().max(500).default("") }).strict();

/**
 * `promote_session` for `promotable` harnesses. With `ask` approval the call goes to the session's permission flow,
 * so the attached person decides under the default `manual` mode; with `allow` it runs without a prompt. Repeated
 * calls return the promotion already under way; a refusal fails the call and the conversation stays shared.
 */
export function promotionTool(
  approval: "ask" | "allow",
  request: (requestKey: string, reason: string) => Promise<{ promotion: PromotionView; created: boolean }>,
): SharedTool {
  return {
    rule: approval === "ask" ? { person: true } : {},
    tool: {
      name: PROMOTE_SESSION_TOOL,
      description: [
        "Move this conversation, one way, into its own container with a real filesystem and a shell, for work this shared",
        "conversation cannot do: running commands, building or testing code, packaged tools, or long-running work.",
        "History and workspace files move with it, and it never returns to shared placement. Call it once with a short",
        "reason, then end your reply; the conversation continues in the container, where you are told how to resume.",
      ].join(" "),
      parameters: z.toJSONSchema(PromoteArgs),
      handler: async (value, invocation) => {
        const args = PromoteArgs.parse(value);
        const { promotion, created } = await request(`tool:${invocation.toolCallId}`, args.reason);
        return {
          promotion: promotion.id, state: promotion.state, size: promotion.size,
          ...(created ? {} : { note: "This conversation is already moving to a container." }),
          next: "End your reply now. When this turn ends the conversation moves into its own container, and you continue there.",
        };
      },
    },
  };
}
