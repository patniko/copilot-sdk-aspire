import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Tool } from "@github/copilot-sdk";
import { ArtifactPath, ARTIFACT_MAX_FILES, type ArtifactData, type ExecutionProfile } from "@copilot-agent/contracts";
import { DelegationStore, JobStore, StoreError, type SharedSessionRecord, type SharedTurn } from "@copilot-agent/job-store";
import { Admission, canonicalJson, sha256Hex } from "@copilot-agent/service-defaults";
import type { SharedActivationContext } from "./runtime.js";

const ReadFile = z.object({
  path: ArtifactPath, offset: z.number().int().min(0).max(1024 * 1024).default(0),
  length: z.number().int().min(1).max(32 * 1024).default(8192),
}).strict();
const WriteFile = z.object({ path: ArtifactPath, content: z.string().max(32 * 1024), ifMatch: z.string().max(200).optional() }).strict();
const JobId = z.object({ jobId: z.string().uuid() }).strict();
const ReadArtifact = z.object({
  jobId: z.string().uuid(), artifactId: z.string().uuid(),
  offset: z.number().int().min(0).max(1024 * 1024).default(0), length: z.number().int().min(1).max(32 * 1024).default(8192),
}).strict();
const ImportArtifact = z.object({ jobId: z.string().uuid(), artifactId: z.string().uuid(), path: ArtifactPath, ifMatch: z.string().max(200).optional() }).strict();

export function coordinatorTools(
  session: SharedSessionRecord,
  context: SharedActivationContext,
  currentTurn: () => SharedTurn,
  deps: { admission: Admission; profiles: Map<string, ExecutionProfile>; jobs: JobStore; delegations: DelegationStore; maxOpenJobs: number },
): Tool[] {
  const Delegate = z.object({
    harness: z.string().min(1).max(63), input: z.unknown(), profile: z.string().max(63).optional(),
    files: z.array(ArtifactPath).max(ARTIFACT_MAX_FILES).default([]),
  }).strict();
  const uri = (path: string) => pathToFileURL(join(context.workspace.anchor, ...path.split("/"))).href;
  const resource = async (operation: Parameters<typeof context.workspace.onResource>[0]["operation"], params: Record<string, unknown>) => {
    const result = await context.workspace.onResource({ hostId: "application-workspace", operation, params }, { signal: context.signal });
    if (result.kind !== "success") throw new Error(result.message ?? "The workspace operation failed.");
    return result.result;
  };
  const bytes = async (path: string): Promise<Buffer> => {
    const value = z.object({ data: z.string(), encoding: z.literal("base64") }).parse(await resource("resourceRead", { uri: uri(path), encoding: "base64" }));
    return Buffer.from(value.data, "base64");
  };
  const write = async (path: string, data: Buffer, ifMatch?: string) => {
    await resource("resourceMkdir", { uri: pathToFileURL(dirname(join(context.workspace.anchor, ...path.split("/")))).href });
    return resource("resourceWrite", { uri: uri(path), data: data.toString("base64"), encoding: "base64", createOnly: ifMatch === undefined,
      ...(ifMatch ? { ifMatch } : {}) });
  };
  const related = async (jobId: string) => {
    if (!(await deps.delegations.list(session.principal, session.id)).some((job) => job.jobId === jobId)) {
      throw new StoreError("not_found", "The job does not belong to this conversation.");
    }
  };
  return [
    {
      name: "delegate_job",
      description: `Queue durable container work and return immediately. Approved harnesses: ${session.definition.allowedHarnesses.map((h) => h.name).join(", ")}. Select optional workspace files to snapshot. Do not poll; completion is delivered to this conversation.`,
      parameters: z.toJSONSchema(Delegate),
      handler: async (value, invocation) => {
        if (invocation.sessionId !== session.id || invocation.agentId) throw new Error("Only the owning root coordinator can delegate.");
        const args = Delegate.parse(value);
        if (Buffer.byteLength(JSON.stringify(args), "utf8") > 256 * 1024) throw new Error("The delegation input exceeds 256 KiB.");
        const argumentsHash = sha256Hex(canonicalJson(args));
        const existing = await deps.delegations.find(context.lease, invocation.toolCallId, argumentsHash);
        if (existing) return { jobId: existing.id, state: existing.state, accepted: true };
        const selected = session.definition.allowedHarnesses.find((harness) => harness.name === args.harness);
        if (!selected) throw new Error("The requested child harness is not approved.");
        const admitted = deps.admission.admit({ harness: { name: selected.name, version: selected.version }, input: args.input, profile: args.profile }, "dedicated");
        if (!deps.profiles.get(admitted.profile)?.capabilities.includes("workspace-artifacts")) throw new Error("This execution profile does not support delegated workspace artifacts.");
        const inputs: ArtifactData[] = [];
        for (const path of args.files) {
          const content = await bytes(path);
          inputs.push({ path, sha256: createHash("sha256").update(content).digest("hex"), base64: content.toString("base64") });
        }
        const job = await deps.delegations.admit(context.lease, currentTurn().id, invocation.toolCallId, argumentsHash,
          { principal: session.principal, ...admitted }, inputs, deps.maxOpenJobs);
        return { jobId: job.id, state: job.state, accepted: true, message: "The controller will allocate a container under the effective limits. Completion will arrive asynchronously." };
      },
    },
    {
      name: "read_workspace_file", description: "Read a bounded portion of a file in this conversation's provider-backed workspace. Includes an etag for conflict-safe writes.",
      parameters: z.toJSONSchema(ReadFile),
      handler: async (value) => {
        const args = ReadFile.parse(value);
        const content = await bytes(args.path);
        return { ...preview(content, args.offset, args.length), etag: createHash("sha256").update(content).digest("base64url") };
      },
    },
    {
      name: "write_workspace_file", description: "Create a small UTF-8 workspace file. Replacing an existing file requires its exact etag from read_workspace_file.",
      parameters: z.toJSONSchema(WriteFile),
      handler: async (value) => {
        const args = WriteFile.parse(value);
        return write(args.path, Buffer.from(args.content, "utf8"), args.ifMatch);
      },
    },
    {
      name: "list_workspace_files", description: "List a provider-backed workspace directory, not the host filesystem.",
      parameters: z.toJSONSchema(z.object({ path: ArtifactPath.optional() }).strict()),
      handler: async (value) => {
        const args = z.object({ path: ArtifactPath.optional() }).strict().parse(value);
        return resource("resourceList", { uri: args.path ? uri(args.path) : pathToFileURL(context.workspace.anchor).href });
      },
    },
    {
      name: "get_job", description: "Read the status, bounded result, and retained artifact manifest of a job delegated by this conversation. Never loop-poll during a turn.",
      parameters: z.toJSONSchema(JobId),
      handler: async (value) => {
        const { jobId } = JobId.parse(value);
        await related(jobId);
        const job = await deps.jobs.getJob(session.principal, jobId);
        if (!job) throw new Error("The delegated job was not found.");
        const result = JSON.stringify(job.result);
        return { ...job, result: result && result.length <= 16_000 ? job.result : undefined,
          ...(result && result.length > 16_000 ? { resultPreview: result.slice(0, 4000), resultTruncated: true } : {}),
          artifacts: await deps.delegations.artifacts(session.principal, jobId) };
      },
    },
    {
      name: "read_job_artifact", description: "Read a bounded portion of a retained output artifact without requiring its container to remain alive.",
      parameters: z.toJSONSchema(ReadArtifact),
      handler: async (value) => {
        const args = ReadArtifact.parse(value);
        await related(args.jobId);
        const file = await deps.delegations.artifact(session.principal, args.jobId, args.artifactId);
        if (!file) throw new Error("The artifact was not found.");
        return { path: file.path, sha256: file.sha256, ...preview(file.content, args.offset, args.length) };
      },
    },
    {
      name: "import_job_artifact", description: "Explicitly import an output artifact into the conversation workspace. Existing files require an exact destination etag; files are never silently overwritten.",
      parameters: z.toJSONSchema(ImportArtifact),
      handler: async (value) => {
        const args = ImportArtifact.parse(value);
        await related(args.jobId);
        const file = await deps.delegations.artifact(session.principal, args.jobId, args.artifactId);
        if (!file) throw new Error("The artifact was not found.");
        return write(args.path, file.content, args.ifMatch);
      },
    },
  ];
}

function preview(content: Buffer, offset: number, length: number): { size: number; offset: number; data: string; encoding: string; truncated: boolean } {
  const part = content.subarray(offset, offset + length);
  let data: string;
  let encoding = "utf-8";
  try { data = new TextDecoder("utf-8", { fatal: true }).decode(part); }
  catch { data = part.toString("base64"); encoding = "base64"; }
  return { size: content.length, offset, data, encoding, truncated: offset + part.length < content.length };
}
