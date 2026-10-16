import { canonicalSessionId, OwnerHostConnection, type HostingTransport } from "@copilot-agent/contracts";
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Provisions connection material for a per-harness owner host through the authenticated API. Direct material is a
 * one-use, 60-second ticket plus the host's public key; relay material is the harness host's environment ID.
 */
export async function ownerHostConnection(
  api: { apiUrl: string; key: string },
  harness: string,
  transport: HostingTransport | undefined,
  resume?: string,
): Promise<OwnerHostConnection> {
  const base = new URL(api.apiUrl);
  if (base.username || base.password || base.search || base.hash
    || (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK.includes(base.hostname)))) {
    throw new Error("Owner host provisioning requires HTTPS or a loopback API without embedded credentials.");
  }
  const response = await fetch(new URL(`/v1/hosts/${encodeURIComponent(harness)}/connection`, base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${api.key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...(transport ? { transport } : {}), ...(resume && canonicalSessionId(resume) ? { sessionId: resume } : {}) }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const error = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" ? body.error : undefined;
    const code = error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    const message = error && "message" in error && typeof error.message === "string" ? ` ${error.message}` : "";
    throw new Error(`Owner host connection provisioning failed (${response.status}${code ? ` ${code}` : ""}).${message}`);
  }
  const info = OwnerHostConnection.parse(await response.json());
  if (info.harness !== harness || (transport && info.transport !== transport)) throw new Error("The API returned material for a different host or transport.");
  if (info.transport === "github") {
    if (!info.environmentId) throw new Error("The owner host has not registered its GitHub environment.");
    return info;
  }
  if (!info.url || !info.token || !info.serverKey || !info.expiresAt || Date.parse(info.expiresAt) <= Date.now()) {
    throw new Error("The owner host has not published a current direct endpoint, key, and connection ticket.");
  }
  const endpoint = new URL(info.url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
    || (endpoint.protocol === "ws:" && !LOOPBACK.includes(endpoint.hostname))) {
    throw new Error("Owner host endpoints must be WSS, or loopback WS, without credentials, paths, or queries.");
  }
  return info;
}

/**
 * Copilot CLI arguments and environment for owner-host material. Direct WSS pins the host key for the exact endpoint,
 * carries the one-use ticket in the URL, and consents to GitHub identity authentication; the relay attaches to the
 * harness host's own environment. A verified `ahpSessionId` (or the caller's ID) resumes that session.
 */
export function ownerHostCliArguments(info: OwnerHostConnection, resume?: string): { args: string[]; env: Record<string, string> } {
  const args = ["--experimental"];
  const session = info.ahpSessionId ?? resume;
  if (info.transport === "direct") {
    const url = new URL(info.url!);
    const serverKey = JSON.stringify({ endpoint: url.href, ...info.serverKey });
    url.searchParams.set("tkn", info.token!);
    args.push("--ahp", url.href, "--ahp-authenticate-with-github");
    if (session) args.push("--resume", session);
    // A direct launch turns the CLI's relay client off. With it on, the CLI (runtime 0a32c39595f) resumes a session
    // that was ever attached over the relay through its Mission Control environment as well, and the two attachments
    // crash the CLI.
    return { args, env: { COPILOT_AHP_SERVER_KEY: serverKey, RELAY_CLIENT: "false" } };
  }
  args.push("--relay", "--environment-id", info.environmentId!);
  // The relay client requires the attached form for a session ID.
  if (session) args.push(`--resume=${session}`);
  return { args, env: {} };
}