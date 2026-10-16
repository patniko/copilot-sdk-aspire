import {
  canonicalSessionId,
  connectionProblem,
  evaluateHosting,
  HOSTING_ERROR_STATUS,
  HostConnectionRequest,
  hostingModeOf,
  policyFor,
  type ExecutionProfile,
  type HarnessSnapshot,
  type HostingProblem,
  type HostingTransport,
  type PolicySet,
} from "@copilot-agent/contracts";
import { StoreError, type HostKey, type HostStore } from "@copilot-agent/job-store";
import { HttpError, isolatedHostsOf, type ConfiguredOwnerHost } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** An owner host as the API sees it: its descriptor plus, for direct hosts, the endpoint clients dial. */
export type ApiOwnerHost = ConfiguredOwnerHost & { url?: string };

export interface HostApiDependencies {
  store: HostStore;
  hosts: ApiOwnerHost[];
  /** The published registry, effective policies, and profiles: connection provisioning re-evaluates hosting. */
  harnesses: ReadonlyMap<string, HarnessSnapshot[]>;
  policies: PolicySet;
  profiles: ReadonlyMap<string, ExecutionProfile>;
}

const keyOf = (host: ApiOwnerHost): HostKey => ({ harness: host.harness, owner: host.owner });
const hasDirect = (host: ApiOwnerHost) => host.transport !== "github";
const hasRelay = (host: ApiOwnerHost) => host.transport !== "direct";

/** Converts a host's HTTP endpoint into the WebSocket URL that clients pin and dial. */
export function websocketUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error("Owner host endpoints must not contain credentials or queries.");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("Owner host endpoints must use HTTP or HTTPS.");
  url.pathname = "/";
  return url.href;
}

function hostingError(problem: HostingProblem): HttpError {
  return new HttpError(HOSTING_ERROR_STATUS[problem.code], problem.code, problem.message,
    problem.prerequisite || problem.path ? { ...(problem.path ? { path: problem.path } : {}), ...(problem.prerequisite ? { prerequisite: problem.prerequisite } : {}) } : undefined);
}

function storeError(error: unknown): unknown {
  if (error instanceof StoreError) {
    return new HttpError(error.code === "not_found" ? 404 : error.code === "quota_exceeded" ? 429 : 409, error.code, error.message);
  }
  return error;
}

/**
 * Per-harness owner hosts (`/v1/hosts/{harness}`) and the legacy single demo host (`/v1/host`). A host belongs to one
 * API principal: only it receives connection material or sees the host's sessions. Connection provisioning applies
 * the same hosting evaluation as admission, so other principals receive `relay_owner_only` for the relay and
 * `hosting_unavailable` (naming session containers) for direct WSS.
 */
export function registerHostRoutes(app: FastifyInstance, deps: HostApiDependencies, principalOf: (request: FastifyRequest) => string): void {
  const legacy = deps.hosts.find((host) => host.legacy);
  if (legacy) registerLegacyRoutes(app, deps.store, legacy, principalOf);
  const isolatedHosts = isolatedHostsOf(deps.hosts);
  const conversation = (harness: string) => deps.harnesses.get(harness)?.find((version) => version.definition.interaction === "conversation");

  const hostFor = (request: FastifyRequest): ApiOwnerHost => {
    const harness = (request.params as { harness: string }).harness;
    const host = deps.hosts.find((candidate) => candidate.harness === harness);
    if (host) return host;
    const snapshot = conversation(harness);
    if (snapshot) {
      const isolated = hostingModeOf(snapshot.definition) === "isolated";
      throw hostingError({
        code: "hosting_unavailable",
        message: isolated
          ? `No owner host is deployed for harness '${harness}'.`
          : `Harness '${harness}' uses ${hostingModeOf(snapshot.definition)} hosting; connect through /v1/sessions instead of an owner host.`,
        ...(isolated ? { prerequisite: { kind: "host" as const, name: "isolated-host" as const } } : {}),
      });
    }
    throw new HttpError(404, "not_found", "Harness not found.");
  };
  /** The first problem, in admission order, that blocks `principal` from this host over `transport`. */
  const problemFor = (host: ApiOwnerHost, principal: string, transport: HostingTransport): HostingProblem | undefined => {
    if (host.execution === "github-native") {
      // GitHub-native hosting ignores the harness and its policy; it offers only the owner's relay.
      if (transport !== "github") return { code: "hosting_unavailable", message: "The GitHub-native host offers only the GitHub relay.", prerequisite: { kind: "transport", name: transport } };
      return principal === host.principal ? undefined
        : { code: "relay_owner_only", message: `Only the owner of the host for '${host.harness}' can use the GitHub relay.` };
    }
    const snapshot = conversation(host.harness);
    if (!snapshot) return { code: "hosting_unavailable", message: `Harness '${host.harness}' is not published as a conversation harness.` };
    const evaluation = evaluateHosting({
      definition: snapshot.definition,
      policy: policyFor(deps.policies, host.harness),
      profiles: deps.profiles,
      deployment: { isolatedHosts },
      lookup: (name) => {
        const target = deps.harnesses.get(name)?.[0];
        return target ? { definition: target.definition, policy: policyFor(deps.policies, name) } : undefined;
      },
      principal,
    });
    return connectionProblem(evaluation, transport);
  };
  const view = async (host: ApiOwnerHost, principal: string) => {
    const owned = principal === host.principal;
    const status = await deps.store.status(keyOf(host));
    return {
      harness: host.harness, transport: host.transport, execution: host.execution, owned, online: status.online,
      resource: host.resource, ...(host.size ? { size: host.size } : {}),
      ...(owned && status.environmentId ? { environmentId: status.environmentId } : {}),
      ...(owned && status.serverKey ? { serverKey: status.serverKey } : {}),
    };
  };
  /** Sessions are private to the owner principal; others see none, as with other principals' jobs. */
  const ownedSessionsOf = (request: FastifyRequest): ApiOwnerHost => {
    const principal = principalOf(request);
    const host = hostFor(request);
    if (principal !== host.principal) throw new HttpError(404, "not_found", "Hosted session not found.");
    if (host.execution === "github-native") throw new HttpError(409, "native_host", "Manage GitHub-native conversations in the connected Copilot CLI.");
    return host;
  };

  app.get("/v1/hosts", async (request) => {
    const principal = principalOf(request);
    return { hosts: await Promise.all(deps.hosts.map((host) => view(host, principal))) };
  });
  app.get("/v1/hosts/:harness", async (request) => {
    const principal = principalOf(request);
    return view(hostFor(request), principal);
  });
  app.get("/v1/hosts/:harness/sessions", async (request) => ({ sessions: await deps.store.list(keyOf(ownedSessionsOf(request))) }));
  app.post("/v1/hosts/:harness/connection", async (request, reply) => {
    const principal = principalOf(request);
    const host = hostFor(request);
    reply.header("cache-control", "no-store");
    const parsed = HostConnectionRequest.safeParse(request.body ?? {});
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid owner host connection request.");
    const transport = parsed.data.transport ?? (hasDirect(host) ? "direct" : "github");
    const problem = problemFor(host, principal, transport);
    if (problem) throw hostingError(problem);
    if (transport === "github" ? !hasRelay(host) : !hasDirect(host)) {
      throw hostingError({
        code: "hosting_unavailable", prerequisite: { kind: "transport", name: transport },
        message: `The owner host for harness '${host.harness}' does not enable ${transport === "github" ? "the GitHub relay" : "direct WSS"}.`,
      });
    }
    const key = keyOf(host);
    const status = await deps.store.status(key);
    if (!status.online || !status.execution) {
      throw hostingError({ code: "hosting_unavailable", message: `The owner host for harness '${host.harness}' is offline.`, prerequisite: { kind: "host", name: "isolated-host" } });
    }
    let ahpSessionId: string | undefined;
    if (parsed.data.sessionId && status.execution === "managed") {
      const session = await deps.store.find(key, parsed.data.sessionId);
      if (!session || session.closed) throw new HttpError(404, "not_found", "Hosted session not found.");
      // Only the client-visible AHP session ID resumes a session; the ledger ID identifies the runtime session.
      ahpSessionId = session.ahpSessionId;
    }
    const base = { harness: host.harness, transport, execution: status.execution, ...(ahpSessionId ? { ahpSessionId } : {}) };
    if (transport === "github") {
      if (!status.environmentId) {
        throw hostingError({ code: "hosting_unavailable", message: `The owner host for harness '${host.harness}' has not registered its GitHub environment.` });
      }
      return { ...base, environmentId: status.environmentId };
    }
    let ticket: { token: string; expiresAt: string };
    try {
      ticket = await deps.store.issueConnection(key);
    } catch (error) {
      if (error instanceof StoreError && error.code === "invalid_state") {
        throw hostingError({ code: "hosting_unavailable", message: `The owner host for harness '${host.harness}' has not published its direct endpoint key.` });
      }
      throw storeError(error);
    }
    return { ...base, ...(host.url ? { url: websocketUrl(host.url) } : {}), ...ticket, serverKey: status.serverKey };
  });
  app.post("/v1/hosts/:harness/sessions/:id/close", async (request) => {
    const host = ownedSessionsOf(request);
    const id = canonicalSessionId((request.params as { id: string }).id);
    if (!id || !(await deps.store.close(keyOf(host), id))) throw new HttpError(404, "not_found", "Hosted session not found.");
    return { closed: true };
  });
}

/** The original single-host API, kept for existing launchers: only principal `dev` sees it; others receive 404. */
function registerLegacyRoutes(app: FastifyInstance, store: HostStore, host: ApiOwnerHost, principalOf: (request: FastifyRequest) => string): void {
  const key = keyOf(host);
  const authorize = (request: FastifyRequest) => {
    if (principalOf(request) !== host.principal) throw new HttpError(404, "not_found", "Demo host not found.");
  };
  app.get("/v1/host", async (request) => {
    authorize(request);
    return { transport: host.transport, harness: host.harness, ...(await store.status(key)) };
  });
  app.get("/v1/host/sessions", async (request) => {
    authorize(request);
    if (host.execution === "github-native") throw new HttpError(409, "native_host", "Manage GitHub-native conversations in the connected Copilot CLI.");
    return { sessions: await store.list(key) };
  });
  app.post("/v1/host/connection", async (request, reply) => {
    authorize(request);
    reply.header("cache-control", "no-store");
    const status = await store.status(key);
    let connection: { token: string; expiresAt: string } | undefined;
    if (hasDirect(host)) {
      try {
        connection = await store.issueConnection(key);
      } catch (error) {
        throw storeError(error);
      }
    }
    return { transport: host.transport, harness: host.harness, ...connection, ...status };
  });
  app.post("/v1/host/sessions/:id/close", async (request) => {
    authorize(request);
    if (host.execution === "github-native") throw new HttpError(409, "native_host", "Manage GitHub-native conversations in the connected Copilot CLI.");
    const id = canonicalSessionId((request.params as { id: string }).id);
    if (!id || !(await store.close(key, id))) throw new HttpError(404, "not_found", "Hosted session not found.");
    return { closed: true };
  });
}
