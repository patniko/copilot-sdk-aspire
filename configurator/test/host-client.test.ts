import { afterEach, describe, expect, it, vi } from "vitest";
import { HostConnectionInfo, hostConnection, websocketEndpoint } from "../server/host-client.js";
import { Settings } from "../server/settings.js";
import { StatusService } from "../server/status.js";
import { TryService } from "../server/try.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function services(apiUrl = "http://127.0.0.1:8080") {
  const settings = new Settings(process.cwd(), () => ({}));
  const status = new StatusService({ root: process.cwd(), aspireEnv: () => ({}) });
  const jobs = new TryService(process.cwd(), settings, status);
  vi.spyOn(status, "local").mockResolvedValue({
    running: true, apiUrl, resources: [{ name: "agent-host", type: "Container", state: "Running",
      urls: [{ name: "http", url: "http://127.0.0.1:8081" }] }],
  });
  vi.spyOn(jobs, "connection").mockResolvedValue({ apiUrl, key: "private-api-key-for-test", at: Date.now() });
  return { settings, status, jobs };
}

describe("demo host connection provisioning", () => {
  it("uses WSS remotely and permits WS only on loopback", () => {
    expect(websocketEndpoint("https://host.example")).toBe("wss://host.example/");
    expect(websocketEndpoint("http://127.0.0.1:1234")).toBe("ws://127.0.0.1:1234/");
    expect(() => websocketEndpoint("http://host.example")).toThrow(/HTTPS/);
  });

  it("rejects credential-bearing and ambiguous endpoints", () => {
    for (const endpoint of ["https://user:pass@host.example", "https://host.example/path", "https://host.example/?tkn=secret", "https://host.example/#fragment"]) {
      expect(() => websocketEndpoint(endpoint)).toThrow();
    }
  });

  it("requires explicit online state and recognized key algorithms", () => {
    expect(HostConnectionInfo.safeParse({ transport: "direct" }).success).toBe(false);
    expect(HostConnectionInfo.safeParse({
      transport: "direct", online: true, serverKey: { keyId: "key", algorithm: "none", publicKey: "value" },
    }).success).toBe(false);
  });

  it("provisions a ticket without returning the caller API credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      transport: "direct", online: true, token: "t".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverKey: { keyId: "pin-key", algorithm: "x25519-sealedbox", publicKey: "public-key" },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const connection = await hostConnection("local", "direct", services());
    expect(connection.endpoint).toBe("ws://127.0.0.1:8081/");
    expect(JSON.stringify(connection)).not.toContain("private-api-key-for-test");
    expect(fetchMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:8080/v1/host/connection"),
      expect.objectContaining({ redirect: "error", headers: { authorization: "Bearer private-api-key-for-test" } }));
  });

  it("refuses to send the API key over a non-loopback plaintext connection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(hostConnection("local", "direct", services("http://remote.example"))).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
