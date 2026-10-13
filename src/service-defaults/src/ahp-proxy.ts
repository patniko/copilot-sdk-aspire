import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";

export interface AhpProxyTarget { token: string; targetPort: number }
type ProxyOptions = { ready: () => boolean } & (
  | (AhpProxyTarget & { authorize: (ticket: string) => Promise<boolean> })
  | { resolve: (path: string, ticket: string) => Promise<AhpProxyTarget | undefined> }
);

/** Authenticates upgrades, then proxies bytes; it does not reinterpret AHP messages. */
export function registerAhpProxy(app: FastifyInstance, options: ProxyOptions): void {
  const connections = new Set<Duplex>();
  const reject = (socket: Duplex, code: number) => {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") return reject(socket, 404);
    if (!("resolve" in options) && url.pathname !== "/") return reject(socket, 404);
    if (!options.ready()) return reject(socket, 503);
    const tickets = url.searchParams.getAll("tkn");
    if (tickets.length !== 1 || tickets[0]!.length < 32 || tickets[0]!.length > 200) return reject(socket, 401);
    const target = "resolve" in options
      ? await options.resolve(url.pathname, tickets[0]!)
      : await options.authorize(tickets[0]!) ? options : undefined;
    if (!target) return reject(socket, 401);
    if (socket.destroyed) return;
    const upstream = httpRequest({
      host: "127.0.0.1", port: target.targetPort, method: "GET",
      path: `/?tkn=${encodeURIComponent(target.token)}`,
      headers: {
        host: `127.0.0.1:${target.targetPort}`,
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": request.headers["sec-websocket-key"],
        "sec-websocket-version": request.headers["sec-websocket-version"],
      },
      timeout: 10_000,
    });
    upstream.on("upgrade", (response, peer, remainder) => {
      connections.add(socket);
      connections.add(peer);
      const headers = Object.entries(response.headers).flatMap(([key, value]) =>
        value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head);
      if (remainder.length) socket.write(remainder);
      socket.pipe(peer).pipe(socket);
      socket.on("close", () => { connections.delete(socket); peer.destroy(); });
      peer.on("close", () => { connections.delete(peer); socket.destroy(); });
      peer.on("error", () => socket.destroy());
    });
    upstream.on("response", (response) => { response.resume(); reject(socket, 502); });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => reject(socket, 502));
    upstream.end();
  };
  app.server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    void upgrade(request, socket, head).catch(() => {
      app.log.error("AHP connection identity verification failed.");
      reject(socket, 503);
    });
  });
  app.addHook("preClose", async () => {
    for (const connection of connections) connection.destroy();
  });
}
