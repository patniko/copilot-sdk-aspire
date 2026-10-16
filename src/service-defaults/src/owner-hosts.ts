import { OwnerHostDescriptor, OwnerHostDescriptors, ownerHostEnvSuffix, ownerHostTransports, type HostingDeployment } from "@copilot-agent/contracts";
import { ConfigError } from "./config.js";

/** An owner host this process serves; `legacy` marks the single host configured through `DEMO_HOST_*`. */
export type ConfiguredOwnerHost = OwnerHostDescriptor & { legacy: boolean };

/**
 * Managed owner hosts as `HostingDeployment.isolatedHosts`, owned by their API principal. They implement no optional
 * hosting features yet. A GitHub-native host ignores its configured harness, so it serves no harness here.
 */
export function isolatedHostsOf(hosts: readonly ConfiguredOwnerHost[]): HostingDeployment["isolatedHosts"] {
  return hosts.filter((host) => host.execution === "managed").map((host) => ({
    harness: host.harness, owner: host.principal, transports: ownerHostTransports(host.transport), features: [],
  }));
}

/**
 * Owner hosts configured for a control-plane process: the per-harness `OWNER_HOSTS` descriptors plus the legacy
 * single demo host (`DEMO_HOST_OWNER`, `DEMO_HOST_TRANSPORT`, `DEMO_HOST_HARNESS`), which keeps its meaning:
 * transport `github` selects GitHub-native execution and its owner principal is `dev`.
 */
export function readOwnerHosts(env: NodeJS.ProcessEnv = process.env): ConfiguredOwnerHost[] {
  const hosts: ConfiguredOwnerHost[] = [];
  const raw = env.OWNER_HOSTS?.trim();
  if (raw) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ConfigError("OWNER_HOSTS must be a JSON array of owner-host descriptors.");
    }
    for (const host of OwnerHostDescriptors.parse(value)) hosts.push({ ...host, owner: host.owner.toLowerCase(), legacy: false });
  }
  const owner = env.DEMO_HOST_OWNER?.trim();
  const transport = env.DEMO_HOST_TRANSPORT?.trim() || "direct";
  if (owner && transport !== "disabled") {
    const legacy = OwnerHostDescriptor.parse({
      harness: env.DEMO_HOST_HARNESS?.trim() || "interactive-demo", owner, principal: "dev",
      transport, execution: transport === "github" ? "github-native" : "managed", resource: "agent-host",
    });
    if (hosts.some((host) => host.harness === legacy.harness)) {
      throw new ConfigError(`Harness '${legacy.harness}' is configured both as the demo host and as an owner host.`);
    }
    hosts.push({ ...legacy, owner: legacy.owner.toLowerCase(), legacy: true });
  }
  return hosts;
}

/** The host's dispatcher service key: `DEMO_HOST_KEY` for the legacy host, `OWNER_HOST_KEY_<HARNESS>` otherwise. */
export function ownerHostKey(host: ConfiguredOwnerHost, env: NodeJS.ProcessEnv = process.env): string {
  const name = host.legacy ? "DEMO_HOST_KEY" : `OWNER_HOST_KEY_${ownerHostEnvSuffix(host.harness)}`;
  const value = env[name];
  if (!value || value.length < 32) throw new ConfigError(`Configure ${name} with at least 32 characters.`);
  return value;
}

/** The host's direct endpoint as seen by this process (`OWNER_HOST_URL_<HARNESS>`), if one is configured. */
export function ownerHostUrl(host: ConfiguredOwnerHost, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`OWNER_HOST_URL_${ownerHostEnvSuffix(host.harness)}`]?.trim();
  return value ? value.replace(/\/+$/, "") : undefined;
}
