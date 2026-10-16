import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const Wire = z.object({
  stream: z.boolean().optional(),
  messages: z.array(z.object({
    role: z.string(), content: z.unknown().optional(),
    tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
  }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() })).default([]),
}).passthrough();
export type ModelRequest = z.infer<typeof Wire>;

/** What the synthetic model answers: text, one tool call, or an upstream failure. */
export type ModelReply = { content: string } | { call: { name: string; arguments: object } } | { status: number };

export interface SyntheticModel {
  url: string;
  requests: ModelRequest[];
  bodies: string[];
  errors: string[];
  close(): Promise<void>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

/** Request helpers for writing scripted replies. */
export const inspect = {
  /** True for the runtime's assisted-permissions judge; it accepts a reply that starts with ALLOW or DENY (or AUTO_APPROVE or REQUIRE_APPROVAL). */
  isJudge: (request: ModelRequest) => request.tools.length === 0 && request.messages.some((message) => message.role === "system" && /permission judge|REQUIRE_APPROVAL|AUTO_APPROVE/.test(text(message.content))),
  system: (request: ModelRequest) => request.messages.filter((message) => message.role === "system").map((message) => text(message.content)).join("\n"),
  lastUser: (request: ModelRequest) => text(request.messages.findLast((message) => message.role === "user")?.content),
  tools: (request: ModelRequest) => request.tools.map((tool) => tool.function.name),
  /** Names of tools the model already called in this conversation, oldest first. */
  called: (request: ModelRequest) => request.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name),
  /** Tool results in this conversation, oldest first. */
  results: (request: ModelRequest) => request.messages.filter((message) => message.role === "tool").map((message) => text(message.content)),
};

/** A loopback OpenAI-compatible chat completions endpoint driven by `reply`. Never contacts a paid model. */
export async function syntheticModel(reply: (request: ModelRequest) => ModelReply): Promise<SyntheticModel> {
  const requests: ModelRequest[] = [];
  const bodies: string[] = [];
  const errors: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) return void response.writeHead(404).end();
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.once("end", () => {
      try {
        const payload = Wire.parse(JSON.parse(body));
        bodies.push(body);
        requests.push(payload);
        const answer = reply(payload);
        if ("status" in answer) return void response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic failure." } }));
        const toolCall = "call" in answer
          ? { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: answer.call.name, arguments: JSON.stringify(answer.call.arguments) } }
          : undefined;
        const content = "content" in answer ? answer.content : null;
        const base = { id: randomUUID(), model: "fixture", created: Math.floor(Date.now() / 1000) };
        const usage = { prompt_tokens: 20, completion_tokens: 5 };
        if (!payload.stream) {
          return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            ...base, object: "chat.completion", usage,
            choices: [{ index: 0, message: { role: "assistant", content, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? "tool_calls" : "stop" }],
          }));
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant", ...(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content }) };
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Synthetic inference failed.");
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, bodies, errors,
    close: () => new Promise<void>((resolve) => { if (!server.listening) return resolve(); server.close(() => resolve()); }),
  };
}
