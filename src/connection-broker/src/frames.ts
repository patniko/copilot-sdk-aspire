export const CLOSE_OPCODE = 0x8;

/**
 * Tracks frame boundaries in one direction of a WebSocket stream without decoding or retaining payloads, so the broker
 * can inject or withhold whole frames while otherwise forwarding bytes unchanged. Control frames may legally appear
 * between the fragments of a message, so every frame boundary is a safe injection point.
 */
export class FrameCursor {
  readonly #header = Buffer.alloc(14);
  #headerLength = 0;
  #remaining = 0;
  #inPayload = false;
  #opcode = -1;

  /** True between frames. */
  get atBoundary(): boolean { return this.#headerLength === 0 && !this.#inPayload; }

  /** The opcode of the most recently started frame, or -1 before the first frame. */
  get opcode(): number { return this.#opcode; }

  /** Advances from `offset` to the end of the current frame or of `chunk`, whichever comes first; returns the new offset. */
  advance(chunk: Buffer, offset: number): number {
    let position = offset;
    while (position < chunk.length) {
      if (this.#inPayload) {
        const step = Math.min(this.#remaining, chunk.length - position);
        position += step;
        this.#remaining -= step;
        if (this.#remaining > 0) continue;
        this.#inPayload = false;
        return position;
      }
      this.#header[this.#headerLength++] = chunk[position++]!;
      if (this.#headerLength === 1) {
        this.#opcode = this.#header[0]! & 0x0f;
        continue;
      }
      if (this.#headerLength < headerLength(this.#header[1]!)) continue;
      const length = payloadLength(this.#header);
      this.#headerLength = 0;
      if (length === 0) return position;
      this.#remaining = length;
      this.#inPayload = true;
    }
    return position;
  }
}

function headerLength(second: number): number {
  const length = second & 0x7f;
  return 2 + (length === 126 ? 2 : length === 127 ? 8 : 0) + (second & 0x80 ? 4 : 0);
}

function payloadLength(header: Buffer): number {
  const length = header[1]! & 0x7f;
  if (length < 126) return length;
  if (length === 126) return header.readUInt16BE(2);
  const extended = header.readBigUInt64BE(2);
  if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported WebSocket frame length.");
  return Number(extended);
}

/** An unmasked server-to-client close frame. */
export function closeFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8");
  if (!Number.isInteger(code) || code < 1000 || code > 4999 || text.length > 123) throw new Error("Invalid WebSocket close frame.");
  const frame = Buffer.alloc(4 + text.length);
  frame[0] = 0x80 | CLOSE_OPCODE;
  frame[1] = 2 + text.length;
  frame.writeUInt16BE(code, 2);
  text.copy(frame, 4);
  return frame;
}
