import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Tool } from "@github/copilot-sdk";
import {
  ArtifactPath, ARTIFACT_MAX_FILES, SHARED_TOOLS, type ArtifactData, type ExecutionProfile, type SharedHarnessRef,
  type SharedWorkerBinding, type ToolRequest,
} from "@copilot-agent/contracts";
import { DelegationStore, JobStore, StoreError, type SharedSessionRecord, type SharedTurn } from "@copilot-agent/job-store";
import { Admission, canonicalJson, sha256Hex } from "@copilot-agent/service-defaults";
import type { SharedActivationContext } from "./runtime.js";
import type { ToolRule } from "./permissions.js";
import { fileChunk, listPage, SHARED_TOOL_OUTPUT_BYTES, utf8Length, utf8Prefix } from "./tool-output.js";

/** An application tool and how the harness's permission rules apply to it. */
export interface SharedTool {
  tool: Tool;
  rule: ToolRule;
}

const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 2048;
const ReadFile = z.object({
  path: ArtifactPath, offset: z.number().int().min(0).max(1024 * 1024).default(0),
  length: z.number().int().min(1).max(32 * 1024).default(8192),
}).strict();
const WriteFile = z.object({ path: ArtifactPath, content: z.string().max(32 * 1024), ifMatch: z.string().max(200).optional() }).strict();
const EditFile = z.object({
  path: ArtifactPath, oldText: z.string().min(1).max(32 * 1024), newText: z.string().max(32 * 1024),
  replaceAll: z.boolean().default(false), ifMatch: z.string().max(200).optional(),
}).strict();
const ListFiles = z.object({ path: ArtifactPath.optional(), offset: z.number().int().min(0).max(100_000).default(0) }).strict();
const SearchFiles = z.object({
  query: z.string().min(1).max(200), path: ArtifactPath.optional(), caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(200).default(50),
}).strict();
const Task = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  title: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "in_progress", "done", "blocked"]),
  notes: z.string().max(1000).optional(),
}).strict();
const TaskList = z.object({ tasks: z.array(Task).max(50) }).strict();
const StoredTaskList = z.object({ tasks: z.array(Task.required({ id: true })), updatedAt: z.iso.datetime() }).strict();
/** A stored task list's largest JSON, so that reading it back always fits a tool result. */
const TASK_LIST_BYTES = 12 * 1024;
/** A delegated job's result is returned whole up to this size, and otherwise as a preview of the next. */
const JOB_RESULT_BYTES = 8 * 1024;
const JOB_RESULT_PREVIEW_BYTES = 4 * 1024;

/** Bounded, provider-backed access to one activation's workspace; never the host filesystem. */
class WorkspaceAccess {
  constructor(private readonly context: SharedActivationContext) {}

  uri(path?: string): string {
    return pathToFileURL(path ? join(this.context.workspace.anchor, ...path.split("/")) : this.context.workspace.anchor).href;
  }

  async resource(operation: Parameters<SharedActivationContext["workspace"]["onResource"]>[0]["operation"], params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.context.workspace.onResource({ hostId: "application-workspace", operation, params }, { signal: this.context.signal });
    if (result.kind !== "success") throw new Error(result.message ?? "The workspace operation failed.");
    return result.result ?? {};
  }

  async bytes(path: string): Promise<Buffer> {
    const value = z.object({ data: z.string(), encoding: z.literal("base64") }).parse(await this.resource("resourceRead", { uri: this.uri(path), encoding: "base64" }));
    return Buffer.from(value.data, "base64");
  }

  async write(path: string, data: Buffer, ifMatch?: string): Promise<Record<string, unknown>> {
    await this.resource("resourceMkdir", { uri: pathToFileURL(dirname(join(this.context.workspace.anchor, ...path.split("/")))).href });
    return this.resource("resourceWrite", {
      uri: this.uri(path), data: data.toString("base64"), encoding: "base64", createOnly: ifMatch === undefined, ...(ifMatch ? { ifMatch } : {}),
    });
  }

  async list(path?: string): Promise<Array<{ name: string; type: string }>> {
    const listed = z.object({ entries: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()) })
      .parse(await this.resource("resourceList", { uri: this.uri(path) }));
    return listed.entries.map(({ name, type }) => ({ name, type }));
  }
}

const etag = (content: Buffer) => createHash("sha256").update(content).digest("base64url");
const pathOf = (args: unknown) => (args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : undefined);

/** The `files` group in shared placement: application workspace tools over `sessionFs` (decision D3). */
export function workspaceTools(context: SharedActivationContext): SharedTool[] {
  const workspace = new WorkspaceAccess(context);
  const read = { kind: "read" as const, quietUnderAsk: true, target: pathOf };
  const write = { kind: "write" as const, target: pathOf };
  return [
    {
      rule: read,
      tool: {
        name: SHARED_TOOLS.readFile,
        description: "Read part of a file in this conversation's workspace, up to about 15 KiB per call; when more remains, call again with the returned nextOffset. Returns an etag for conflict-safe changes.",
        parameters: z.toJSONSchema(ReadFile),
        handler: async (value) => {
          const args = ReadFile.parse(value);
          const content = await workspace.bytes(args.path);
          return { ...fileChunk(content, args.offset, args.length, SHARED_TOOLS.readFile), etag: etag(content) };
        },
      },
    },
    {
      rule: write,
      tool: {
        name: SHARED_TOOLS.writeFile,
        description: "Create a small UTF-8 workspace file. Replacing an existing file requires its exact etag from read_workspace_file.",
        parameters: z.toJSONSchema(WriteFile),
        handler: async (value) => {
          const args = WriteFile.parse(value);
          return workspace.write(args.path, Buffer.from(args.content, "utf8"), args.ifMatch);
        },
      },
    },
    {
      rule: write,
      tool: {
        name: SHARED_TOOLS.editFile,
        description: "Replace exact text in a UTF-8 workspace file. oldText must occur exactly once unless replaceAll is true. Pass ifMatch to require an unchanged file.",
        parameters: z.toJSONSchema(EditFile),
        handler: async (value) => {
          const args = EditFile.parse(value);
          const before = await workspace.bytes(args.path);
          if (args.ifMatch !== undefined && etag(before) !== args.ifMatch) throw new Error("The workspace file changed; read it again.");
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(before); }
          catch { throw new Error("Only UTF-8 text files can be edited."); }
          const count = text.split(args.oldText).length - 1;
          if (count === 0) throw new Error("oldText was not found in the file.");
          if (count > 1 && !args.replaceAll) throw new Error(`oldText occurs ${count} times; make it unique or set replaceAll.`);
          const after = Buffer.from(args.replaceAll ? text.split(args.oldText).join(args.newText) : text.replace(args.oldText, () => args.newText), "utf8");
          await workspace.write(args.path, after, etag(before));
          return { replacements: args.replaceAll ? count : 1, etag: etag(after) };
        },
      },
    },
    {
      rule: read,
      tool: {
        name: SHARED_TOOLS.listFiles,
        description: "List a directory in this conversation's workspace, not the host filesystem. A long listing is returned in pages; continue with the returned nextOffset.",
        parameters: z.toJSONSchema(ListFiles),
        handler: async (value) => {
          const args = ListFiles.parse(value);
          return listPage(await workspace.list(args.path), args.offset, SHARED_TOOLS.listFiles);
        },
      },
    },
    {
      rule: read,
      tool: {
        name: SHARED_TOOLS.searchFiles,
        description: "Find workspace files whose path or UTF-8 text contains a literal query. Returns matching paths and lines.",
        parameters: z.toJSONSchema(SearchFiles),
        handler: async (value) => {
          const args = SearchFiles.parse(value);
          const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
          const contains = (text: string) => (args.caseSensitive ? text : text.toLowerCase()).includes(needle);
          const matches: Array<{ path: string; line?: number; text?: string }> = [];
          const pending = [args.path];
          const budget = SHARED_TOOL_OUTPUT_BYTES - 1024;
          let used = 0;
          let visited = 0;
          let stopped: string | undefined;
          // Keeps a match unless the result already holds maxResults matches or its size limit.
          const add = (match: (typeof matches)[number]) => {
            const cost = utf8Length(JSON.stringify(match)) + 1;
            if (matches.length >= args.maxResults) stopped = `Stopped at maxResults (${args.maxResults}); narrow the query or search a subdirectory to see others.`;
            else if (used + cost > budget) stopped = "Stopped at the result size limit; narrow the query or search a subdirectory to see others.";
            else {
              used += cost;
              matches.push(match);
            }
            return stopped === undefined;
          };
          while (pending.length && stopped === undefined) {
            const directory = pending.shift();
            for (const entry of await workspace.list(directory)) {
              const path = directory ? `${directory}/${entry.name}` : entry.name;
              if (++visited > MAX_SEARCH_FILES) { stopped = `Stopped after ${MAX_SEARCH_FILES} files; search a subdirectory to see others.`; break; }
              if (entry.type === "directory") { pending.push(path); continue; }
              if (contains(path) && !add({ path })) break;
              let content: Buffer;
              try { content = await workspace.bytes(path); }
              catch { continue; }
              if (content.length > MAX_SEARCH_FILE_BYTES || content.subarray(0, 1024).includes(0)) continue;
              const lines = content.toString("utf8").split(/\r?\n/);
              for (let index = 0; index < lines.length && stopped === undefined; index++) {
                if (contains(lines[index]!)) add({ path, line: index + 1, text: lines[index]!.slice(0, 300) });
              }
              if (stopped !== undefined) break;
              if (matches.length >= args.maxResults) { stopped = `Stopped at maxResults (${args.maxResults}); narrow the query or search a subdirectory to see others.`; break; }
            }
          }
          return { matches, truncated: stopped !== undefined, ...(stopped ? { note: stopped } : {}) };
        },
      },
    },
  ];
}

/** A task list the agent keeps in session storage, outside the user-visible workspace. Needs no permission. */
export function taskListTools(context: SharedActivationContext): SharedTool[] {
  const path = join(context.stateDirectory, "application-task-list.json");
  const load = async () => {
    if (!(await context.workspace.sessionFs.exists(path))) return { tasks: [], updatedAt: undefined };
    return StoredTaskList.parse(JSON.parse(await context.workspace.sessionFs.readFile(path)));
  };
  return [
    {
      rule: {},
      tool: {
        name: SHARED_TOOLS.getTasks,
        description: "Read this conversation's task list.",
        parameters: z.toJSONSchema(z.object({}).strict()),
        handler: async () => load(),
      },
    },
    {
      rule: {},
      tool: {
        name: SHARED_TOOLS.updateTasks,
        description: "Replace this conversation's task list (up to 50 tasks) to plan and track multi-step work. Statuses: pending, in_progress, done, blocked.",
        parameters: z.toJSONSchema(TaskList),
        handler: async (value) => {
          const args = TaskList.parse(value);
          const stored = StoredTaskList.parse({
            tasks: args.tasks.map((task, index) => ({ ...task, id: task.id ?? `task-${index + 1}` })),
            updatedAt: new Date().toISOString(),
          });
          if (new Set(stored.tasks.map((task) => task.id)).size !== stored.tasks.length) throw new Error("Task ids must be unique.");
          const json = JSON.stringify(stored);
          if (utf8Length(json) > TASK_LIST_BYTES) {
            return {
              resultType: "failure" as const,
              textResultForLlm: `The task list would take ${Math.ceil(utf8Length(json) / 1024)} KiB; keep it within ${TASK_LIST_BYTES / 1024} KiB by shortening notes or removing finished tasks. The previous list is unchanged.`,
            };
          }
          await context.workspace.sessionFs.writeFile(path, json);
          return stored;
        },
      },
    },
  ];
}

export interface DelegationDependencies {
  admission: () => Promise<Admission>;
  profiles: () => Promise<ReadonlyMap<string, ExecutionProfile>>;
  jobs: JobStore;
  delegations: DelegationStore;
  maxOpenJobs: number;
}

/**
 * The shared worker's in-process host bindings for one-shot container work: the harness names and describes each tool,
 * and the binding implements it. Children are limited to the batch harnesses captured at admission.
 */
export function delegationTools(
  requests: readonly ToolRequest[],
  session: SharedSessionRecord,
  targets: readonly SharedHarnessRef[],
  context: SharedActivationContext,
  currentTurn: () => SharedTurn,
  deps: DelegationDependencies,
): SharedTool[] {
  const workspace = new WorkspaceAccess(context);
  // The harness names its bindings, so notes refer to the artifact reader by the name it gave.
  const artifactReader = requests.find((request) => request.kind === "host" && request.binding === "shared:read-job-artifact")?.name;
  const related = async (jobId: string) => {
    if (!(await deps.delegations.list(session.principal, session.id)).some((job) => job.jobId === jobId)) {
      throw new StoreError("not_found", "The job does not belong to this conversation.");
    }
  };
  const JobId = z.object({ jobId: z.string().uuid() }).strict();
  const ReadArtifact = z.object({
    jobId: z.string().uuid(), artifactId: z.string().uuid(),
    offset: z.number().int().min(0).max(1024 * 1024).default(0), length: z.number().int().min(1).max(32 * 1024).default(8192),
  }).strict();
  const ImportArtifact = z.object({ jobId: z.string().uuid(), artifactId: z.string().uuid(), path: ArtifactPath, ifMatch: z.string().max(200).optional() }).strict();
  const Delegate = z.object({
    harness: z.string().min(1).max(63), input: z.unknown(), profile: z.string().max(63).optional(),
    files: z.array(ArtifactPath).max(ARTIFACT_MAX_FILES).default([]),
  }).strict();
  const bindings: Record<SharedWorkerBinding, (request: ToolRequest) => SharedTool> = {
    "shared:delegate-job": (request) => ({
      rule: {},
      tool: {
        name: request.name,
        description: `${request.description} Approved harnesses: ${targets.map((harness) => harness.name).join(", ") || "none"}.`,
        parameters: z.toJSONSchema(Delegate),
        handler: async (value, invocation) => {
          if (invocation.sessionId !== context.runtimeSessionId || invocation.agentId) throw new Error("Only the owning root agent can delegate.");
          const args = Delegate.parse(value);
          if (Buffer.byteLength(JSON.stringify(args), "utf8") > 256 * 1024) throw new Error("The delegation input exceeds 256 KiB.");
          const argumentsHash = sha256Hex(canonicalJson(args));
          const existing = await deps.delegations.find(context.lease, invocation.toolCallId, argumentsHash);
          if (existing) return { jobId: existing.id, state: existing.state, accepted: true };
          const selected = targets.find((harness) => harness.name === args.harness);
          if (!selected) throw new Error("The requested child harness is not approved.");
          const admitted = (await deps.admission()).admit({ harness: { name: selected.name, version: selected.version }, input: args.input, profile: args.profile }, "dedicated");
          if (!(await deps.profiles()).get(admitted.profile)?.capabilities.includes("workspace-artifacts")) {
            throw new Error("This execution profile does not support delegated workspace artifacts.");
          }
          const inputs: ArtifactData[] = [];
          for (const path of args.files) {
            const content = await workspace.bytes(path);
            inputs.push({ path, sha256: createHash("sha256").update(content).digest("hex"), base64: content.toString("base64") });
          }
          const job = await deps.delegations.admit(context.lease, currentTurn().id, invocation.toolCallId, argumentsHash,
            { principal: session.principal, ...admitted }, inputs, deps.maxOpenJobs);
          return { jobId: job.id, state: job.state, accepted: true, message: "The controller will allocate a container under the effective limits. Completion will arrive asynchronously." };
        },
      },
    }),
    "shared:get-job": (request) => ({
      rule: {},
      tool: {
        name: request.name, description: request.description, parameters: z.toJSONSchema(JobId),
        handler: async (value) => {
          const { jobId } = JobId.parse(value);
          await related(jobId);
          const job = await deps.jobs.getJob(session.principal, jobId);
          if (!job) throw new Error("The delegated job was not found.");
          const { result, error, ...rest } = job;
          const json = result === undefined ? undefined : JSON.stringify(result);
          const whole = json === undefined || utf8Length(json) <= JOB_RESULT_BYTES;
          return {
            ...rest,
            ...(json === undefined ? {} : whole ? { result } : {
              resultPreview: utf8Prefix(json, JOB_RESULT_PREVIEW_BYTES), resultTruncated: true,
              note: `The result is ${Math.ceil(utf8Length(json) / 1024)} KiB, so only its start is shown. Long output belongs in the job's outputs/ files${artifactReader ? `, which ${artifactReader} reads in parts` : ""}.`,
            }),
            ...(error ? { error: { ...error, message: utf8Prefix(error.message, 2048) } } : {}),
            artifacts: await deps.delegations.artifacts(session.principal, jobId),
          };
        },
      },
    }),
    "shared:read-job-artifact": (request) => ({
      rule: {},
      tool: {
        name: request.name, description: request.description, parameters: z.toJSONSchema(ReadArtifact),
        handler: async (value) => {
          const args = ReadArtifact.parse(value);
          await related(args.jobId);
          const file = await deps.delegations.artifact(session.principal, args.jobId, args.artifactId);
          if (!file) throw new Error("The artifact was not found.");
          return { path: file.path, sha256: file.sha256, ...fileChunk(file.content, args.offset, args.length, request.name) };
        },
      },
    }),
    "shared:import-job-artifact": (request) => ({
      rule: { kind: "write", target: pathOf },
      tool: {
        name: request.name, description: request.description, parameters: z.toJSONSchema(ImportArtifact),
        handler: async (value) => {
          const args = ImportArtifact.parse(value);
          await related(args.jobId);
          const file = await deps.delegations.artifact(session.principal, args.jobId, args.artifactId);
          if (!file) throw new Error("The artifact was not found.");
          return workspace.write(args.path, file.content, args.ifMatch);
        },
      },
    }),
  };
  return requests.flatMap((request) => {
    const binding = bindings[request.binding as SharedWorkerBinding];
    return request.kind === "host" && binding ? [binding(request)] : [];
  });
}

