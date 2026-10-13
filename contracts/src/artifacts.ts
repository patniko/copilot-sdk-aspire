import { z } from "zod";

export const ARTIFACT_MAX_BYTES = 1024 * 1024;
export const ARTIFACT_MAX_FILES = 16;
export const ARTIFACT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const ArtifactPath = z.string().min(1).max(512).refine((path) => {
  const parts = path.split("/");
  return parts.length <= 8 && parts.every((part) =>
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(part) && !part.endsWith(".")
    && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}, "Use a portable relative artifact path without traversal, aliases, or device names.");
export const ArtifactData = z.object({
  path: ArtifactPath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  base64: z.string().max(Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4),
}).strict();
export type ArtifactData = z.infer<typeof ArtifactData>;
export const ArtifactManifest = z.object({
  id: z.string().uuid(), path: ArtifactPath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(ARTIFACT_MAX_BYTES),
}).strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifest>;

export const WorkspaceArtifacts = z.object({
  inputDirectory: z.literal("inputs"),
  outputDirectory: z.literal("outputs"),
  inputs: z.array(z.object({
    path: ArtifactPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(ARTIFACT_MAX_BYTES),
  }).strict()).max(ARTIFACT_MAX_FILES),
}).strict();
export type WorkspaceArtifacts = z.infer<typeof WorkspaceArtifacts>;

export const ExecutionContainerSettings = z.object({
  namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{7,47}$/),
  image: z.string().min(1).max(300),
  cpus: z.number().min(0.25).max(8).default(1),
  memoryMiB: z.number().int().min(256).max(16_384).default(1024),
  startupSeconds: z.number().int().min(10).max(600).default(120),
  shutdownSeconds: z.number().int().min(1).max(60).default(25),
}).strict();
export type ExecutionContainerSettings = z.infer<typeof ExecutionContainerSettings>;
