import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { secretsEqual } from "@copilot-agent/service-defaults";

export async function verifyGitHubOwner(token: string, expected: string): Promise<boolean> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "copilot-aspire-demo-host" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error("GitHub identity verification is unavailable.");
  const user: unknown = await response.json();
  return !!user && typeof user === "object" && "login" in user && typeof user.login === "string"
    && user.login.toLowerCase() === expected.toLowerCase();
}

/** Authenticates upgrades, then proxies bytes; it does not reinterpret AHP messages. */
export function registerAhpProxy(app: FastifyInstance, options: {
  token: string;
  owner: string;
  targetPort: number;
  ready: () => boolean;
  verifyOwner?: typeof verifyGitHubOwner;
}): void {
  const connections = new Set<Duplex>();
  const reject = (socket: Duplex, code: number) => {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (request.method !== "GET" || url.pathname !== "/" || request.headers.upgrade?.toLowerCase() !== "websocket") return reject(socket, 404);
    if (!options.ready()) return reject(socket, 503);
    if (!secretsEqual(url.searchParams.get("tkn") ?? "", options.token)) return reject(socket, 401);
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!bearer || !(await (options.verifyOwner ?? verifyGitHubOwner)(bearer, options.owner))) return reject(socket, 403);
    if (socket.destroyed) return;
    const upstream = httpRequest({
      host: "127.0.0.1", port: options.targetPort, method: "GET",
      path: `/?tkn=${encodeURIComponent(options.token)}`,
      headers: {
        host: `127.0.0.1:${options.targetPort}`,
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
