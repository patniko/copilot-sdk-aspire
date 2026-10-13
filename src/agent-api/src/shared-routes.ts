import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SharedConnection, SharedSessionClosure, SharedSessionCreation, SharedSessionView } from "@copilot-agent/contracts";
import { HttpError } from "@copilot-agent/service-defaults";
import type { DelegationStore } from "@copilot-agent/job-store";

export interface SharedApiDependencies { url: string; key: string }

export function registerSharedSessionRoutes(app: FastifyInstance, deps: SharedApiDependencies, principalOf: (request: FastifyRequest) => string, delegations?: DelegationStore): void {
  const idOf = (request: FastifyRequest): string => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) throw new HttpError(404, "not_found", "The shared conversation was not found.");
    return parsed.data.id.toLowerCase();
  };
  const control = async <T>(principal: string, command: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${deps.url}/internal/shared`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-key": deps.key },
        body: JSON.stringify({ ...command, principal }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      app.log.error({ err: error }, "shared session service unavailable");
      throw new HttpError(503, "shared_unavailable", "The shared session service is unavailable.");
    }
    const value: unknown = await response.json();
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string().max(100), message: z.string().max(1000) }) }).safeParse(value);
      if (parsed.success && [400, 404, 409, 429].includes(response.status)) {
        throw new HttpError(response.status, parsed.data.error.code, parsed.data.error.message);
      }
      throw new HttpError(503, "shared_unavailable", "The shared session service could not complete this request.");
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new HttpError(502, "invalid_shared_response", "The shared service returned an invalid response.");
    return result.data;
  };
  app.post("/v1/sessions", async (request, reply) => {
    const principal = principalOf(request);
    const body = SharedSessionCreation.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Invalid shared conversation request.");
    const session = await control(principal, { operation: "create", request: body.data }, SharedSessionView);
    return reply.header("location", `/v1/sessions/${session.id}`).status(201).send(session);
  });
  app.get("/v1/sessions", async (request) =>
    control(principalOf(request), { operation: "list" }, z.object({ sessions: z.array(SharedSessionView) }).strict()));
  app.get("/v1/sessions/:id", async (request) =>
    control(principalOf(request), { operation: "get", id: idOf(request) }, SharedSessionView));
  app.get("/v1/sessions/:id/jobs", async (request) => {
    const principal = principalOf(request);
    const id = idOf(request);
    await control(principal, { operation: "get", id }, SharedSessionView);
    if (!delegations) throw new HttpError(503, "delegations_unavailable", "Delegation history is unavailable.");
    return { jobs: await delegations.list(principal, id) };
  });
  app.post("/v1/sessions/:id/connection", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return control(principalOf(request), { operation: "connect", id: idOf(request) }, SharedConnection);
  });
  app.post("/v1/sessions/:id/close", async (request) => {
    const principal = principalOf(request);
    const body = SharedSessionClosure.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Invalid shared conversation closure.");
    return control(principal, { operation: "close", id: idOf(request), request: body.data }, z.object({ closed: z.literal(true) }).strict());
  });
}
