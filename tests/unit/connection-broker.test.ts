import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BROKER_MOVED_CLOSE, PLACEMENT_EPOCH_HEADER, type PlacementRoute, type SessionPlacement } from "@copilot-agent/contracts";
import { createService, registerAhpProxy } from "@copilot-agent/service-defaults";
import { buildBroker, type ConnectionBroker } from "../../src/connection-broker/src/broker.js";
import { closeFrame, FrameCursor } from "../../src/connection-broker/src/frames.js";
import { sessionRoutes, sharedUpstream, type PlacementDirectory } from "../../src/connection-broker/src/sessions.js";

const brokerKey = "synthetic-connection-broker-key-".repeat(2);
const nativeToken = "synthetic-native-listener-token-".repeat(2);

function frame(opcode: number, payload: Buffer, mask?: Buffer): Buffer {
  const length = payload.length;
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (mask ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (mask ? 0x80 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (mask) mask.copy(header, 2 + extended);
  return Buffer.concat([header, mask ? Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!)) : payload]);
}

function boundaries(cursor: FrameCursor, chunks: Buffer[]): Array<{ chunk: number; offset: number; opcode: number }> {
  const found: Array<{ chunk: number; offset: number; opcode: number }> = [];
  chunks.forEach((chunk, index) => {
    let offset = 0;
    while (offset < chunk.length) {
      offset = cursor.advance(chunk, offset);
      if (cursor.atBoundary) found.push({ chunk: index, offset, opcode: cursor.opcode });
    }
  });
  return found;
}

describe("WebSocket frame boundaries", () => {
  it("finds the end of every frame across lengths, masks, and arbitrary chunking", () => {
    const frames = [
      frame(0x1, Buffer.from("hello")),
      frame(0x9, Buffer.alloc(0)),
      frame(0x2, randomBytes(300), randomBytes(4)),
      frame(0x2, randomBytes(70_000)),
      frame(0x8, Buffer.from([0x03, 0xe8])),
    ];
    const stream = Buffer.concat(frames);
    const ends = frames.map((_, index) => frames.slice(0, index + 1).reduce((sum, item) => sum + item.length, 0));
    for (const size of [1, 2, 3, 7, 125, 4096, stream.length]) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < stream.length; offset += size) chunks.push(stream.subarray(offset, offset + size));
      const found = boundaries(new FrameCursor(), chunks).map(({ chunk, offset, opcode }) => ({ at: chunk * size + offset, opcode }));
      expect(found, `chunk size ${size}`).toEqual(ends.map((at, index) => ({ at, opcode: [0x1, 0x9, 0x2, 0x2, 0x8][index] })));
    }
  });

  it("refuses lengths it cannot represent and encodes only valid close frames", () => {
    const header = Buffer.from([0x82, 127, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => new FrameCursor().advance(header, 0)).toThrow(/length/);
    expect([...closeFrame(4301, "moved")]).toEqual([0x88, 7, 0x10, 0xcd, ...Buffer.from("moved")]);
    expect(() => closeFrame(999, "")).toThrow();
    expect(() => closeFrame(4301, "x".repeat(124))).toThrow();
  });
});

/** A raw private listener standing in for the native AHP host, so tests control every frame it writes. */
class NativeListener {
  readonly server: Server = createServer((_request, response) => response.writeHead(404).end());
  readonly sockets: Duplex[] = [];
  readonly urls: string[] = [];
  constructor() {
    this.server.on("upgrade", (request, socket) => {
      this.urls.push(request.url ?? "");
      if (request.url !== `/?tkn=${encodeURIComponent(nativeToken)}`) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("error", () => socket.destroy());
      socket.on("end", () => socket.destroy());
      this.sockets.push(socket);
    });
  }
  get port(): number { return (this.server.address() as AddressInfo).port; }
  async socket(index = 0): Promise<Duplex> {
    const deadline = Date.now() + 5_000;
    while (!this.sockets[index]) {
      if (Date.now() > deadline) throw new Error("The private listener received no connection.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.sockets[index]!;
  }
}

class FakeDirectory implements PlacementDirectory {
  readonly placements = new Map<string, SessionPlacement>();
  readonly #tickets = new Map<string, PlacementRoute>();
  available = true;
  issue(sessionId: string, epoch: string): string {
    const placement = this.placements.get(sessionId)!;
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { kind: "shared", sessionId, generation: placement.generation, epoch });
    return ticket;
  }
  move(sessionId: string): void {
    const placement = this.placements.get(sessionId)!;
    this.placements.set(sessionId, { ...placement, generation: placement.generation + 1 });
  }
  async consume(sessionId: string, ticket: string): Promise<PlacementRoute | undefined> {
    if (!this.available) throw new Error("The synthetic directory is unavailable.");
    const route = this.#tickets.get(ticket);
    if (route?.sessionId !== sessionId) return undefined;
    this.#tickets.delete(ticket);
    return route.generation === this.placements.get(sessionId)?.generation ? route : undefined;
  }
  async lookup(sessionIds: readonly string[]): Promise<SessionPlacement[]> {
    if (!this.available) throw new Error("The synthetic directory is unavailable.");
    return sessionIds.flatMap((id) => this.placements.get(id) ?? []);
  }
}

interface Client { socket: WebSocket; messages: Buffer[]; closed: Promise<{ code: number; reason: string }> }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action().catch(() => undefined);
});
const listen = async (server: Server | FastifyInstance["server"]) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

async function fixture(checkMilliseconds = 25) {
  const native = new NativeListener();
  const nativePort = await listen(native.server);
  cleanup.push(async () => { for (const socket of native.sockets) socket.destroy(); native.server.close(); });
  const sessionId = randomUUID();
  const epoch = randomUUID();
  const forwarded: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const ingress = createService({ name: "synthetic-placement" });
  registerAhpProxy(ingress, {
    ready: () => true, forwardedBy: brokerKey,
    resolve: async (path, headers) => {
      forwarded.push({ path, headers });
      return path === `/sessions/${sessionId}` && headers[PLACEMENT_EPOCH_HEADER] === epoch ? { token: nativeToken, targetPort: nativePort } : undefined;
    },
  });
  const ingressPort = await listen(ingress.server);
  cleanup.push(() => ingress.close());
  const directory = new FakeDirectory();
  directory.placements.set(sessionId, { sessionId, kind: "shared", generation: 1 });
  const { app, broker } = buildBroker({
    families: [sessionRoutes(directory)],
    upstreams: { shared: sharedUpstream(new URL(`http://127.0.0.1:${ingressPort}`), brokerKey) },
    checkMilliseconds,
  });
  const brokerPort = await listen(app.server);
  cleanup.push(() => app.close());
  const connect = (ticket: string, path = `/sessions/${sessionId}`) => openClient(`ws://127.0.0.1:${brokerPort}${path}?tkn=${encodeURIComponent(ticket)}`);
  return { native, directory, broker: broker as ConnectionBroker<PlacementRoute>, sessionId, epoch, forwarded, ingressPort, brokerPort, connect, ticket: () => directory.issue(sessionId, epoch) };
}

function openClient(url: string, headers?: Record<string, string>): Promise<Client | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const messages: Buffer[] = [];
    let closed: (value: { code: number; reason: string }) => void = () => undefined;
    const close = new Promise<{ code: number; reason: string }>((done) => { closed = done; });
    socket.on("message", (data: Buffer) => messages.push(Buffer.from(data)));
    socket.on("close", (code, reason) => closed({ code, reason: reason.toString() }));
    socket.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.on("open", () => {
      cleanup.push(async () => socket.terminate());
      resolve({ socket, messages, closed: close });
    });
    socket.on("error", (error) => reject(error));
  });
}

async function connected(attempt: Promise<Client | number>): Promise<Client> {
  const client = await attempt;
  if (typeof client === "number") throw new Error(`The broker refused the connection (${client}).`);
  return client;
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("AHP proxy ticket mode used by the demo host", () => {
  it("authorizes the public ticket, then connects to the private listener with only its private token", async () => {
    const native = new NativeListener();
    const nativePort = await listen(native.server);
    cleanup.push(async () => { for (const socket of native.sockets) socket.destroy(); native.server.close(); });
    const tickets: string[] = [];
    let ready = false;
    const host = createService({ name: "synthetic-demo-host" });
    registerAhpProxy(host, {
      token: nativeToken, targetPort: nativePort, ready: () => ready,
      authorize: async (ticket) => { tickets.push(ticket); return ticket.startsWith("valid-"); },
    });
    const port = await listen(host.server);
    cleanup.push(() => host.close());
    const ticket = `valid-${randomBytes(32).toString("base64url")}`;
    expect(await openClient(`ws://127.0.0.1:${port}/?tkn=${ticket}`)).toBe(503);
    ready = true;
    expect(await openClient(`ws://127.0.0.1:${port}/sessions/${randomUUID()}?tkn=${ticket}`)).toBe(404);
    expect(await openClient(`ws://127.0.0.1:${port}/`)).toBe(401);
    expect(await openClient(`ws://127.0.0.1:${port}/?tkn=invalid-${randomBytes(32).toString("base64url")}`)).toBe(401);
    const client = await connected(openClient(`ws://127.0.0.1:${port}/?tkn=${ticket}`));
    (await native.socket()).write(frame(0x1, Buffer.from("hosted")));
    await eventually(() => client.messages.length === 1, "a hosted message");
    expect(client.messages[0]!.toString()).toBe("hosted");
    expect(tickets.at(-1)).toBe(ticket);
    expect(native.urls).toEqual([`/?tkn=${encodeURIComponent(nativeToken)}`]);
  });
});

describe("connection broker", () => {
  it("consumes the client's ticket once and forwards bytes with only the broker's credential", async () => {
    const { native, connect, ticket, forwarded, sessionId, epoch } = await fixture();
    const issued = ticket();
    const client = await connected(connect(issued));
    const upstream = await native.socket();
    upstream.write(frame(0x1, Buffer.from("from placement")));
    await eventually(() => client.messages.length === 1, "a downstream message");
    expect(client.messages[0]!.toString()).toBe("from placement");
    const received: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => received.push(chunk));
    client.socket.send("from client");
    await eventually(() => Buffer.concat(received).length >= 2 + 4 + 11, "an upstream message");
    expect(native.urls).toEqual([`/?tkn=${encodeURIComponent(nativeToken)}`]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.path).toBe(`/sessions/${sessionId}`);
    expect(forwarded[0]!.headers[PLACEMENT_EPOCH_HEADER]).toBe(epoch);
    expect(JSON.stringify(forwarded[0]!.headers)).not.toContain(issued);
    expect(await connect(issued)).toBe(401);
  });

  it("refuses malformed paths, tickets, handshakes, and unavailable directories", async () => {
    const { connect, ticket, directory, brokerPort, sessionId } = await fixture();
    expect(await connect(ticket(), `/sessions/${randomUUID()}`)).toBe(401);
    expect(await connect(ticket(), "/")).toBe(404);
    expect(await connect(ticket(), `/sessions/${sessionId}/extra`)).toBe(404);
    expect(await connect("short")).toBe(401);
    expect(await openClient(`ws://127.0.0.1:${brokerPort}/sessions/${sessionId}`)).toBe(401);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port: brokerPort, path: `/sessions/${sessionId}?tkn=${ticket()}`, headers: {
        connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "not-a-key",
      } });
      request.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("upgrade", () => reject(new Error("A malformed handshake was accepted.")));
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(400);
    const live = await connected(connect(ticket()));
    directory.available = false;
    expect(await connect(ticket())).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("accepts only broker-forwarded connections at the placement's ingress", async () => {
    const { ingressPort, ticket, sessionId, epoch } = await fixture();
    const direct = (headers?: Record<string, string>, query = "") => openClient(`ws://127.0.0.1:${ingressPort}/sessions/${sessionId}${query}`, headers);
    expect(await direct(undefined, `?tkn=${ticket()}`)).toBe(401);
    expect(await direct({ "x-internal-key": "wrong-connection-broker-key-".repeat(2), [PLACEMENT_EPOCH_HEADER]: epoch })).toBe(401);
    expect(await direct({ "x-internal-key": brokerKey, [PLACEMENT_EPOCH_HEADER]: randomUUID() })).toBe(401);
    expect(await direct({ "x-internal-key": brokerKey, [PLACEMENT_EPOCH_HEADER]: epoch }, `?tkn=${ticket()}`)).toBe(401);
    expect(typeof await direct({ "x-internal-key": brokerKey, [PLACEMENT_EPOCH_HEADER]: epoch })).toBe("object");
  });

  it("closes with the moved code when the placement changes, and refuses tickets for the old generation", async () => {
    const { native, connect, ticket, directory, sessionId, broker } = await fixture();
    const stale = ticket();
    const client = await connected(connect(ticket()));
    const upstream = await native.socket();
    const upstreamClosed = new Promise((resolve) => upstream.once("close", resolve));
    directory.move(sessionId);
    expect(await client.closed).toEqual({ code: BROKER_MOVED_CLOSE.code, reason: BROKER_MOVED_CLOSE.reason });
    await upstreamClosed;
    expect(await connect(stale)).toBe(401);
    const replacement = await connected(connect(ticket()));
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN);
    await eventually(() => broker.connections === 1, "the moved connection to be released");
  });

  it("delivers a frame in flight completely before the moved close", async () => {
    const { native, connect, ticket, directory, sessionId, broker } = await fixture(60_000);
    const client = await connected(connect(ticket()));
    const upstream = await native.socket();
    const payload = randomBytes(200_000);
    const message = frame(0x2, payload);
    upstream.write(message.subarray(0, 100_000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    directory.move(sessionId);
    await broker.check();
    let early = false;
    void client.closed.then(() => { early = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(early).toBe(false);
    upstream.write(message.subarray(100_000));
    expect(await client.closed).toEqual({ code: BROKER_MOVED_CLOSE.code, reason: BROKER_MOVED_CLOSE.reason });
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]!.equals(payload)).toBe(true);
  });

  it("replaces an upstream close with moved only when the placement changed", async () => {
    const moved = await fixture(60_000);
    const first = await connected(moved.connect(moved.ticket()));
    moved.directory.move(moved.sessionId);
    (await moved.native.socket()).write(closeFrame(1001, "going away"));
    expect(await first.closed).toEqual({ code: BROKER_MOVED_CLOSE.code, reason: BROKER_MOVED_CLOSE.reason });

    const current = await fixture(60_000);
    const second = await connected(current.connect(current.ticket()));
    const upstream = await current.native.socket();
    upstream.write(closeFrame(1000, "finished"));
    upstream.end();
    expect(await second.closed).toEqual({ code: 1000, reason: "finished" });

    const dropped = await fixture(60_000);
    const third = await connected(dropped.connect(dropped.ticket()));
    (await dropped.native.socket()).destroy();
    expect((await third.closed).code).toBe(1006);

    const droppedAfterMove = await fixture(60_000);
    const fourth = await connected(droppedAfterMove.connect(droppedAfterMove.ticket()));
    droppedAfterMove.directory.move(droppedAfterMove.sessionId);
    (await droppedAfterMove.native.socket()).destroy();
    expect(await fourth.closed).toEqual({ code: BROKER_MOVED_CLOSE.code, reason: BROKER_MOVED_CLOSE.reason });
  });

  it("passes a client-initiated close handshake through without a placement recheck", async () => {
    const { native, connect, ticket, directory, sessionId, broker } = await fixture(60_000);
    const client = await connected(connect(ticket()));
    const upstream = await native.socket();
    const received: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (Buffer.concat(received).length >= 2 + 4 + 2) {
        upstream.write(closeFrame(1000, "bye"));
        upstream.end();
      }
    });
    directory.move(sessionId);
    client.socket.close(1000, "");
    expect(await client.closed).toEqual({ code: 1000, reason: "bye" });
    await eventually(() => broker.connections === 0, "the closed connection to be released");
  });

  it("drops connections whose session is gone and keeps them while checks are unavailable", async () => {
    const { connect, ticket, directory, sessionId, broker } = await fixture(60_000);
    const client = await connected(connect(ticket()));
    directory.available = false;
    await broker.check();
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    directory.available = true;
    directory.placements.delete(sessionId);
    await broker.check();
    expect((await client.closed).code).toBe(1006);
  });
});
