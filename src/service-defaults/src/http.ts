import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { REDACT_PATHS } from "./logging.js";

export interface ServiceOptions {
  name: string;
  /** Maximum accepted request body in bytes. */
  bodyLimit?: number;
  /** Readiness check; failing checks return 503 from /health. */
  ready?: () => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Creates a Fastify server with the shared operational defaults: redacted request logging,
 * no payload logging, bounded bodies, opaque 500s, and distinct liveness/readiness routes.
 */
export function createService(options: ServiceOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    logger: {
      name: options.name,
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: redactUrl(req.url), id: req.id }),
      },
    },
    disableRequestLogging: process.env.LOG_REQUESTS !== "true",
    trustProxy: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const fastifyError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (fastifyError.validation || (fastifyError.statusCode && fastifyError.statusCode < 500)) {
      return reply
        .status(fastifyError.statusCode ?? 400)
        .send({ error: { code: "bad_request", message: fastifyError.message ?? "Bad request" } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Internal error" } });
  });

  app.get("/alive", async () => ({ status: "alive" }));
  app.get("/health", async (_request, reply) => {
    try {
      await options.ready?.();
      return { status: "healthy" };
    } catch (error) {
      app.log.warn({ err: error }, "readiness check failed");
      return reply.status(503).send({ status: "unhealthy" });
    }
  });

  return app;
}

function redactUrl(url: string): string {
  const index = url.indexOf("?");
  return index < 0 ? url : `${url.slice(0, index)}?[redacted]`;
}

export async function listen(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ port, host: "0.0.0.0" });
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
