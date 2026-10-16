import { z } from "zod";
import { SessionContainerSpec, WorkerContainerSpec } from "@copilot-agent/contracts";

/** Start-up configuration for the unprivileged owner. It carries no allocation, signing, or provider credential. */
export const OwnerConfiguration = z.object({
  spec: SessionContainerSpec,
  /** The owner's private directory on the session volume. */
  dataDirectory: z.string().min(1),
  gatewayUrl: z.string().url(),
  /** Private token for the in-container AHP listener; only the supervisor's ingress presents it. */
  listenerToken: z.string().min(32).max(200),
  port: z.number().int().min(1).max(65_535),
  toolsRoot: z.string().min(1),
  pythonBin: z.string().min(1),
}).strict();
export type OwnerConfiguration = z.infer<typeof OwnerConfiguration>;

export const OwnerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("token"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("activity"), activeTurn: z.boolean() }).strict(),
  z.object({ kind: z.literal("failed"), message: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("diagnostic"), message: z.string().max(500) }).strict(),
]);
export type OwnerMessage = z.infer<typeof OwnerMessage>;

export const SupervisorMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), config: OwnerConfiguration }).strict(),
  z.object({ kind: z.literal("token"), id: z.string().uuid(), token: z.string().min(1).max(8192).optional(), error: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);
export type SupervisorMessage = z.infer<typeof SupervisorMessage>;

/** The in-container AHP listener port; it binds loopback only and is reached through the supervisor's ingress. */
export const OWNER_PORT = 8765;
/** The supervisor's ingress port, published by the controller on host loopback. */
export const INGRESS_PORT = 8080;
/** The unprivileged execution user that runs the agent loop and its tools. */
export const EXECUTION_UID = 10001;

/** Start-up configuration for a worker's unprivileged owner. It carries no allocation, signing, or provider credential. */
export const WorkerOwnerConfiguration = z.object({
  spec: WorkerContainerSpec,
  /** The owner's private directory on the worker's private volume. */
  dataDirectory: z.string().min(1),
  gatewayUrl: z.string().url(),
  toolsRoot: z.string().min(1),
  pythonBin: z.string().min(1),
}).strict();
export type WorkerOwnerConfiguration = z.infer<typeof WorkerOwnerConfiguration>;

/**
 * Worker routes the owner may ask its supervisor to call. The supervisor alone holds the allocation credential and
 * sends each call to the dispatcher's `/internal/workers/<operation>` route, which is bound to this container's worker.
 */
export const WORKER_OPERATIONS = [
  "control", "messages/delivered", "turns/started", "turns/finished", "input-requests", "input-requests/poll", "authority", "authority/applied",
] as const;
export type WorkerOperation = (typeof WORKER_OPERATIONS)[number];

export const WorkerOwnerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("token"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("activity"), activeTurn: z.boolean() }).strict(),
  z.object({ kind: z.literal("call"), id: z.string().uuid(), operation: z.enum(WORKER_OPERATIONS), body: z.unknown() }).strict(),
  z.object({ kind: z.literal("failed"), message: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("diagnostic"), message: z.string().max(500) }).strict(),
]);
export type WorkerOwnerMessage = z.infer<typeof WorkerOwnerMessage>;

export const WorkerSupervisorMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), config: WorkerOwnerConfiguration }).strict(),
  z.object({ kind: z.literal("token"), id: z.string().uuid(), token: z.string().min(1).max(8192).optional(), error: z.string().max(500).optional() }).strict(),
  /** A worker call's HTTP status and JSON body; status 0 when the dispatcher could not be reached. */
  z.object({ kind: z.literal("result"), id: z.string().uuid(), status: z.number().int().min(0).max(599), body: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);
export type WorkerSupervisorMessage = z.infer<typeof WorkerSupervisorMessage>;
