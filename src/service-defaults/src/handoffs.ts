import { createHash } from "node:crypto";
import { HANDOFF_TOOL_PREFIX } from "@copilot-agent/contracts";

const MAX_TOOL_NAME = 64;

/**
 * The model-facing transfer tool for a handoff target: `transfer_to_<harness>` with hyphens as underscores, or, when
 * that exceeds 64 characters, its first 53 characters, an underscore, and 10 hexadecimal digits of a stable hash.
 */
export function handoffToolName(harness: string): string {
  const direct = `${HANDOFF_TOOL_PREFIX}${harness.replaceAll("-", "_")}`;
  if (direct.length <= MAX_TOOL_NAME) return direct;
  const hash = createHash("sha256").update(harness).digest("hex").slice(0, 10);
  return `${direct.slice(0, MAX_TOOL_NAME - 11)}_${hash}`;
}
