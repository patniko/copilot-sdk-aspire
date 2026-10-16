import { SharedConnection, SharedSessionView } from "@copilot-agent/contracts";

export async function sharedConnection(connection: { apiUrl: string; key: string }, resume?: string): Promise<SharedConnection> {
  const api = new URL(connection.apiUrl);
  if (api.username || api.password || api.search || api.hash
    || (api.protocol !== "https:" && !(api.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)))) {
    throw new Error("Shared provisioning requires HTTPS or a loopback API without embedded credentials.");
  }
  const post = async (path: string, body?: object): Promise<unknown> => {
    const response = await fetch(new URL(path, api), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${connection.key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Shared conversation provisioning failed (${response.status}).`);
    return response.json();
  };
  if (resume && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resume)) throw new Error("Shared resume requires an application session UUID.");
  const sessionId = resume?.toLowerCase() ?? SharedSessionView.parse(await post("/v1/sessions", {})).id;
  const result = SharedConnection.parse(await post(`/v1/sessions/${sessionId}/connection`));
  const endpoint = new URL(result.url);
  if (result.sessionId !== sessionId || Date.parse(result.expiresAt) <= Date.now() || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== `/sessions/${sessionId}`
    || (endpoint.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("The API returned an invalid or expired broker connection.");
  }
  return result;
}
