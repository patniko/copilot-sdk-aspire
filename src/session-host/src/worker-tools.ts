import { createHash } from "node:crypto";
import { z } from "zod";
import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import {
  ArtifactPath, type HostingFeature, policyFor, WORKER_TOOLS, workerCeilings, WorkerCreation, WorkerMessageRequest,
  WorkerReference, type WorkerView,
} from "@copilot-agent/contracts";
import { StoreError, type SharedSessionRecord, type SharedTurn, type WorkerContainerOptions, type WorkerStore } from "@copilot-agent/job-store";
import { canonicalJson, HttpError, planWorker, sha256Hex, type WorkerRegistry } from "@copilot-agent/service-defaults";
import type { SharedActivationPlan } from "./admission.js";
import type { SharedActivationContext } from "./runtime.js";
import type { SharedTool } from "./tools.js";

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
const LIST_RESULT_PREVIEW = 1000;
const Worker = z.object({ worker: WorkerReference }).strict();
const Wait = z.object({ workers: z.array(WorkerReference).max(32).optional() }).strict();
const Answer = z.object({ requestId: z.string().uuid(), answer: z.string().min(1).max(8000) }).strict();
const ListFiles = z.object({ path: ArtifactPath.optional() }).strict();
const ReadFile = z.object({
  path: ArtifactPath, offset: z.number().int().min(0).max(1024 * 1024).default(0), length: z.number().int().min(1).max(READ_LIMIT).default(8192),
}).strict();
const WriteFile = z.object({ path: ArtifactPath, content: z.string().max(READ_LIMIT), ifMatch: z.string().max(200).optional() }).strict();
const pathOf = (args: unknown) => (args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : undefined);
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: "input" });

function parse<T>(value: z.ZodType<T>, input: unknown): T {
  const parsed = value.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid arguments${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : "."}`);
  }
  return parsed.data;
}

/** Policy and ledger refusals become tool failures the model can read and act on, never a halted turn. */
function refusal(error: unknown): Error {
  if (error instanceof HttpError) {
    const path = (error.details as { path?: unknown } | undefined)?.path;
    return new Error(`${error.message}${typeof path === "string" ? ` (argument: ${path})` : ""}`);
  }
  if (error instanceof StoreError) return new Error(error.message);
  return error instanceof Error ? error : new Error(String(error));
}

/** A worker as the coordinator's tools report it; `full` keeps the whole latest result. */
function summary(view: WorkerView, full = false): Record<string, unknown> {
  const result = view.result && !full && view.result.text.length > LIST_RESULT_PREVIEW
    ? { ...view.result, text: view.result.text.slice(0, LIST_RESULT_PREVIEW), truncated: true }
    : view.result;
  return {
    id: view.id, name: view.name, state: view.state, ...(view.stopReason ? { stopReason: view.stopReason } : {}),
    source: view.source, harness: `${view.harness.name}@${view.harness.version}`, ...(view.template ? { template: view.template } : {}),
    size: view.size, sharedVolume: view.sharedVolume, approvalMode: view.approvalMode,
    ...(result ? { result } : {}), ...(view.error ? { error: view.error } : {}),
    pendingMessages: view.pendingMessages, pendingInputs: view.pendingInputs, usage: view.usage, expiresAt: view.expiresAt,
  };
}

function preview(content: Buffer, offset: number, length: number): Record<string, unknown> {
  const part = content.subarray(offset, offset + length);
  let data: string;
  let encoding = "utf-8";
  try { data = new TextDecoder("utf-8", { fatal: true }).decode(part); }
  catch { data = part.toString("base64"); encoding = "base64"; }
  return { size: content.length, offset, data, encoding, truncated: offset + part.length < content.length };
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
    if (invocation.sessionId !== session.id || invocation.agentId) throw new Error("Only the coordinator's root agent can manage workers.");
  };
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) { throw refusal(error); }
  };
  const tool = (name: string, description: string, parameters: z.ZodType, handler: Tool["handler"], rule: SharedTool["rule"] = {}): SharedTool =>
    ({ rule, tool: { name, description, parameters: schema(parameters), handler } });
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
          if (!view) throw new Error("No worker with that name or id belongs to this conversation.");
          return summary(view, true);
        });
      }),
    tool(WORKER_TOOLS.list, "List this conversation's workers with their states and result previews.", z.object({}).strict(),
      async (_value, invocation) => {
        rootOnly(invocation);
        return run(async () => ({ workers: (await deps.workers.list(session.principal, session.id)).map((view) => summary(view)) }));
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
    tools.push(
      tool(WORKER_TOOLS.listFiles, "List a directory of this conversation's shared worker volume.", ListFiles,
        async (value, invocation) => {
          rootOnly(invocation);
          const args = parse(ListFiles, value);
          return run(async () => ({ entries: await files.list(session.id, args.path, signal()) }));
        }, { kind: "read", quietUnderAsk: true, target: pathOf }),
      tool(WORKER_TOOLS.readFile, "Read a bounded portion of a file in this conversation's shared worker volume (untrusted worker output).", ReadFile,
        async (value, invocation) => {
          rootOnly(invocation);
          const args = parse(ReadFile, value);
          return run(async () => {
            const content = await files.read(session.id, args.path, signal());
            return { ...preview(content, args.offset, args.length), etag: createHash("sha256").update(content).digest("base64url") };
          });
        }, { kind: "read", quietUnderAsk: true, target: pathOf }),
      tool(WORKER_TOOLS.writeFile,
        `Create a small UTF-8 file (up to ${READ_LIMIT / 1024} KiB) in the shared worker volume. Replacing a file requires its etag from read_shared_file. Workers may change files concurrently; give each worker its own directory.`,
        WriteFile,
        async (value, invocation) => {
          rootOnly(invocation);
          const args = parse(WriteFile, value);
          return run(async () => files.write(session.id, args.path, Buffer.from(args.content, "utf8"), args.ifMatch, signal()));
        }, { kind: "write", target: pathOf }),
    );
  }
  return tools;
}
