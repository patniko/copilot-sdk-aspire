import { type HostingDeployment, SESSION_CONTAINER_FEATURES, SHARED_WORKER_FEATURES } from "@copilot-agent/contracts";
import { DEMO_HOST_FEATURES } from "@copilot-agent/service-defaults";

/** The deployment configuration agent-api receives from the AppHost, as hosting inputs. */
export interface HostingConfiguration {
  /** `EXECUTOR_MODE`: the shared executor pool, or one-shot containers on demand. */
  executor: "pool" | "on-demand";
  /**
   * The optional demo host, when `DEMO_HOST_OWNER` is set: its `DEMO_HOST_TRANSPORT`, the `DEMO_HOST_HARNESS` it
   * serves, and the API principal that owns it.
   */
  demoHost?: { transport: string; harness: string; principal: string };
  /** Whether the local hybrid shared worker is connected (`SHARED_WORKER_KEY`). */
  sharedWorker: boolean;
  /** Whether per-session containers are enabled (`SESSION_CONTAINER_SETTINGS`). */
  sessionContainers?: boolean;
}

/**
 * The hosts, transports, and features this deployment provides, for hosting admission and the `/v1/hosting` views.
 * The demo host is an isolated host for its one harness over direct WSS, the GitHub relay, or both; with the
 * `github` transport it runs GitHub-native sessions instead of the harness and adds no host. The local hybrid worker
 * is the shared worker, over direct WSS, with SHARED_WORKER_FEATURES. Session containers serve isolated harnesses for
 * any principal over direct WSS, with SESSION_CONTAINER_FEATURES.
 */
export function hostingDeployment(configuration: HostingConfiguration): HostingDeployment {
  const demo = configuration.demoHost;
  const transports = demo?.transport === "both" ? (["direct", "github"] as const) : demo?.transport === "direct" ? (["direct"] as const) : [];
  return {
    executor: configuration.executor === "on-demand" ? "dedicated" : "pool",
    isolatedHosts:
      demo && transports.length > 0
        ? [{ harness: demo.harness, owner: demo.principal, transports: [...transports], features: [...DEMO_HOST_FEATURES] }]
        : [],
    ...(configuration.sessionContainers ? { sessionContainers: { transports: ["direct"], features: [...SESSION_CONTAINER_FEATURES] } } : {}),
    ...(configuration.sharedWorker ? { sharedWorker: { transports: ["direct"], features: [...SHARED_WORKER_FEATURES] } } : {}),
  };
}
