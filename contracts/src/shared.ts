import { z } from "zod";
import { APPROVAL_MODES, HarnessDefinition, HOSTING_MODES, SEMVER, SLUG } from "./harness.js";
import type { HostingFeature } from "./hosting.js";
import { PlacementGeneration, PlacementKind } from "./placement.js";
import { HOSTING_TRANSPORTS } from "./profile.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Operator ceilings for one shared session. A harness narrows them: the session's token budget is the smallest of
 * these, the harness's `limits.maxInferenceTokens`, and its policy's `maxInferenceTokensPerJob`; the turn deadline
 * likewise uses `limits.maxDurationSeconds` and the policy's `maxDurationSeconds`.
 */
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

/** Per-harness ceilings on the shared worker; omitted fields use the worker's `*PerHarness` defaults. */
export const SharedHarnessLimits = z.object({
  residentSessions: z.number().int().min(1).max(100).optional(),
  activeTurns: z.number().int().min(1).max(32).optional(),
  queuedTurns: z.number().int().min(1).max(1000).optional(),
}).strict();
export type SharedHarnessLimits = z.infer<typeof SharedHarnessLimits>;

export const SharedWorkerLimits = z.object({
  residentSessions: z.number().int().min(1).max(100).default(16),
  activeTurns: z.number().int().min(1).max(32).default(2),
  activeTurnsPerPrincipal: z.number().int().min(1).max(16).default(2),
  queuedTurns: z.number().int().min(1).max(1000).default(32),
  queueWaitSeconds: z.number().int().min(1).max(600).default(60),
  retainedSessionsPerPrincipal: z.number().int().min(1).max(1000).default(100),
  executionContainers: z.number().int().min(0).max(32).default(2),
  containersPerPrincipal: z.number().int().min(1).max(16).default(2),
  /** Resident sessions of any one harness, so one harness cannot take every resident slot. */
  residentSessionsPerHarness: z.number().int().min(1).max(100).default(12),
  /** Running turns of any one harness, so one harness cannot hold every active turn. */
  activeTurnsPerHarness: z.number().int().min(1).max(32).default(1),
  /** Queued turns of any one harness, so one harness cannot fill the shared queue. */
  queuedTurnsPerHarness: z.number().int().min(1).max(1000).default(24),
  /** Overrides of the per-harness ceilings, by harness name. */
  harnesses: z.record(z.string().regex(SLUG), SharedHarnessLimits).default({}),
}).strict();
export type SharedWorkerLimits = z.infer<typeof SharedWorkerLimits>;

/** The effective ceilings for one harness: its override or the worker default, never above the worker-wide limit. */
export function sharedHarnessLimits(limits: SharedWorkerLimits, harness: string): Required<SharedHarnessLimits> {
  const override = Object.hasOwn(limits.harnesses, harness) ? limits.harnesses[harness] : undefined;
  return {
    residentSessions: Math.min(override?.residentSessions ?? limits.residentSessionsPerHarness, limits.residentSessions),
    activeTurns: Math.min(override?.activeTurns ?? limits.activeTurnsPerHarness, limits.activeTurns),
    queuedTurns: Math.min(override?.queuedTurns ?? limits.queuedTurnsPerHarness, limits.queuedTurns),
  };
}

/** A published harness version. */
export const SharedHarnessRef = z.object({
  name: z.string().regex(SLUG),
  version: z.string().regex(SEMVER),
  digest: z.string().regex(DIGEST),
}).strict();
export type SharedHarnessRef = z.infer<typeof SharedHarnessRef>;

/**
 * The harness a session was admitted with. A shared-placement session needs `definition`, the admitted snapshot it
 * keeps for its lifetime; a container-placement session may keep its snapshot with the container instead.
 */
export const SharedSessionHarness = z.object({
  name: z.string().regex(SLUG),
  version: z.string().regex(SEMVER),
  digest: z.string().regex(DIGEST),
  mode: z.enum(HOSTING_MODES),
  definition: HarnessDefinition.optional(),
  /** Digest of the harness's effective operator policy at admission, for provenance. */
  policyDigest: z.string().regex(DIGEST).optional(),
}).strict();
export type SharedSessionHarness = z.infer<typeof SharedSessionHarness>;

/**
 * What a session was admitted with, stored as `shared_sessions.definition`. `model` and `limits` are read by the
 * ledger for every placement. Sessions created before harness-driven hosting have `instructions` and
 * `allowedHarnesses` instead of `harness`; the shared worker no longer activates them.
 */
export const SharedSessionDefinition = z.object({
  /** The admitted model: the first of the harness's preferred and allowed models that its policy approves. */
  model: z.string().min(1).max(200),
  limits: SharedSessionLimits,
  harness: SharedSessionHarness.optional(),
  /** Published batch harnesses the session's `delegate_job` tool may run, captured at admission. */
  delegation: z.object({ harnesses: z.array(SharedHarnessRef).max(32) }).strict().optional(),
  /** Legacy: the AppHost-defined coordinator instructions. */
  instructions: z.string().min(1).max(32_000).optional(),
  /** Legacy: the AppHost-defined child harnesses. */
  allowedHarnesses: z.array(SharedHarnessRef).max(32).optional(),
}).strict();
export type SharedSessionDefinition = z.infer<typeof SharedSessionDefinition>;

/** Create a session for a published conversation harness. Omitting `version` admits the latest one. */
export const SharedSessionCreation = z.object({
  harness: z.string().regex(SLUG),
  version: z.string().regex(SEMVER).optional(),
  label: z.string().trim().max(120).default(""),
}).strict();
export type SharedSessionCreation = z.infer<typeof SharedSessionCreation>;
export const SharedSessionClosure = z.object({ cancelChildren: z.boolean().default(false) }).strict();
export const SharedPrincipalBindings = z.record(z.string().regex(/^[A-Za-z0-9._@-]{1,128}$/), z.number().int().positive().safe());

/** Request client connection material over one transport. Shared-runtime sessions support `direct` only. */
export const SharedConnectionRequest = z.object({ transport: z.enum(HOSTING_TRANSPORTS).default("direct") }).strict();
export type SharedConnectionRequest = z.infer<typeof SharedConnectionRequest>;

export const SharedServerKey = z.object({
  keyId: z.string().min(1).max(200),
  algorithm: z.enum(["x25519-sealedbox", "hpke-x25519-hkdf-sha256-aes256gcm"]),
  publicKey: z.string().min(1).max(1000),
}).strict();
export type SharedServerKey = z.infer<typeof SharedServerKey>;

/**
 * A period of one session with one harness snapshot at one placement. Promotion and handoff start a new segment;
 * its generation is the session's placement generation.
 */
export const SharedSessionSegment = z.object({
  generation: PlacementGeneration,
  placement: PlacementKind,
  harness: SharedHarnessRef.optional(),
  /** The runtime session a client attaches to (`copilot --resume`). */
  ahpSessionId: z.string().min(1).max(128),
  startedAt: z.iso.datetime(),
}).strict();
export type SharedSessionSegment = z.infer<typeof SharedSessionSegment>;

export const SharedSessionView = z.object({
  id: z.string().uuid(), label: z.string(), model: z.string(),
  closed: z.boolean(), online: z.boolean(), createdAt: z.iso.datetime(), lastActivityAt: z.iso.datetime(),
  /** The admitted harness; absent for sessions created before harness-driven hosting. */
  harness: SharedHarnessRef.optional(),
  mode: z.enum(HOSTING_MODES),
  placement: PlacementKind,
  segment: SharedSessionSegment,
  limits: SharedSessionLimits,
  budget: z.object({
    usedTokens: z.number().int().nonnegative(), reservedTokens: z.number().int().nonnegative(), remainingTokens: z.number().int().nonnegative(),
  }).strict(),
  jobs: z.number().int().nonnegative(), continuations: z.number().int().nonnegative(),
}).strict();
export type SharedSessionView = z.infer<typeof SharedSessionView>;

export const SharedConnection = z.object({
  sessionId: z.string().uuid(), destination: z.literal("shared"), transport: z.literal("direct"),
  /** The runtime session to resume after attaching; changes when a new segment starts. */
  ahpSessionId: z.string().min(1).max(128),
  url: z.url().refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol)),
  token: z.string().min(32).max(200), expiresAt: z.iso.datetime(), serverKey: SharedServerKey,
}).strict();
export type SharedConnection = z.infer<typeof SharedConnection>;

/**
 * Harness features the shared worker implements (docs/HOSTING-MODES-PLAN.md, section 3). The deployment's hosting
 * evaluation reports any other requested feature as `hosting_unavailable`.
 */
export const SHARED_WORKER_FEATURES = ["remote-mcp", "approval-modes", "custom-approval"] as const satisfies readonly HostingFeature[];

/** Client transports the shared worker offers. */
export const SHARED_WORKER_TRANSPORTS = ["direct"] as const;

/** Approval modes the runtime itself applies; `custom` is decided by the host's permission handler. */
export const RUNTIME_APPROVAL_MODES = ["manual", "assisted", "allow-all"] as const satisfies readonly (typeof APPROVAL_MODES)[number][];
export type RuntimeApprovalMode = (typeof RUNTIME_APPROVAL_MODES)[number];

/**
 * Model-facing names of the shared worker's application tools (docs/HOSTING-MODES-PLAN.md, section 7.2). The
 * `files` group maps to the workspace tools and `web` to `web_fetch`; the task list is part of every shared session.
 * Remote MCP tools are named `mcp_<server>_<tool>` in lowercase with other characters replaced by underscores; a name
 * that is ambiguous within the harness or longer than 64 characters becomes its first 53 characters, an underscore,
 * and 10 hexadecimal digits of a stable hash.
 */
export const SHARED_TOOLS = {
  readFile: "read_workspace_file",
  writeFile: "write_workspace_file",
  editFile: "edit_workspace_file",
  listFiles: "list_workspace_files",
  searchFiles: "search_workspace_files",
  webFetch: "web_fetch",
  getTasks: "get_task_list",
  updateTasks: "update_task_list",
} as const;

/**
 * In-process host bindings the shared worker implements. Batch runners cannot provide them, so batch admission
 * rejects them; a conversation profile must also list them in `inProcessBindings`.
 */
export const SHARED_WORKER_BINDINGS = [
  "shared:delegate-job",
  "shared:get-job",
  "shared:read-job-artifact",
  "shared:import-job-artifact",
] as const;
export type SharedWorkerBinding = (typeof SHARED_WORKER_BINDINGS)[number];
