import { z } from "zod";

/** The OpenAI wire shape the inference gateway serves a model over: `/chat/completions` or `/responses`. */
export const WireApi = z.enum(["completions", "responses"]);
export type WireApi = z.infer<typeof WireApi>;

/** GitHub Copilot models are routed under this prefix, so they never collide with Foundry deployment names. */
export const GITHUB_MODEL_PREFIX = "github/";

/** The gateway's description of one routed model (`GET /openai/v1/models/{model}`). */
export const GatewayModel = z
  .object({ id: z.string().min(1), object: z.literal("model"), owned_by: z.string(), wire_api: WireApi })
  .passthrough();
export type GatewayModel = z.infer<typeof GatewayModel>;

/**
 * Resolves the single wire API a session's models use through the gateway at `gatewayUrl` (ending in `/openai/v1`).
 * A model the gateway does not describe, or a gateway that cannot be reached, uses `completions`, the original shape.
 * A session has one provider, so models with different wire APIs cannot share it.
 */
export async function gatewayWireApi(
  gatewayUrl: string,
  models: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<WireApi> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const apis = new Map<WireApi, string>();
  for (const model of new Set(models)) {
    apis.set(await describedWireApi(base, model, fetchImpl), model);
  }
  if (apis.size > 1) {
    throw new Error(
      `This session's models use different inference APIs (${[...apis].map(([api, model]) => `${model}: ${api}`).join(", ")}). ` +
        "Use models that share one API for a harness, its sub-agents, and its approval judge.",
    );
  }
  return [...apis.keys()][0] ?? "completions";
}

async function describedWireApi(base: string, model: string, fetchImpl: typeof fetch): Promise<WireApi> {
  try {
    const response = await fetchImpl(`${base}/models/${encodeURIComponent(model)}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "completions";
    }
    const parsed = GatewayModel.safeParse(await response.json());
    return parsed.success && parsed.data.id === model ? parsed.data.wire_api : "completions";
  } catch {
    return "completions";
  }
}
