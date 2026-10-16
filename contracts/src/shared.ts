import { z } from "zod";
import { SEMVER, SLUG } from "./harness.js";
import type { HostingFeature } from "./hosting.js";

/**
 * Harness hosting features the shared worker implements for harness-driven sessions. Hosting admission reports
 * `hosting_unavailable` for a shared-placement harness that requests a feature missing here.
 */
export const SHARED_WORKER_FEATURES: readonly HostingFeature[] = [];

export const SharedSessionLimits = z.object({
  tokenBudget: z.number().int().min(100).max(10_000_000).default(500_000),
  turnTokenBudget: z.number().int().min(100).max(1_000_000).default(20_000),
  maxTurnSeconds: z.number().int().min(1).max(3600).default(180),
  idleSeconds: z.number().int().min(1).max(86_400).default(300),
  maxJobs: z.number().int().min(0).max(100).default(16),
  maxParallelJobs: z.number().int().min(1).max(16).default(2),
  maxContinuations: z.number().int().min(0).max(100).default(16),
}).strict();
export type SharedSessionLimits = z.infer<typeof SharedSessionLimits>;

export const SharedWorkerLimits = z.object({
  residentSessions: z.number().int().min(1).max(100).default(16),
  activeTurns: z.number().int().min(1).max(32).default(2),
  activeTurnsPerPrincipal: z.number().int().min(1).max(16).default(2),
  queuedTurns: z.number().int().min(1).max(1000).default(32),
  queueWaitSeconds: z.number().int().min(1).max(600).default(60),
  retainedSessionsPerPrincipal: z.number().int().min(1).max(1000).default(100),
  executionContainers: z.number().int().min(0).max(32).default(2),
  containersPerPrincipal: z.number().int().min(1).max(16).default(2),
}).strict();
export type SharedWorkerLimits = z.infer<typeof SharedWorkerLimits>;

export const SharedSessionDefinition = z.object({
  model: z.string().min(1).max(200),
  instructions: z.string().min(1).max(32_000),
  allowedHarnesses: z.array(z.object({
    name: z.string().regex(SLUG), version: z.string().regex(SEMVER), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict()).max(32),
  limits: SharedSessionLimits,
}).strict();
export type SharedSessionDefinition = z.infer<typeof SharedSessionDefinition>;

export const SharedSessionCreation = z.object({ label: z.string().trim().max(120).default("") }).strict();
export const SharedSessionClosure = z.object({ cancelChildren: z.boolean().default(false) }).strict();
export const SharedPrincipalBindings = z.record(z.string().regex(/^[A-Za-z0-9._@-]{1,128}$/), z.number().int().positive().safe());

export const SharedServerKey = z.object({
  keyId: z.string().min(1).max(200),
  algorithm: z.enum(["x25519-sealedbox", "hpke-x25519-hkdf-sha256-aes256gcm"]),
  publicKey: z.string().min(1).max(1000),
}).strict();
export type SharedServerKey = z.infer<typeof SharedServerKey>;

export const SharedSessionView = z.object({
  id: z.string().uuid(), label: z.string(), model: z.string(),
  closed: z.boolean(), online: z.boolean(), createdAt: z.iso.datetime(), lastActivityAt: z.iso.datetime(),
  limits: SharedSessionLimits,
  budget: z.object({
    usedTokens: z.number().int().nonnegative(), reservedTokens: z.number().int().nonnegative(), remainingTokens: z.number().int().nonnegative(),
  }).strict(),
  jobs: z.number().int().nonnegative(), continuations: z.number().int().nonnegative(),
}).strict();
export type SharedSessionView = z.infer<typeof SharedSessionView>;

export const SharedConnection = z.object({
  sessionId: z.string().uuid(), destination: z.enum(["shared", "container"]),
  url: z.url().refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol)),
  token: z.string().min(32).max(200), expiresAt: z.iso.datetime(), serverKey: SharedServerKey,
  /** The runtime session to resume over AHP; the application session ID unless a handoff started a new segment. */
  ahpSessionId: z.string().min(1).max(200).optional(),
}).strict();
export type SharedConnection = z.infer<typeof SharedConnection>;
