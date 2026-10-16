import { z } from "zod";
import { HarnessDefinition } from "./harness.js";
import type { HostingFeature } from "./hosting.js";
import { PromotionNotice, RuntimeSessionId } from "./promotion.js";
import { SharedServerKey } from "./shared.js";

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

// Internal protocol between a session container's supervisor and the dispatcher. Every route authenticates the
// container's allocation-scoped credential, which is bound to exactly one session.

/** What a session container runs: one admitted application session. */
export const SessionContainerSpec = z.object({
  sessionId: z.string().uuid(),
  allocationId: z.string().uuid(),
  githubUserId: z.number().int().positive().safe(),
  harness: z.object({ definition: HarnessDefinition, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  model: z.string().min(1).max(200),
  maxTurnSeconds: z.number().int().min(1).max(3600),
  heartbeatSeconds: z.number().int().min(2).max(60),
  /**
   * Present when the allocation was started to move a shared session here (a promotion or a handoff): restore this
   * snapshot onto the volume before starting the session. The volume is not authoritative until the cutover commit.
   */
  promotion: z.object({
    id: z.string().uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    /** The workspace path the conversation's history names: the shared worker's anchor, in its original spelling. */
    previousWorkspace: z.string().min(1).max(4096).optional(),
    /** The runtime session the container runs: resumed from the snapshot's history, or created fresh without it. */
    runtimeSessionId: RuntimeSessionId,
    /** Whether the snapshot carries the runtime history; without it the container creates `runtimeSessionId`. */
    history: z.boolean(),
    /** Sent once after the session starts, in place of the standard move continuation; its first line deduplicates. */
    notice: PromotionNotice.optional(),
  }).strict().optional(),
}).strict();
export type SessionContainerSpec = z.infer<typeof SessionContainerSpec>;

export const SessionContainerReady = z.object({ serverKey: SharedServerKey }).strict();
export type SessionContainerReady = z.infer<typeof SessionContainerReady>;
/** `promoted`: the readiness committed the promotion's cutover; the session's placement is now this container. */
export const SessionContainerReadyResult = z.object({ ready: z.literal(true), promoted: z.string().uuid().optional() }).strict();
export type SessionContainerReadyResult = z.infer<typeof SessionContainerReadyResult>;

/** `activity`: a turn ran, a client connected, or session events occurred since the previous heartbeat. */
export const SessionContainerHeartbeat = z.object({ activeTurn: z.boolean(), activity: z.boolean() }).strict();
export type SessionContainerHeartbeat = z.infer<typeof SessionContainerHeartbeat>;
export const SessionContainerHeartbeatResult = z.object({ stop: z.boolean() }).strict();
export type SessionContainerHeartbeatResult = z.infer<typeof SessionContainerHeartbeatResult>;
