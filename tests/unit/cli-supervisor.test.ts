import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BROKER_MOVED_CLOSE } from "@copilot-agent/contracts";
import { superviseSessionCli, type SessionConnection } from "../../src/agent-client/src/cli-supervisor.js";
import { SessionRouteChanged } from "../../configurator/server/connect-route.js";

const fakeCli = join(import.meta.dirname, "..", "fakes", "fake-ahp-cli.mjs");

/** A broker stand-in: one-use tickets bound to a placement generation, and the moved close on a placement change. */
class FakeBroker {
  readonly sessionId = randomUUID();
  readonly server: WebSocketServer;
  readonly tickets = new Map<string, { generation: number; used: boolean }>();
  readonly attached: Array<{ socket: WebSocket; generation: number; hello: Promise<string> }> = [];
  readonly refused: number[] = [];
  generation = 1;
  failProvisioning?: Error;
  /** Delays for the next provisioning calls, which capture the placement when called, as the API reads the allocation. */
  delays: number[] = [];

  constructor() {
    this.server = new WebSocketServer({
      host: "127.0.0.1", port: 0,
      verifyClient: ({ req }: { req: IncomingMessage }, done: (ok: boolean, code?: number) => void) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const ticket = this.tickets.get(url.searchParams.get("tkn") ?? "");
        const ok = url.pathname === `/sessions/${this.sessionId}` && !!ticket && !ticket.used && ticket.generation === this.generation;
        if (ticket && ok) ticket.used = true;
        if (!ok) this.refused.push(401);
        done(ok, 401);
      },
    });
    this.server.on("connection", (socket) => {
      const hello = new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString())));
      this.attached.push({ socket, generation: this.generation, hello });
    });
  }

  async listening(): Promise<void> { if (!this.server.address()) await once(this.server, "listening"); }

  provision = async (): Promise<SessionConnection> => {
    if (this.failProvisioning) throw this.failProvisioning;
    const generation = this.generation;
    const wait = this.delays.shift();
    if (wait) await delay(wait);
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, { generation, used: false });
    return {
      sessionId: this.sessionId, ahpSessionId: this.sessionId, token,
      url: `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/sessions/${this.sessionId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverKey: { keyId: `placement-${generation}`, algorithm: "x25519-sealedbox", publicKey: `public-${generation}` },
    };
  };

  /** The placement changed: bump the generation and close live connections with "moved". */
  move(): void {
    this.generation++;
    for (const { socket } of this.attached) if (socket.readyState === WebSocket.OPEN) socket.close(BROKER_MOVED_CLOSE.code, BROKER_MOVED_CLOSE.reason);
  }

  async close(): Promise<void> {
    for (const { socket } of this.attached) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(50);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function supervised(broker: FakeBroker, extra: Partial<Parameters<typeof superviseSessionCli>[0]> = {}, env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cli-supervisor-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "cli.jsonl");
  const notices: string[] = [];
  const exit = superviseSessionCli({
    command: process.execPath, args: [fakeCli, "--experimental"], env: { ...process.env, FAKE_CLI_LOG: logPath, ...env },
    connection: await broker.provision(), provision: broker.provision, notify: (message) => notices.push(message), retryMs: 50, ...extra,
  });
  const log = async () => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { exit, log, notices };
}

describe("launcher supervision of the CLI", () => {
  it("restarts the CLI in place with --resume and the new placement's key after a moved close", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const connection = await broker.provision();
    const { exit, log, notices } = await supervised(broker, { connection });
    const first = await eventually(() => broker.attached[0], "the first attachment");
    expect(await first.hello).toMatch(/^hello \d+$/);
    const [started] = await log();
    const relay = new URL(String(started!.url));
    expect(relay.hostname).toBe("127.0.0.1");
    expect(relay.port).not.toBe(String((broker.server.address() as AddressInfo).port));
    expect(relay.pathname).toBe(`/sessions/${broker.sessionId}`);
    expect(started).toMatchObject({ event: "start", resume: broker.sessionId, pin: { endpoint: relay.href, keyId: "placement-1" } });
    expect(JSON.stringify(started)).not.toContain(connection.token);

    broker.move();
    const second = await eventually(() => broker.attached.find((entry) => entry.generation === 2), "the reattachment after the move");
    const secondHello = await second.hello;
    expect(secondHello).not.toBe(await first.hello);
    const starts = (await log()).filter((entry) => entry.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ resume: broker.sessionId, pin: { keyId: "placement-2" } });
    expect(starts[1]!.pid).not.toBe(starts[0]!.pid);
    expect(notices.some((line) => line.includes("moved"))).toBe(true);
    expect([...broker.tickets.values()].filter((ticket) => ticket.used).map((ticket) => ticket.generation)).toEqual([1, 2]);

    second.socket.send("quit");
    expect(await exit).toBe(0);
  }, 60_000);

  it("keeps the CLI through a transient drop, spending a new ticket for its reconnection", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const { exit, log } = await supervised(broker);
    const first = await eventually(() => broker.attached[0], "the first attachment");
    await first.hello;
    first.socket.terminate();
    const again = await eventually(() => broker.attached[1], "the CLI's own reconnection");
    expect(await again.hello).toBe(await first.hello);
    expect((await log()).filter((entry) => entry.event === "start")).toHaveLength(1);
    expect([...broker.tickets.values()].filter((ticket) => ticket.used)).toHaveLength(2);
    again.socket.send("quit");
    expect(await exit).toBe(0);
  }, 60_000);

  it("restarts the CLI when a reconnection finds the placement changed without a moved close", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const { exit, log } = await supervised(broker);
    const first = await eventually(() => broker.attached[0], "the first attachment");
    await first.hello;
    broker.generation++;
    first.socket.terminate();
    const moved = await eventually(() => broker.attached.find((entry) => entry.generation === 2), "the reattachment at the new placement");
    await moved.hello;
    const starts = (await log()).filter((entry) => entry.event === "start");
    expect(starts.map((entry) => (entry.pin as { keyId: string }).keyId)).toEqual(["placement-1", "placement-2"]);
    moved.socket.send("quit");
    expect(await exit).toBe(0);
  }, 60_000);

  it("stops with an error when the moved session can no longer be provisioned", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const { exit, notices } = await supervised(broker, { moveTimeoutMs: 1_000 });
    await (await eventually(() => broker.attached[0], "the first attachment")).hello;
    broker.failProvisioning = Object.assign(new Error("not_found: The shared conversation is closed."), { status: 404 });
    broker.move();
    expect(await exit).toBe(1);
    expect(notices.at(-1)).toMatch(/Could not reconnect/);
  }, 60_000);

  it("retries provisioning while the move completes, and stops at once when the route no longer reaches the session", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const { exit, log } = await supervised(broker, { moveTimeoutMs: 60_000 });
    await (await eventually(() => broker.attached[0], "the first attachment")).hello;
    broker.failProvisioning = Object.assign(new Error("promotion_in_progress: The conversation is moving."), { status: 409 });
    broker.move();
    await delay(300);
    broker.failProvisioning = undefined;
    const moved = await eventually(() => broker.attached.find((entry) => entry.generation === 2), "the reattachment after the move");
    await moved.hello;
    expect((await log()).filter((entry) => entry.event === "start")).toHaveLength(2);

    broker.failProvisioning = new SessionRouteChanged("Session moved off /v1/sessions.");
    const started = Date.now();
    broker.move();
    expect(await exit).toBe(1);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("ignores a re-provisioning that began before the CLI was replaced, as after a container crash", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const { exit, log } = await supervised(broker, {}, { FAKE_CLI_HANDSHAKE_MS: "700", FAKE_CLI_RECONNECTS: "10" });
    const first = await eventually(() => broker.attached[0], "the first attachment");
    await first.hello;
    // The placement behind the connection dies. The CLI's reconnection provisions slowly against the old placement,
    // gives up on that attempt, and reconnects once the replacement (a new server key) is up.
    broker.delays = [2_500];
    first.socket.terminate();
    await delay(150);
    broker.generation++;
    const replaced = await eventually(() => broker.attached.find((entry) => entry.generation === 2), "the reattachment at the replacement");
    await replaced.hello;
    // The slow provisioning returns the old placement's key after the restart; it must not restart the CLI again.
    await delay(3_500);
    const starts = (await log()).filter((entry) => entry.event === "start");
    expect(starts.map((entry) => (entry.pin as { keyId: string }).keyId)).toEqual(["placement-1", "placement-2"]);
    replaced.socket.send("quit");
    expect(await exit).toBe(0);
  }, 60_000);

  it("returns the CLI's own exit code when the person ends it", async () => {
    const broker = new FakeBroker();
    await broker.listening();
    cleanup.push(() => broker.close());
    const { exit } = await supervised(broker);
    const first = await eventually(() => broker.attached[0], "the first attachment");
    await first.hello;
    first.socket.send("crash");
    expect(await exit).toBe(3);
  }, 60_000);
});
