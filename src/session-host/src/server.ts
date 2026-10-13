import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { SharedSessionClosure, SharedSessionCreation } from "@copilot-agent/contracts";
import { StoreError } from "@copilot-agent/job-store";
import { createService, HttpError, registerAhpProxy, requireInternalKey } from "@copilot-agent/service-defaults";
import { SharedSessionService } from "./service.js";

const Principal = z.string().regex(/^[A-Za-z0-9._@-]{1,128}$/);
const Control = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), principal: Principal, request: SharedSessionCreation }).strict(),
  z.object({ operation: z.literal("list"), principal: Principal }).strict(),
  z.object({ operation: z.literal("get"), principal: Principal, id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("connect"), principal: Principal, id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("close"), principal: Principal, id: z.string().uuid(), request: SharedSessionClosure }).strict(),
]);

export function buildSharedHost(service: SharedSessionService, key: string): FastifyInstance {
  const app = createService({ name: "session-host", bodyLimit: 64 * 1024, ready: async () => {
    if (!service.healthy) throw new Error("The shared session owner is not ready.");
  } });
  registerAhpProxy(app, { ready: () => service.healthy, resolve: (path, ticket) => service.resolveConnection(path, ticket) });
  app.post("/internal/shared", async (request, reply) => {
    requireInternalKey(request, key);
    reply.header("cache-control", "no-store");
    const parsed = Control.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid shared control request.");
    const command = parsed.data;
    try {
      switch (command.operation) {
        case "create": return await service.create(command.principal, command.request.label);
        case "list": return { sessions: await service.list(command.principal) };
        case "get": return (await service.get(command.principal, command.id)).view;
        case "connect": return await service.connection(command.principal, command.id);
        case "close":
          await service.close(command.principal, command.id, command.request.cancelChildren);
          return { closed: true };
      }
    } catch (error) {
      if (error instanceof StoreError) {
        const status = { not_found: 404, quota_exceeded: 429, invalid_request: 400, invalid_state: 409, idempotency_conflict: 409 }[error.code];
        throw new HttpError(status, error.code, error.message);
      }
      throw error;
    }
  });
  app.addHook("onClose", async () => { await service.stop(); });
  return app;
}
