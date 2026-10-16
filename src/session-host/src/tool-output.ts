import type { Tool, ToolResultObject } from "@github/copilot-sdk";

/**
 * Shared placement keeps every tool result inline (docs/HOSTING-MODES-PLAN.md, section 7.2). The Copilot runtime replaces
 * a tool result larger than its large-output threshold (20 KiB of UTF-8 by default) with a pointer to a temporary file
 * that only its own file tools can read, naming a path on the worker. Shared sessions turn that off, but a client
 * attached through AHP can turn it back on (runtime `d89cfe45b29`), and shared placement has no tool that reads those
 * files. So each shared tool sizes its result to {@link SHARED_TOOL_OUTPUT_BYTES}, saying what it left out and how to get
 * the rest, and the toolkit cuts any result still above {@link SHARED_TOOL_RESULT_LIMIT_BYTES}.
 */
export const SHARED_TOOL_OUTPUT_BYTES = 16 * 1024;
/** The ceiling on any shared tool's model-visible text, below the runtime's 20 KiB default threshold. */
export const SHARED_TOOL_RESULT_LIMIT_BYTES = 18 * 1024;
/** Room in a file read's result for its data, leaving the rest of the output budget to the fields around it. */
export const FILE_CHUNK_BYTES = SHARED_TOOL_OUTPUT_BYTES - 1024;

export const utf8Length = (text: string): number => Buffer.byteLength(text, "utf8");

/** The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never splitting a character. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = Math.max(0, Math.floor(maxBytes));
  // A continuation byte at the cut belongs to a character that starts earlier: leave that whole character out.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * The longest prefix of `text` whose JSON string literal (quotes included, escaped as `JSON.stringify` writes it) fits in
 * `maxBytes` of UTF-8. Escaping can more than double some text, so a byte bound on raw text does not bound its JSON.
 */
export function jsonStringPrefix(text: string, maxBytes: number): string {
  let used = 2;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let width = 1;
    let cost: number;
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) cost = 2;
    else if (code < 0x20) cost = 6;
    else if (code < 0x80) cost = 1;
    else if (code < 0x800) cost = 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      cost = 4;
      width = 2;
    } else if (code >= 0xd800 && code <= 0xdfff) cost = 6;
    else cost = 3;
    if (used + cost > maxBytes) break;
    used += cost;
    index += width;
  }
  return text.slice(0, index);
}

/** One bounded part of a file, and where to continue when more remains. */
export interface FileChunk {
  size: number;
  offset: number;
  data: string;
  encoding: "utf-8" | "base64";
  truncated: boolean;
  nextOffset?: number;
  note?: string;
}

const continuation = (content: Buffer, index: number) => index < content.length && (content[index]! & 0xc0) === 0x80;

/**
 * Up to `length` bytes of `content` from byte `offset`, cut so that the data fits in `budget` bytes once written as JSON.
 * Text starts and ends on UTF-8 character boundaries; content that is not UTF-8 is returned as base64. When more remains,
 * `nextOffset` and a note say how to continue with `tool`.
 */
export function fileChunk(content: Buffer, offset: number, length: number, tool: string, budget = FILE_CHUNK_BYTES): FileChunk {
  let start = Math.min(Math.max(0, offset), content.length);
  // Begin on a character boundary, so a read that starts inside a character still decodes.
  for (let back = 0; back < 3 && start > 0 && continuation(content, start); back++) start--;
  let end = Math.min(content.length, start + Math.max(1, length));
  for (let back = 0; back < 3 && end > start && continuation(content, end); back++) end--;
  if (end === start && start < content.length) {
    // `length` is shorter than the next character: return that whole character so that reading always progresses.
    end = start + 1;
    for (let more = 0; more < 3 && continuation(content, end); more++) end++;
  }
  let data: string;
  let encoding: FileChunk["encoding"] = "utf-8";
  try {
    // ignoreBOM keeps a byte-order mark as U+FEFF, so the text re-encodes to exactly the bytes read.
    data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content.subarray(start, end));
    const fitted = jsonStringPrefix(data, budget);
    if (fitted.length < data.length) {
      data = fitted;
      end = start + utf8Length(fitted);
    }
  } catch {
    end = Math.min(end, start + Math.floor((budget - 2) / 4) * 3);
    data = content.subarray(start, end).toString("base64");
    encoding = "base64";
  }
  const truncated = end < content.length;
  return {
    size: content.length, offset: start, data, encoding, truncated,
    ...(truncated ? { nextOffset: end, note: `More remains: call ${tool} with offset ${end} to continue.` } : {}),
  };
}

/** One page of a listing, and where to continue when more entries remain. */
export interface ListPage<T> {
  entries: T[];
  offset?: number;
  total?: number;
  truncated?: boolean;
  nextOffset?: number;
  note?: string;
}

/**
 * The entries from `offset` that fit in `budget` bytes once written as JSON. When more remain, the page says how many
 * there are and where `tool` continues.
 */
export function listPage<T>(entries: readonly T[], offset: number, tool: string, budget = SHARED_TOOL_OUTPUT_BYTES - 1024): ListPage<T> {
  const start = Math.min(Math.max(0, offset), entries.length);
  const page: T[] = [];
  let used = 2;
  for (let index = start; index < entries.length; index++) {
    const cost = utf8Length(JSON.stringify(entries[index])) + (page.length ? 1 : 0);
    // Always return at least one entry, so that paging progresses.
    if (page.length && used + cost > budget) break;
    used += cost;
    page.push(entries[index]!);
  }
  const next = start + page.length;
  return {
    entries: page,
    ...(start > 0 ? { offset: start } : {}),
    ...(next < entries.length
      ? { total: entries.length, truncated: true, nextOffset: next, note: `Showing entries ${start + 1}-${next} of ${entries.length}; call ${tool} with offset ${next} for more.` }
      : {}),
  };
}

const RESULT_TYPES = new Set(["success", "failure", "rejected", "denied", "timeout"]);

/** Whether the SDK sends `value` as a tool result object rather than as its JSON. */
function isResultObject(value: unknown): value is ToolResultObject {
  return typeof value === "object" && value !== null
    && typeof (value as ToolResultObject).textResultForLlm === "string" && RESULT_TYPES.has((value as ToolResultObject).resultType);
}

function cut(text: string, limit: number): string {
  if (utf8Length(text) <= limit) return text;
  const marker = `\n[Result truncated at ${limit / 1024} KiB by the shared worker; ask for less, such as a smaller range or a narrower query, to see the rest.]`;
  return `${utf8Prefix(text, limit - utf8Length(marker))}${marker}`;
}

/**
 * A tool result whose model-visible text is at most `limit` bytes of UTF-8, measured as the SDK sends it: a string as
 * is, a result object's `textResultForLlm` and `sessionLog`, and any other value as its JSON. A longer value is cut with
 * a note saying so; results within the limit are returned unchanged.
 */
export function boundToolResult(raw: unknown, limit = SHARED_TOOL_RESULT_LIMIT_BYTES): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "string") return cut(raw, limit);
  if (isResultObject(raw)) {
    const text = cut(raw.textResultForLlm, limit);
    const log = raw.sessionLog === undefined ? undefined : cut(raw.sessionLog, limit);
    return text === raw.textResultForLlm && log === raw.sessionLog
      ? raw
      : { ...raw, textResultForLlm: text, ...(log === undefined ? {} : { sessionLog: log }) };
  }
  const json = JSON.stringify(raw);
  return json === undefined || utf8Length(json) <= limit ? raw : cut(json, limit);
}

/** `tool`, with every result held to {@link boundToolResult}'s limit. */
export function boundedTool(tool: Tool, limit = SHARED_TOOL_RESULT_LIMIT_BYTES): Tool {
  const handler = tool.handler;
  if (!handler) return tool;
  return { ...tool, handler: async (args, invocation) => boundToolResult(await handler(args, invocation), limit) };
}
