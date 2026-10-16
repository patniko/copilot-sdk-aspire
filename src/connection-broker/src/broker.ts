import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { connectionTicket, createService, openUpstream, rejectUpgrade, upgradeProblem, type AhpUpstream } from "@copilot-agent/service-defaults";
import { BrokeredConnection, type RouteStatus } from "./connection.js";

/** A consumed ticket's destination. `kind` selects the upstream table entry; other fields are kind-specific. */
export interface BrokerRoute { kind: string }

/**
 * One family of public paths, such as `/sessions/{id}`. A family turns a path into its connection key, consumes the
 * client's one-use ticket for that key, and may report when live routes move. Families without movable placements
 * omit `check`.
 */
export interface RouteFamily<R extends BrokerRoute> {
  /** A short label for logs, such as "session". */
  readonly name: string;
  /** The connection key for a request path, or undefined when the path belongs to another family. */
  match(path: string): string | undefined;
  /** Consumes the ticket presented for `key`. Resolves undefined when refused; rejects when the directory is unavailable. */
  authorize(key: string, ticket: string): Promise<R | undefined>;
  /** The status of each live route, in order. */
  check?(routes: readonly R[], timeoutMilliseconds: number): Promise<RouteStatus[]>;
}

/** How the broker reaches each route kind. Each entry receives only routes of its own kind. */
export type UpstreamTable<R extends BrokerRoute> = { readonly [K in R["kind"]]: (route: Extract<R, { kind: K }>) => AhpUpstream };

export interface BrokerOptions<R extends BrokerRoute> {
  families: readonly RouteFamily<R>[];
  upstreams: UpstreamTable<R>;
  /** Interval between checks of live routes. Defaults to one second. */
  checkMilliseconds?: number;
  /** Open plus pending connections. Defaults to 1,000. */
  maxConnections?: number;
}

interface Live<R extends BrokerRoute> { family: RouteFamily<R>; key: string; route: R }

/**
 * Routes direct WebSocket clients to their current placement. It verifies one-use tickets through the placement
 * directory, then splices bytes without interpreting AHP. It holds only its own service key: no caller API keys,
 * database credentials, inference grants, or provider credentials.
 */
export class ConnectionBroker<R extends BrokerRoute> {
  readonly #live = new Map<BrokeredConnection, Live<R>>();
  #pending = 0;
  #stopping = false;
  #checking?: Promise<void>;
  #checkFailing = false;
  #timer?: NodeJS.Timeout;

  constructor(private readonly options: BrokerOptions<R>, private readonly log: FastifyBaseLogger) {}

  get connections(): number { return this.#live.size; }
  get stopping(): boolean { return this.#stopping; }

  register(app: FastifyInstance): void {
    app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      void this.#upgrade(request, socket, head).catch(() => {
        this.log.error("A brokered connection could not be opened.");
        if (!socket.destroyed) rejectUpgrade(socket, 503);
      });
    });
    this.#timer = setInterval(() => void this.check(), this.options.checkMilliseconds ?? 1_000);
    this.#timer.unref();
    app.addHook("preClose", async () => {
      this.#stopping = true;
      clearInterval(this.#timer);
      for (const connection of this.#live.keys()) connection.terminate();
      await this.#checking;
    });
  }

  /** Checks every live route once and closes routes that moved; the broker also runs this on its interval. */
  check(): Promise<void> {
    this.#checking ??= this.#checkAll().finally(() => { this.#checking = undefined; });
    return this.#checking;
  }

  async #checkAll(): Promise<void> {
    const groups = new Map<RouteFamily<R>, Array<[BrokeredConnection, R]>>();
    for (const [connection, { family, route }] of this.#live) {
      if (!family.check) continue;
      const group = groups.get(family) ?? [];
      group.push([connection, route]);
      groups.set(family, group);
    }
    let failed = false;
    for (const [family, entries] of groups) {
      try {
        const statuses = await family.check!(entries.map(([, route]) => route), 10_000);
        entries.forEach(([connection], index) => {
          if (statuses[index] === "moved") connection.move();
          else if (statuses[index] === "gone") connection.terminate();
        });
      } catch {
        failed = true;
        if (!this.#checkFailing) this.log.warn({ family: family.name }, "Placement checks are unavailable; live connections are kept.");
      }
    }
    if (this.#checkFailing && !failed) this.log.info("Placement checks recovered.");
    this.#checkFailing = failed;
  }

  async #status(family: RouteFamily<R>, route: R): Promise<RouteStatus> {
    try { return (await family.check?.([route], 2_000))?.[0] ?? "current"; }
    catch { return "current"; }
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const problem = upgradeProblem(request);
    if (problem) return rejectUpgrade(socket, problem);
    const url = new URL(request.url ?? "", "http://localhost");
    let family: RouteFamily<R> | undefined;
    let key: string | undefined;
    for (const candidate of this.options.families) {
      key = candidate.match(url.pathname);
      if (key !== undefined) { family = candidate; break; }
    }
    if (!family || key === undefined) return rejectUpgrade(socket, 404);
    if (this.#stopping) return rejectUpgrade(socket, 503);
    const ticket = connectionTicket(url);
    if (!ticket) return rejectUpgrade(socket, 401);
    if (this.#live.size + this.#pending >= (this.options.maxConnections ?? 1_000)) return rejectUpgrade(socket, 503);
    this.#pending++;
    try {
      let route: R | undefined;
      try { route = await family.authorize(key, ticket); }
      catch {
        this.log.warn({ family: family.name }, "The placement directory is unavailable; a connection was refused.");
        return rejectUpgrade(socket, 503);
      }
      if (!route) return rejectUpgrade(socket, 401);
      const upstream = (this.options.upstreams as unknown as Readonly<Record<string, ((route: R) => AhpUpstream) | undefined>>)[route.kind];
      if (!upstream) {
        this.log.error({ family: family.name, kind: route.kind }, "No upstream is configured for a placement kind.");
        return rejectUpgrade(socket, 503);
      }
      if (socket.destroyed) return;
      if (this.#stopping) return rejectUpgrade(socket, 503);
      const tunnel = await openUpstream(request, socket, upstream(route));
      if (!tunnel) {
        this.log.warn({ family: family.name, key, kind: route.kind }, "A placement refused a brokered connection.");
        return;
      }
      if (this.#stopping) {
        tunnel.peer.destroy();
        socket.destroy();
        return;
      }
      const live: Live<R> = { family, key, route };
      const connection = new BrokeredConnection(socket, tunnel.peer, {
        recheck: () => this.#status(live.family, live.route),
        moved: () => this.log.info({ family: family.name, key, kind: route.kind }, "Placement moved; closing the brokered connection."),
        closed: () => {
          this.#live.delete(connection);
          this.log.info({ family: family.name, key, kind: route.kind }, "Brokered connection closed.");
        },
      });
      this.#live.set(connection, live);
      this.log.info({ family: family.name, key, kind: route.kind }, "Brokered connection opened.");
      connection.start(head, tunnel.remainder);
    } finally {
      this.#pending--;
    }
  }
}

export function buildBroker<R extends BrokerRoute>(options: BrokerOptions<R>): { app: FastifyInstance; broker: ConnectionBroker<R> } {
  let broker: ConnectionBroker<R> | undefined;
  const app = createService({ name: "connection-broker", ready: async () => {
    if (!broker || broker.stopping) throw new Error("The connection broker is stopping.");
  } });
  broker = new ConnectionBroker(options, app.log);
  broker.register(app);
  return { app, broker };
}
