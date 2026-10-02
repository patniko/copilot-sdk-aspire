/**
 * Splits a byte stream into newline-delimited JSON messages with a hard per-line limit,
 * so a misbehaving peer cannot force unbounded buffering.
 */
export class JsonLineDecoder {
  #buffer = "";
  #overflow = false;

  constructor(private readonly maxLineBytes: number) {}

  /** Returns complete lines; lines exceeding the limit are reported as `null`. */
  push(chunk: string): Array<string | null> {
    const lines: Array<string | null> = [];
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (this.#overflow) {
        this.#overflow = false;
        lines.push(null);
        continue;
      }
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        lines.push(null);
        continue;
      }
      if (line.trim()) {
        lines.push(line);
      }
    }
    if (Buffer.byteLength(this.#buffer) > this.maxLineBytes) {
      this.#buffer = "";
      this.#overflow = true;
    }
    return lines;
  }
}
