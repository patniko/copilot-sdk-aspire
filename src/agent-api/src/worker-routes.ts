import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { InputResponseSubmission } from "@copilot-agent/contracts";
import { StoreError, type WorkerStore } from "@copilot-agent/job-store";
import { HttpError } from "@copilot-agent/service-defaults";

const SessionParams = z.object({ id: z.string().uuid() });
const WorkerParams = z.object({ id: z.string().uuid(), workerId: z.string().min(1).max(64) });
const RequestParams = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });
const ListQuery = z.object({
  state: z.enum(["pending", "all"]).default("pending"),
  limit: z.coerce.number().int().catch(50).transform((value) => Math.min(Math.max(value, 1), 100)),
});

function mapStoreError(error: unknown): unknown {
  if (error instanceof StoreError) {
    const status = { idempotency_conflict: 409, quota_exceeded: 429, not_found: 404, invalid_state: 409, invalid_request: 400 }[error.code];
    return new HttpError(status, error.code, error.message);
  }
  return error;
}

/**
 * Orchestrator workers of the caller's shared conversations (docs/HOSTING-MODES-PLAN.md, section 7.4), read from the
 * worker ledger, and the request queue through which a person answers workers' approvals and questions when nobody is
 * attached to the coordinator session. A coordinator never answers a permission request.
 */
export function registerWorkerRoutes(app: FastifyInstance, workers: WorkerStore, principalOf: (request: FastifyRequest) => string): void {
  const sessionOf = (request: FastifyRequest): string => {
    const parsed = SessionParams.safeParse(request.params);
    if (!parsed.success) throw new HttpError(404, "not_found", "The shared conversation was not found.");
    return parsed.data.id.toLowerCase();
  };
  const workerOf = (request: FastifyRequest): { id: string; worker: string } => {
    const parsed = WorkerParams.safeParse(request.params);
    if (!parsed.success) throw new HttpError(404, "not_found", "The worker was not found.");
    return { id: parsed.data.id.toLowerCase(), worker: parsed.data.workerId };
  };
  const listQuery = (request: FastifyRequest) => {
    const parsed = ListQuery.safeParse(request.query ?? {});
    if (!parsed.success) throw new HttpError(400, "invalid_request", "'state' must be 'pending' or 'all'.");
    return parsed.data;
  };
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) { throw mapStoreError(error); }
  };

  app.get("/v1/sessions/:id/workers", async (request) => {
    const principal = principalOf(request);
    const id = sessionOf(request);
    return { workers: await run(() => workers.list(principal, id)) };
  });
  app.get("/v1/sessions/:id/workers/:workerId", async (request) => {
    const principal = principalOf(request);
    const { id, worker } = workerOf(request);
    const view = await run(() => workers.get(principal, id, worker));
    if (!view) throw new HttpError(404, "not_found", "The worker was not found.");
    return view;
  });
  app.get("/v1/sessions/:id/workers/:workerId/definition", async (request, reply) => {
    const principal = principalOf(request);
    const { id, worker } = workerOf(request);
    const exported = await run(() => workers.definition(principal, id, worker));
    if (!exported) throw new HttpError(404, "not_found", "The worker was not found.");
    reply.header("cache-control", "no-store");
    return exported;
  });
  app.get("/v1/sessions/:id/input-requests", async (request) => {
    const principal = principalOf(request);
    const id = sessionOf(request);
    const query = listQuery(request);
    return { requests: await run(() => workers.listInputRequests(principal, { sessionId: id, state: query.state, limit: query.limit })) };
  });
  app.get("/v1/worker-input-requests", async (request) => {
    const principal = principalOf(request);
    const query = listQuery(request);
    return { requests: await run(() => workers.listInputRequests(principal, { state: query.state, limit: query.limit })) };
  });
  app.post("/v1/sessions/:id/input-requests/:requestId/respond", async (request) => {
    const principal = principalOf(request);
    const params = RequestParams.safeParse(request.params);
    if (!params.success) throw new HttpError(404, "not_found", "Input request not found.");
    const body = InputResponseSubmission.safeParse(request.body);
    if (!body.success) {
      throw new HttpError(400, "invalid_request", "The input response is invalid.", {
        issues: body.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    return run(() => workers.respondInputRequest(principal, params.data.id.toLowerCase(), params.data.requestId.toLowerCase(), body.data));
  });
}
