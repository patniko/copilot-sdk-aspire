import { z } from "zod";

export const CAPABILITY_ISSUER = "job-dispatcher";
export const CAPABILITY_AUDIENCE_INFERENCE = "inference-gateway";

/**
 * Claims carried by a job-scoped inference capability. Bound to one attempt, a principal,
 * an allowlist of models, a token budget, and an expiry. It is not a provider credential.
 */
export const CapabilityClaims = z.object({
  iss: z.literal(CAPABILITY_ISSUER),
  aud: z.literal(CAPABILITY_AUDIENCE_INFERENCE),
  sub: z.string().uuid(),
  jti: z.string().uuid(),
  job: z.string().uuid(),
  att: z.number().int().min(1),
  prn: z.string().min(1),
  mdl: z.array(z.string().min(1)).min(1),
  tok: z.number().int().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
});
export type CapabilityClaims = z.infer<typeof CapabilityClaims>;

export interface CapabilityIntrospection {
  active: boolean;
  reason?: "revoked" | "attempt_inactive" | "budget_exhausted" | "unknown";
  remainingTokens: number;
}

export interface UsageReport {
  jti: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
