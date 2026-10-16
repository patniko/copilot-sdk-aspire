import { z } from "zod";
import { HarnessDefinition, HOSTING_MODES, SEMVER, SLUG } from "./harness.js";
import type { HostingFeature } from "./hosting.js";
import { PlacementKind } from "./placement.js";
import { ContainerSize } from "./profile.js";
import { SharedServerKey, SharedSessionView } from "./shared.js";

/** Harness hosting features session containers implement. A harness that needs others is unavailable there. */
export const SESSION_CONTAINER_FEATURES: readonly HostingFeature[] = [];

/**
 * Operator settings for resumable session containers. The controller resolves `image` to an immutable local image ID
 * before allocation. Sizes come from the effective policy's hosting size catalog, never from callers.
 */
export const SessionContainerSettings = z.object({
  image: z.string().min(1).max(300).default("copilot-session-container:local"),
  /** Stop a container whose session had no turn or connection activity for this long; its volume is retained. */
  idleSeconds: z.number().int().min(10).max(86_400).default(900),
  /** Hard backstop for one allocation; the session resumes from its volume on the next connection. */
  maxLifetimeSeconds: z.number().int().min(60).max(604_800).default(28_800),
  /** How long a new container may take to report its AHP listener ready. */
  startupSeconds: z.number().int().min(10).max(600).default(180),
  shutdownSeconds: z.number().int().min(1).max(60).default(25),
  heartbeatSeconds: z.number().int().min(2).max(60).default(5),
}).strict();
export type SessionContainerSettings = z.infer<typeof SessionContainerSettings>;

export const HarnessReference = z.object({ name: z.string().regex(SLUG), version: z.string().regex(SEMVER).optional() }).strict();
export type HarnessReference = z.infer<typeof HarnessReference>;

/** `POST /v1/sessions`. Without a harness the session uses the shared coordinator; with one, the harness's hosting mode decides. */
export const SessionCreation = z.object({
  harness: HarnessReference.optional(),
  label: z.string().trim().max(120).default(""),
}).strict();
export type SessionCreation = z.infer<typeof SessionCreation>;

/**
 * `dormant`: no container, volume retained. `starting`: allocated, listener not yet ready. `running`: attachable.
 * `stopping`: the container is being retired. `closed`: no further allocations.
 */
export const SessionContainerState = z.enum(["dormant", "starting", "running", "stopping", "closed"]);
export type SessionContainerState = z.infer<typeof SessionContainerState>;

export const SessionContainerStatus = z.object({
  state: SessionContainerState,
  size: z.string().regex(SLUG),
  cpus: ContainerSize.shape.cpus,
  memoryMiB: ContainerSize.shape.memoryMiB,
  idleSeconds: z.number().int().positive(),
  activations: z.number().int().nonnegative(),
}).strict();
export type SessionContainerStatus = z.infer<typeof SessionContainerStatus>;

const SessionHarness = z.object({ name: z.string().regex(SLUG), version: z.string().regex(SEMVER), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();

/** A period of one session with one harness snapshot at one placement. Promotion and handoff start a new segment. */
export const SessionSegment = z.object({
  generation: z.number().int().positive(),
  placement: PlacementKind,
  harness: SessionHarness.optional(),
  ahpSessionId: z.string().min(1).max(200),
  startedAt: z.iso.datetime(),
}).strict();
export type SessionSegment = z.infer<typeof SessionSegment>;

/** The placement-agnostic session view returned by `GET /v1/sessions` and `GET /v1/sessions/{id}`. */
export const SessionView = SharedSessionView.extend({
  placement: PlacementKind,
  mode: z.enum(HOSTING_MODES),
  harness: SessionHarness.optional(),
  segment: SessionSegment,
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
