import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerHostCliArguments, ownerHostConnection } from "../server/owner-host-client.js";

const api = { apiUrl: "http://127.0.0.1:3000", key: "synthetic-api-key" };
const ahpSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverKey = { keyId: "fixture", algorithm: "x25519-sealedbox", publicKey: "fixture-public-key" } as const;
const direct = {
  harness: "interactive-demo", transport: "direct", execution: "managed", url: "ws://127.0.0.1:3101/",
  token: "synthetic-ticket-".repeat(3), expiresAt: new Date(Date.now() + 60_000).toISOString(), serverKey,
} as const;
const relay = { harness: "interactive-demo", transport: "github", execution: "managed", environmentId: "fixture-environment" } as const;
afterEach(() => { vi.restoreAllMocks(); });

describe("owner host CLI provisioning client", () => {
  it("asks the harness host's connection route for a transport and a session to resume", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ...direct, ahpSessionId }));
    expect(await ownerHostConnection(api, "interactive-demo", "direct", ahpSessionId)).toEqual({ ...direct, ahpSessionId });
    expect(String(request.mock.calls[0]![0])).toBe(`${api.apiUrl}/v1/hosts/interactive-demo/connection`);
    expect(request.mock.calls[0]![1]).toMatchObject({
      method: "POST", redirect: "error", body: JSON.stringify({ transport: "direct", sessionId: ahpSessionId }),
    });
  });

  it("reports the API's error code, such as relay_owner_only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(
      { error: { code: "relay_owner_only", message: "Only the host's owner can use its relay." } }, { status: 403 }));
    await expect(ownerHostConnection(api, "interactive-demo", "github")).rejects.toThrow(/403 relay_owner_only\)\. Only the host's owner/);
  });

  it("rejects unsafe APIs, mismatched material, unregistered environments and expired or non-loopback endpoints", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    await expect(ownerHostConnection({ ...api, apiUrl: "http://remote.example" }, "interactive-demo", "direct")).rejects.toThrow(/HTTPS/);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ ...direct, harness: "other-harness" }));
    await expect(ownerHostConnection(api, "interactive-demo", "direct")).rejects.toThrow(/different host or transport/);
    request.mockResolvedValueOnce(Response.json({ ...relay, environmentId: undefined }));
    await expect(ownerHostConnection(api, "interactive-demo", "github")).rejects.toThrow(/not registered its GitHub environment/);
    request.mockResolvedValueOnce(Response.json({ ...direct, expiresAt: new Date(0).toISOString() }));
    await expect(ownerHostConnection(api, "interactive-demo", "direct")).rejects.toThrow(/current direct endpoint/);
    request.mockResolvedValueOnce(Response.json({ ...direct, url: "ws://remote.example/" }));
    await expect(ownerHostConnection(api, "interactive-demo", "direct")).rejects.toThrow(/WSS, or loopback WS/);
  });

  it("pins the key for a direct launch and turns the CLI's relay client off for it", () => {
    const launch = ownerHostCliArguments({ ...direct, ahpSessionId });
    expect(launch.args).toEqual([
      "--experimental", "--ahp", `ws://127.0.0.1:3101/?tkn=${direct.token}`, "--ahp-authenticate-with-github", "--resume", ahpSessionId,
    ]);
    expect(launch.env).toEqual({ COPILOT_AHP_SERVER_KEY: JSON.stringify({ endpoint: "ws://127.0.0.1:3101/", ...serverKey }), RELAY_CLIENT: "false" });
  });

  it("attaches the relay to the harness host's own environment with the attached resume form", () => {
    expect(ownerHostCliArguments(relay, ahpSessionId)).toEqual({
      args: ["--experimental", "--relay", "--environment-id", "fixture-environment", `--resume=${ahpSessionId}`], env: {},
    });
    expect(ownerHostCliArguments(relay).args).not.toContain("--resume");
  });
});
