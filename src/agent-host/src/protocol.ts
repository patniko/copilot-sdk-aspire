import { z } from "zod";
import { HostControlRequest } from "@copilot-agent/contracts";

const OwnerBase = z.object({
  owner: z.string().min(1),
  ownerUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  computeId: z.string().uuid(),
  dataDirectory: z.string().min(1),
});
const ManagedOwner = OwnerBase.extend({
  execution: z.literal("managed"),
  transport: z.enum(["direct", "both"]),
  connectionToken: z.string().min(32),
  githubToken: z.string().optional(),
  runtimePath: z.string().min(1).optional(),
  runtimeProvider: z.string().min(1).optional(),
  gatewayUrl: z.string().url(),
  model: z.string().min(1),
  maxTurnSeconds: z.number().int().min(10).max(3600),
  port: z.number().int().min(1).max(65535),
}).strict().superRefine((config, ctx) => {
  if (Boolean(config.runtimePath) !== Boolean(config.runtimeProvider)) {
    ctx.addIssue({ code: "custom", message: "Provide both the runtime launcher and its matching native provider." });
  }
});
const NativeOwner = OwnerBase.extend({
  execution: z.literal("github-native"),
  transport: z.literal("github"),
  githubToken: z.string().min(20),
}).strict();
export const OwnerConfiguration = z.discriminatedUnion("execution", [ManagedOwner, NativeOwner]);
export type OwnerConfiguration = z.infer<typeof OwnerConfiguration>;

export const OwnerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("control"), id: z.string().uuid(), request: HostControlRequest }).strict(),
  z.object({ kind: z.literal("ready"), environmentId: z.string().max(200).optional() }).strict(),
  z.object({ kind: z.literal("failed"), message: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("diagnostic"), message: z.string().max(500) }).strict(),
]);
export const SupervisorMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), config: OwnerConfiguration }).strict(),
  z.object({ kind: z.literal("response"), id: z.string().uuid(), result: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({ kind: z.literal("close"), sessionIds: z.array(z.string().uuid()) }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);
