import type { AddressInfo } from "node:net";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { SHARED_WORKER_FEATURES, SharedWorkerLimits } from "@copilot-agent/contracts";
import { JobEventListener, JobStore, PlacementStore, SessionFileStore, SharedStore } from "@copilot-agent/job-store";
import { Admission, ApiKeyAuthenticator, signSessionCapability } from "@copilot-agent/service-defaults";
import { buildApi } from "../../../src/agent-api/src/server.js";
import { buildBroker } from "../../../src/connection-broker/src/broker.js";
import { containerUpstream, DispatcherDirectory, sessionRoutes, sharedUpstream } from "../../../src/connection-broker/src/sessions.js";
import { buildDispatcher } from "../../../src/job-dispatcher/src/server.js";
import { buildGateway } from "../../../src/inference-gateway/src/server.js";
import { parseRoutes } from "../../../src/inference-gateway/src/routes.js";
import type { SharedAdmission } from "../../../src/session-host/src/admission.js";
import type { SharedRegistry } from "../../../src/session-host/src/configuration.js";
import { PERMISSION_HANDLERS, type CustomPermissionHandler } from "../../../src/session-host/src/permission-handlers.js";
import { buildSharedHost } from "../../../src/session-host/src/server.js";
import { SharedSessionService } from "../../../src/session-host/src/service.js";
import type { SharedEgress } from "../../../src/session-host/src/shared-egress.js";

export interface SharedStack {
  store: SharedStore;
  service: SharedSessionService;
  host: FastifyInstance;
  /** The connection broker; CLI connections attach only through it. */
  broker: FastifyInstance;
  api: FastifyInstance;
  /** Signed inference grants minted for turns, to prove they never reach stored history. */
  grants: string[];
  close(): Promise<void>;
}

export const address = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/** Attempts a WebSocket attachment with `ticket`: the HTTP status of a refusal, or 101 when it opens (then closes it). */
export function attachStatus(url: string, ticket: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    target.searchParams.set("tkn", ticket);
    const socket = new WebSocket(target);
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.once("open", () => { socket.terminate(); resolve(101); });
    socket.once("error", reject);
  });
}

/**
 * The shared worker, inference gateway, dispatcher broker routes, connection broker, and agent-api wired as the
 * AppHost wires them, against synthetic inference. Grants are reservation-backed turn capabilities; nothing contacts a
 * paid model.
 */
export async function sharedStack(options: {
  pool: pg.Pool;
  root: string;
  registry: SharedRegistry;
  admission: SharedAdmission;
  principals: Record<string, number>;
  apiKeys: Record<string, string>;
  modelUrl: string;
  workerLimits?: Partial<SharedWorkerLimits>;
  egress?: SharedEgress;
  permissionHandlers?: ReadonlyMap<string, CustomPermissionHandler>;
  permissionHandlerTimeoutMs?: number;
  report?: (event: string, id: string) => void;
}): Promise<SharedStack> {
  const signingKey = "synthetic-signing-key-".repeat(3);
  const controlKey = "synthetic-control-key-".repeat(2);
  const brokerKey = "synthetic-connection-broker-key-".repeat(2);
  const store = new SharedStore(options.pool);
  const grants: string[] = [];
  const apps: FastifyInstance[] = [];
  const gateway = buildGateway({
    signingKey,
    routes: parseRoutes(JSON.stringify([{ model: "fixture", deployment: "fixture", baseUrl: options.modelUrl, auth: "none" }]), true),
    upstreamToken: async () => { throw new Error("The fixture must not request provider credentials."); },
    introspect: (jti) => store.introspect(jti),
    beginRequest: async (jti, requestId) => { await store.beginInference(jti, requestId); },
    reportUsage: async (report) => {
      if (!report.requestId) throw new Error("Usage must have a stable request identity.");
      await store.recordUsage(report.jti, report.requestId, report.inputTokens, report.outputTokens, report.usageKnown ?? false);
    },
  });
  apps.push(gateway);
  await gateway.listen({ port: 0, host: "127.0.0.1" });
  const jobs = new JobStore(options.pool);
  const dispatcher = buildDispatcher({
    store: jobs, policies: options.registry.policies, executorKey: "unused-executor-key-".repeat(3), gatewayKey: "unused-gateway-key-".repeat(3),
    signingKey: "unused-signing-key-".repeat(4), broker: { store: new PlacementStore(options.pool), key: brokerKey },
  });
  apps.push(dispatcher);
  await dispatcher.listen({ port: 0, host: "127.0.0.1" });
  const service = new SharedSessionService({
    root: options.root, store, files: new SessionFileStore(options.pool), principals: options.principals, admission: options.admission,
    limits: SharedWorkerLimits.parse(options.workerLimits ?? {}),
    gatewayUrl: `${address(gateway)}/openai/v1`,
    mintToken: async (lease, turn) => {
      const grant = await store.grant(lease, turn.id);
      const token = await signSessionCapability(signingKey, {
        sub: lease.id, session: lease.id, epoch: lease.epoch, jti: turn.id, prn: lease.principal,
        mdl: [grant.model], tok: grant.tokenBudget, expiresAt: grant.expiresAt,
      });
      grants.push(token);
      return token;
    },
    report: options.report ?? (() => undefined),
    ...(options.egress ? { toolkit: { egress: options.egress } } : {}),
    permissionHandlers: options.permissionHandlers ?? PERMISSION_HANDLERS,
    ...(options.permissionHandlerTimeoutMs ? { permissionHandlerTimeoutMs: options.permissionHandlerTimeoutMs } : {}),
  });
  await service.start();
  const host = buildSharedHost(service, controlKey, brokerKey);
  apps.push(host);
  await host.listen({ port: 0, host: "127.0.0.1" });
  const { app: broker } = buildBroker({
    families: [sessionRoutes(new DispatcherDirectory(address(dispatcher), brokerKey))],
    upstreams: { shared: sharedUpstream(new URL(address(host)), brokerKey), container: containerUpstream() },
  });
  apps.push(broker);
  await broker.listen({ port: 0, host: "127.0.0.1" });
  const harnesses = new Map(options.registry.harnesses);
  const profiles = new Map(options.registry.profiles);
  const api = buildApi({
    store: jobs, listener: new JobEventListener(options.pool), harnesses, console: false, maxOpenJobsPerPrincipal: 10,
    admission: new Admission({ harnesses, profiles, policies: options.registry.policies }),
    authenticator: new ApiKeyAuthenticator(Object.entries(options.apiKeys).map(([principal, key]) => `${principal}:${key}`).join(";")),
    shared: { url: address(host), key: controlKey, brokerUrl: address(broker) },
    hosting: {
      harnesses, profiles, policies: options.registry.policies,
      deployment: { isolatedHosts: [], sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] } },
    },
  });
  apps.push(api);
  return {
    store, service, host, broker, api, grants,
    close: async () => {
      // Closing the worker's listener also stops the service.
      for (const app of apps.reverse()) await app.close();
    },
  };
}
