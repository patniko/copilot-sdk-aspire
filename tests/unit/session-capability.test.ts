import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signSessionCapability, verifyCapability, verifyInferenceCapability } from "@copilot-agent/service-defaults";

const key = "test-session-signing-key-".repeat(3);
function grant(expiresAt = new Date(Date.now() + 60_000)) {
  const id = randomUUID();
  return {
    sub: id, session: id, epoch: randomUUID(), jti: randomUUID(), prn: "alice",
    mdl: ["test-model"], tok: 1000, expiresAt,
  };
}

describe("hosted-session inference capability", () => {
  it("binds session, owner, host epoch, models, and budget", async () => {
    const claims = grant();
    const token = await signSessionCapability(key, claims);
    expect(await verifyInferenceCapability(key, token)).toMatchObject({
      kind: "hosted-session", session: claims.session, epoch: claims.epoch,
      prn: "alice", mdl: ["test-model"], tok: 1000, aud: "inference-gateway",
    });
  });

  it("cannot be parsed as a job-attempt capability", async () => {
    await expect(verifyCapability(key, await signSessionCapability(key, grant()))).rejects.toThrow();
  });

  it("rejects expired tokens and incorrect signatures", async () => {
    await expect(verifyInferenceCapability(key, await signSessionCapability(key, grant(new Date(Date.now() - 60_000))))).rejects.toThrow();
    await expect(verifyInferenceCapability("another-signing-key-".repeat(4), await signSessionCapability(key, grant()))).rejects.toThrow();
  });
});
