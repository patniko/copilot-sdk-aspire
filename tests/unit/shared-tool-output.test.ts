import { describe, expect, it } from "vitest";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import {
  boundedTool, boundToolResult, fileChunk, FILE_CHUNK_BYTES, jsonStringPrefix, listPage, SHARED_TOOL_OUTPUT_BYTES,
  SHARED_TOOL_RESULT_LIMIT_BYTES, utf8Prefix,
} from "../../src/session-host/src/tool-output.js";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
// Text whose JSON escaping and UTF-8 widths vary: quotes, backslashes, newlines, tabs, control characters, Latin, CJK,
// emoji (surrogate pairs), and a byte-order mark.
const mixed = (length: number) => {
  const pieces = ["plain ascii ", "\"quoted\" ", "back\\slash ", "line\n", "tab\t", "\u0001ctl ", "café ", "中文字符 ", "😀 ", "\ufeff"];
  let text = "";
  for (let index = 0; text.length < length; index++) text += pieces[index % pieces.length];
  return text;
};

describe("shared tool output bounds", () => {
  it("stays below the runtime's 20 KiB large-output threshold", () => {
    expect(SHARED_TOOL_OUTPUT_BYTES).toBeLessThan(SHARED_TOOL_RESULT_LIMIT_BYTES);
    expect(SHARED_TOOL_RESULT_LIMIT_BYTES).toBeLessThan(20 * 1024);
  });

  it("cuts UTF-8 text at a character boundary", () => {
    expect(utf8Prefix("hello", 10)).toBe("hello");
    expect(utf8Prefix("hello", 3)).toBe("hel");
    expect(utf8Prefix("aé", 2)).toBe("a");
    expect(utf8Prefix("中文", 5)).toBe("中");
    expect(utf8Prefix("a😀b", 4)).toBe("a");
    expect(utf8Prefix("a😀b", 5)).toBe("a😀");
  });

  it("finds the longest prefix whose JSON string fits, however the text escapes", () => {
    const text = mixed(5000);
    for (const limit of [2, 3, 10, 101, 1000, 4096, 6000, 9999]) {
      const prefix = jsonStringPrefix(text, limit);
      expect(text.startsWith(prefix)).toBe(true);
      expect(jsonBytes(prefix), String(limit)).toBeLessThanOrEqual(limit);
      if (prefix.length === text.length) {
        expect(jsonBytes(text)).toBeLessThanOrEqual(limit);
        continue;
      }
      // One more character (a whole surrogate pair) would not fit.
      const next = text.codePointAt(prefix.length)! > 0xffff ? 2 : 1;
      expect(jsonBytes(text.slice(0, prefix.length + next)), String(limit)).toBeGreaterThan(limit);
    }
    // A lone surrogate is escaped as six bytes, as JSON.stringify writes it.
    expect(jsonStringPrefix("a\ud800b", 9)).toBe("a\ud800");
    expect(jsonStringPrefix("a\ud800b", 8)).toBe("a");
  });

  it("reads a file in parts whose data fits the budget, and the parts rebuild the file exactly", () => {
    for (const content of [Buffer.from(mixed(60_000), "utf8"), Buffer.from(`\ufeff${"x".repeat(40_000)}`, "utf8")]) {
      const parts: Buffer[] = [];
      let offset = 0;
      for (let reads = 0; ; reads++) {
        expect(reads).toBeLessThan(100);
        const chunk = fileChunk(content, offset, 32 * 1024, "read_workspace_file");
        expect(chunk).toMatchObject({ size: content.length, offset, encoding: "utf-8" });
        expect(jsonBytes(chunk.data)).toBeLessThanOrEqual(FILE_CHUNK_BYTES);
        parts.push(Buffer.from(chunk.data, "utf8"));
        if (!chunk.truncated) {
          expect(chunk.nextOffset).toBeUndefined();
          break;
        }
        expect(chunk.nextOffset).toBe(offset + bytes(chunk.data));
        expect(chunk.note).toBe(`More remains: call read_workspace_file with offset ${chunk.nextOffset} to continue.`);
        offset = chunk.nextOffset!;
      }
      expect(Buffer.concat(parts).equals(content)).toBe(true);
    }
  });

  it("keeps file reads on character boundaries and always progresses", () => {
    const content = Buffer.from("a中b", "utf8");
    // An offset inside a character starts at that character; a length shorter than it still returns it whole.
    expect(fileChunk(content, 2, 1, "read")).toMatchObject({ offset: 1, data: "中", nextOffset: 4, truncated: true });
    expect(fileChunk(content, 0, 2, "read")).toMatchObject({ offset: 0, data: "a", nextOffset: 1 });
    expect(fileChunk(content, 4, 10, "read")).toEqual({ size: 5, offset: 4, data: "b", encoding: "utf-8", truncated: false });
    expect(fileChunk(content, 99, 10, "read")).toEqual({ size: 5, offset: 5, data: "", encoding: "utf-8", truncated: false });
  });

  it("returns content that is not UTF-8 as bounded base64 parts", () => {
    const content = Buffer.alloc(40_000, 0xff);
    const first = fileChunk(content, 0, 32 * 1024, "read");
    expect(first.encoding).toBe("base64");
    expect(jsonBytes(first.data)).toBeLessThanOrEqual(FILE_CHUNK_BYTES);
    expect(Buffer.from(first.data, "base64").length).toBe(first.nextOffset);
    expect(fileChunk(content, first.nextOffset!, 32 * 1024, "read").offset).toBe(first.nextOffset);
  });

  it("pages a long listing and returns a short one whole", () => {
    const short = [{ name: "a", type: "file" }];
    expect(listPage(short, 0, "list")).toEqual({ entries: short });
    const long = Array.from({ length: 600 }, (_, index) => ({ name: `${String(index).padStart(4, "0")}-${"n".repeat(60)}.md`, type: "file" }));
    const seen: unknown[] = [];
    let offset = 0;
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(20);
      const page = listPage(long, offset, "list_workspace_files");
      expect(jsonBytes(page)).toBeLessThanOrEqual(SHARED_TOOL_OUTPUT_BYTES);
      seen.push(...page.entries);
      if (!page.truncated) break;
      expect(page).toMatchObject({ total: 600, nextOffset: offset + page.entries.length });
      expect(page.note).toContain(`call list_workspace_files with offset ${page.nextOffset}`);
      offset = page.nextOffset!;
    }
    expect(seen).toEqual(long);
    // A single entry larger than a page is still returned, so that paging progresses.
    expect(listPage([{ name: "x".repeat(20_000) }, { name: "y" }], 0, "list").entries).toHaveLength(1);
  });

  it("cuts any tool result above the ceiling, as the SDK would send it, and leaves smaller ones unchanged", () => {
    const limit = SHARED_TOOL_RESULT_LIMIT_BYTES;
    expect(boundToolResult("small")).toBe("small");
    expect(boundToolResult(undefined)).toBeUndefined();
    const text = boundToolResult("中".repeat(10_000)) as string;
    expect(bytes(text)).toBeLessThanOrEqual(limit);
    expect(text).toMatch(/^中+\n\[Result truncated at 18 KiB by the shared worker; ask for less/);
    const object: ToolResultObject = { resultType: "failure", textResultForLlm: "x".repeat(30_000), sessionLog: "y".repeat(30_000), error: "e" };
    const cut = boundToolResult(object) as ToolResultObject;
    expect(cut).toMatchObject({ resultType: "failure", error: "e" });
    expect(bytes(cut.textResultForLlm)).toBeLessThanOrEqual(limit);
    expect(bytes(cut.sessionLog!)).toBeLessThanOrEqual(limit);
    const small: ToolResultObject = { resultType: "success", textResultForLlm: "ok" };
    expect(boundToolResult(small)).toBe(small);
    // Other values are sent as JSON: small ones unchanged, large ones as cut JSON text.
    const value = { entries: ["a", "b"] };
    expect(boundToolResult(value)).toBe(value);
    const large = boundToolResult({ data: "\n".repeat(15_000) }) as string;
    expect(typeof large).toBe("string");
    expect(bytes(large)).toBeLessThanOrEqual(limit);
    expect(large.startsWith("{\"data\":\"\\n\\n")).toBe(true);
    // An object the SDK would not treat as a tool result is measured as JSON too.
    expect(typeof boundToolResult({ resultType: "unknown", textResultForLlm: "z".repeat(30_000) })).toBe("string");
  });

  it("wraps a tool so that its handler's results are bounded and its definition is unchanged", async () => {
    const tool: Tool = { name: "big", description: "Big.", overridesBuiltInTool: true, handler: async () => "q".repeat(50_000) };
    const wrapped = boundedTool(tool);
    expect(wrapped).toMatchObject({ name: "big", description: "Big.", overridesBuiltInTool: true });
    const result = await wrapped.handler!({}, {} as never) as string;
    expect(bytes(result)).toBeLessThanOrEqual(SHARED_TOOL_RESULT_LIMIT_BYTES);
    const declaration: Tool = { name: "declared" };
    expect(boundedTool(declaration)).toBe(declaration);
  });
});
