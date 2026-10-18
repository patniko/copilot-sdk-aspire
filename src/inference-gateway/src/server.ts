import type { InferenceCapabilityClaims, CapabilityIntrospection, UsageReport } from "@copilot-agent/contracts";
import { bearerToken, createService, verifyInferenceCapability } from "@copilot-agent/service-defaults";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ResolvedUpstream } from "./github-upstream.js";
import { routeOwner, routeWireApi, type InferenceRoute, type RouteTable } from "./routes.js";

export interface GatewayDependencies {
  signingKey: string;
  routes: RouteTable;
  upstreamToken: () => Promise<string>;
  /** Resolves GitHub Copilot routes (`auth: "github"`); absent when GitHub inference is not configured. */
  github?: {
    endpoint: (deployment: string) => Promise<ResolvedUpstream>;
    invalidate: (deployment: string) => void;
  };
  introspect: (jti: string) => Promise<CapabilityIntrospection>;
  reportUsage: (report: UsageReport) => Promise<void>;
  beginRequest?: (jti: string, requestId: string) => Promise<void>;
  maxInFlightPerCapability?: number;
  maxInFlightTotal?: number;
  upstreamTimeoutMs?: number;
}

interface ChatBody {
  model?: unknown;
  stream?: unknown;
  stream_options?: Record<string, unknown>;
  [key: string]: unknown;
}

function openAiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { message, type: "gateway_error", code } });
}

/**
 * OpenAI-compatible inference gateway. The executor holds only a job-scoped capability; the gateway
 * owns the upstream credential, resolves approved routes from trusted configuration, and never falls
 * back to a direct or unapproved provider.
 */
export function buildGateway(deps: GatewayDependencies): FastifyInstance {
  const app = createService({ name: "inference-gateway", bodyLimit: 16 * 1024 * 1024 });
  const perCapabilityLimit = deps.maxInFlightPerCapability ?? 4;
  const totalLimit = deps.maxInFlightTotal ?? 128;
  const timeoutMs = deps.upstreamTimeoutMs ?? 10 * 60_000;
  const inFlight = new Map<string, number>();
  let totalInFlight = 0;

  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<InferenceCapabilityClaims | undefined> {
    const presented = bearerToken(request) ?? (request.headers["api-key"] as string | undefined);
    if (!presented) {
      openAiError(reply, 401, "missing_capability", "An inference capability is required.");
      return undefined;
    }
    try {
      return await verifyInferenceCapability(deps.signingKey, presented);
    } catch {
      openAiError(reply, 401, "invalid_capability", "The inference capability is invalid or expired.");
      return undefined;
    }
  }

  app.get("/openai/v1/models", async (request, reply) => {
    const claims = await authorize(request, reply);
    if (!claims) {
      return reply;
    }
    return {
      object: "list",
      data: claims.mdl
        .flatMap((id) => {
          const route = deps.routes.routes.get(id);
          return route ? [describe(route)] : [];
        }),
    };
  });

  // Runtimes choose their provider's wire API before they hold a capability, so one routed model's description is
  // public: it reveals only that the name is routed and how. Listing every model still requires a capability.
  app.get("/openai/v1/models/*", async (request, reply) => {
    const id = (request.params as { "*": string })["*"];
    const route = deps.routes.routes.get(id);
    if (!route) return openAiError(reply, 404, "model_not_found", "The model is not routed by this gateway.");
    return describe(route);
  });

  app.post("/openai/v1/chat/completions", async (request, reply) => forward(request, reply, "chat/completions"));
  app.post("/openai/v1/responses", async (request, reply) => forward(request, reply, "responses"));

  async function forward(request: FastifyRequest, reply: FastifyReply, path: "chat/completions" | "responses") {
    const claims = await authorize(request, reply);
    if (!claims) {
      return reply;
    }
    const body = request.body as ChatBody | undefined;
    const correlation = "job" in claims ? { job: claims.job, attempt: claims.att } : { session: claims.session };
    if (!body || typeof body !== "object" || typeof body.model !== "string") {
      return openAiError(reply, 400, "invalid_request", "A model is required.");
    }
    const route = deps.routes.routes.get(body.model);
    if (!route || !claims.mdl.includes(body.model)) {
      return openAiError(reply, 403, "model_not_allowed", "The model is not approved for this execution.");
    }
    const wireApi = routeWireApi(route);
    if (wireApi !== (path === "responses" ? "responses" : "completions")) {
      return openAiError(reply, 400, "unsupported_api_for_model", `The model is served over /${wireApi === "responses" ? "responses" : "chat/completions"}.`);
    }

    let status: CapabilityIntrospection;
    try {
      status = await deps.introspect(claims.jti);
    } catch (error) {
      request.log.error({ err: error, ...correlation }, "capability introspection unavailable");
      return openAiError(reply, 503, "authorization_unavailable", "Authorization service unavailable.");
    }
    if (!status.active) {
      return openAiError(reply, 403, `capability_${status.reason ?? "inactive"}`, "The inference capability is not active.");
    }

    const current = inFlight.get(claims.jti) ?? 0;
    if (current >= perCapabilityLimit || totalInFlight >= totalLimit) {
      reply.header("retry-after", "1");
      return openAiError(reply, 429, "concurrency_limited", "Too many concurrent inference requests.");
    }

    const requestId = randomUUID();
    const reserved = status.reservationRequired === true;
    if (reserved) {
      if (!deps.beginRequest) return openAiError(reply, 503, "reservation_unavailable", "Durable inference admission is unavailable.");
      try { await deps.beginRequest(claims.jti, requestId); }
      catch (error) {
        request.log.warn({ err: error, ...correlation }, "inference reservation refused");
        return openAiError(reply, 409, "reservation_refused", "The conversation cannot start another inference request.");
      }
    }
    let upstreamToken: string | undefined;
    let upstreamBase = route.baseUrl;
    let upstreamHeaders: Record<string, string> = {};
    if (route.auth === "entra" || route.auth === "github") {
      try {
        if (route.auth === "entra") {
          upstreamToken = await deps.upstreamToken();
        } else {
          if (!deps.github) throw new Error("GitHub inference is not configured.");
          ({ baseUrl: upstreamBase, headers: upstreamHeaders } = await deps.github.endpoint(route.deployment));
        }
      } catch (error) {
        request.log.error({ err: error }, "upstream credential unavailable");
        if (reserved) {
          await deps.reportUsage({ requestId, jti: claims.jti, model: body.model, inputTokens: 0, outputTokens: 0, usageKnown: true })
            .catch((failure) => request.log.error({ err: failure, ...correlation }, "inference reservation settlement pending"));
        }
        return openAiError(reply, 502, "upstream_auth_unavailable", "The gateway could not authenticate upstream.");
      }
    }

    const streaming = body.stream === true;
    const upstreamBody: ChatBody = { ...body, model: route.deployment };
    // Responses streams always end with usage; chat completion streams include it only on request.
    if (streaming && path === "chat/completions") {
      upstreamBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    }

    // Reservation and upstream credential calls yield; recheck before taking local capacity.
    const admittedInFlight = inFlight.get(claims.jti) ?? 0;
    if (admittedInFlight >= perCapabilityLimit || totalInFlight >= totalLimit) {
      if (reserved) {
        await deps.reportUsage({ requestId, jti: claims.jti, model: body.model, inputTokens: 0, outputTokens: 0, usageKnown: true })
          .catch((error) => request.log.error({ err: error, ...correlation }, "inference reservation settlement pending"));
      }
      reply.header("retry-after", "1");
      return openAiError(reply, 429, "concurrency_limited", "Too many concurrent inference requests.");
    }
    inFlight.set(claims.jti, admittedInFlight + 1);
    totalInFlight++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("upstream timeout")), timeoutMs);
    const onClientClose = () => {
      if (!reply.raw.writableEnded) {
        abort.abort(new Error("client disconnected"));
      }
    };
    request.raw.on("close", onClientClose);
    const started = Date.now();
    let usage = { input: 0, output: 0 };
    let usageKnown = false;

    try {
      const headers: Record<string, string> = {
        ...upstreamHeaders,
        ...(route.auth === "github" ? { "x-interaction-id": requestId } : {}),
        "content-type": "application/json",
        accept: streaming ? "text/event-stream" : "application/json",
        "user-agent": "copilot-agent-inference-gateway/0.1",
      };
      if (upstreamToken) {
        headers.authorization = `Bearer ${upstreamToken}`;
      }
      const upstream = await fetch(`${upstreamBase}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        redirect: "manual",
        signal: abort.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return openAiError(reply, 502, "upstream_redirect_refused", "The upstream attempted a redirect.");
      }
      if (route.auth === "github" && (upstream.status === 401 || upstream.status === 403)) {
        deps.github?.invalidate(route.deployment);
      }

      const contentType = upstream.headers.get("content-type") ?? "application/json";
      reply.hijack();
      reply.raw.writeHead(upstream.status, {
        "content-type": contentType,
        "cache-control": "no-store",
        ...(contentType.includes("text/event-stream") ? { "x-accel-buffering": "no" } : {}),
      });
      if (!upstream.body) {
        reply.raw.end();
        return reply;
      }

      const decoder = new TextDecoder();
      let pending = "";
      let buffered = "";
      const isEventStream = contentType.includes("text/event-stream");
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        reply.raw.write(chunk);
        const text = decoder.decode(chunk, { stream: true });
        if (isEventStream) {
          pending += text;
          let index: number;
          while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index).trim();
            pending = pending.slice(index + 1);
            if (line.startsWith("data:") && line.includes('"usage"')) {
              const measured = extractUsage(line.slice(5).trim());
              if (measured) { usage = measured; usageKnown = true; }
            }
          }
        } else if (buffered.length < 4 * 1024 * 1024) {
          buffered += text;
        }
      }
      if (!isEventStream && upstream.ok) {
        const measured = extractUsage(buffered);
        if (measured) { usage = measured; usageKnown = true; }
      }
      reply.raw.end();
      request.log.info(
        {
          ...correlation,
          model: body.model,
          status: upstream.status,
          streaming,
          ms: Date.now() - started,
          inputTokens: usage.input,
          outputTokens: usage.output,
          // Shape only (never content) when the provider omits usage or fails, to diagnose odd responses.
          ...(usage.input === 0 && usage.output === 0 && !isEventStream ? { shape: responseShape(buffered) } : {}),
        },
        "inference completed",
      );
      return reply;
    } catch (error) {
      const aborted = abort.signal.aborted;
      request.log.warn({ err: error, ...correlation, aborted }, "inference request failed");
      if (!reply.sent && !reply.raw.headersSent) {
        return openAiError(reply, aborted ? 504 : 502, "upstream_unavailable", "The model provider request failed.");
      }
      reply.raw.destroy();
      return reply;
    } finally {
      clearTimeout(timer);
      request.raw.off("close", onClientClose);
      totalInFlight--;
      const remaining = (inFlight.get(claims.jti) ?? 1) - 1;
      if (remaining <= 0) {
        inFlight.delete(claims.jti);
      } else {
        inFlight.set(claims.jti, remaining);
      }
      if (reserved || usage.input > 0 || usage.output > 0) {
        await deps
          .reportUsage({ requestId, jti: claims.jti, model: body.model, inputTokens: usage.input, outputTokens: usage.output,
            ...(reserved ? { usageKnown } : {}) })
          .catch((error) => request.log.error({ err: error, ...correlation }, reserved ? "inference reservation settlement pending" : "usage report lost"));
      }
    }
  }

  app.all("/openai/*", async (_request, reply) => openAiError(reply, 404, "not_found", "Unsupported endpoint."));

  return app;
}

function describe(route: InferenceRoute) {
  return { id: route.model, object: "model" as const, created: 0, owned_by: routeOwner(route), wire_api: routeWireApi(route) };
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** Usage from a chat completion (`usage.prompt_tokens`) or a Responses payload or `response.completed` event (`input_tokens`). */
function extractUsage(json: string): { input: number; output: number } | undefined {
  try {
    const parsed = JSON.parse(json) as { usage?: Usage | null; response?: { usage?: Usage | null } | null };
    const usage = parsed.usage ?? parsed.response?.usage;
    if (!usage) {
      return undefined;
    }
    const input = usage.prompt_tokens ?? usage.input_tokens;
    const output = usage.completion_tokens ?? usage.output_tokens;
    if (typeof input !== "number" || typeof output !== "number"
      || ![input, output].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)) return undefined;
    return { input, output };
  } catch {
    return undefined;
  }
}

/** Describes a provider response without its content: top-level keys, finish reasons, and error codes. */
export function responseShape(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as {
      object?: unknown;
      choices?: Array<{ finish_reason?: unknown; message?: { tool_calls?: unknown[]; content?: unknown } }>;
      error?: { code?: unknown; type?: unknown };
    };
    return {
      bytes: json.length,
      keys: Object.keys(parsed).slice(0, 20),
      object: typeof parsed.object === "string" ? parsed.object : undefined,
      choices: parsed.choices?.length,
      finishReasons: parsed.choices?.map((c) => c.finish_reason),
      toolCalls: parsed.choices?.map((c) => c.message?.tool_calls?.length ?? 0),
      contentChars: parsed.choices?.map((c) => (typeof c.message?.content === "string" ? c.message.content.length : null)),
      error: parsed.error ? { code: parsed.error.code, type: parsed.error.type } : undefined,
    };
  } catch {
    return { bytes: json.length, parseable: false };
  }
}
