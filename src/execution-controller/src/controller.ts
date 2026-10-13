import { createHmac, randomUUID } from "node:crypto";
import { ExecutionContainerSettings, SharedWorkerLimits, TERMINAL_STATES } from "@copilot-agent/contracts";
import { AllocationStore, DelegationStore, JobStore, type ControllerLease, type ExecutionAllocation } from "@copilot-agent/job-store";
import type { Logger } from "@copilot-agent/service-defaults";
import { DockerExecutionAdapter } from "./docker.js";

export interface ControllerOptions {
  allocations: AllocationStore;
  jobs: JobStore;
  delegations: DelegationStore;
  settings: ExecutionContainerSettings;
  limits: SharedWorkerLimits;
  signingKey: string;
  dispatcherUrl: string;
  gatewayUrl: string;
  logger: Logger;
}

export class ExecutionController {
  readonly #lifetime = new AbortController();
  readonly #adapter: DockerExecutionAdapter;
  #lease?: ControllerLease;
  #settings?: ExecutionContainerSettings;
  #heartbeat?: NodeJS.Timeout;
  #timer?: NodeJS.Timeout;
  #cycle?: Promise<void>;
  #renewing = false;
  #stopping = false;
  #healthy = false;

  constructor(private readonly options: ControllerOptions) {
    ExecutionContainerSettings.parse(options.settings);
    SharedWorkerLimits.parse(options.limits);
    if (options.signingKey.length < 32) throw new Error("The allocation signing key must contain at least 32 characters.");
    this.#adapter = new DockerExecutionAdapter(options.settings.namespace, this.#lifetime.signal);
  }
  get healthy(): boolean { return this.#healthy && !this.#lifetime.signal.aborted && !this.#stopping; }
  private token(id: string): string { return createHmac("sha256", this.options.signingKey).update(`allocation:${id}`).digest("base64url"); }

  async start(): Promise<void> {
    const image = await this.#adapter.image(this.options.settings.image);
    this.#settings = { ...this.options.settings, image };
    this.#lease = await this.options.allocations.acquire(this.#settings.namespace, randomUUID());
    this.#heartbeat = setInterval(() => {
      if (this.#renewing || this.#lifetime.signal.aborted || !this.#lease) return;
      this.#renewing = true;
      void this.options.allocations.heartbeat(this.#lease).catch(() => {
        this.#healthy = false;
        this.#lifetime.abort(new Error("Controller ownership was lost."));
        this.options.logger.error("Execution controller ownership was lost; provisioning stopped.");
      }).finally(() => { this.#renewing = false; });
    }, 5_000);
    await this.tick();
    this.#timer = setInterval(() => {
      if (this.#cycle || this.#stopping || this.#lifetime.signal.aborted) return;
      this.#cycle = this.tick().catch((error) => {
        this.#healthy = false;
        this.options.logger.error({ err: error }, "execution reconciliation failed");
      }).finally(() => { this.#cycle = undefined; });
    }, 1_000);
  }

  async tick(): Promise<void> {
    const lease = this.#lease;
    const settings = this.#settings;
    if (!lease || !settings || this.#stopping) return;
    await this.options.allocations.assertLease(lease);
    await this.options.delegations.reconcile();
    const allocations = await this.options.allocations.active(lease);
    const known = new Set(allocations.map((entry) => entry.id));
    for (const container of await this.#adapter.managed()) {
      if (!known.has(container.labels?.["copilot.hybrid.allocation"] ?? "")) {
        await this.options.allocations.assertLease(lease);
        await this.#adapter.remove(container);
        this.options.logger.warn({ container: container.id }, "removed an orphan execution container");
      }
    }
    for (const allocation of allocations) {
      if (this.#stopping) return;
      await this.reconcile(allocation);
    }
    while (!this.#stopping) {
      const allocation = await this.options.allocations.reserve(lease, settings, this.options.limits, (id) => this.token(id));
      if (!allocation) break;
      await this.reconcile(allocation);
    }
    this.#healthy = true;
  }

  private async reconcile(allocation: ExecutionAllocation): Promise<void> {
    const lease = this.#lease!;
    await this.options.allocations.assertLease(lease);
    let container = await this.#adapter.allocation(allocation);
    const current = await this.options.allocations.get(lease, allocation.id);
    if (!current) return;
    allocation = current;
    const terminal = TERMINAL_STATES.has(allocation.jobState);
    const attemptEnded = allocation.attemptId !== undefined && allocation.attemptState !== "running";
    const expired = Date.parse(allocation.expiresAt) <= Date.now();
    const startupFailed = !allocation.attemptId && (Date.parse(allocation.startupUntil) <= Date.now()
      || (!container && (allocation.startAttempts >= 3 || allocation.state === "running")) || (container && ["exited", "dead"].includes(container.status)));
    if (allocation.state === "retiring" || terminal || attemptEnded || expired || startupFailed
      || (allocation.attemptId && !container)) {
      await this.options.allocations.retiring(lease, allocation.id, terminal || attemptEnded ? "Attempt ended." : "Allocation expired or stopped.");
      if (container) await this.#adapter.remove(container, allocation);
      if (!allocation.attemptId && !terminal) {
        await this.options.allocations.failStartup(lease, allocation.id, this.options.jobs, "The approved execution container did not claim work before its startup limit.");
      }
      await this.options.allocations.retired(lease, allocation.id);
      this.options.logger.info({ allocation: allocation.id, job: allocation.jobId }, "execution allocation retired");
      return;
    }
    if (!container) {
      await this.options.allocations.beforeStart(lease, allocation.id);
      await this.#adapter.create(allocation, this.token(allocation.id), this.options.dispatcherUrl, this.options.gatewayUrl);
      container = await this.#adapter.allocation(allocation);
      if (!container) throw new Error("The created container could not be observed.");
    }
    if (container.status === "created") {
      await this.options.allocations.assertLease(lease);
      await this.#adapter.start(container, allocation);
      container = await this.#adapter.allocation(allocation);
      if (!container) return;
    }
    if (container.status === "running") {
      await this.options.allocations.observed(lease, allocation.id, container.id);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    await this.#cycle;
    const lease = this.#lease;
    try {
      if (lease && !this.#lifetime.signal.aborted) {
        for (const allocation of await this.options.allocations.active(lease)) {
          if (!TERMINAL_STATES.has(allocation.jobState)) await this.options.jobs.requestCancel(allocation.principal, allocation.jobId);
          await this.options.allocations.retiring(lease, allocation.id, "Local deployment is stopping.");
          const container = await this.#adapter.allocation(allocation);
          if (container) await this.#adapter.remove(container, allocation);
          await this.options.allocations.retired(lease, allocation.id);
        }
      }
    } finally {
      clearInterval(this.#heartbeat);
      if (lease) await this.options.allocations.release(lease);
    }
  }
}
