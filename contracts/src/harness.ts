import { z } from "zod";

export const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A JSON Schema document. Validated structurally by Ajv at load time, not by zod. */
export const JsonSchemaDocument = z.record(z.string(), z.unknown());
export type JsonSchemaDocument = z.infer<typeof JsonSchemaDocument>;

export const ToolRequest = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
    /** Where the implementation comes from. The harness requests; host bindings decide. */
    kind: z.enum(["host", "python", "mcp-local"]),
    description: z.string().min(1).max(1000),
    /** Reference to an implementation in the selected execution profile's toolchain. */
    binding: z.string().min(1).max(200),
  })
  .strict();
export type ToolRequest = z.infer<typeof ToolRequest>;

/**
 * Harness definition v1. A harness requests capabilities; it never grants them.
 * Effective capabilities are the intersection of the harness, caller authorization,
 * and operator execution policy.
 */
export const HarnessDefinition = z
  .object({
    schemaVersion: z.literal("1"),
    name: z.string().regex(SLUG),
    version: z.string().regex(SEMVER),
    description: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(100_000),
    model: z
      .object({
        preferred: z.string().min(1).max(200),
        allowed: z.array(z.string().min(1).max(200)).min(1),
      })
      .strict(),
    tools: z.array(ToolRequest).max(64),
    input: z.object({ schema: JsonSchemaDocument }).strict(),
    output: z.object({ schema: JsonSchemaDocument }).strict(),
    limits: z
      .object({
        maxDurationSeconds: z.number().int().min(10).max(3600),
        maxInferenceTokens: z.number().int().min(1000).max(5_000_000),
      })
      .strict(),
    retry: z
      .object({
        /** Only read-only workloads may be retried automatically after an uncertain outcome. */
        safeToRetry: z.boolean(),
        maxAttempts: z.number().int().min(1).max(5),
      })
      .strict(),
    runners: z
      .object({
        allowedProfiles: z.array(z.string().regex(SLUG)).min(1),
        defaultProfile: z.string().regex(SLUG),
      })
      .strict()
      .refine((r) => r.allowedProfiles.includes(r.defaultProfile), {
        message: "defaultProfile must be one of allowedProfiles",
      }),
  })
  .strict()
  .refine((h) => h.model.allowed.includes(h.model.preferred), {
    message: "model.preferred must be one of model.allowed",
    path: ["model", "preferred"],
  });
export type HarnessDefinition = z.infer<typeof HarnessDefinition>;

/** A published, immutable harness version with its content digest. */
export interface HarnessSnapshot {
  definition: HarnessDefinition;
  digest: string;
}
