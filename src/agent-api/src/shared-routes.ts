import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SharedConnection, SharedConnectionRequest, SharedSessionClosure, SharedSessionCreation, SharedSessionView } from "@copilot-agent/contracts";
import { harnessHostingView, hostingError, HttpError, type HostingCatalog } from "@copilot-agent/service-defaults";
import type { DelegationStore } from "@copilot-agent/job-store";
import type { ContainerSessionService } from "./container-sessions.js";

export interface SharedApiDependencies { url: string; key: string }

const PASSED_THROUGH = new Set([400, 403, 404, 409, 422, 429]);

/**
 * Harness-driven conversations. When a hosting catalog is available, creation is evaluated against the deployment
 * first: `shared` placement goes to the shared worker, which re-checks everything it admits, and `container`
 * placement to the session-container service. Views are placement-agnostic; with session containers configured they
 * come from the ledger, and connection and close go to the session's placement.
 */
export function registerSharedSessionRoutes(
  app: FastifyInstance,
  deps: SharedApiDependencies | undefined,
  principalOf: (request: FastifyRequest) => string,
  delegations?: DelegationStore,
  hosting?: HostingCatalog,
  containers?: ContainerSessionService,
): void {
  const catalog = hosting ?? containers?.catalog;
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
    if (catalog) {
      const versions = catalog.harnesses.get(creation.harness);
      const snapshot = creation.version === undefined ? versions?.[0] : versions?.find((entry) => entry.definition.version === creation.version);
      if (!snapshot) throw new HttpError(404, "harness_not_found", "The requested harness version is not published.");
      const view = harnessHostingView(catalog, snapshot, principal);
      if (view.interaction !== "conversation") {
        throw new HttpError(422, "policy_rejected", "Batch harnesses run as jobs; create conversations from conversation harnesses.");
      }
      if (view.problems[0]) throw hostingError(view.problems[0]);
      creation = { ...creation, version: snapshot.definition.version };
      if (view.placement === "container" && containers) {
        const session = await containers.create(principal, creation);
        return reply.header("location", `/v1/sessions/${session.id}`).status(201).send(session);
      }
      if (view.placement !== "shared") {
        throw new HttpError(409, "hosting_unavailable", `${snapshot.definition.name} uses ${view.mode} hosting, which needs session containers.`,
          { prerequisite: { kind: "host", name: "session-containers" } });
      }
    }
    if (!deps) {
      throw new HttpError(409, "hosting_unavailable", "Shared conversations need the shared worker, which this deployment does not provide.",
        { prerequisite: { kind: "host", name: "shared-worker" } });
    }
    const session = await control(principal, { operation: "create", request: creation }, SharedSessionView);
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
    const body = SharedConnectionRequest.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, "invalid_request", "Request a connection with { \"transport\": \"direct\" }.");
    if (containers && await containers.owns(principal, id)) return containers.connect(principal, id, body.data);
    return control(principal, { operation: "connect", id, request: body.data }, SharedConnection);
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
