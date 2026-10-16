import { z } from "zod";
import {
  APPROVAL_MODES,
  BUILTIN_TOOL_GROUPS,
  HarnessDefinition,
  hostingModeOf,
  SLUG,
  TOOL_NAME,
  type ToolRequest,
} from "./harness.js";
import { CONVERSATION_PROFILE } from "./hosting.js";
import { InputRequestState } from "./jobs.js";
import {
  ContainerSize,
  type CraftingTemplate,
  effectiveHarnessHosting,
  effectiveHostingPolicy,
  type ExecutionPolicy,
  type PolicyViolation,
} from "./profile.js";
import { InputRequestBody, InputResponseBody } from "./runner-protocol.js";
import { SHARED_WORKER_BINDINGS } from "./shared.js";

/** Lifecycle states of an orchestrator worker (docs/HOSTING-MODES-PLAN.md, section 7.4). */
export const WORKER_STATES = ["starting", "working", "idle", "needs_input", "stopped"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/**
 * Why a worker stopped: its coordinator archived it, a backstop stopped it (idle time, lifetime, or its share of the
 * aggregate token budget), its coordinator session closed, or it failed.
 */
export const WORKER_STOP_REASONS = ["archived", "idle_timeout", "max_lifetime", "budget_exhausted", "coordinator_closed", "failed"] as const;
export type WorkerStopReason = (typeof WORKER_STOP_REASONS)[number];
export type WorkerBackstopReason = Extract<WorkerStopReason, "idle_timeout" | "max_lifetime" | "budget_exhausted">;

/** A worker runs a listed worker harness or a definition its coordinator crafted from an operator template. */
export const WORKER_SOURCES = ["listed", "crafted"] as const;
export type WorkerSource = (typeof WORKER_SOURCES)[number];

/** How a worker mounts its coordinator session's shared volume. */
export const WORKER_SHARED_ACCESS = ["none", "read-write", "read-only"] as const;
export type WorkerSharedAccess = (typeof WORKER_SHARED_ACCESS)[number];

/** `immediate` steers the worker at its next turn boundary; `enqueue` waits until its current work finishes. */
export const WORKER_DELIVERIES = ["immediate", "enqueue"] as const;
export type WorkerDelivery = (typeof WORKER_DELIVERIES)[number];

/**
 * Worker events delivered to the coordinator's durable inbox:
 * - completed: a turn finished with a result.
 * - idle: a turn ended without a result, for example after an interrupt.
 * - needs_input: the worker waits for a person's approval or answer.
 * - failed: the worker failed and stopped.
 * - stopped: a backstop stopped the worker (idle time, lifetime, or budget).
 * Archiving a worker or closing the coordinator session reports nothing.
 */
export const WORKER_EVENT_KINDS = ["completed", "idle", "needs_input", "failed", "stopped"] as const;
export type WorkerEventKind = (typeof WORKER_EVENT_KINDS)[number];

/** Who answered a worker's input request. Only questions can be answered by the coordinator, and only when policy allows. */
export const WORKER_ANSWERERS = ["principal", "coordinator"] as const;
export type WorkerAnswerer = (typeof WORKER_ANSWERERS)[number];

/** The largest task or message a coordinator can send a worker, and the largest result the ledger keeps. */
export const WORKER_TEXT_MAX = 16_000;
/** The largest instructions a coordinator can give a crafted worker. */
export const CRAFTED_INSTRUCTIONS_MAX = 20_000;
/** The smallest share of the aggregate token budget a worker can start with. */
export const MIN_WORKER_TOKENS = 1000;
/** The version every crafted definition carries; crafted definitions are never published. */
export const CRAFTED_WORKER_VERSION = "1.0.0-crafted";

/** A worker, by id or by its name within the coordinator session. */
export const WorkerReference = z.string().min(1).max(64);

/**
 * Model-facing names of an orchestrator coordinator's worker tools (docs/HOSTING-MODES-PLAN.md, section 7.4). The shared
 * file tools exist only when the coordinator gives its workers a shared volume, and `answer_worker_question` only when
 * its policy lets the coordinator answer worker questions.
 */
export const WORKER_TOOLS = {
  create: "create_worker",
  send: "send_to_worker",
  get: "get_worker",
  list: "list_workers",
  interrupt: "interrupt_worker",
  archive: "archive_worker",
  wait: "wait_for_workers",
  answer: "answer_worker_question",
  listFiles: "list_shared_files",
  readFile: "read_shared_file",
  writeFile: "write_shared_file",
} as const;

/** Per-kind rules a crafted worker may set: `ask` (its approval mode decides) or `deny`. `allow` would widen the template. */
const CraftedRule = z.enum(["ask", "deny"]);

export const CraftedToolSpec = z
  .object({
    name: z.string().regex(TOOL_NAME),
    /** A binding from the crafting template's `toolBindings`. */
    binding: z.string().min(1).max(200),
    description: z.string().trim().min(1).max(1000),
  })
  .strict();
export type CraftedToolSpec = z.infer<typeof CraftedToolSpec>;

/**
 * What a coordinator supplies to craft a worker: bounded instructions and a subset of its operator crafting template.
 * It is model-authored and untrusted: it cannot name an image, command, mount, or policy, and it can only narrow the
 * template.
 */
export const CraftedWorkerSpec = z
  .object({
    description: z.string().trim().min(1).max(1000).optional(),
    instructions: z.string().trim().min(1).max(CRAFTED_INSTRUCTIONS_MAX),
    /** One of the template's models; omitted means the first one the policy approves. */
    model: z.string().min(1).max(200).optional(),
    builtinTools: z.array(z.enum(BUILTIN_TOOL_GROUPS)).max(BUILTIN_TOOL_GROUPS.length).optional(),
    tools: z.array(CraftedToolSpec).max(16).optional(),
    permissions: z
      .object({
        /** Omitted means `ask`. */
        default: CraftedRule.optional(),
        kinds: z
          .object({ read: CraftedRule.optional(), write: CraftedRule.optional(), shell: CraftedRule.optional(), url: CraftedRule.optional() })
          .strict()
          .optional(),
        questions: z.boolean().optional(),
        /** One of the template's approval modes; omitted means the template's first. */
        approvalMode: z.enum(APPROVAL_MODES).optional(),
        judgeModel: z.string().min(1).max(200).optional(),
        handler: z.string().regex(SLUG).optional(),
      })
      .strict()
      .optional(),
    /** Omitted means the template's maximum. */
    maxDurationSeconds: z.number().int().min(10).max(3600).optional(),
    /** Omitted means the template's maximum, or the policy's per-job maximum when the template sets none. */
    maxInferenceTokens: z.number().int().min(1000).max(5_000_000).optional(),
  })
  .strict();
export type CraftedWorkerSpec = z.infer<typeof CraftedWorkerSpec>;

/** `create_worker` arguments: a listed worker harness or a crafted definition, a size, a mount, and the first task. */
export const WorkerCreation = z
  .object({
    /** Unique within the coordinator session; a crafted worker's harness takes the same name. */
    name: z.string().regex(SLUG),
    harness: z.string().regex(SLUG).optional(),
    craft: CraftedWorkerSpec.optional(),
    /** One of the coordinator's effective worker sizes; omitted means the first one the worker may use. */
    size: z.string().regex(SLUG).optional(),
    /** Shared-volume access; omitted means `read-write` when the coordinator enables session storage, otherwise `none`. */
    sharedVolume: z.enum(WORKER_SHARED_ACCESS).optional(),
    task: z.string().trim().min(1).max(WORKER_TEXT_MAX),
    /** The most of the conversation's aggregate token budget this worker may use; capped by the worker's own limits. */
    tokenBudget: z.number().int().min(MIN_WORKER_TOKENS).max(5_000_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.harness === undefined) === (value.craft === undefined)) {
      ctx.addIssue({ code: "custom", path: ["harness"], message: "Name one listed worker harness or craft a worker, not both." });
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.name)) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "A worker name cannot look like a worker id." });
    }
  });
export type WorkerCreation = z.infer<typeof WorkerCreation>;

/** `send_to_worker` arguments. */
export const WorkerMessageRequest = z
  .object({
    worker: WorkerReference,
    message: z.string().trim().min(1).max(WORKER_TEXT_MAX),
    delivery: z.enum(WORKER_DELIVERIES).default("enqueue"),
  })
  .strict();
export type WorkerMessageRequest = z.infer<typeof WorkerMessageRequest>;

export const WorkerHarnessRef = z.object({ name: z.string(), version: z.string(), digest: z.string() }).strict();
export type WorkerHarnessRef = z.infer<typeof WorkerHarnessRef>;

/** A worker as its coordinator's tools and `GET /v1/sessions/{id}/workers` report it. */
export const WorkerView = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    name: z.string(),
    source: z.enum(WORKER_SOURCES),
    harness: WorkerHarnessRef,
    /** The crafting template a crafted worker was validated against. */
    template: z.string().optional(),
    size: z.string(),
    resources: ContainerSize,
    sharedVolume: z.enum(WORKER_SHARED_ACCESS),
    approvalMode: z.enum(APPROVAL_MODES),
    /** Whether the worker's assisted judge receives the coordinator session's recorded human messages. */
    inheritsHumanAuthority: z.boolean(),
    state: z.enum(WORKER_STATES),
    stopReason: z.enum(WORKER_STOP_REASONS).optional(),
    /** The final message of the worker's latest completed turn: untrusted model output. */
    result: z.object({ text: z.string(), truncated: z.boolean(), at: z.iso.datetime() }).strict().optional(),
    error: z.string().optional(),
    usage: z
      .object({
        /** The worker's reservation from the conversation's aggregate budget. */
        tokenBudget: z.number().int().nonnegative(),
        tokensUsed: z.number().int().nonnegative(),
        turns: z.number().int().nonnegative(),
        containerSeconds: z.number().nonnegative(),
      })
      .strict(),
    pendingMessages: z.number().int().nonnegative(),
    pendingInputs: z.number().int().nonnegative(),
    /** False until the worker's container is confirmed gone; until then the worker counts against the ceilings. */
    capacityReleased: z.boolean(),
    createdAt: z.iso.datetime(),
    lastActivityAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    stoppedAt: z.iso.datetime().optional(),
  })
  .strict();
export type WorkerView = z.infer<typeof WorkerView>;

/** A worker's approval or question, answered through the API when nobody is attached to the coordinator session. */
export const WorkerInputRequestView = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    workerId: z.string().uuid(),
    worker: z.string(),
    harness: z.object({ name: z.string(), version: z.string() }).strict(),
    state: InputRequestState,
    request: InputRequestBody,
    response: InputResponseBody.optional(),
    answeredBy: z.enum(WORKER_ANSWERERS).optional(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().optional(),
  })
  .strict();
export type WorkerInputRequestView = z.infer<typeof WorkerInputRequestView>;

/** A worker's recorded definition. A crafted definition can be opened in the configurator as an unsaved draft. */
export const WorkerDefinitionExport = z
  .object({
    workerId: z.string().uuid(),
    sessionId: z.string().uuid(),
    name: z.string(),
    source: z.enum(WORKER_SOURCES),
    template: z.string().optional(),
    digest: z.string(),
    /** The coordinator tool call that created the worker. */
    toolCallId: z.string(),
    createdAt: z.iso.datetime(),
    definition: HarnessDefinition,
  })
  .strict();
export type WorkerDefinitionExport = z.infer<typeof WorkerDefinitionExport>;

/** One event in a coordinator's inbox. `detail` is bounded, untrusted worker data. */
export interface WorkerEvent {
  id: string;
  workerId: string;
  worker: string;
  kind: WorkerEventKind;
  at: string;
  detail: Record<string, unknown>;
}

/** What a coordinator harness may do with workers under its effective policy. */
export interface WorkerCeilings {
  harnesses: string[];
  /** The coordinator's effective worker sizes with their resources, in preference order. */
  sizes: Array<{ name: string; resources: ContainerSize }>;
  maxConcurrent: number;
  maxPerSession: number;
  maxPerPrincipal: number;
  idleSeconds: number;
  maxLifetimeSeconds: number;
  sharedStorage: "none" | "session";
  /** The harness sets `humanAuthority: "inherit"` and its policy allows it. */
  inheritHumanAuthority: boolean;
  /** The policy lets the coordinator answer its workers' questions. */
  coordinatorAnswers: boolean;
  crafting?: { template: string; ceiling: CraftingTemplate };
}

/** The worker ceilings of an orchestrator harness, or undefined for any other harness: depth one starts here. */
export function workerCeilings(
  definition: Pick<HarnessDefinition, "interaction" | "hosting" | "permissions" | "mcpServers">,
  policy: Pick<ExecutionPolicy, "hosting" | "mcpServers">,
): WorkerCeilings | undefined {
  if (definition.interaction !== "conversation" || hostingModeOf(definition) !== "orchestrator") return undefined;
  const workers = effectiveHarnessHosting(definition, policy).workers;
  if (!workers) return undefined;
  const hosting = effectiveHostingPolicy(policy);
  const template = workers.craftingTemplate;
  return {
    harnesses: [...workers.harnesses],
    sizes: workers.sizes.map((name) => ({ name, resources: { ...hosting.sizes[name]! } })),
    maxConcurrent: workers.maxConcurrent,
    maxPerSession: workers.maxPerSession,
    maxPerPrincipal: hosting.workers.maxPerPrincipal,
    idleSeconds: hosting.workers.idleSeconds,
    maxLifetimeSeconds: hosting.workers.maxLifetimeSeconds,
    sharedStorage: workers.sharedStorage,
    inheritHumanAuthority: workers.humanAuthority === "inherit" && hosting.workers.allowInheritedAuthority,
    coordinatorAnswers: hosting.workers.allowCoordinatorAnswers,
    ...(template !== undefined && Object.hasOwn(hosting.crafting.templates, template)
      ? { crafting: { template, ceiling: structuredClone(hosting.crafting.templates[template]!) } }
      : {}),
  };
}

/** Workers that hold capacity: every worker whose container is not confirmed gone, counted under one lock. */
export interface WorkerCounts {
  /** Workers this session has ever created. */
  sessionTotal: number;
  sessionActive: number;
  principalActive: number;
  deploymentActive: number;
}

export interface WorkerCapacity {
  maxPerSession: number;
  maxConcurrent: number;
  maxPerPrincipal: number;
  /** The deployment-wide ceiling on workers holding capacity. */
  deployment: number;
}

/** Why one more worker cannot start, or undefined when it fits. */
export function workerCapacityProblem(counts: WorkerCounts, capacity: WorkerCapacity): string | undefined {
  if (counts.sessionTotal >= capacity.maxPerSession) return `This conversation has already created its maximum of ${capacity.maxPerSession} workers.`;
  if (counts.sessionActive >= capacity.maxConcurrent) {
    return `This conversation already has ${capacity.maxConcurrent} workers running or stopping; archive one before starting another.`;
  }
  if (counts.principalActive >= capacity.maxPerPrincipal) return `This principal already has ${capacity.maxPerPrincipal} workers running or stopping.`;
  if (counts.deploymentActive >= capacity.deployment) return "The deployment's worker capacity is exhausted; try again after other workers stop.";
  return undefined;
}

export interface WorkerBackstopInput {
  state: WorkerState;
  /** When the worker last became idle; absent while it starts, works, or waits for input. */
  idleSince?: Date;
  idleSeconds: number;
  expiresAt: Date;
  tokensUsed: number;
  tokenBudget: number;
}

/**
 * The backstop that stops a worker now, or undefined. Lifetime and budget apply in every state; idle time only while
 * the worker is idle, so a worker waiting for a person is bounded by its request's expiry and its lifetime instead.
 */
export function workerBackstop(worker: WorkerBackstopInput, now: Date): WorkerBackstopReason | undefined {
  if (worker.state === "stopped") return undefined;
  if (now.getTime() >= worker.expiresAt.getTime()) return "max_lifetime";
  if (worker.tokensUsed >= worker.tokenBudget) return "budget_exhausted";
  if (worker.state === "idle" && worker.idleSince && now.getTime() - worker.idleSince.getTime() >= worker.idleSeconds * 1000) {
    return "idle_timeout";
  }
  return undefined;
}

const SHARED_ONLY_BINDINGS = new Set<string>(SHARED_WORKER_BINDINGS);

/** Depth one: a worker runs an isolated conversation harness and cannot create workers, delegate jobs, or hand off. */
export function workerDepthProblems(definition: Pick<HarnessDefinition, "interaction" | "hosting" | "tools">): PolicyViolation[] {
  const problems: PolicyViolation[] = [];
  if (definition.interaction !== "conversation") problems.push({ path: "interaction", message: "Workers run conversation harnesses." });
  const mode = hostingModeOf(definition);
  if (mode !== "isolated") problems.push({ path: "hosting.mode", message: `Workers run isolated harnesses; this harness requests ${mode} hosting.` });
  if (definition.hosting?.handoffs?.length) problems.push({ path: "hosting.handoffs", message: "Workers cannot hand off." });
  definition.tools.forEach((tool, index) => {
    if (SHARED_ONLY_BINDINGS.has(tool.binding)) problems.push({ path: `tools.${index}.binding`, message: "Workers cannot delegate jobs." });
  });
  return problems;
}

/** The tool kind a binding implies: `python:` bindings run Python, `mcp-local:` bindings start a local MCP server, others run in the host. */
export function toolKindOfBinding(binding: string): ToolRequest["kind"] {
  if (binding.startsWith("python:")) return "python";
  if (binding.startsWith("mcp-local:")) return "mcp-local";
  return "host";
}

export interface CraftingInput {
  /** The worker's name, which the crafted harness takes. */
  name: string;
  spec: CraftedWorkerSpec;
  template: string;
  ceiling: CraftingTemplate;
  /** The coordinator harness's name, for the default description. */
  coordinator: string;
  policy: Pick<ExecutionPolicy, "allowedModels" | "maxInferenceTokensPerJob">;
}

export interface CraftingResult {
  definition?: HarnessDefinition;
  /** Problems with paths relative to the `create_worker` arguments. */
  problems: PolicyViolation[];
}

/** Maps a harness-definition issue path to the `create_worker` argument it comes from. */
function craftedPath(path: readonly PropertyKey[]): string {
  const dotted = path.map(String).join(".");
  if (dotted === "name") return "name";
  if (dotted === "limits.maxDurationSeconds") return "craft.maxDurationSeconds";
  if (dotted === "limits.maxInferenceTokens") return "craft.maxInferenceTokens";
  if (dotted.startsWith("model")) return "craft.model";
  if (["description", "instructions", "tools", "builtinTools", "permissions"].includes(String(path[0]))) return `craft.${dotted}`;
  return "craft";
}

/**
 * Composes a crafted worker's harness definition within its operator template (docs/HOSTING-MODES-PLAN.md, section 7.5).
 * Every template ceiling is checked (models, built-in groups, tool bindings, approval modes, judge model, duration, and
 * token limit) and the result is parsed as a harness definition. The coordinator cannot set images, commands, mounts,
 * hosting, handoffs, MCP servers, skills, or sub-agents, and per-kind rules can only be `ask` or `deny`. Sizes, the policy
 * and profile checks, and hosted admission belong to the caller.
 */
export function craftWorkerDefinition(input: CraftingInput): CraftingResult {
  const { spec, ceiling } = input;
  const problems: PolicyViolation[] = [];
  const reject = (path: string, message: string) => problems.push({ path: `craft.${path}`, message });
  const where = `crafting template '${input.template}'`;
  const model = spec.model ?? ceiling.models.find((name) => input.policy.allowedModels.includes(name)) ?? ceiling.models[0]!;
  if (!ceiling.models.includes(model)) reject("model", `Model '${model}' is not in ${where}.`);
  else if (!input.policy.allowedModels.includes(model)) reject("model", `Model '${model}' is not approved by the operator policy.`);
  spec.builtinTools?.forEach((group, index) => {
    if (!ceiling.builtinTools.includes(group)) reject(`builtinTools.${index}`, `The '${group}' built-in tools are not in ${where}.`);
  });
  spec.tools?.forEach((tool, index) => {
    if (SHARED_ONLY_BINDINGS.has(tool.binding)) reject(`tools.${index}.binding`, "Workers cannot delegate jobs.");
    else if (!ceiling.toolBindings.includes(tool.binding)) reject(`tools.${index}.binding`, `Binding '${tool.binding}' is not in ${where}.`);
  });
  const permissions = spec.permissions ?? {};
  const approvalMode = permissions.approvalMode ?? ceiling.approvalModes[0]!;
  if (!ceiling.approvalModes.includes(approvalMode)) reject("permissions.approvalMode", `The '${approvalMode}' approval mode is not in ${where}.`);
  if (permissions.judgeModel !== undefined && !ceiling.models.includes(permissions.judgeModel)) {
    reject("permissions.judgeModel", `Judge model '${permissions.judgeModel}' is not in ${where}.`);
  } else if (permissions.judgeModel !== undefined && !input.policy.allowedModels.includes(permissions.judgeModel)) {
    reject("permissions.judgeModel", `Judge model '${permissions.judgeModel}' is not approved by the operator policy.`);
  }
  const maxDurationSeconds = spec.maxDurationSeconds ?? ceiling.maxDurationSeconds;
  if (maxDurationSeconds > ceiling.maxDurationSeconds) reject("maxDurationSeconds", `${capitalize(where)} allows at most ${ceiling.maxDurationSeconds} seconds.`);
  const tokenCeiling = Math.min(ceiling.maxInferenceTokens ?? input.policy.maxInferenceTokensPerJob, 5_000_000);
  const maxInferenceTokens = spec.maxInferenceTokens ?? tokenCeiling;
  if (maxInferenceTokens > tokenCeiling) reject("maxInferenceTokens", `${capitalize(where)} allows at most ${tokenCeiling} inference tokens.`);
  if (problems.length) return { problems };

  const judgeModel = permissions.judgeModel;
  const candidate = {
    schemaVersion: "1",
    name: input.name,
    version: CRAFTED_WORKER_VERSION,
    description: spec.description ?? `A worker crafted by ${input.coordinator} from ${where}.`,
    interaction: "conversation",
    instructions: spec.instructions,
    // The Copilot foundation prompt, including its safety guidance, stays ahead of model-authored instructions.
    prompt: { mode: "append" },
    model: { preferred: model, allowed: judgeModel && judgeModel !== model ? [model, judgeModel] : [model] },
    tools: (spec.tools ?? []).map((tool) => ({
      name: tool.name, kind: toolKindOfBinding(tool.binding), description: tool.description, binding: tool.binding,
    })),
    ...(spec.builtinTools?.length ? { builtinTools: [...spec.builtinTools] } : {}),
    permissions: {
      default: permissions.default ?? "ask",
      ...(permissions.kinds && Object.keys(permissions.kinds).length ? { kinds: { ...permissions.kinds } } : {}),
      ...(permissions.questions ? { questions: true } : {}),
      approvalMode,
      ...(judgeModel ? { judgeModel } : {}),
      ...(permissions.handler ? { handler: permissions.handler } : {}),
    },
    input: { schema: { type: "object", additionalProperties: false } },
    output: { schema: { type: "object" } },
    limits: { maxDurationSeconds, maxInferenceTokens },
    retry: { safeToRetry: false, maxAttempts: 1 },
    runners: { allowedProfiles: [CONVERSATION_PROFILE], defaultProfile: CONVERSATION_PROFILE },
  };
  const parsed = HarnessDefinition.safeParse(candidate);
  if (!parsed.success) {
    return { problems: parsed.error.issues.map((issue) => ({ path: craftedPath(issue.path), message: issue.message })) };
  }
  return { definition: parsed.data, problems: [] };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A runtime session event, reduced to what the authority source reads. */
export interface AuthorityEventLike {
  type: string;
  agentId?: string;
  data?: { content?: unknown; source?: unknown; isAutopilotContinuation?: unknown };
}

/**
 * The coordinator session's human messages, exactly as sent and oldest first, for workers that inherit human authority
 * (docs/HOSTING-MODES-PLAN.md, section 3). Only the root agent's user messages without a source, or with source `user`,
 * count. System continuations, inter-agent prompts, hidden injections, and autopilot continuations carry no authority.
 * Messages are never shortened, because the runtime sends a request covered only by an oversized message down the
 * ordinary approval path; keeping only the newest `maximum` messages can only narrow the authority.
 */
export function humanAuthorityMessages(events: readonly AuthorityEventLike[], maximum = 50): string[] {
  const messages = events.flatMap((event) => {
    if (event.type !== "user.message" || event.agentId) return [];
    const data = event.data ?? {};
    if (data.source !== undefined && data.source !== null && data.source !== "user") return [];
    if (data.isAutopilotContinuation === true || typeof data.content !== "string") return [];
    return [data.content];
  });
  return maximum > 0 ? messages.slice(-maximum) : [];
}
