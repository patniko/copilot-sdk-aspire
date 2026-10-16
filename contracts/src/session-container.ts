import { z } from "zod";
import { HarnessDefinition, SEMVER, SLUG } from "./harness.js";
import { PlacementKind } from "./placement.js";
import { SharedServerKey, SharedSessionView } from "./shared.js";

/**
 * Proposed per-harness hosting modes (docs/HOSTING-MODES-PLAN.md section 3). The stage-1 contract owns the harness
 * `hosting` block; until it lands, a harness without one is `isolated`, which keeps today's behavior and digest.
 */
export const HOSTING_MODES = ["isolated", "shared", "promotable", "orchestrator"] as const;
export type HostingMode = (typeof HOSTING_MODES)[number];

export function hostingModeOf(definition: HarnessDefinition): HostingMode | undefined {
  const hosting = (definition as { hosting?: { mode?: unknown } }).hosting;
  if (hosting?.mode === undefined) return "isolated";
  return (HOSTING_MODES as readonly unknown[]).includes(hosting.mode) ? hosting.mode as HostingMode : undefined;
}

/** Where a new session of this mode starts. Only `isolated` sessions start in a dedicated session container. */
export function initialPlacementFor(mode: HostingMode): PlacementKind {
  return mode === "isolated" ? "container" : "shared";
}

export const CONTAINER_SIZE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** One operator size. Bounds match the Docker CPU and memory limits in `ExecutionContainerSettings`. */
export const ContainerSize = z.object({
  cpus: z.number().min(0.25).max(8),
  memoryMiB: z.number().int().min(256).max(16_384),
}).strict();
export type ContainerSize = z.infer<typeof ContainerSize>;
export const DEFAULT_CONTAINER_SIZES: Record<string, ContainerSize> = {
  small: { cpus: 0.5, memoryMiB: 1024 },
  medium: { cpus: 1, memoryMiB: 2048 },
  large: { cpus: 2, memoryMiB: 4096 },
};
/** The operator size catalog. Callers and models choose a size by name only. */
export const ContainerSizeCatalog = z.record(z.string().regex(CONTAINER_SIZE_NAME), ContainerSize)
  .refine((sizes) => Object.keys(sizes).length >= 1 && Object.keys(sizes).length <= 16, "Define between 1 and 16 container sizes.");
export type ContainerSizeCatalog = z.infer<typeof ContainerSizeCatalog>;

/**
 * Operator settings for resumable session containers. The controller resolves `image` to an immutable local image ID
 * before allocation; the API applies sizes, idle time and lifetime when it requests an allocation.
 */
export const SessionContainerSettings = z.object({
  image: z.string().min(1).max(300).default("copilot-session-container:local"),
  sizes: ContainerSizeCatalog.default(DEFAULT_CONTAINER_SIZES),
  defaultSize: z.string().regex(CONTAINER_SIZE_NAME).default("small"),
  /** Stop a container whose session had no turn or connection activity for this long; its volume is retained. */
  idleSeconds: z.number().int().min(10).max(86_400).default(900),
  /** Hard backstop for one allocation; the session resumes from its volume on the next connection. */
  maxLifetimeSeconds: z.number().int().min(60).max(604_800).default(28_800),
  /** How long a new container may take to report its AHP listener ready. */
  startupSeconds: z.number().int().min(10).max(600).default(180),
  shutdownSeconds: z.number().int().min(1).max(60).default(25),
  heartbeatSeconds: z.number().int().min(2).max(60).default(5),
}).strict().superRefine((settings, ctx) => {
  if (!settings.sizes[settings.defaultSize]) ctx.addIssue({ code: "custom", path: ["defaultSize"], message: "The default size must be in the size catalog." });
});
export type SessionContainerSettings = z.infer<typeof SessionContainerSettings>;

export const HarnessReference = z.object({ name: z.string().regex(SLUG), version: z.string().regex(SEMVER).optional() }).strict();
export type HarnessReference = z.infer<typeof HarnessReference>;

/** `POST /v1/sessions`. Without a harness the session uses the shared coordinator; with one, the harness's hosting mode decides. */
export const SessionCreation = z.object({
  harness: HarnessReference.optional(),
  label: z.string().trim().max(120).default(""),
}).strict();
export type SessionCreation = z.infer<typeof SessionCreation>;

/** `dormant`: no container, volume retained. `starting`: allocated, AHP listener not yet ready. `running`: attachable. */
export const SessionContainerState = z.enum(["dormant", "starting", "running", "stopping", "closed"]);
export type SessionContainerState = z.infer<typeof SessionContainerState>;

export const SessionContainerStatus = z.object({
  state: SessionContainerState,
  size: z.string().regex(CONTAINER_SIZE_NAME),
  cpus: ContainerSize.shape.cpus,
  memoryMiB: ContainerSize.shape.memoryMiB,
  idleSeconds: z.number().int().positive(),
  activations: z.number().int().nonnegative(),
}).strict();
export type SessionContainerStatus = z.infer<typeof SessionContainerStatus>;

/** The placement-agnostic session view returned by `GET /v1/sessions` and `GET /v1/sessions/{id}`. */
export const SessionView = SharedSessionView.extend({
  placement: PlacementKind,
  mode: z.enum(HOSTING_MODES).optional(),
  harness: z.object({ name: z.string().regex(SLUG), version: z.string().regex(SEMVER), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional(),
  container: SessionContainerStatus.optional(),
}).strict();
export type SessionView = z.infer<typeof SessionView>;

// Internal protocol between a session container's supervisor and the dispatcher. Every route authenticates the
// container's allocation-scoped credential, which is bound to exactly one session.

/** What a session container runs: one admitted application session. */
export const SessionContainerSpec = z.object({
  sessionId: z.string().uuid(),
  allocationId: z.string().uuid(),
  githubUserId: z.number().int().positive().safe(),
  harness: z.object({ definition: HarnessDefinition, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  model: z.string().min(1).max(200),
  maxTurnSeconds: z.number().int().min(10).max(3600),
  heartbeatSeconds: z.number().int().min(2).max(60),
}).strict();
export type SessionContainerSpec = z.infer<typeof SessionContainerSpec>;

export const SessionContainerReady = z.object({ serverKey: SharedServerKey }).strict();
export type SessionContainerReady = z.infer<typeof SessionContainerReady>;

/** `activity`: a turn ran, a client connected, or session events occurred since the previous heartbeat. */
export const SessionContainerHeartbeat = z.object({ activeTurn: z.boolean(), activity: z.boolean() }).strict();
export type SessionContainerHeartbeat = z.infer<typeof SessionContainerHeartbeat>;
export const SessionContainerHeartbeatResult = z.object({ stop: z.boolean() }).strict();
export type SessionContainerHeartbeatResult = z.infer<typeof SessionContainerHeartbeatResult>;

export const SessionContainerTicket = z.object({ ticket: z.string().min(32).max(200) }).strict();
export type SessionContainerTicket = z.infer<typeof SessionContainerTicket>;
