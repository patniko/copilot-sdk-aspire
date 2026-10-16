import { HarnessHostingView, HostingOverview, SharedConnection, SharedSessionView, type HostingTransport } from "@copilot-agent/contracts";

export interface SharedLaunch {
  /** A published conversation harness for a new session; ignored when resuming. */
  harness?: string;
  /** An existing application session UUID to resume instead of creating one. */
  resume?: string;
  transport?: HostingTransport;
  label?: string;
}

/** Provisioning failed with an API error; `code` is the API's error code, such as `transport_unsupported`. */
export class SharedProvisioningError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

function apiBase(connection: { apiUrl: string }): URL {
  const api = new URL(connection.apiUrl);
  if (api.username || api.password || api.search || api.hash
    || (api.protocol !== "https:" && !(api.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)))) {
    throw new Error("Shared provisioning requires HTTPS or a loopback API without embedded credentials.");
  }
  return api;
}

async function call(connection: { apiUrl: string; key: string }, method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
  const response = await fetch(new URL(path, apiBase(connection)), {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${connection.key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let code: string | undefined;
    let message = `Shared conversation provisioning failed (${response.status}).`;
    try {
      const error = (await response.json() as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code)) code = error.code;
      if (typeof error?.message === "string") message = `${message} ${code ? `${code}: ` : ""}${error.message.slice(0, 500)}`;
    } catch { /* The status alone is reported. */ }
    throw new SharedProvisioningError(response.status, code, message);
  }
  return response.json();
}

/** The API's read-only hosting view of a harness: its mode, placement, status, and transports for this caller. */
export async function harnessHosting(connection: { apiUrl: string; key: string }, harness: string): Promise<HarnessHostingView> {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(harness)) throw new Error("Name a published harness.");
  return HarnessHostingView.parse(await call(connection, "GET", `/v1/hosting/${harness}`));
}

/** Whether the deployment runs `isolated` conversations in session containers over `transport`, through `/v1/sessions`. */
export async function sessionContainersOffer(connection: { apiUrl: string; key: string }, transport: HostingTransport): Promise<boolean> {
  return HostingOverview.parse(await call(connection, "GET", "/v1/hosting")).hosts.sessionContainers?.transports.includes(transport) ?? false;
}

/** Creates or resumes a harness-driven conversation (shared or session-container placement) and returns one-use connection material for it. */
export async function sharedConnection(connection: { apiUrl: string; key: string }, launch: SharedLaunch): Promise<SharedConnection> {
  apiBase(connection);
  const { resume, transport = "direct" } = launch;
  if (resume && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resume)) throw new Error("Shared resume requires an application session UUID.");
  if (!resume && !launch.harness) throw new Error("Name the harness for a new shared conversation.");
  const sessionId = resume?.toLowerCase()
    ?? SharedSessionView.parse(await call(connection, "POST", "/v1/sessions", { harness: launch.harness, ...(launch.label ? { label: launch.label } : {}) })).id;
  const result = SharedConnection.parse(await call(connection, "POST", `/v1/sessions/${sessionId}/connection`, { transport }));
  const endpoint = new URL(result.url);
  if (result.sessionId !== sessionId || Date.parse(result.expiresAt) <= Date.now() || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== `/sessions/${sessionId}`
    || (endpoint.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("The API returned an invalid or expired broker connection.");
  }
  return result;
}
