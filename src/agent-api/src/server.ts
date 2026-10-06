import {
  InputResponseSubmission,
  JobSubmission,
  TERMINAL_STATES,
  type HarnessSnapshot,
  type JobEventView,
} from "@copilot-agent/contracts";
import { HostStore, JobEventListener, JobStore, StoreError } from "@copilot-agent/job-store";
import { ApiKeyAuthenticator, createService, HttpError } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Admission } from "./admission.js";
import { registerConsole } from "./console.js";

export interface ApiDependencies {
  store: JobStore;
  listener: JobEventListener;
  admission: Admission;
  authenticator: ApiKeyAuthenticator;
  harnesses: Map<string, HarnessSnapshot[]>;
  maxOpenJobsPerPrincipal: number;
  /** Serve the browser job console at `/`. Defaults to true. */
  console?: boolean;
  host?: { store: HostStore; owner: string; principal: string; transport: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildApi(deps: ApiDependencies): FastifyInstance {
  const app = createService({ name: "agent-api", bodyLimit: 2 * 1024 * 1024, ready: () => deps.store.ping() });
  // Custom methods like :cancel carry no body; accept (and ignore) non-JSON content types.
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => done(null, undefined));
  if (deps.console !== false) {
    registerConsole(app);
  }

  const principalOf = (request: FastifyRequest) => deps.authenticator.authenticate(request).id;
  if (deps.host) {
    const host = deps.host;
    const authorizeHost = (request: FastifyRequest) => {
      if (principalOf(request) !== host.principal) throw new HttpError(404, "not_found", "Demo host not found.");
    };
    app.get("/v1/host", async (request) => {
      authorizeHost(request);
      return { transport: host.transport, ...(await host.store.status(host.owner)) };
    });
    app.get("/v1/host/sessions", async (request) => {
      authorizeHost(request);
      if (host.transport === "github") throw new HttpError(409, "native_host", "Manage GitHub-native conversations in the connected Copilot CLI.");
      return { sessions: await host.store.list(host.owner) };
    });
    app.post("/v1/host/connection", async (request, reply) => {
      authorizeHost(request);
      reply.header("cache-control", "no-store");
      const status = await host.store.status(host.owner);
      let connection: { token: string; expiresAt: string } | undefined;
      if (host.transport === "direct" || host.transport === "both") {
        try {
          connection = await host.store.issueConnection(host.owner);
        } catch (error) {
          throw mapStoreError(error);
        }
      }
      return { transport: host.transport, ...connection, ...status };
    });
    app.post("/v1/host/sessions/:id/close", async (request) => {
      authorizeHost(request);
      if (host.transport === "github") throw new HttpError(409, "native_host", "Manage GitHub-native conversations in the connected Copilot CLI.");
      const id = (request.params as { id: string }).id;
      if (!UUID.test(id) || !(await host.store.close(host.owner, id))) throw new HttpError(404, "not_found", "Hosted session not found.");
      return { closed: true };
    });
  }
  const jobIdOf = (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) {
      throw new HttpError(404, "not_found", "Job not found.");
    }
    return id;
  };
  const requestIdOf = (request: FastifyRequest) => {
    const requestId = (request.params as { requestId: string }).requestId;
    if (!UUID.test(requestId)) {
      throw new HttpError(400, "invalid_request", "Input request id must be a UUID.");
    }
    return requestId;
  };

  app.get("/v1/harnesses", async (request) => {
    principalOf(request);
    return {
      harnesses: [...deps.harnesses.values()]
        .map((versions) => versions.filter((version) => version.definition.interaction !== "conversation"))
        .filter((versions) => versions.length > 0)
        .map((versions) => ({
        name: versions[0]!.definition.name,
        description: versions[0]!.definition.description,
        versions: versions.map((v) => ({
          version: v.definition.version,
          digest: v.digest,
          profiles: v.definition.runners.allowedProfiles,
          defaultProfile: v.definition.runners.defaultProfile,
          inputSchema: v.definition.input.schema,
          outputSchema: v.definition.output.schema,
        })),
      })),
    };
  });

  app.get("/v1/jobs", async (request) => {
    const principal = principalOf(request);
    const query = request.query as { limit?: string; before?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "25", 10) || 25, 1), 100);
    const before = query.before ? new Date(query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      throw new HttpError(400, "invalid_request", "'before' must be an ISO 8601 timestamp.");
    }
    const jobs = await deps.store.listJobs(principal, limit, before);
    return { jobs, next: jobs.length === limit ? jobs.at(-1)?.createdAt : undefined };
  });

  app.post("/v1/jobs", async (request, reply) => {
    const principal = principalOf(request);
    const parsed = JobSubmission.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", "The job submission is invalid.", {
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
      throw new HttpError(400, "invalid_request", "Idempotency-Key must be 1-200 visible ASCII characters.");
    }
    const admitted = deps.admission.admit(parsed.data);
    try {
      const { view, created } = await deps.store.createJob(
        { principal, idempotencyKey, ...admitted },
        deps.maxOpenJobsPerPrincipal,
      );
      reply.header("location", `/v1/jobs/${view.id}`);
      return reply.status(created ? 202 : 200).send(view);
    } catch (error) {
      throw mapStoreError(error);
    }
  });

  app.get("/v1/jobs/:id", async (request) => {
    const view = await deps.store.getJob(principalOf(request), jobIdOf(request));
    if (!view) {
      throw new HttpError(404, "not_found", "Job not found.");
    }
    return view;
  });

  app.get("/v1/input-requests", async (request) => {
    const principal = principalOf(request);
    const query = request.query as { state?: string; limit?: string };
    const state = query.state ?? "pending";
    if (state !== "pending" && state !== "all") {
      throw new HttpError(400, "invalid_request", "'state' must be 'pending' or 'all'.");
    }
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "50", 10) || 50, 1), 100);
    const requests = await deps.store.listInputRequests(principal, { state, limit });
    return { requests };
  });

  app.get("/v1/jobs/:id/input-requests", async (request) => {
    const principal = principalOf(request);
    const id = jobIdOf(request);
    if (!(await deps.store.getJob(principal, id))) {
      throw new HttpError(404, "not_found", "Job not found.");
    }
    const requests = await deps.store.listInputRequests(principal, {
      jobId: id,
      state: "all",
      limit: 100,
      order: "oldest",
    });
    return { requests };
  });

  app.post("/v1/jobs/:id/input-requests/:requestId/respond", async (request) => {
    const principal = principalOf(request);
    const jobId = jobIdOf(request);
    const requestId = requestIdOf(request);
    const parsed = InputResponseSubmission.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", "The input response is invalid.", {
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    try {
      return await deps.store.respondInputRequest(principal, jobId, requestId, parsed.data, principal);
    } catch (error) {
      throw mapStoreError(error);
    }
  });

  // Custom methods (`/v1/jobs/{id}:cancel`, `/v1/jobs/{id}:retry`) share one route because the
  // router cannot distinguish literal suffixes after a parameter.
  app.post("/v1/jobs/:target", async (request) => {
    const target = (request.params as { target: string }).target;
    const separator = target.lastIndexOf(":");
    const id = separator > 0 ? target.slice(0, separator) : "";
    const action = separator > 0 ? target.slice(separator + 1) : "";
    if (!UUID.test(id) || (action !== "cancel" && action !== "retry")) {
      throw new HttpError(404, "not_found", "Not found.");
    }
    const principal = principalOf(request);
    try {
      return action === "cancel"
        ? await deps.store.requestCancel(principal, id)
        : await deps.store.retryJob(principal, id);
    } catch (error) {
      throw mapStoreError(error);
    }
  });

  app.get("/v1/jobs/:id/artifacts", async (request) => {
    const id = jobIdOf(request);
    const view = await deps.store.getJob(principalOf(request), id);
    if (!view) {
      throw new HttpError(404, "not_found", "Job not found.");
    }
    return {
      artifacts:
        view.state === "succeeded"
          ? [{ name: "result.json", contentType: "application/json", href: `/v1/jobs/${id}/artifacts/result.json` }]
          : [],
    };
  });

  app.get("/v1/jobs/:id/artifacts/result.json", async (request, reply) => {
    const view = await deps.store.getJob(principalOf(request), jobIdOf(request));
    if (!view || view.state !== "succeeded") {
      throw new HttpError(404, "not_found", "Artifact not found.");
    }
    return reply.type("application/json").send(JSON.stringify(view.result));
  });

  app.get("/v1/jobs/:id/events", async (request, reply) => {
    const principal = principalOf(request);
    const id = jobIdOf(request);
    if (!(await deps.store.getJob(principal, id))) {
      throw new HttpError(404, "not_found", "Job not found.");
    }
    const after = cursorOf(request);
    if (!acceptsEventStream(request)) {
      const events = await deps.store.listEvents(principal, id, after, 500);
      return { events, next: events.at(-1)?.seq ?? after };
    }
    await streamEvents(deps, principal, id, after, request, reply);
    return reply;
  });

  return app;
}

async function streamEvents(
  deps: ApiDependencies,
  principal: string,
  jobId: string,
  after: number,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let cursor = after;
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  deps.listener.on(jobId, notify);
  const keepAlive = setInterval(() => raw.write(": keep-alive\n\n"), 15_000);
  request.raw.on("close", () => {
    closed = true;
    notify();
  });

  const write = (event: JobEventView) => {
    raw.write(`id: ${event.seq}\nevent: ${event.body.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  try {
    while (!closed) {
      const events = await deps.store.listEvents(principal, jobId, cursor, 200);
      for (const event of events) {
        write(event);
        cursor = event.seq;
      }
      if (events.length === 200) {
        continue;
      }
      const job = await deps.store.getJob(principal, jobId);
      if (!job || TERMINAL_STATES.has(job.state)) {
        const tail = await deps.store.listEvents(principal, jobId, cursor, 200);
        tail.forEach(write);
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 2_000);
      });
    }
  } finally {
    clearInterval(keepAlive);
    deps.listener.off(jobId, notify);
    raw.end();
  }
}

function cursorOf(request: FastifyRequest): number {
  const fromHeader = headerValue(request, "last-event-id");
  const fromQuery = (request.query as { after?: string }).after;
  const value = Number.parseInt(fromHeader ?? fromQuery ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function acceptsEventStream(request: FastifyRequest): boolean {
  return (headerValue(request, "accept") ?? "").includes("text/event-stream");
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function mapStoreError(error: unknown): unknown {
  if (error instanceof StoreError) {
    const status = {
      idempotency_conflict: 409,
      quota_exceeded: 429,
      not_found: 404,
      invalid_state: 409,
      invalid_request: 400,
    }[error.code];
    return new HttpError(status, error.code, error.message);
  }
  return error;
}
