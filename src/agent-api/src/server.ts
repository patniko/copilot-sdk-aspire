import { JobSubmission, TERMINAL_STATES, type HarnessSnapshot, type JobEventView } from "@copilot-agent/contracts";
import { JobEventListener, JobStore, StoreError } from "@copilot-agent/job-store";
import { ApiKeyAuthenticator, createService, HttpError } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Admission } from "./admission.js";

export interface ApiDependencies {
  store: JobStore;
  listener: JobEventListener;
  admission: Admission;
  authenticator: ApiKeyAuthenticator;
  harnesses: Map<string, HarnessSnapshot[]>;
  maxOpenJobsPerPrincipal: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildApi(deps: ApiDependencies): FastifyInstance {
  const app = createService({ name: "agent-api", bodyLimit: 2 * 1024 * 1024, ready: () => deps.store.ping() });
  // Custom methods like :cancel carry no body; accept (and ignore) non-JSON content types.
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => done(null, undefined));

  const principalOf = (request: FastifyRequest) => deps.authenticator.authenticate(request).id;
  const jobIdOf = (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) {
      throw new HttpError(404, "not_found", "Job not found.");
    }
    return id;
  };

  app.get("/v1/harnesses", async (request) => {
    principalOf(request);
    return {
      harnesses: [...deps.harnesses.values()].map((versions) => ({
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
    const status = { idempotency_conflict: 409, quota_exceeded: 429, not_found: 404, invalid_state: 409 }[error.code];
    return new HttpError(status, error.code, error.message);
  }
  return error;
}
