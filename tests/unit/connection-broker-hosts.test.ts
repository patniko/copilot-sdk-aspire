import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { HostBrokerRoute } from "@copilot-agent/contracts";
import { createService, registerAhpProxy } from "@copilot-agent/service-defaults";
import { buildBroker } from "../../src/connection-broker/src/broker.js";
import { DispatcherHostDirectory, hostRoutes, hostUpstream, type HostDirectory } from "../../src/connection-broker/src/hosts.js";

const nativeToken = "synthetic-native-listener-token-".repeat(2);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action().catch(() => undefined);
});
const listen = async (server: Server | FastifyInstance["server"]) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

/** Stands in for the dispatcher: one-use client tickets per harness, exchanged for one-use upstream tickets. */
class FakeHostDirectory implements HostDirectory {
  readonly #clients = new Map<string, string>();
  readonly upstream = new Set<string>();
  available = true;
  constructor(private readonly endpoints: ReadonlyMap<string, string>) {}
  issue(harness: string): string {
    const ticket = randomBytes(32).toString("base64url");
    this.#clients.set(ticket, harness);
    return ticket;
  }
  async consume(harness: string, ticket: string): Promise<HostBrokerRoute | undefined> {
    if (!this.available) throw new Error("The synthetic directory is unavailable.");
    if (this.#clients.get(ticket) !== harness) return undefined;
    this.#clients.delete(ticket);
    const upstreamTicket = randomBytes(32).toString("base64url");
    this.upstream.add(upstreamTicket);
    return { kind: "host", harness, epoch: randomUUID(), endpoint: this.endpoints.get(harness)!, upstreamTicket };
  }
}

/** A synthetic owner host in the demo host's ticket mode, in front of a private listener that echoes its URL. */
async function ownerHost(accepted: Set<string>) {
  const presented: string[] = [];
  const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  native.on("connection", (socket, request) => socket.send(`native ${request.url}`));
  await new Promise((resolve) => native.once("listening", resolve));
  cleanup.push(() => new Promise((resolve) => { for (const client of native.clients) client.terminate(); native.close(() => resolve()); }));
  const host = createService({ name: "synthetic-owner-host" });
  registerAhpProxy(host, {
    token: nativeToken, targetPort: (native.address() as AddressInfo).port, ready: () => true,
    authorize: async (ticket) => { presented.push(ticket); return accepted.delete(ticket); },
  });
  const port = await listen(host.server);
  cleanup.push(() => host.close());
  return { origin: `http://127.0.0.1:${port}/`, presented };
}

async function fixture() {
  const accepted = new Set<string>();
  const host = await ownerHost(accepted);
  const directory = new FakeHostDirectory(new Map([["interactive-demo", host.origin], ["review-agent", host.origin]]));
  const { app } = buildBroker<HostBrokerRoute>({
    families: [hostRoutes({ consume: async (harness, ticket) => {
      const route = await directory.consume(harness, ticket);
      if (route) accepted.add(route.upstreamTicket);
      return route;
    } })],
    upstreams: { host: hostUpstream },
  });
  const port = await listen(app.server);
  cleanup.push(() => app.close());
  const connect = (path: string, ticket?: string) => new Promise<{ socket: WebSocket; first: Promise<string> } | number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}${ticket ? `?tkn=${encodeURIComponent(ticket)}` : ""}`);
    const first = new Promise<string>((done) => socket.once("message", (data: Buffer) => done(data.toString())));
    socket.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.on("open", () => { cleanup.push(async () => socket.terminate()); resolve({ socket, first }); });
    socket.on("error", reject);
  });
  return { directory, host, connect };
}

describe("connection broker owner-host routes", () => {
  it("exchanges the client's one-use ticket for an upstream ticket that the host checks as its own", async () => {
    const { directory, host, connect } = await fixture();
    const ticket = directory.issue("interactive-demo");
    const client = await connect("/hosts/interactive-demo", ticket);
    if (typeof client === "number") throw new Error(`The broker refused the connection (${client}).`);
    expect(await client.first).toBe(`native /?tkn=${encodeURIComponent(nativeToken)}`);
    expect(host.presented).toHaveLength(1);
    expect(host.presented[0]).not.toBe(ticket);
    expect(directory.upstream.has(host.presented[0]!)).toBe(true);
    expect(await connect("/hosts/interactive-demo", ticket)).toBe(401);
  });

  it("refuses another harness's ticket, malformed paths, missing tickets, and an unavailable directory", async () => {
    const { directory, host, connect } = await fixture();
    expect(await connect("/hosts/review-agent", directory.issue("interactive-demo"))).toBe(401);
    for (const path of ["/hosts/Interactive-Demo", "/hosts/interactive-demo/extra", "/hosts/", "/host/interactive-demo"]) {
      expect(await connect(path, directory.issue("interactive-demo"))).toBe(404);
    }
    expect(await connect("/hosts/interactive-demo")).toBe(401);
    directory.available = false;
    expect(await connect("/hosts/interactive-demo", directory.issue("interactive-demo"))).toBe(503);
    expect(host.presented).toEqual([]);
  });

  it("dials only internal HTTP origins with the upstream ticket in the host's own query", () => {
    const route: HostBrokerRoute = {
      kind: "host", harness: "interactive-demo", epoch: randomUUID(), endpoint: "http://127.0.0.1:4100/", upstreamTicket: "a+b/".repeat(10),
    };
    const upstream = hostUpstream(route);
    expect(upstream.origin.href).toBe("http://127.0.0.1:4100/");
    expect(upstream.path).toBe(`/?tkn=${encodeURIComponent(route.upstreamTicket)}`);
    expect(upstream.headers).toBeUndefined();
    for (const endpoint of ["https://host.example/", "http://user:secret@127.0.0.1:4100/", "http://127.0.0.1:4100/path", "http://127.0.0.1:4100/?q=1"]) {
      expect(() => hostUpstream({ ...route, endpoint })).toThrow(/internal HTTP origin/);
    }
  });

  it("asks the dispatcher with the broker key, treating a dispatcher without host routes as a refusal", async () => {
    const route = { kind: "host", harness: "interactive-demo", epoch: randomUUID(), endpoint: "http://127.0.0.1:4100/", upstreamTicket: "u".repeat(43) };
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ authorized: true, route }))
      .mockResolvedValueOnce(Response.json({ authorized: false }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ authorized: true, route: { ...route, endpoint: "https://host.example/" } }));
    const directory = new DispatcherHostDirectory("http://dispatcher.internal", "synthetic-broker-key-".repeat(2));
    expect(await directory.consume("interactive-demo", "t".repeat(43))).toEqual(route);
    expect(String(request.mock.calls[0]![0])).toBe("http://dispatcher.internal/internal/broker/host-connection");
    expect(request.mock.calls[0]![1]).toMatchObject({
      method: "POST", redirect: "error", body: JSON.stringify({ harness: "interactive-demo", ticket: "t".repeat(43) }),
      headers: { "x-internal-key": "synthetic-broker-key-".repeat(2) },
    });
    expect(await directory.consume("interactive-demo", "t".repeat(43))).toBeUndefined();
    expect(await directory.consume("interactive-demo", "t".repeat(43))).toBeUndefined();
    await expect(directory.consume("interactive-demo", "t".repeat(43))).rejects.toThrow(/refused a broker request \(500\)/);
    await expect(directory.consume("interactive-demo", "t".repeat(43))).rejects.toThrow();
  });
});
