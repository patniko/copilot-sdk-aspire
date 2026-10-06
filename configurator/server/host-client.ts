import { z } from "zod";
import type { Settings } from "./settings.js";
import type { StatusService } from "./status.js";
import type { TryService } from "./try.js";
import type { TryTarget } from "./types.js";

export const HostConnectionInfo = z.object({
  transport: z.enum(["direct", "github", "both"]),
  online: z.boolean(),
  execution: z.enum(["managed", "github-native"]).optional(),
  environmentId: z.string().max(200).optional(),
  token: z.string().min(32).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
  serverKey: z.object({
    keyId: z.string().min(1).max(200),
    algorithm: z.enum(["x25519-sealedbox", "hpke-x25519-hkdf-sha256-aes256gcm"]),
    publicKey: z.string().min(1).max(1000),
  }).optional(),
});

export function websocketEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Host endpoints must not contain credentials, paths, queries, or fragments.");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:" && loopback) url.protocol = "ws:";
  else throw new Error("Non-loopback host endpoints require HTTPS.");
  return url.href;
}

export async function hostConnection(
  target: TryTarget,
  mode: "direct" | "github",
  services: { settings: Settings; status: StatusService; jobs: TryService },
): Promise<{ info: z.infer<typeof HostConnectionInfo>; endpoint?: string }> {
  let endpoint: string | undefined;
  if (mode === "direct") {
    if (target === "local") {
      const local = await services.status.local();
      const resource = local.resources.find((item) => item.name === "agent-host");
      const url = resource?.urls.find((item) => item.name === "http")?.url ?? resource?.urls[0]?.url;
      if (!url) throw new Error("The local demo host endpoint is not available.");
      endpoint = websocketEndpoint(url);
    } else {
      const azure = await services.status.azure(await services.settings.target(undefined));
      const resource = azure.apps.find((item) => item.name === "agent-host" && item.external);
      if (!resource?.fqdn) throw new Error("The selected Azure target has no external demo host endpoint.");
      endpoint = websocketEndpoint(`https://${resource.fqdn}`);
    }
  }
  const connection = await services.jobs.connection(target);
  const api = new URL(connection.apiUrl);
  if (api.protocol !== "https:" && !(api.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname))) {
    throw new Error("Connection provisioning requires HTTPS or a loopback API.");
  }
  const response = await fetch(new URL("/v1/host/connection", api), {
    method: "POST",
    headers: { authorization: `Bearer ${connection.key}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Demo host connection provisioning failed (${response.status}).`);
  const info = HostConnectionInfo.parse(await response.json());
  if (!info.online) throw new Error("The demo host is offline.");
  if (mode === "direct" && (!info.token || !info.serverKey || !info.expiresAt || Date.parse(info.expiresAt) <= Date.now())) {
    throw new Error("The direct host has not published a current key and connection ticket.");
  }
  if (mode === "github" && !info.environmentId) throw new Error("The host has not registered a GitHub environment.");
  return { info, endpoint };
}
