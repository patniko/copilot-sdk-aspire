import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { BROKER_MOVED_CLOSE, type SharedConnection } from "@copilot-agent/contracts";
import { CLOSE_OPCODE, closeCode, FrameCursor, rejectUpgrade, upgradeProblem } from "@copilot-agent/service-defaults";

/** Connection material for one session, as `POST /v1/sessions/{id}/connection` returns it. */
export type SessionConnection = Pick<SharedConnection, "sessionId" | "ahpSessionId" | "url" | "token" | "expiresAt" | "serverKey">;

export interface CliSupervisorOptions {
  /** The executable to run, and the arguments that precede the connection arguments (for example `--experimental`). */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The first connection material, already provisioned for the session. */
  connection: SessionConnection;
  /**
   * Provisions fresh material for the same session: a new one-use ticket at its current placement. A rejection with a
   * `status` of 404, or one marked `permanent`, stops supervision; others are retried until `moveTimeoutMs`.
   */
  provision: () => Promise<SessionConnection>;
  /** Status lines for the person at the terminal. */
  notify?: (message: string) => void;
  /** How long to keep provisioning after a move before giving up; five minutes by default. */
  moveTimeoutMs?: number;
  /** The most restarts in one supervision; twenty by default. */
  maxRestarts?: number;
  /** Delay between provisioning attempts while a move completes; one second by default. */
  retryMs?: number;
}

/** Terminal modes a killed CLI may leave behind: alternate screen, hidden cursor, mouse reporting, bracketed paste. */
const TERMINAL_RESET = "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m\r\n";

/**
 * Supervises the Copilot CLI for one brokered application session (the launcher-supervised first step of
 * docs/HOSTING-MODES-PLAN.md, decision N5). The CLI attaches to a loopback relay this process owns, which spends one
 * broker ticket per CLI connection and forwards bytes unchanged. When the broker closes the session's connection with
 * "moved" (4301), as it does when the session's placement changes, the supervisor stops the CLI, provisions the same
 * session again, and restarts the CLI with `--resume` and the new placement's server key in the same terminal, so the
 * person does not rerun the launcher. Resolves with the CLI's exit code once the person ends it.
 */
export async function superviseSessionCli(options: CliSupervisorOptions): Promise<number> {
  const supervisor = new CliSupervisor(options);
  return supervisor.run();
}

class CliSupervisor {
  readonly #notify: (message: string) => void;
  readonly #server: Server;
  readonly #live = new Set<Duplex>();
  #token = randomBytes(32).toString("base64url");
  #connection: SessionConnection;
  #ticket?: SessionConnection;
  /** Increments whenever the CLI is replaced; a provisioning result that started before then is stale. */
  #version = 0;
  #child?: ChildProcess;
  #restarts = 0;
  #state: "running" | "moving" | "stopped" = "running";
  #finish!: (code: number) => void;
  #fail!: (error: Error) => void;

  constructor(private readonly options: CliSupervisorOptions) {
    this.#notify = options.notify ?? ((message) => process.stderr.write(`${message}\n`));
    this.#connection = options.connection;
    this.#ticket = options.connection;
    this.#server = createServer((_request, response) => response.writeHead(404).end());
    this.#server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      void this.#upgrade(request, socket, head).catch(() => { if (!socket.destroyed) rejectUpgrade(socket, 502); });
    });
  }

  async run(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        this.#finish = resolve;
        this.#fail = reject;
        this.#start();
      });
    } finally {
      this.#state = "stopped";
      for (const socket of this.#live) socket.destroy();
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
  }

  /** The relay URL the CLI dials; its token is a loopback secret for this supervisor only, never a broker ticket. */
  #endpoint(): URL {
    return new URL(`ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/sessions/${this.#connection.sessionId}`);
  }

  #start(): void {
    const endpoint = this.#endpoint();
    const env = { ...this.options.env, COPILOT_AHP_SERVER_KEY: JSON.stringify({ endpoint: endpoint.href, ...this.#connection.serverKey }) };
    endpoint.searchParams.set("tkn", this.#token);
    const child = spawn(this.options.command, [
      ...this.options.args, "--ahp", endpoint.href, "--ahp-authenticate-with-github", "--resume", this.#connection.ahpSessionId,
    ], { stdio: "inherit", env, shell: false });
    this.#child = child;
    child.once("error", () => {
      if (this.#child === child) this.#fail(new Error("Could not launch Copilot. Install a compatible AHP-enabled CLI or provide --cli."));
    });
    child.once("exit", (code) => {
      if (this.#child !== child || this.#state !== "running") return;
      this.#finish(code ?? 1);
    });
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const problem = upgradeProblem(request);
    if (problem) return rejectUpgrade(socket, problem);
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const presented = url.searchParams.getAll("tkn");
    if (url.pathname !== `/sessions/${this.#connection.sessionId}` || presented.length !== 1 || !same(presented[0]!, this.#token)) {
      return rejectUpgrade(socket, 401);
    }
    if (this.#state !== "running") return rejectUpgrade(socket, 503);
    const ticket = await this.#takeTicket();
    if (!ticket) return rejectUpgrade(socket, 503);
    // The CLI gave up on this attempt while the ticket was provisioned: keep the unspent ticket for its next one.
    if (socket.destroyed) {
      this.#ticket ??= ticket;
      return;
    }
    const upstream = await openUpstream(new URL(ticket.url), ticket.token, request);
    if (!upstream || "status" in upstream) {
      if (upstream?.status === 401) this.#ticket = undefined;
      return rejectUpgrade(socket, 502);
    }
    if (socket.destroyed || this.#state !== "running") {
      upstream.peer.destroy();
      return;
    }
    socket.write(upstream.response);
    this.#splice(socket, upstream.peer, head, upstream.remainder);
  }

  /**
   * A ticket for the next CLI connection: the unspent provisioned one while it is fresh, otherwise a new one. A new
   * ticket whose server key differs from the CLI's pin means the session moved without a close the relay saw. A result
   * that started provisioning before the CLI was last replaced is discarded: it can name a placement that no longer
   * serves the session, such as a crashed container the controller had not yet retired.
   */
  async #takeTicket(): Promise<SessionConnection | undefined> {
    let ticket = this.#ticket;
    this.#ticket = undefined;
    if (!ticket || Date.parse(ticket.expiresAt) - Date.now() < 5_000) {
      const version = this.#version;
      try { ticket = await this.options.provision(); }
      catch {
        this.#notify("Could not provision a connection for this session; the CLI will report the disconnection.");
        return undefined;
      }
      if (version !== this.#version || this.#state !== "running") return undefined;
      if (JSON.stringify(ticket.serverKey) !== JSON.stringify(this.#connection.serverKey) || ticket.ahpSessionId !== this.#connection.ahpSessionId) {
        void this.#moved(ticket);
        return undefined;
      }
    }
    return ticket;
  }

  #splice(client: Duplex, peer: Duplex, head: Buffer, remainder: Buffer): void {
    this.#live.add(client);
    this.#live.add(peer);
    const frames = new FrameCursor();
    let close: Buffer[] | undefined;
    peer.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const start = offset;
        if (frames.atBoundary && (chunk[offset]! & 0x0f) === CLOSE_OPCODE) close = [];
        offset = frames.advance(chunk, offset);
        if (close) {
          close.push(chunk.subarray(start, offset));
          if (frames.atBoundary) {
            const code = closeCode(Buffer.concat(close));
            close = undefined;
            // Withhold the move from the CLI: it would report a refused connection while it is being replaced.
            if (code === BROKER_MOVED_CLOSE.code) {
              client.destroy();
              peer.destroy();
              void this.#moved();
              return;
            }
          }
        }
      }
      if (!client.destroyed && !client.write(chunk)) {
        peer.pause();
        client.once("drain", () => peer.resume());
      }
    });
    client.on("data", (chunk: Buffer) => {
      if (!peer.destroyed && !peer.write(chunk)) {
        client.pause();
        peer.once("drain", () => client.resume());
      }
    });
    const end = () => { this.#live.delete(client); this.#live.delete(peer); client.destroy(); peer.destroy(); };
    client.on("close", end);
    peer.on("close", end);
    peer.on("error", () => peer.destroy());
    if (remainder.length) peer.emit("data", remainder);
    if (head.length) peer.write(head);
  }

  /**
   * The session moved: replace the CLI with one attached to the session's new placement. `next` is the ticket that
   * revealed the move, if any; otherwise the new placement is provisioned after the CLI stops.
   */
  async #moved(next?: SessionConnection): Promise<void> {
    if (this.#state !== "running") return;
    this.#state = "moving";
    this.#version++;
    // A ticket kept from before the move names the old placement.
    this.#ticket = undefined;
    for (const socket of this.#live) socket.destroy();
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESET);
    if (++this.#restarts > (this.options.maxRestarts ?? 20)) {
      this.#notify("The session moved too many times; stopping. Reconnect with pnpm host:connect --resume.");
      this.#state = "stopped";
      return this.#finish(1);
    }
    this.#notify(`Session ${this.#connection.sessionId} moved to a new placement. Reconnecting in this terminal...`);
    const deadline = Date.now() + (this.options.moveTimeoutMs ?? 300_000);
    let connection = next && Date.parse(next.expiresAt) - Date.now() >= 5_000 ? next : undefined;
    while (!connection) {
      try { connection = await this.options.provision(); }
      catch (error) {
        if (Date.now() >= deadline || permanent(error)) {
          this.#notify(`Could not reconnect to session ${this.#connection.sessionId}: ${error instanceof Error ? error.message : "provisioning failed"}`);
          this.#state = "stopped";
          return this.#finish(1);
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.retryMs ?? 1_000));
      }
    }
    if (connection.sessionId !== this.#connection.sessionId) {
      this.#notify("Provisioning returned another session; stopping.");
      this.#state = "stopped";
      return this.#finish(1);
    }
    this.#connection = connection;
    this.#ticket = connection;
    this.#token = randomBytes(32).toString("base64url");
    this.#state = "running";
    this.#notify(`Resuming session ${connection.sessionId} at its new placement.`);
    this.#start();
  }
}

function same(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A provisioning failure that retrying cannot fix: the session is gone, or no longer reachable on this path. */
function permanent(error: unknown): boolean {
  return error instanceof Error && (("status" in error && error.status === 404) || ("permanent" in error && error.permanent === true));
}

/**
 * Opens the broker connection for one relayed CLI connection, presenting the CLI's own key and version so the broker's
 * `101` answers the CLI's handshake; no extension or subprotocol is negotiated, so frames are never compressed.
 */
function openUpstream(url: URL, ticket: string, client: IncomingMessage): Promise<{ peer: Duplex; remainder: Buffer; response: string } | { status: number } | undefined> {
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return Promise.resolve(undefined);
  const target = new URL(url);
  target.searchParams.set("tkn", ticket);
  return new Promise((resolve) => {
    const outgoing = (target.protocol === "wss:" ? httpsRequest : httpRequest)({
      host: target.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(target.port || (target.protocol === "wss:" ? 443 : 80)),
      method: "GET", path: `${target.pathname}${target.search}`, timeout: 10_000,
      headers: {
        host: target.host, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": client.headers["sec-websocket-key"], "sec-websocket-version": client.headers["sec-websocket-version"],
      },
    });
    outgoing.on("upgrade", (response, peer, remainder) => {
      peer.setTimeout(0);
      const headers = Object.entries(response.headers).flatMap(([key, value]) =>
        value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`));
      resolve({ peer, remainder, response: `HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n` });
    });
    outgoing.on("response", (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }); });
    outgoing.on("timeout", () => { outgoing.destroy(); resolve(undefined); });
    outgoing.on("error", () => resolve(undefined));
    outgoing.end();
  });
}
