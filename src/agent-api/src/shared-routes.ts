import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ConnectionTicket, SharedConnection, SharedConnectionRequest, SharedSessionClosure, SharedSessionCreation, SharedSessionView } from "@copilot-agent/contracts";
import { harnessHostingView, hostingError, HttpError, type HostingCatalog } from "@copilot-agent/service-defaults";
import type { DelegationStore } from "@copilot-agent/job-store";

/** `url` and `key` reach the shared worker's control API; `brokerUrl` is the connection broker's public origin. */
export interface SharedApiDependencies { url: string; key: string; brokerUrl: string }

/** The broker's public WebSocket origin; connection responses add `/sessions/{id}`. */
export function brokerOrigin(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The connection broker URL must be an origin without credentials, a path, a query, or a fragment.");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("The connection broker URL must use HTTP(S) or WS(S).");
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Unencrypted CLI connections are restricted to a loopback connection broker.");
  }
  return url;
}

const PASSED_THROUGH = new Set([400, 403, 404, 409, 422, 429]);

/**
 * Harness-driven conversations on the shared worker. When `hosting` is supplied, creation is evaluated against the
 * deployment first, so a harness whose mode is not allowed, unavailable, or not hosted by the shared worker fails
 * before the worker is contacted; the worker re-checks everything it admits. Connections go through the broker.
 */
export function registerSharedSessionRoutes(
  app: FastifyInstance,
  deps: SharedApiDependencies,
  principalOf: (request: FastifyRequest) => string,
  delegations?: DelegationStore,
  hosting?: HostingCatalog,
): void {
  const broker = brokerOrigin(deps.brokerUrl);
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
      const parsed = z.object({
        error: z.object({ code: z.string().max(100), message: z.string().max(1000), details: z.record(z.string(), z.unknown()).optional() }),
      }).safeParse(value);
      if (parsed.success && PASSED_THROUGH.has(response.status)) {
        throw new HttpError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
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
    if (!body.success) throw new HttpError(400, "invalid_request", "Name a published conversation harness: { \"harness\": \"<name>\", \"label\": \"...\" }.");
    let creation = body.data;
    if (hosting) {
      const versions = hosting.harnesses.get(creation.harness);
      const snapshot = creation.version === undefined ? versions?.[0] : versions?.find((entry) => entry.definition.version === creation.version);
      if (!snapshot) throw new HttpError(404, "harness_not_found", "The requested harness version is not published.");
      const view = harnessHostingView(hosting, snapshot, principal);
      if (view.interaction !== "conversation") {
        throw new HttpError(422, "policy_rejected", "Batch harnesses run as jobs; create conversations from conversation harnesses.");
      }
      if (view.problems[0]) throw hostingError(view.problems[0]);
      if (view.placement !== "shared") {
        throw new HttpError(409, "hosting_unavailable", `${snapshot.definition.name} uses ${view.mode} hosting, which needs session containers.`,
          { prerequisite: { kind: "host", name: "session-containers" } });
      }
      creation = { ...creation, version: snapshot.definition.version };
    }
    const session = await control(principal, { operation: "create", request: creation }, SharedSessionView);
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
    const principal = principalOf(request);
    const id = idOf(request);
    const body = SharedConnectionRequest.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Request a connection with { \"transport\": \"direct\" }.");
    const ticket = await control(principal, { operation: "connect", id, request: body.data }, ConnectionTicket);
    if (ticket.sessionId !== id) throw new HttpError(502, "invalid_shared_response", "The shared service returned an invalid response.");
    return SharedConnection.parse({
      ...ticket, destination: "shared", transport: "direct", url: new URL(`/sessions/${id}`, broker).href,
    });
  });
  app.post("/v1/sessions/:id/close", async (request) => {
    const principal = principalOf(request);
    const body = SharedSessionClosure.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Invalid shared conversation closure.");
    return control(principal, { operation: "close", id: idOf(request), request: body.data }, z.object({ closed: z.literal(true) }).strict());
  });
}
