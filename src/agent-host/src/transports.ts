import type { AhpHostOptions } from "@github/copilot-sdk";
import type { OwnerConfiguration } from "./protocol.js";

type ManagedOwnerConfiguration = Extract<OwnerConfiguration, { execution: "managed" }>;

/**
 * Transports for a managed owner host. The catalog follows the durable host identity on every transport, so a host
 * keeps its sessions when its transports change; SDKs without the `computeId` option ignore it. Each relay-enabled
 * harness host registers its own Mission Control environment under the owner's account.
 */
export function managedHostOptions(
  config: ManagedOwnerConfiguration,
  callbacks: Pick<AhpHostOptions, "createSession" | "resumeSession" | "onExit">,
): AhpHostOptions {
  const options: AhpHostOptions & { computeId?: string } = {
    computeId: config.computeId,
    ...(config.transport !== "github" ? { localServer: { hostname: "0.0.0.0", port: config.port, token: config.connectionToken } } : {}),
    ...(config.transport !== "direct" ? {
      githubEnvironment: { name: `Aspire ${config.harness} (${config.owner})`, computeId: config.computeId },
    } : {}),
    ...callbacks,
  };
  return options;
}
