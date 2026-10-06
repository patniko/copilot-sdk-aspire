import { z } from "zod";
import { HostControlRequest } from "@copilot-agent/contracts";

export const OwnerConfiguration = z.object({
  transport: z.enum(["direct", "github", "both"]),
  owner: z.string().min(1),
  computeId: z.string().uuid(),
  connectionToken: z.string().min(32),
  githubToken: z.string().optional(),
  dataDirectory: z.string().min(1),
  gatewayUrl: z.string().url(),
  model: z.string().min(1),
  maxTurnSeconds: z.number().int().min(10).max(3600),
  port: z.number().int().min(1).max(65535),
}).strict();
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
