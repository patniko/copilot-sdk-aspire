import { createHash } from "node:crypto";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import {
  ArtifactPath, type HostingFeature, policyFor, WORKER_SHARED_MOUNT, WORKER_TOOLS, workerCeilings, WorkerCreation, WorkerMessageRequest,
  WorkerReference, type WorkerView,
} from "@copilot-agent/contracts";
import { StoreError, type SharedSessionRecord, type SharedTurn, type WorkerContainerOptions, type WorkerStore } from "@copilot-agent/job-store";
import { canonicalJson, HttpError, planWorker, sha256Hex, type WorkerRegistry } from "@copilot-agent/service-defaults";
import type { SharedActivationPlan } from "./admission.js";
import type { SharedActivationContext } from "./runtime.js";
import type { SharedTool } from "./tools.js";
import { fileChunk, listPage, utf8Length, utf8Prefix } from "./tool-output.js";

/** Bounded access to a coordinator session's shared worker volume through the controller-side file service (decision D10). */
export interface SharedFileService {
  list(sessionId: string, path: string | undefined, signal: AbortSignal): Promise<Array<{ name: string; type: "file" | "directory"; size?: number }>>;
  read(sessionId: string, path: string, signal: AbortSignal): Promise<Buffer>;
  /** Creates a file, or replaces one whose current SHA-256 (base64url) matches `ifMatch`. */
  write(sessionId: string, path: string, content: Buffer, ifMatch: string | undefined, signal: AbortSignal): Promise<{ size: number; etag: string }>;
}

export interface WorkerToolDependencies {
  workers: WorkerStore;
  /** The current published harnesses, profiles, and policies; worker creation rechecks them. */
  registry: () => Promise<WorkerRegistry>;
  /** Harness features the worker containers implement. */
  features: readonly HostingFeature[];
  /** The deployment-wide ceiling on workers holding capacity. */
  deploymentLimit: number;
  /** How workers' containers are allocated. */
  containers: WorkerContainerOptions;
  /** Required for coordinators that give their workers a shared volume. */
  files?: SharedFileService;
}

const READ_LIMIT = 32 * 1024;
/** A worker's result preview in listings, and the most of one result a tool returns, in bytes of UTF-8. */
const LIST_RESULT_PREVIEW = 1000;
const FULL_RESULT_BYTES = 12 * 1024;
const Worker = z.object({ worker: WorkerReference }).strict();
const Page = z.object({ offset: z.number().int().min(0).max(10_000).default(0) }).strict();
const Wait = z.object({ workers: z.array(WorkerReference).max(32).optional() }).strict();
const Answer = z.object({ requestId: z.string().uuid(), answer: z.string().min(1).max(8000) }).strict();

/**
 * A shared-volume path in the volume-relative form the file service takes. Workers see the volume at
 * WORKER_SHARED_MOUNT, so coordinators often name files as workers do (`/shared/plan.txt`): the mount prefix is removed,
 * and the rest must still be a portable relative path, so nothing outside the volume becomes reachable.
 */
export function sharedVolumePath(path: string): string {
  if (path === WORKER_SHARED_MOUNT) return "";
  return path.startsWith(`${WORKER_SHARED_MOUNT}/`) ? path.slice(WORKER_SHARED_MOUNT.length + 1) : path;
}
const SHARED_PATH_RULE = `Use a path inside the shared volume, relative to it (plan.txt) or as workers see it under ${WORKER_SHARED_MOUNT}/ `
  + `(${WORKER_SHARED_MOUNT}/plan.txt), without traversal, aliases, or device names.`;
/** A shared-file path argument, parsed to its volume-relative form; `root` also accepts the volume itself (""). */
const sharedPath = (description: string, root = false) => z.string().min(1)
  // The relative part keeps ArtifactPath's 512-character limit.
  .max(WORKER_SHARED_MOUNT.length + 1 + 512).describe(description)
  .transform(sharedVolumePath)
  .refine((path) => (root && path === "") || ArtifactPath.safeParse(path).success, SHARED_PATH_RULE);
const ListFiles = z.object({
  path: sharedPath(`A directory, such as reports or ${WORKER_SHARED_MOUNT}/reports. Omit it for the top level.`, true).optional(),
  offset: z.number().int().min(0).max(100_000).default(0),
}).strict();
const ReadFile = z.object({
  path: sharedPath(`A file, such as plan.txt or ${WORKER_SHARED_MOUNT}/plan.txt.`),
  // No maximum offset: each part's nextOffset must stay valid for files up to the shared file service's 4 MiB.
  offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(READ_LIMIT).default(8192),
}).strict();
const WriteFile = z.object({
  path: sharedPath(`The file to create or replace, such as plan.txt or ${WORKER_SHARED_MOUNT}/plan.txt.`),
  content: z.string().max(READ_LIMIT), ifMatch: z.string().max(200).optional(),
}).strict();
/** The volume-relative path a shared-file call targets, so custom permission handlers see the file the call touches. */
const sharedPathOf = (args: unknown) =>
  (args && typeof args === "object" && "path" in args && typeof args.path === "string" ? sharedVolumePath(args.path) : undefined);
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: "input" });

/** A refusal the coordinator's model should read and act on. */
class ToolRefusal extends Error {}

function parse<T>(value: z.ZodType<T>, input: unknown): T {
  const parsed = value.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ToolRefusal(`Invalid arguments${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : "."}`);
  }
  return parsed.data;
}

/**
 * Policy, ledger, and argument refusals become `failure` results the model reads and can act on. The runtime reports a
 * thrown error only as a generic failure, and `rejected` would halt the turn as if a person had stopped it.
 */
function refusal(error: unknown): ToolResultObject | undefined {
  let text: string | undefined;
  if (error instanceof HttpError) {
    const path = (error.details as { path?: unknown } | undefined)?.path;
    text = `${error.message}${typeof path === "string" ? ` (argument: ${path})` : ""}`;
  } else if (error instanceof StoreError || error instanceof ToolRefusal) {
    text = error.message;
  }
  return text === undefined ? undefined : { resultType: "failure", textResultForLlm: text };
}

/**
 * A worker as the coordinator's tools report it: a preview of its latest result, or with `full` as much of it as one tool
 * result holds. A longer result says that it was shortened.
 */
function summary(view: WorkerView, full = false): Record<string, unknown> {
  const limit = full ? FULL_RESULT_BYTES : LIST_RESULT_PREVIEW;
  const result = view.result && utf8Length(view.result.text) > limit
    ? {
        ...view.result, text: utf8Prefix(view.result.text, limit), truncated: true,
        ...(full ? { note: "The result is longer than shown. Ask the worker for a shorter summary, or to save the details in a file." } : {}),
      }
    : view.result;
  return {
    id: view.id, name: view.name, state: view.state, ...(view.stopReason ? { stopReason: view.stopReason } : {}),
    source: view.source, harness: `${view.harness.name}@${view.harness.version}`, ...(view.template ? { template: view.template } : {}),
    size: view.size, sharedVolume: view.sharedVolume, approvalMode: view.approvalMode,
    ...(result ? { result } : {}), ...(view.error ? { error: view.error } : {}),
    pendingMessages: view.pendingMessages, pendingInputs: view.pendingInputs, usage: view.usage, expiresAt: view.expiresAt,
  };
}


/**
 * An orchestrator coordinator's worker tools (docs/HOSTING-MODES-PLAN.md, section 7.4). Only the coordinator's root agent
 * can use them. Creation rechecks the coordinator's current effective policy and returns immediately; workers report
 * back through the coordinator's inbox, so no tool waits inside a turn. Tool arguments are data: a task or message never
 * carries the person's authority, and a coordinator never decides a worker's permission requests.
 */
export function workerTools(
  plan: SharedActivationPlan,
  session: SharedSessionRecord,
  context: SharedActivationContext,
  currentTurn: () => SharedTurn,
  deps: WorkerToolDependencies,
): SharedTool[] {
  const ceilings = workerCeilings(plan.definition, plan.policy);
  if (!ceilings) return [];
  const lease = context.lease;
  const rootOnly = (invocation: ToolInvocation) => {
    if (invocation.sessionId !== context.runtimeSessionId || invocation.agentId) throw new ToolRefusal("Only the coordinator's root agent can manage workers.");
  };
  const run = async <T>(action: () => Promise<T>): Promise<T> => action();
  const tool = (name: string, description: string, parameters: z.ZodType, handler: NonNullable<Tool["handler"]>, rule: SharedTool["rule"] = {}): SharedTool => ({
    rule,
    tool: {
      name, description, parameters: schema(parameters),
      handler: async (args, invocation) => {
        try { return await handler(args, invocation); }
        catch (error) {
          const failure = refusal(error);
          if (failure) return failure;
          throw error;
        }
      },
    },
  });
  /**
   * Inherited authority comes only from the person's recorded messages in this conversation's runtime history, never
   * from tool arguments, and is recorded for the worker before its first task can rely on it.
   */
  const grant = async (view: WorkerView) => {
    if (view.inheritsHumanAuthority && view.state !== "stopped") await deps.workers.grantAuthority(lease, view.id, await context.humanMessages());
  };

  const tools: SharedTool[] = [
    tool(WORKER_TOOLS.create,
      `Start a worker: its own agent session in a container, from a listed worker harness (${ceilings.harnesses.join(", ") || "none"})`
      + `${ceilings.crafting ? ` or crafted within the '${ceilings.crafting.template}' template` : ""}, with a size (${ceilings.sizes.map((size) => size.name).join(", ")})`
      + `${ceilings.sharedStorage === "session" ? ", shared-volume access," : ""} and a first task. Returns at once; the worker reports back to this`
      + " conversation when it finishes, needs input, or stops. Do not poll.",
      WorkerCreation,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(WorkerCreation, value);
        const argumentsHash = sha256Hex(canonicalJson(args));
        return run(async () => {
          const existing = await deps.workers.find(lease, invocation.toolCallId, argumentsHash);
          if (existing) {
            await grant(existing);
            return { accepted: true, worker: summary(existing), message: "This tool call already started the worker." };
          }
          const registry = await deps.registry();
          const { capacity, ...planned } = planWorker(registry,
            { definition: plan.definition, policy: policyFor(registry.policies, plan.harness.name) }, args, { features: deps.features });
          const admitted = await deps.workers.admit(lease, currentTurn().id, { ...planned, operationKey: invocation.toolCallId, argumentsHash },
            { ...capacity, deployment: deps.deploymentLimit }, deps.containers);
          await grant(admitted.view);
          return {
            accepted: true, worker: summary(admitted.view),
            message: "The worker starts in its own container and reports back to this conversation. End your turn or continue with other work; do not poll.",
          };
        });
      }),
    tool(WORKER_TOOLS.send,
      "Send a worker a durable message. 'immediate' steers it at its next turn boundary; 'enqueue' (default) waits until its current work is done.",
      WorkerMessageRequest,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(WorkerMessageRequest, value);
        return run(async () => {
          // The worker reads its authority before the message that may rely on it.
          if (ceilings.inheritHumanAuthority) await deps.workers.refreshAuthority(lease, await context.humanMessages());
          const sent = await deps.workers.send(lease, invocation.toolCallId, sha256Hex(canonicalJson(args)), args.worker, args.message, args.delivery);
          return { accepted: true, worker: sent.worker.name, seq: sent.message.seq, delivery: sent.message.delivery, state: sent.worker.state };
        });
      }),
    tool(WORKER_TOOLS.get, "Read one worker's state, latest result (untrusted worker output), usage, and container time.", Worker,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(Worker, value);
        return run(async () => {
          const view = await deps.workers.get(session.principal, session.id, args.worker);
          if (!view) throw new ToolRefusal("No worker with that name or id belongs to this conversation.");
          return summary(view, true);
        });
      }),
    tool(WORKER_TOOLS.list, "List this conversation's workers with their states and result previews. A long list is returned in pages; continue with the returned nextOffset.", Page,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(Page, value);
        return run(async () => {
          const { entries, ...page } = listPage((await deps.workers.list(session.principal, session.id)).map((view) => summary(view)), args.offset, WORKER_TOOLS.list);
          return { workers: entries, ...page };
        });
      }),
    tool(WORKER_TOOLS.interrupt, "Abort a worker's current turn. The worker stays available for new messages.", Worker,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(Worker, value);
        return run(async () => {
          const result = await deps.workers.interrupt(lease, args.worker);
          return { interrupted: result.interrupted, worker: result.worker.name, state: result.worker.state };
        });
      }),
    tool(WORKER_TOOLS.archive, "Stop a worker and release its capacity. Its volumes are kept; a stopped worker cannot be resumed.", Worker,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(Worker, value);
        return run(async () => {
          const view = await deps.workers.archive(lease, args.worker);
          return { archived: true, worker: view.name, state: view.state, capacityReleased: view.capacityReleased };
        });
      }),
    tool(WORKER_TOOLS.wait,
      "End this turn to wait for workers. Their completions, failures, and input requests arrive as a new message; nothing is lost.",
      Wait,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(Wait, value);
        return run(async () => {
          const views = await deps.workers.list(session.principal, session.id);
          const selected = args.workers?.length
            ? views.filter((view) => args.workers!.includes(view.name) || args.workers!.includes(view.id))
            : views.filter((view) => view.state !== "stopped");
          return {
            waiting: selected.map((view) => ({ name: view.name, state: view.state })),
            instruction: "End your turn now without calling more tools. Worker updates will arrive as a new message.",
          };
        });
      }),
  ];
  if (ceilings.coordinatorAnswers) {
    tools.push(tool(WORKER_TOOLS.answer,
      "Answer a worker's question when the person's instructions already settle it. You cannot decide permission requests; only a person can.",
      Answer,
      async (value, invocation) => {
        rootOnly(invocation);
        const args = parse(Answer, value);
        return run(async () => {
          const answered = await deps.workers.answerAsCoordinator(lease, args.requestId, args.answer);
          return { answered: true, worker: answered.worker, state: answered.state };
        });
      }));
  }
  if (ceilings.sharedStorage === "session") {
    const files = deps.files;
    if (!files) throw new Error("Shared worker storage needs the controller's shared file service.");
    const signal = () => context.signal;
    // The file service's refusals (missing files, conflicts, limits) are for the model to act on.
    const shared = <T>(operation: Promise<T>): Promise<T> => operation.catch((error: unknown) => {
      throw new ToolRefusal(error instanceof Error ? error.message : "The shared file service failed.");
    });
    tools.push(
      tool(WORKER_TOOLS.listFiles,
        `List a directory of this conversation's shared worker volume, which workers see at ${WORKER_SHARED_MOUNT}. Give the path relative to `
          + `the volume (reports) or as workers see it (${WORKER_SHARED_MOUNT}/reports); omit it for the top level. A long listing is `
          + "returned in pages; continue with the returned nextOffset.",
        ListFiles,
        async (value, invocation) => {
          rootOnly(invocation);
          const args = parse(ListFiles, value);
          return run(async () => listPage(await shared(files.list(session.id, args.path || undefined, signal())), args.offset, WORKER_TOOLS.listFiles));
        }, { kind: "read", quietUnderAsk: true, target: sharedPathOf }),
      tool(WORKER_TOOLS.readFile,
        `Read part of a file in this conversation's shared worker volume (untrusted worker output), up to about 15 KiB per call; when more `
          + `remains, call again with the returned nextOffset. Workers see the volume at ${WORKER_SHARED_MOUNT}; give the path relative to it `
          + `(plan.txt) or as workers see it (${WORKER_SHARED_MOUNT}/plan.txt).`,
        ReadFile,
        async (value, invocation) => {
          rootOnly(invocation);
          const args = parse(ReadFile, value);
          return run(async () => {
            const content = await shared(files.read(session.id, args.path, signal()));
            return { ...fileChunk(content, args.offset, args.length, WORKER_TOOLS.readFile), etag: createHash("sha256").update(content).digest("base64url") };
          });
        }, { kind: "read", quietUnderAsk: true, target: sharedPathOf }),
      tool(WORKER_TOOLS.writeFile,
        `Create a small UTF-8 file (up to ${READ_LIMIT / 1024} KiB) in the shared worker volume, which workers see at ${WORKER_SHARED_MOUNT}; give `
          + `the path relative to it (plan.txt) or as workers see it (${WORKER_SHARED_MOUNT}/plan.txt). Replacing a file requires its etag from `
          + "read_shared_file. Workers may change files concurrently; give each worker its own directory.",
        WriteFile,
        async (value, invocation) => {
          rootOnly(invocation);
          const args = parse(WriteFile, value);
          return run(async () => shared(files.write(session.id, args.path, Buffer.from(args.content, "utf8"), args.ifMatch, signal())));
        }, { kind: "write", target: sharedPathOf }),
    );
  }
  return tools;
}
