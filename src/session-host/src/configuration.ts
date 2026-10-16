import type { ExecutionProfile, HarnessSnapshot, PolicySet } from "@copilot-agent/contracts";

/** The published configuration the shared worker admits and activates sessions against. */
export interface SharedRegistry {
  harnesses: ReadonlyMap<string, HarnessSnapshot[]>;
  profiles: ReadonlyMap<string, ExecutionProfile>;
  policies: PolicySet;
}

/**
 * Re-reads published harnesses, profiles, and policy at most once per `maxAgeMs`, so a configurator harness reload
 * reaches new sessions without restarting the worker and disconnecting attached clients. An invalid edit keeps the
 * last valid configuration in force and is reported; the first load must succeed.
 */
export class SharedConfiguration {
  #current?: SharedRegistry;
  #loadedAt = 0;
  #loading?: Promise<SharedRegistry>;

  constructor(
    private readonly load: () => Promise<SharedRegistry>,
    private readonly report: (event: string) => void = () => undefined,
    private readonly maxAgeMs = 5_000,
  ) {}

  static fixed(registry: SharedRegistry): SharedConfiguration {
    const configuration = new SharedConfiguration(async () => registry, () => undefined, Number.MAX_SAFE_INTEGER);
    configuration.#current = registry;
    configuration.#loadedAt = Date.now();
    return configuration;
  }

  async current(): Promise<SharedRegistry> {
    if (this.#current && Date.now() - this.#loadedAt < this.maxAgeMs) return this.#current;
    this.#loading ??= this.load().then((registry) => {
      this.#current = registry;
      this.#loadedAt = Date.now();
      return registry;
    }, (error: unknown) => {
      if (!this.#current) throw error;
      this.#loadedAt = Date.now();
      this.report("shared.configuration_reload_failed");
      return this.#current;
    }).finally(() => { this.#loading = undefined; });
    return this.#loading;
  }
}
