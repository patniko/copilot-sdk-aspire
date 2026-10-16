import { createHmac, randomUUID } from "node:crypto";
import { ExecutionContainerSettings, SessionContainerSettings, SharedWorkerLimits, TERMINAL_STATES } from "@copilot-agent/contracts";
import {
  AllocationStore, DelegationStore, JobStore,
  type BoundVolume, type ControllerLease, type ExecutionAllocation, type JobAllocation, type SessionAllocation,
} from "@copilot-agent/job-store";
import type { Logger } from "@copilot-agent/service-defaults";
import { DockerExecutionAdapter, type ExecutionAdapter, type ObservedContainer } from "./docker.js";

export interface ControllerOptions {
  allocations: AllocationStore;
  jobs: JobStore;
  delegations: DelegationStore;
  settings: ExecutionContainerSettings;
  limits: SharedWorkerLimits;
  /** Resumable session containers. Omitted means session allocations are retired with an explanatory error. */
  sessions?: SessionContainerSettings;
  signingKey: string;
  dispatcherUrl: string;
  gatewayUrl: string;
  logger: Logger;
  /** Container platform; Docker on the local socket by default. */
  adapter?: (namespace: string, signal: AbortSignal) => ExecutionAdapter;
}

export class ExecutionController {
  readonly #lifetime = new AbortController();
  readonly #adapter: ExecutionAdapter;
  readonly #reportedVolumes = new Set<string>();
  #lease?: ControllerLease;
  #settings?: ExecutionContainerSettings;
  #sessionImage?: string;
  #heartbeat?: NodeJS.Timeout;
  #timer?: NodeJS.Timeout;
  #cycle?: Promise<void>;
  #renewing = false;
  #stopping = false;
  #healthy = false;

  constructor(private readonly options: ControllerOptions) {
    ExecutionContainerSettings.parse(options.settings);
    SharedWorkerLimits.parse(options.limits);
    if (options.sessions) options.sessions = SessionContainerSettings.parse(options.sessions);
    if (options.signingKey.length < 32) throw new Error("The allocation signing key must contain at least 32 characters.");
    this.#adapter = (options.adapter ?? ((namespace, signal) => new DockerExecutionAdapter(namespace, signal)))(options.settings.namespace, this.#lifetime.signal);
  }
  get healthy(): boolean { return this.#healthy && !this.#lifetime.signal.aborted && !this.#stopping; }
  private token(id: string): string { return createHmac("sha256", this.options.signingKey).update(`allocation:${id}`).digest("base64url"); }
  /** The credential the connection broker presents to a session container's ingress. */
  private ingressCredential(id: string): string { return createHmac("sha256", this.options.signingKey).update(`ingress:${id}`).digest("base64url"); }

  async start(): Promise<void> {
    const image = await this.#adapter.image(this.options.settings.image);
    this.#settings = { ...this.options.settings, image };
    if (this.options.sessions) this.#sessionImage = await this.#adapter.image(this.options.sessions.image);
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
    if (this.options.sessions) {
      // Volumes are retained data: unknown labeled volumes are reported for the operator, never deleted here.
      const recorded = await this.options.allocations.volumes(lease);
      for (const name of await this.#adapter.volumes()) {
        if (!recorded.has(name) && !this.#reportedVolumes.has(name)) {
          this.#reportedVolumes.add(name);
          this.options.logger.warn({ volume: name }, "found a namespace volume without a ledger record; retained for operator review");
        }
      }
    }
    for (const allocation of allocations) {
      if (this.#stopping) return;
      if (allocation.kind === "job") await this.reconcileJob(allocation);
      else await this.reconcileSession(allocation);
    }
    while (!this.#stopping) {
      const allocation = await this.options.allocations.reserve(lease, settings, this.options.limits, (id) => this.token(id));
      if (!allocation) break;
      await this.reconcileJob(allocation);
    }
    this.#healthy = true;
  }

  private async reconcileJob(allocation: JobAllocation): Promise<void> {
    const lease = this.#lease!;
    await this.options.allocations.assertLease(lease);
    let container = await this.#adapter.allocation(allocation);
    const current = await this.options.allocations.get(lease, allocation.id);
    if (!current || current.kind !== "job") return;
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

  /** Why a session allocation must retire now, if it must. */
  private retirement(allocation: SessionAllocation, container: ObservedContainer | undefined): string | undefined {
    const sessions = this.options.sessions;
    const now = Date.now();
    const stopped = container !== undefined && ["exited", "dead"].includes(container.status);
    if (allocation.state === "retiring") return "Retiring.";
    if (allocation.sessionClosed) return "The session was closed.";
    if (!sessions || !this.#sessionImage) return "Session containers are not enabled on this execution controller.";
    if (Date.parse(allocation.expiresAt) <= now) return "The allocation reached its maximum lifetime.";
    if (!allocation.readyAt) {
      if (stopped || (!container && allocation.state === "running")) {
        return `The session container stopped before becoming ready${container?.exitCode !== undefined ? ` (exit code ${container.exitCode})` : ""}.`;
      }
      if (Date.parse(allocation.startupUntil) <= now || (!container && allocation.startAttempts >= 3)) {
        return "The session container did not become ready before its startup limit.";
      }
      return undefined;
    }
    if (!container || stopped) return `The session container exited${stopped && container?.exitCode !== undefined ? ` (exit code ${container.exitCode})` : ""}.`;
    const heartbeat = Date.parse(allocation.heartbeatAt ?? allocation.readyAt);
    if (now - heartbeat > Math.max(3 * sessions.heartbeatSeconds, 15) * 1000) return "The session container stopped reporting.";
    if (now - Date.parse(allocation.activityAt ?? allocation.readyAt) >= allocation.idleSeconds * 1000) return "The session was idle.";
    return undefined;
  }

  private async reconcileSession(allocation: SessionAllocation): Promise<void> {
    const lease = this.#lease!;
    await this.options.allocations.assertLease(lease);
    const current = await this.options.allocations.get(lease, allocation.id);
    if (!current || current.kind !== "session") return;
    allocation = current;
    let container = await this.#adapter.allocation(allocation);
    const reason = this.retirement(allocation, container);
    if (reason) {
      await this.retireSession(allocation, container, reason);
      return;
    }
    if (!allocation.image) {
      allocation = await this.options.allocations.bind(lease, allocation.id, {
        ...this.#settings!, image: this.#sessionImage!,
        startupSeconds: this.options.sessions!.startupSeconds, shutdownSeconds: this.options.sessions!.shutdownSeconds,
      }, this.token(allocation.id), this.ingressCredential(allocation.id));
    }
    for (const volume of allocation.volumes as BoundVolume[]) {
      await this.#adapter.ensureVolume(volume, allocation);
      await this.options.allocations.volumeObserved(lease, volume.name);
    }
    if (!container) {
      await this.options.allocations.beforeStart(lease, allocation.id);
      await this.#adapter.createSession(allocation, { token: this.token(allocation.id), ingress: this.ingressCredential(allocation.id) },
        this.options.dispatcherUrl, this.options.gatewayUrl);
      container = await this.#adapter.allocation(allocation);
      if (!container) throw new Error("The created session container could not be observed.");
    }
    if (container.status === "created") {
      await this.options.allocations.assertLease(lease);
      await this.#adapter.start(container, allocation);
      container = await this.#adapter.allocation(allocation);
      if (!container) return;
    }
    if (container.status === "running") {
      await this.options.allocations.observed(lease, allocation.id, container.id, await this.#adapter.ingress(container));
    }
  }

  /** Stops a session container gracefully so its runtime can flush history, then removes it. Volumes are retained. */
  private async retireSession(allocation: SessionAllocation, container: ObservedContainer | undefined, reason: string): Promise<void> {
    const lease = this.#lease!;
    if (allocation.state !== "retiring") await this.options.allocations.retiring(lease, allocation.id, reason);
    if (container) {
      await this.#adapter.stop(container, allocation, this.options.sessions?.shutdownSeconds ?? 25);
      const remaining = await this.#adapter.allocation(allocation);
      if (remaining) await this.#adapter.remove(remaining, allocation);
    }
    await this.options.allocations.retired(lease, allocation.id);
    this.options.logger.info({ allocation: allocation.id, session: allocation.sessionId, reason }, "session allocation retired; volume retained");
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    await this.#cycle;
    const lease = this.#lease;
    try {
      if (lease && !this.#lifetime.signal.aborted) {
        const sessions: Promise<void>[] = [];
        for (const allocation of await this.options.allocations.active(lease)) {
          if (allocation.kind === "session") {
            sessions.push((async () => {
              await this.options.allocations.retiring(lease, allocation.id, "Local deployment is stopping.");
              await this.retireSession({ ...allocation, state: "retiring" }, await this.#adapter.allocation(allocation), "Local deployment is stopping.");
            })());
            continue;
          }
          if (!TERMINAL_STATES.has(allocation.jobState)) await this.options.jobs.requestCancel(allocation.principal, allocation.jobId);
          await this.options.allocations.retiring(lease, allocation.id, "Local deployment is stopping.");
          const container = await this.#adapter.allocation(allocation);
          if (container) await this.#adapter.remove(container, allocation);
          await this.options.allocations.retired(lease, allocation.id);
        }
        const failures = (await Promise.allSettled(sessions)).filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((failure) => (failure as PromiseRejectedResult).reason), "Session containers could not all be stopped.");
      }
    } finally {
      clearInterval(this.#heartbeat);
      if (lease) await this.options.allocations.release(lease);
    }
  }
}
