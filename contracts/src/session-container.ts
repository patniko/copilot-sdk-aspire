import { z } from "zod";
import { HarnessDefinition } from "./harness.js";
import type { HostingFeature } from "./hosting.js";
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
}).strict();
export type SessionContainerSpec = z.infer<typeof SessionContainerSpec>;

export const SessionContainerReady = z.object({ serverKey: SharedServerKey }).strict();
export type SessionContainerReady = z.infer<typeof SessionContainerReady>;

/** `activity`: a turn ran, a client connected, or session events occurred since the previous heartbeat. */
export const SessionContainerHeartbeat = z.object({ activeTurn: z.boolean(), activity: z.boolean() }).strict();
export type SessionContainerHeartbeat = z.infer<typeof SessionContainerHeartbeat>;
export const SessionContainerHeartbeatResult = z.object({ stop: z.boolean() }).strict();
export type SessionContainerHeartbeatResult = z.infer<typeof SessionContainerHeartbeatResult>;
