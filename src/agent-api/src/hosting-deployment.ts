import {
  type HostingDeployment, SESSION_CONTAINER_FEATURES, SHARED_WORKER_FEATURES, WORKER_CONTAINER_FEATURES,
} from "@copilot-agent/contracts";
import { type ConfiguredOwnerHost, DEMO_HOST_FEATURES, isolatedHostsOf } from "@copilot-agent/service-defaults";

/** The deployment configuration agent-api receives from the AppHost, as hosting inputs. */
export interface HostingConfiguration {
  /** `EXECUTOR_MODE`: the shared executor pool, or one-shot containers on demand. */
  executor: "pool" | "on-demand";
  /**
   * The optional demo host, when `DEMO_HOST_OWNER` is set: its `DEMO_HOST_TRANSPORT`, the `DEMO_HOST_HARNESS` it
   * serves, and the API principal that owns it. Equivalent to the legacy entry of `ownerHosts`.
   */
  demoHost?: { transport: string; harness: string; principal: string };
  /** Owner hosts from `readOwnerHosts`: per-harness `OWNER_HOSTS` plus the legacy demo host. */
  ownerHosts?: readonly ConfiguredOwnerHost[];
  /** Whether the local hybrid shared worker is connected (`SHARED_WORKER_KEY`). */
  sharedWorker: boolean;
  /** Whether per-session containers are enabled (`SESSION_CONTAINER_SETTINGS`). */
  sessionContainers?: boolean;
  /**
   * Whether the shared worker promotes `promotable` conversations into session containers; it does when both run
   * with the same session-container settings.
   */
  promotion?: boolean;
  /** Whether orchestrator workers run in session containers (`ORCHESTRATOR_WORKERS`). */
  workerContainers?: boolean;
}

/**
 * The hosts, transports, and features this deployment provides, for hosting admission and the `/v1/hosting` views.
 * Each managed owner host is an isolated host for its one harness over direct WSS, the GitHub relay, or both; the
 * legacy demo host with the `github` transport runs GitHub-native sessions instead of the harness and adds no host.
 * The local hybrid worker is the shared worker, over direct WSS, with SHARED_WORKER_FEATURES. Session containers serve
 * isolated harnesses for any principal over direct WSS, with SESSION_CONTAINER_FEATURES. Worker containers run
 * orchestrator workers, with WORKER_CONTAINER_FEATURES.
 */
export function hostingDeployment(configuration: HostingConfiguration): HostingDeployment {
  const demo = configuration.demoHost;
  const transports = demo?.transport === "both" ? (["direct", "github"] as const) : demo?.transport === "direct" ? (["direct"] as const) : [];
  const owners = isolatedHostsOf(configuration.ownerHosts ?? []);
  const legacy = demo && transports.length > 0 && !owners.some((host) => host.harness === demo.harness)
    ? [{ harness: demo.harness, owner: demo.principal, transports: [...transports], features: [...DEMO_HOST_FEATURES] }]
    : [];
  return {
    executor: configuration.executor === "on-demand" ? "dedicated" : "pool",
    isolatedHosts: [...owners, ...legacy],
    ...(configuration.sessionContainers ? { sessionContainers: { transports: ["direct"], features: [...SESSION_CONTAINER_FEATURES] } } : {}),
    ...(configuration.sharedWorker ? { sharedWorker: { transports: ["direct"], features: [
      ...SHARED_WORKER_FEATURES, ...(configuration.promotion && configuration.sessionContainers ? ["promotion" as const] : []),
    ] } } : {}),
    ...(configuration.workerContainers ? { workerContainers: { features: [...WORKER_CONTAINER_FEATURES] } } : {}),
  };
}
