import { z } from "zod";
import { HarnessDefinition } from "./harness.js";

export const HostTransport = z.enum(["disabled", "direct", "github", "both"]);
export type HostTransport = z.infer<typeof HostTransport>;

export const DemoHostSettings = z.object({
  transport: HostTransport.default("disabled"),
  owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/).or(z.literal("")).default(""),
  harness: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).default("interactive-demo"),
  runtimeDirectory: z.string().max(300).refine((path) => path === "" ||
    (/^[A-Za-z0-9._/\\-]+$/.test(path) && path.split(/[/\\]/).every((part) => part !== "" && part !== "..")),
  "Use a relative build-context directory without parent traversal.").optional(),
}).strict().superRefine((settings, ctx) => {
  if (settings.transport !== "disabled" && !settings.owner) {
    ctx.addIssue({ code: "custom", path: ["owner"], message: "An expected GitHub owner is required." });
  }
});
export type DemoHostSettings = z.infer<typeof DemoHostSettings>;

export const HostLease = z.object({
  epoch: z.string().uuid(),
  computeId: z.string().uuid(),
  expiresAt: z.string().datetime(),
}).strict();
export type HostLease = z.infer<typeof HostLease>;

export const HostedSession = z.object({
  id: z.string().uuid(),
  harness: z.object({ definition: HarnessDefinition, digest: z.string() }).strict(),
  model: z.string(),
  tokenBudget: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  closed: z.boolean(),
}).strict();
export type HostedSession = z.infer<typeof HostedSession>;

export const HostControlRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("session"), sessionId: z.string().uuid(), resume: z.boolean() }).strict(),
  z.object({ operation: z.literal("token"), sessionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("close"), sessionId: z.string().uuid() }).strict(),
]);
export type HostControlRequest = z.infer<typeof HostControlRequest>;
