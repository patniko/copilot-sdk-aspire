import { sharedHarnessLimits, type SharedWorkerLimits } from "@copilot-agent/contracts";
import { StoreError } from "@copilot-agent/job-store";

/** A resident session the worker could evict to make room for another activation. */
export interface ResidencyCandidate {
  id: string;
  harness: string;
  lastActivity: number;
  /** Not running a turn and not already closing. */
  idle: boolean;
}

/**
 * The least recently active idle resident to evict so session `id` of `harness` fits, or undefined when it fits now.
 * `reservations` maps every opening or resident session to its harness. At the harness's own ceiling only a resident of
 * the same harness can make room, so a busy harness never displaces another harness's sessions; when the worker as a
 * whole is full, any idle resident can. Throws `quota_exceeded` when nothing can be evicted.
 */
export function residencyVictim(
  limits: SharedWorkerLimits,
  reservations: ReadonlyMap<string, string>,
  residents: readonly ResidencyCandidate[],
  id: string,
  harness: string,
): string | undefined {
  const oldest = (predicate: (entry: ResidencyCandidate) => boolean) => residents
    .filter((entry) => entry.id !== id && entry.idle && predicate(entry))
    .sort((a, b) => a.lastActivity - b.lastActivity)[0]?.id;
  const reserved = [...reservations.entries()].filter(([entry]) => entry !== id);
  if (reserved.filter(([, name]) => name === harness).length >= sharedHarnessLimits(limits, harness).residentSessions) {
    const victim = oldest((entry) => entry.harness === harness);
    if (!victim) throw new StoreError("quota_exceeded", "The shared worker is at resident capacity for this harness.");
    return victim;
  }
  if (reserved.length >= limits.residentSessions) {
    const victim = oldest(() => true);
    if (!victim) throw new StoreError("quota_exceeded", "The shared worker is at resident capacity.");
    return victim;
  }
  return undefined;
}
