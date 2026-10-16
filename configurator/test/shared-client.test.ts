import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedSessionLimits } from "@copilot-agent/contracts";
import { SharedProvisioningError, sharedConnection } from "../server/shared-client.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const api = { apiUrl: "http://127.0.0.1:3000", key: "synthetic-api-key" };
const harness = { name: "hybrid-coordinator", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
const connection = {
  sessionId: id, destination: "shared", transport: "direct", ahpSessionId: id, url: `ws://127.0.0.1:3001/sessions/${id}`,
  token: "synthetic-ticket-".repeat(3), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  serverKey: { keyId: "fixture", algorithm: "x25519-sealedbox", publicKey: "fixture-public-key" },
};
const created = () => new Date().toISOString();
const view = {
  id, label: "", model: "fixture", closed: false, online: false, createdAt: created(), lastActivityAt: created(),
  harness, mode: "shared", placement: "shared",
  segment: { generation: 1, placement: "shared", harness, ahpSessionId: id, startedAt: created() },
  limits: SharedSessionLimits.parse({}), budget: { usedTokens: 0, reservedTokens: 0, remainingTokens: 1000 }, jobs: 0, continuations: 0,
};
afterEach(() => { vi.restoreAllMocks(); });

describe("shared CLI provisioning client", () => {
  it("creates a conversation for a harness and obtains a separately pinned one-use connection", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(view, { status: 201 }))
      .mockResolvedValueOnce(Response.json(connection));
    expect(await sharedConnection(api, { harness: "hybrid-coordinator", label: "Demo" })).toEqual(connection);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      `${api.apiUrl}/v1/sessions`, `${api.apiUrl}/v1/sessions/${id}/connection`,
    ]);
    expect(request.mock.calls[0]![1]).toMatchObject({
      redirect: "error", body: JSON.stringify({ harness: "hybrid-coordinator", label: "Demo" }), headers: { authorization: `Bearer ${api.key}` },
    });
    expect(request.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ transport: "direct" }) });
  });
  it("resumes without creating another conversation or retrying an ambiguous operation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(connection));
    await sharedConnection(api, { resume: id.toUpperCase() });
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear().mockRejectedValueOnce(new Error("connection lost"));
    await expect(sharedConnection(api, { harness: "hybrid-coordinator" })).rejects.toThrow("connection lost");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(sharedConnection(api, {})).rejects.toThrow(/Name the harness/);
  });
  it("reports the API's hosting error code, such as an unsupported transport", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(
      { error: { code: "transport_unsupported", message: "Shared hosting supports direct WSS only." } }, { status: 422 }));
    const failure = await sharedConnection(api, { resume: id, transport: "github" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SharedProvisioningError);
    expect(failure).toMatchObject({ status: 422, code: "transport_unsupported" });
    expect((failure as Error).message).toContain("transport_unsupported: Shared hosting supports direct WSS only.");
  });
  it("rejects unsafe endpoints, expired tickets and mismatched session authority", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    await expect(sharedConnection({ ...api, apiUrl: "http://remote.example" }, { resume: id })).rejects.toThrow(/HTTPS/);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ ...connection, url: `ws://remote.example/sessions/${id}` }));
    await expect(sharedConnection(api, { resume: id })).rejects.toThrow(/invalid or expired/);
    request.mockResolvedValueOnce(Response.json({ ...connection, expiresAt: new Date(0).toISOString() }));
    await expect(sharedConnection(api, { resume: id })).rejects.toThrow(/invalid or expired/);
    request.mockResolvedValueOnce(Response.json({ ...connection, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    await expect(sharedConnection(api, { resume: id })).rejects.toThrow(/invalid or expired/);
  });
});
