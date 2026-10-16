import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SessionCreation, SharedConnection, SharedSessionClosure, SharedSessionView } from "@copilot-agent/contracts";
import { HttpError } from "@copilot-agent/service-defaults";
import type { DelegationStore } from "@copilot-agent/job-store";
import type { ContainerSessionService } from "./container-sessions.js";

export interface SharedApiDependencies { url: string; key: string }

/**
 * Application-session routes. Sessions are placement-agnostic to callers: views come from the ledger when session
 * containers are configured, and connection and close go to the session's placement (the shared worker, or the
 * container service for container-placed sessions).
 */
export function registerSharedSessionRoutes(
  app: FastifyInstance, deps: SharedApiDependencies | undefined, principalOf: (request: FastifyRequest) => string,
  delegations?: DelegationStore, containers?: ContainerSessionService,
): void {
  const idOf = (request: FastifyRequest): string => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) throw new HttpError(404, "not_found", "The shared conversation was not found.");
    return parsed.data.id.toLowerCase();
  };
  const control = async <T>(principal: string, command: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    if (!deps) throw new HttpError(404, "not_found", "The conversation was not found.");
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
    const body = SessionCreation.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Invalid conversation request.");
    if (body.data.harness) {
      if (!containers) {
        throw new HttpError(409, "hosting_unavailable", "Harness-selected sessions need session containers, which this deployment does not provide.",
          { prerequisite: { kind: "host", name: "session-containers" } });
      }
      const session = await containers.create(principal, body.data);
      return reply.header("location", `/v1/sessions/${session.id}`).status(201).send(session);
    }
    if (!deps) {
      throw new HttpError(409, "hosting_unavailable", "Sessions without a harness need the shared coordinator, which this deployment does not provide.",
        { prerequisite: { kind: "host", name: "shared-worker" } });
    }
    const session = await control(principal, { operation: "create", request: { label: body.data.label } }, SharedSessionView);
    return reply.header("location", `/v1/sessions/${session.id}`).status(201).send(session);
  });
  app.get("/v1/sessions", async (request) => containers
    ? { sessions: await containers.list(principalOf(request)) }
    : control(principalOf(request), { operation: "list" }, z.object({ sessions: z.array(SharedSessionView) }).strict()));
  app.get("/v1/sessions/:id", async (request) => {
    if (!containers) return control(principalOf(request), { operation: "get", id: idOf(request) }, SharedSessionView);
    const session = await containers.view(principalOf(request), idOf(request));
    if (!session) throw new HttpError(404, "not_found", "The conversation was not found.");
    return session;
  });
  app.get("/v1/sessions/:id/jobs", async (request) => {
    const principal = principalOf(request);
    const id = idOf(request);
    if (containers) {
      if (!(await containers.view(principal, id))) throw new HttpError(404, "not_found", "The conversation was not found.");
    } else await control(principal, { operation: "get", id }, SharedSessionView);
    if (!delegations) throw new HttpError(503, "delegations_unavailable", "Delegation history is unavailable.");
    return { jobs: await delegations.list(principal, id) };
  });
  app.post("/v1/sessions/:id/connection", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = principalOf(request);
    const id = idOf(request);
    if (containers && await containers.owns(principal, id)) return containers.connect(principal, id, request.body);
    return control(principal, { operation: "connect", id }, SharedConnection);
  });
  app.post("/v1/sessions/:id/close", async (request) => {
    const principal = principalOf(request);
    const body = SharedSessionClosure.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Invalid shared conversation closure.");
    const id = idOf(request);
    if (containers && await containers.owns(principal, id)) return containers.close(principal, id);
    return control(principal, { operation: "close", id, request: body.data }, z.object({ closed: z.literal(true) }).strict());
  });
}
