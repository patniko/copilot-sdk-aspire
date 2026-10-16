import { z } from "zod";
import { HostControlRequest } from "@copilot-agent/contracts";

const OwnerBase = z.object({
  owner: z.string().min(1),
  ownerUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  computeId: z.string().uuid(),
  dataDirectory: z.string().min(1),
  harness: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
});
const ManagedOwner = OwnerBase.extend({
  execution: z.literal("managed"),
  /** `github` is a relay-only managed host: it registers its environment and opens no local listener. */
  transport: z.enum(["direct", "github", "both"]),
  connectionToken: z.string().min(32).optional(),
  githubToken: z.string().min(20).optional(),
  runtimePath: z.string().min(1).optional(),
  runtimeProvider: z.string().min(1).optional(),
  gatewayUrl: z.string().url(),
  model: z.string().min(1),
  maxTurnSeconds: z.number().int().min(10).max(3600),
  port: z.number().int().min(1).max(65535).optional(),
}).strict().superRefine((config, ctx) => {
  if (Boolean(config.runtimePath) !== Boolean(config.runtimeProvider)) {
    ctx.addIssue({ code: "custom", message: "Provide both the runtime launcher and its matching native provider." });
  }
  const direct = config.transport !== "github";
  if (direct !== Boolean(config.connectionToken) || direct !== Boolean(config.port)) {
    ctx.addIssue({ code: "custom", message: "Direct transports need the private listener token and port; a relay-only host opens no listener." });
  }
  if (config.transport !== "direct" && !config.githubToken) {
    ctx.addIssue({ code: "custom", message: "The GitHub relay needs the owner's credential." });
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
