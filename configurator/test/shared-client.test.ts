import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedSessionLimits } from "@copilot-agent/contracts";
import { sharedConnection } from "../server/shared-client.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const api = { apiUrl: "http://127.0.0.1:3000", key: "synthetic-api-key" };
const connection = {
  sessionId: id, destination: "shared", url: `ws://127.0.0.1:3001/sessions/${id}`,
  token: "synthetic-ticket-".repeat(3), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  serverKey: { keyId: "fixture", algorithm: "x25519-sealedbox", publicKey: "fixture-public-key" },
};
afterEach(() => { vi.restoreAllMocks(); });

describe("shared CLI provisioning client", () => {
  it("creates a conversation and obtains a separately pinned one-use connection", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        id, label: "", model: "fixture", closed: false, online: false, createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(), limits: SharedSessionLimits.parse({}),
        budget: { usedTokens: 0, reservedTokens: 0, remainingTokens: 1000 }, jobs: 0, continuations: 0,
      }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(connection));
    expect(await sharedConnection(api)).toEqual(connection);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      `${api.apiUrl}/v1/sessions`, `${api.apiUrl}/v1/sessions/${id}/connection`,
    ]);
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: "error", body: "{}", headers: { authorization: `Bearer ${api.key}` } });
  });
  it("resumes without creating another conversation or retrying an ambiguous operation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(connection));
    await sharedConnection(api, id.toUpperCase());
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear().mockRejectedValueOnce(new Error("connection lost"));
    await expect(sharedConnection(api)).rejects.toThrow("connection lost");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects unsafe endpoints, expired tickets and mismatched session authority", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    await expect(sharedConnection({ ...api, apiUrl: "http://remote.example" }, id)).rejects.toThrow(/HTTPS/);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ ...connection, url: `ws://remote.example/sessions/${id}` }));
    await expect(sharedConnection(api, id)).rejects.toThrow(/invalid or expired/);
    request.mockResolvedValueOnce(Response.json({ ...connection, expiresAt: new Date(0).toISOString() }));
    await expect(sharedConnection(api, id)).rejects.toThrow(/invalid or expired/);
    request.mockResolvedValueOnce(Response.json({ ...connection, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    await expect(sharedConnection(api, id)).rejects.toThrow(/invalid or expired/);
    for (const url of ["ws://127.0.0.1:3001/", "ws://127.0.0.1:3001/sessions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]) {
      request.mockResolvedValueOnce(Response.json({ ...connection, url }));
      await expect(sharedConnection(api, id), url).rejects.toThrow(/invalid or expired/);
    }
  });
});
