import {
  CAPABILITY_AUDIENCE_INFERENCE,
  CAPABILITY_ISSUER,
  CapabilityClaims,
  InferenceCapabilityClaims,
  type SessionCapabilityClaims,
} from "@copilot-agent/contracts";
import { jwtVerify, SignJWT } from "jose";

const ALGORITHM = "HS256";

function keyBytes(secret: string): Uint8Array {
  if (secret.length < 32) {
    throw new Error("The capability signing key must be at least 32 characters.");
  }
  return new TextEncoder().encode(secret);
}

export interface CapabilityGrant {
  attemptId: string;
  jti: string;
  jobId: string;
  attempt: number;
  principal: string;
  models: string[];
  tokenBudget: number;
  expiresAt: Date;
}

/** Mints a job-scoped inference capability. It carries no upstream provider credential. */
export async function signCapability(secret: string, grant: CapabilityGrant): Promise<string> {
  return new SignJWT({
    job: grant.jobId,
    att: grant.attempt,
    prn: grant.principal,
    mdl: grant.models,
    tok: grant.tokenBudget,
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuer(CAPABILITY_ISSUER)
    .setAudience(CAPABILITY_AUDIENCE_INFERENCE)
    .setSubject(grant.attemptId)
    .setJti(grant.jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(grant.expiresAt.getTime() / 1000))
    .sign(keyBytes(secret));
}

export async function verifyCapability(secret: string, token: string): Promise<CapabilityClaims> {
  const { payload } = await jwtVerify(token, keyBytes(secret), {
    algorithms: [ALGORITHM],
    issuer: CAPABILITY_ISSUER,
    audience: CAPABILITY_AUDIENCE_INFERENCE,
    clockTolerance: 5,
  });
  return CapabilityClaims.parse(payload);
}

export async function signSessionCapability(
  secret: string,
  grant: Omit<SessionCapabilityClaims, "iss" | "aud" | "iat" | "exp" | "kind"> & { expiresAt: Date },
): Promise<string> {
  const { expiresAt, ...claims } = grant;
  return new SignJWT({ ...claims, kind: "hosted-session" })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuer(CAPABILITY_ISSUER)
    .setAudience(CAPABILITY_AUDIENCE_INFERENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(keyBytes(secret));
}

export async function verifyInferenceCapability(secret: string, token: string): Promise<InferenceCapabilityClaims> {
  const { payload } = await jwtVerify(token, keyBytes(secret), {
    algorithms: [ALGORITHM],
    issuer: CAPABILITY_ISSUER,
    audience: CAPABILITY_AUDIENCE_INFERENCE,
    clockTolerance: 5,
  });
  return InferenceCapabilityClaims.parse(payload);
}
