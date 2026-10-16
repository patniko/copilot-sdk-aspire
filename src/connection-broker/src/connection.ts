import type { Duplex } from "node:stream";
import { BROKER_MOVED_CLOSE } from "@copilot-agent/contracts";
import { CLOSE_OPCODE, closeFrame, FrameCursor } from "./frames.js";

/** A live route is `current`, has `moved` to another placement, or is `gone` because its session no longer exists. */
export type RouteStatus = "current" | "moved" | "gone";

export interface ConnectionEvents {
  /** Re-checks the route after its upstream started closing; resolves `current` when the check is unavailable. */
  recheck(): Promise<RouteStatus>;
  moved(): void;
  closed(): void;
}

const HELD_LIMIT = 4096;
const GRACE_MILLISECONDS = 5_000;

/**
 * One client connection spliced to its placement. Bytes pass through unchanged in both directions. The broker tracks
 * only frame boundaries so that it can end the client side with one whole close frame when the route moves, and so
 * that an upstream's own close can be replaced with "moved" when the placement changed underneath it.
 */
export class BrokeredConnection {
  readonly #fromClientFrames = new FrameCursor();
  readonly #toClientFrames = new FrameCursor();
  #state: "open" | "deciding" | "moving" | "closing" | "done" = "open";
  #clientClosing = false;
  #upstreamClosing = false;
  #upstreamGone = false;
  #moveRequested = false;
  #held: Buffer[] = [];
  #heldBytes = 0;
  #timer?: NodeJS.Timeout;

  constructor(private readonly client: Duplex, private readonly upstream: Duplex, private readonly events: ConnectionEvents) {}

  start(head: Buffer, remainder: Buffer): void {
    this.client.on("data", (chunk: Buffer) => this.#guard(() => this.#fromClient(chunk)));
    this.upstream.on("data", (chunk: Buffer) => this.#guard(() => this.#fromUpstream(chunk)));
    this.client.on("error", () => this.client.destroy());
    this.upstream.on("error", () => this.upstream.destroy());
    this.client.on("close", () => this.#finish());
    this.client.on("end", () => this.#guard(() => this.#clientEnded()));
    this.upstream.on("close", () => this.#guard(() => this.#upstreamClosed()));
    this.#guard(() => {
      if (head.length) this.#fromClient(head);
      if (remainder.length) this.#fromUpstream(remainder);
    });
  }

  /** Ends the client side with the "moved" close at the next frame boundary; the old placement receives nothing more. */
  move(): void {
    if (this.#state === "deciding") this.#moveRequested = true;
    else if (this.#state === "open" && !this.#upstreamClosing) this.#beginMove();
  }

  /** Drops both sides without a close frame. */
  terminate(): void {
    this.client.destroy();
    this.upstream.destroy();
  }

  #beginMove(): void {
    this.#state = "moving";
    this.events.moved();
    if (this.#toClientFrames.atBoundary) return this.#sendMoved();
    if (this.#upstreamGone) return this.terminate();
    this.#arm(() => this.terminate());
  }

  #sendMoved(): void {
    this.#state = "closing";
    this.upstream.destroy();
    if (!this.client.destroyed) this.client.write(closeFrame(BROKER_MOVED_CLOSE.code, BROKER_MOVED_CLOSE.reason));
    this.#arm(() => this.client.destroy());
  }

  #fromClient(chunk: Buffer): void {
    if (this.#state === "open" || this.#state === "deciding") {
      let offset = 0;
      while (offset < chunk.length) {
        offset = this.#fromClientFrames.advance(chunk, offset);
        if (this.#fromClientFrames.atBoundary && this.#fromClientFrames.opcode === CLOSE_OPCODE) this.#clientClosing = true;
      }
      if (!this.#upstreamGone) this.#write(this.upstream, chunk, this.client);
      return;
    }
    if (this.#state !== "closing" && this.#state !== "moving") return;
    let offset = 0;
    while (offset < chunk.length) {
      offset = this.#fromClientFrames.advance(chunk, offset);
      if (this.#state === "closing" && this.#fromClientFrames.atBoundary && this.#fromClientFrames.opcode === CLOSE_OPCODE) {
        this.client.end();
        return;
      }
    }
  }

  #fromUpstream(chunk: Buffer): void {
    if (this.#state === "deciding") return this.#hold(chunk);
    if (this.#state !== "open" && this.#state !== "moving") return;
    if (this.#upstreamClosing) return this.#write(this.client, chunk, this.upstream);
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#toClientFrames.atBoundary) {
        if (this.#state === "moving") {
          this.#write(this.client, chunk.subarray(0, offset), this.upstream);
          return this.#sendMoved();
        }
        if (!this.#clientClosing && (chunk[offset]! & 0x0f) === CLOSE_OPCODE) {
          this.#write(this.client, chunk.subarray(0, offset), this.upstream);
          this.#hold(chunk.subarray(offset));
          return this.#decide();
        }
      }
      offset = this.#toClientFrames.advance(chunk, offset);
    }
    this.#write(this.client, chunk, this.upstream);
    if (this.#state === "moving" && this.#toClientFrames.atBoundary) this.#sendMoved();
  }

  #upstreamClosed(): void {
    this.#upstreamGone = true;
    if (this.#state === "moving") return this.terminate();
    if (this.#state !== "open") return;
    if (this.#upstreamClosing || this.#clientClosing) return this.#endClient();
    if (!this.#toClientFrames.atBoundary) return this.terminate();
    this.#decide();
  }

  /** The client half-closed its connection: finish a close in progress, or pass the half-close on as a pipe would. */
  #clientEnded(): void {
    if (this.#state === "closing" || this.#state === "done" || this.#upstreamGone) this.client.end();
    else this.upstream.end();
  }

  /** The upstream is closing at a frame boundary: hold its close until the route is re-checked. */
  #decide(): void {
    this.#state = "deciding";
    void this.events.recheck().catch((): RouteStatus => "current").then((status) => this.#guard(() => {
      if (this.#state !== "deciding") return;
      if (status === "moved" || this.#moveRequested) {
        this.events.moved();
        return this.#sendMoved();
      }
      const held = Buffer.concat(this.#held);
      this.#held = [];
      if (!held.length) return this.terminate();
      this.#state = "open";
      this.#upstreamClosing = true;
      this.#write(this.client, held, this.upstream);
      if (this.#upstreamGone) this.#endClient();
    }));
  }

  #hold(chunk: Buffer): void {
    this.#heldBytes += chunk.length;
    if (this.#heldBytes > HELD_LIMIT) return this.terminate();
    this.#held.push(chunk);
  }

  #write(target: Duplex, data: Buffer, source: Duplex): void {
    if (!data.length || target.destroyed) return;
    if (!target.write(data) && !source.isPaused()) {
      source.pause();
      target.once("drain", () => source.resume());
    }
  }

  #endClient(): void {
    this.client.end();
    this.#arm(() => this.client.destroy());
  }

  #arm(action: () => void): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(action, GRACE_MILLISECONDS);
    this.#timer.unref();
  }

  #guard(action: () => void): void {
    try { action(); }
    catch { this.terminate(); }
  }

  #finish(): void {
    if (this.#state === "done") return;
    this.#state = "done";
    clearTimeout(this.#timer);
    this.upstream.destroy();
    this.events.closed();
  }
}
