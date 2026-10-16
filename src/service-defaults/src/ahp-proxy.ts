import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { secretsEqual } from "./auth.js";

export interface AhpProxyTarget { token: string; targetPort: number }

/** A WebSocket upgrade destination: an internal HTTP origin, a request path, and headers that authenticate the hop. */
export interface AhpUpstream {
  origin: URL;
  path: string;
  headers?: Record<string, string>;
}

type ProxyOptions = { ready: () => boolean } & (
  /** A public one-use ticket in `tkn`, verified before connecting to one private listener. */
  | (AhpProxyTarget & { authorize: (ticket: string) => Promise<boolean> })
  /**
   * Only connections forwarded by the holder of `forwardedBy`, presented in `x-internal-key`. Query strings, and so
   * public tickets, are refused; `resolve` picks the private listener from the path and forwarded headers.
   */
  | { forwardedBy: string; resolve: (path: string, headers: IncomingHttpHeaders) => Promise<AhpProxyTarget | undefined> }
);

const WEBSOCKET_KEY = /^[A-Za-z0-9+/]{22}==$/;

export function rejectUpgrade(socket: Duplex, code: number): void {
  socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** 404 for anything but a WebSocket upgrade, 400 for a malformed or non-version-13 handshake, otherwise undefined. */
export function upgradeProblem(request: IncomingMessage): 400 | 404 | undefined {
  if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") return 404;
  const key = request.headers["sec-websocket-key"];
  return typeof key === "string" && WEBSOCKET_KEY.test(key) && request.headers["sec-websocket-version"] === "13" ? undefined : 400;
}

/** The single `tkn` query value, if the request carries exactly one of a plausible ticket length. */
export function connectionTicket(url: URL): string | undefined {
  const tickets = url.searchParams.getAll("tkn");
  return tickets.length === 1 && tickets[0]!.length >= 32 && tickets[0]!.length <= 200 ? tickets[0] : undefined;
}

export function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? undefined : value;
}

/**
 * Opens the upstream half of a client's WebSocket upgrade and relays the upstream's `101` response to the client.
 * Only the client's key and version cross the hop, so no extension or subprotocol is negotiated and frames are never
 * compressed. Resolves with the upstream socket and any bytes the upstream sent after its response, or `undefined`
 * after rejecting the client with `502` when the upstream refuses or fails.
 */
export function openUpstream(request: IncomingMessage, socket: Duplex, upstream: AhpUpstream): Promise<{ peer: Duplex; remainder: Buffer } | undefined> {
  if (upstream.origin.protocol !== "http:") return Promise.reject(new Error("AHP upstreams must be internal HTTP origins."));
  return new Promise((resolve) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      if (!socket.destroyed) rejectUpgrade(socket, 502);
      resolve(undefined);
    };
    const outgoing = httpRequest({
      host: upstream.origin.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(upstream.origin.port || 80),
      method: "GET", path: upstream.path,
      headers: {
        ...upstream.headers,
        host: upstream.origin.host,
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": request.headers["sec-websocket-key"],
        "sec-websocket-version": request.headers["sec-websocket-version"],
      },
      timeout: 10_000,
    });
    outgoing.on("upgrade", (response, peer, remainder) => {
      if (settled) { peer.destroy(); return; }
      settled = true;
      peer.setTimeout(0);
      if (socket.destroyed) { peer.destroy(); resolve(undefined); return; }
      for (const stream of [socket, peer]) if (stream instanceof Socket) stream.setNoDelay(true);
      const headers = Object.entries(response.headers).flatMap(([key, value]) =>
        value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      resolve({ peer, remainder });
    });
    outgoing.on("response", (response) => { response.resume(); fail(); });
    outgoing.on("timeout", () => { outgoing.destroy(); fail(); });
    outgoing.on("error", fail);
    outgoing.end();
  });
}

/** Authenticates upgrades, then proxies bytes to a private AHP listener; it does not reinterpret AHP messages. */
export function registerAhpProxy(app: FastifyInstance, options: ProxyOptions): void {
  const connections = new Set<Duplex>();
  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const problem = upgradeProblem(request);
    if (problem) return rejectUpgrade(socket, problem);
    if ("authorize" in options && url.pathname !== "/") return rejectUpgrade(socket, 404);
    if (!options.ready()) return rejectUpgrade(socket, 503);
    let target: AhpProxyTarget | undefined;
    if ("authorize" in options) {
      const ticket = connectionTicket(url);
      if (!ticket) return rejectUpgrade(socket, 401);
      target = await options.authorize(ticket) ? options : undefined;
    } else {
      const presented = singleHeader(request.headers, "x-internal-key");
      if (url.search || !presented || !secretsEqual(presented, options.forwardedBy)) return rejectUpgrade(socket, 401);
      target = await options.resolve(url.pathname, request.headers);
    }
    if (!target) return rejectUpgrade(socket, 401);
    if (socket.destroyed) return;
    const tunnel = await openUpstream(request, socket, {
      origin: new URL(`http://127.0.0.1:${target.targetPort}`), path: `/?tkn=${encodeURIComponent(target.token)}`,
    });
    if (!tunnel) return;
    const { peer, remainder } = tunnel;
    connections.add(socket);
    connections.add(peer);
    if (head.length) peer.write(head);
    if (remainder.length) socket.write(remainder);
    socket.pipe(peer).pipe(socket);
    socket.on("close", () => { connections.delete(socket); peer.destroy(); });
    peer.on("close", () => { connections.delete(peer); socket.destroy(); });
    peer.on("error", () => socket.destroy());
  };
  app.server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    void upgrade(request, socket, head).catch(() => {
      app.log.error("AHP connection identity verification failed.");
      rejectUpgrade(socket, 503);
    });
  });
  app.addHook("preClose", async () => {
    for (const connection of connections) connection.destroy();
  });
}
