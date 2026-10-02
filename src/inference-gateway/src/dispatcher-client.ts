import type { CapabilityIntrospection, UsageReport } from "@copilot-agent/contracts";

/** Client for the dispatcher's capability endpoints, with a short revocation cache. */
export class DispatcherClient {
  readonly #cache = new Map<string, { value: CapabilityIntrospection; at: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly gatewayKey: string,
    private readonly cacheMs = 2_000,
  ) {}

  async introspect(jti: string): Promise<CapabilityIntrospection> {
    const cached = this.#cache.get(jti);
    if (cached && Date.now() - cached.at < this.cacheMs) {
      return cached.value;
    }
    const response = await fetch(`${this.baseUrl}/internal/capabilities/introspect`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": this.gatewayKey },
      body: JSON.stringify({ jti }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Capability introspection failed with ${response.status}.`);
    }
    const value = (await response.json()) as CapabilityIntrospection;
    this.#cache.set(jti, { value, at: Date.now() });
    if (this.#cache.size > 10_000) {
      this.#cache.clear();
    }
    return value;
  }

  invalidate(jti: string): void {
    this.#cache.delete(jti);
  }

  async reportUsage(report: UsageReport): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/internal/capabilities/usage`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-key": this.gatewayKey },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) {
          this.invalidate(report.jti);
          return;
        }
      } catch {
        // retried below
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error("Usage report could not be delivered.");
  }
}
