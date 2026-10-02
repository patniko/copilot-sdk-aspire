import { EventEmitter } from "node:events";
import type pg from "pg";

/**
 * Wakes event-stream readers when new job events are committed. Notifications are hints:
 * readers always re-query the ledger from their cursor, so a missed notification only adds latency.
 */
export class JobEventListener extends EventEmitter {
  #client: pg.PoolClient | undefined;
  #stopped = false;

  constructor(private readonly pool: pg.Pool) {
    super();
    this.setMaxListeners(0);
  }

  async start(): Promise<void> {
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#client?.release();
    this.#client = undefined;
  }

  async #connect(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    try {
      const client = await this.pool.connect();
      client.on("notification", (message) => {
        if (message.channel === "job_events" && message.payload) {
          this.emit(message.payload);
        }
      });
      client.on("error", () => {
        client.release(true);
        this.#client = undefined;
        setTimeout(() => void this.#connect(), 2000);
      });
      await client.query("LISTEN job_events");
      this.#client = client;
    } catch {
      setTimeout(() => void this.#connect(), 2000);
    }
  }
}
