import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { z } from "zod";
import {
  gatewayWireApi, renderSkillMarkdown, WorkerAuthorityGrant, WorkerControl, WorkerInputPoll,
  type InputRequestBody, type InputResponseBody, type WorkerContainerSpec,
} from "@copilot-agent/contracts";
import { bindTools, buildSessionOptions, hostToolGuard } from "@copilot-agent/harness-hosting";
import { WorkerSupervisorMessage, type WorkerOperation, type WorkerOwnerConfiguration } from "./protocol.js";
import { workerManagedSettings, workerPermissionHandler } from "./worker-permissions.js";

/**
 * The unprivileged owner of one orchestrator worker (docs/HOSTING-MODES-PLAN.md, section 7.4). It runs the worker's
 * harness on its private volume, delivers its coordinator's durable messages marked with the coordinator's agent
 * source (never human authority), reports each turn and its result, aborts a turn on interrupt, and sends requests
 * that need a person to the worker request queue: the coordinator never decides them. With inherited human authority,
 * it applies the grants its coordinator's host recorded. It never holds the allocation credential; its supervisor
 * performs every worker call.
 */
const CONTROL_INTERVAL_MS = 1_000;
const INPUT_POLL_MS = 2_000;
const pendingTokens = new Map<string, { resolve: (token: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const pendingCalls = new Map<string, { resolve: (result: { status: number; body: unknown }) => void; timer: NodeJS.Timeout }>();
let client: CopilotClient | undefined;
let session: CopilotSession | undefined;
let stopping = false;
let started = false;
let control: NodeJS.Timeout | undefined;
let controlling = false;
/** The worker's current turn: from accepting a message while idle until the runtime is idle again. */
let turn: { id: string; result?: string; timer: NodeJS.Timeout } | undefined;
let maxTurnSeconds = 600;
let appliedGrant: string | undefined;

class CallError extends Error {
  constructor(readonly operation: string, readonly status: number) { super(`The worker call ${operation} failed (${status}).`); }
}

function send(message: object): void {
  if (process.connected) process.send!(message);
}

function token(): Promise<string> {
  if (!process.connected || stopping) return Promise.reject(new Error("The worker supervisor is unavailable."));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTokens.delete(id);
      reject(new Error("The inference grant request timed out."));
    }, 15_000);
    pendingTokens.set(id, { resolve, reject, timer });
    send({ kind: "token", id });
  });
}

/** One worker route, called by the supervisor with the allocation credential. */
async function call<T>(operation: WorkerOperation, body: object, schema: z.ZodType<T>): Promise<T> {
  if (!process.connected || stopping) throw new CallError(operation, 0);
  const id = randomUUID();
  const result = await new Promise<{ status: number; body: unknown }>((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      resolve({ status: 0, body: undefined });
    }, 30_000);
    pendingCalls.set(id, { resolve, timer });
    send({ kind: "call", id, operation, body });
  });
  if (result.status < 200 || result.status >= 300) throw new CallError(operation, result.status);
  return schema.parse(result.body);
}

function activity(): void {
  send({ kind: "activity", activeTurn: turn !== undefined });
}

const Recorded = z.object({ recorded: z.literal(true) }).strict();
const Created = z.object({ id: z.string().uuid(), expiresAt: z.string(), created: z.boolean() }).strict();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a person's answer through the worker request queue. A request belongs to the current turn; when the turn
 * ends, the worker stops, or no answer arrives in time, the worker receives `expired` and does not act.
 */
async function askPerson(request: InputRequestBody): Promise<InputResponseBody> {
  const current = turn;
  if (!current || stopping) return { kind: "expired" };
  let id: string;
  try {
    id = (await call("input-requests", { turnId: current.id, runtimeRequestId: randomUUID(), request }, Created)).id;
  } catch {
    return { kind: "expired" };
  }
  for (;;) {
    if (stopping) return { kind: "expired" };
    await wait(INPUT_POLL_MS);
    let poll: WorkerInputPoll;
    try { poll = await call("input-requests/poll", { id }, WorkerInputPoll); }
    catch (error) {
      if (error instanceof CallError && (error.status === 404 || error.status === 401)) return { kind: "expired" };
      continue;
    }
    if (poll.state === "answered" && poll.response) return poll.response;
    if (poll.state !== "pending") return { kind: "expired" };
    activity();
  }
}

/** Starts a turn and reports it before any of its requests can reach the queue. */
async function beginTurn(): Promise<void> {
  const current: NonNullable<typeof turn> = {
    id: randomUUID(),
    timer: setTimeout(() => { void session?.abort().catch(() => fail("Could not abort the expired turn.")); }, maxTurnSeconds * 1000),
  };
  turn = current;
  activity();
  await call("turns/started", { turnId: current.id }, Recorded);
}

async function finishTurn(interrupted: boolean): Promise<void> {
  const current = turn;
  if (!current) return;
  turn = undefined;
  clearTimeout(current.timer);
  activity();
  for (let attempt = 0; attempt < 5 && !stopping; attempt++) {
    try {
      await call("turns/finished", {
        turnId: current.id, ...(current.result !== undefined && !interrupted ? { result: current.result } : {}), ...(interrupted ? { interrupted: true } : {}),
      }, Recorded);
      return;
    } catch {
      await wait(1_000);
    }
  }
  send({ kind: "diagnostic", message: "A worker turn's end could not be reported." });
}


function onEvent(event: SessionEvent): void {
  if (event.agentId) return;
  if (event.type === "assistant.turn_start" && !turn) {
    // The runtime started work this owner did not send, such as a background completion: report it as a turn.
    void beginTurn().catch(() => send({ kind: "diagnostic", message: "A worker turn's start could not be reported." }));
  } else if (event.type === "assistant.message" && turn && event.data.content.trim()) {
    turn.result = event.data.content;
  } else if (event.type === "session.idle") {
    void finishTurn(event.data.aborted === true);
  }
  if (["user.message", "assistant.message", "tool.execution_start", "tool.execution_complete"].includes(event.type)) activity();
}

/** Applies an authority grant from the coordinator's host, exactly as recorded, and reports what the runtime accepted. */
async function applyAuthority(grantId: string): Promise<void> {
  const grant = await call("authority", { grantId }, WorkerAuthorityGrant);
  const applied = await session!.rpc.permissions.setInheritedHumanAuthority({ sourceSessionId: grant.sourceSessionId, messages: grant.messages });
  await call("authority/applied", { grantId, messageCount: applied.messageCount, overLimitMessageCount: applied.overLimitMessageCount }, Recorded);
  appliedGrant = grantId;
}

/** One control cycle: authority first, then an interrupt, then messages: a new turn when idle, steering when busy. */
async function tick(spec: WorkerContainerSpec): Promise<void> {
  if (controlling || stopping || !session) return;
  controlling = true;
  try {
    const state = await call("control", {}, WorkerControl);
    if (state.state === "stopped") return;
    if (spec.inheritAuthority && state.authority && state.authority.id !== appliedGrant) await applyAuthority(state.authority.id);
    if (state.interrupt && turn) {
      await session.abort();
      return;
    }
    const delivered: string[] = [];
    if (!turn) {
      const next = state.messages[0];
      if (next) {
        await beginTurn();
        try {
          await session.send({ prompt: next.content, source: spec.messageSource as `agent-${string}`, mode: "enqueue" });
        } catch (error) {
          // Not delivered: the message stays pending, and the empty turn ends.
          await finishTurn(false);
          throw error;
        }
        delivered.push(next.id);
      }
    } else {
      for (const message of state.messages.filter((entry) => entry.delivery === "immediate")) {
        await session.send({ prompt: message.content, source: spec.messageSource as `agent-${string}`, mode: "immediate" });
        delivered.push(message.id);
      }
    }
    if (delivered.length) await call("messages/delivered", { ids: delivered }, Recorded);
  } catch (error) {
    if (error instanceof CallError && error.status === 401) fail("The worker's allocation is no longer active.");
  } finally {
    controlling = false;
  }
}

async function start(config: WorkerOwnerConfiguration): Promise<void> {
  const { spec } = config;
  maxTurnSeconds = spec.maxTurnSeconds;
  const definition = spec.harness.definition;
  await chmod(config.dataDirectory, 0o700);
  await mkdir(join(config.dataDirectory, "workspace"), { recursive: true, mode: 0o700 });
  const workspace = await realpath(join(config.dataDirectory, "workspace"));
  const skills = join(config.dataDirectory, "skills");
  await rm(skills, { recursive: true, force: true });
  for (const skill of definition.skills ?? []) {
    await mkdir(join(skills, skill.name), { recursive: true, mode: 0o700 });
    await writeFile(join(skills, skill.name, "SKILL.md"), renderSkillMarkdown(skill), { mode: 0o600 });
  }
  const marker = join(config.dataDirectory, "worker.json");
  const retained = await readFile(marker, "utf8").then((text) => JSON.parse(text) as { workerId?: unknown; digest?: unknown }, (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (retained && (retained.workerId !== spec.workerId || retained.digest !== spec.harness.digest)) {
    throw new Error("The volume holds a different worker or harness snapshot.");
  }
  const models = [...new Set([spec.model, ...(spec.judgeModel ? [spec.judgeModel] : []), ...(definition.agents ?? []).flatMap((agent) => agent.model ? [agent.model] : [])])];
  const wireApi = await gatewayWireApi(config.gatewayUrl, models);
  // The in-process runtime uses this process's working directory; it cannot take a client-level one.
  process.chdir(workspace);
  // The runtime offers assisted approval only behind its experimental AUTO_APPROVAL flag, which the in-process engine
  // reads from this process's environment when it starts; without it, setMode("assisted") is ignored. Managed settings
  // still refuse every mode except the worker's admitted one.
  if (spec.approvalMode === "assisted") process.env.AUTO_APPROVAL = "true";
  else delete process.env.AUTO_APPROVAL;
  client = new CopilotClient({
    connection: RuntimeConnection.forInProcess(),
    mode: "empty",
    baseDirectory: join(config.dataDirectory, "copilot-home"),
    useLoggedInUser: false,
    logLevel: "error",
    onListModels: () => models.map((id) => ({
      id, name: id,
      capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128_000 } },
    })),
  });
  await client.start();
  const tools = bindTools(definition.tools, { toolsRoot: config.toolsRoot, pythonBin: config.pythonBin, workspace }) as NonNullable<SessionConfig["tools"]>;
  const mapped = buildSessionOptions(definition, tools.map((tool) => tool.name), skills, "conversation") as unknown as Partial<SessionConfig>;
  const availableTools = mapped.availableTools;
  if (!Array.isArray(availableTools)) throw new Error("The worker requires an explicit tool allowlist.");
  const questions = definition.permissions?.questions === true;
  const options: SessionConfig = {
    ...mapped,
    sessionId: spec.workerId,
    workingDirectory: workspace,
    model: spec.model,
    tools,
    streaming: true,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    provider: {
      type: "openai", baseUrl: config.gatewayUrl, wireApi,
      bearerTokenProvider: async () => {
        if (stopping) throw new Error("The worker is stopping.");
        activity();
        return token();
      },
    },
    onPermissionRequest: workerPermissionHandler(spec, workspace, askPerson),
    managedSettings: workerManagedSettings(spec.approvalMode),
    ...(questions ? {
      onUserInputRequest: async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
        const choices = request.choices?.map((choice) => choice.slice(0, 500)).filter(Boolean).slice(0, 20);
        const response = await askPerson({
          kind: "question", question: (request.question || "The worker asks for input.").slice(0, 4000),
          ...(choices?.length ? { choices } : {}), allowFreeform: request.allowFreeform ?? true,
        });
        if (response.kind === "question") return { answer: response.answer, wasFreeform: response.wasFreeform };
        return { answer: "No answer was given in time. Continue with your best judgement and state your assumptions.", wasFreeform: true };
      },
    } : {}),
    hooks: {
      onPreToolUse: async (input) => {
        // Only a `deny` rule decides here. Every other request takes the runtime's own permission flow, which carries
        // the full action to the judge and the worker's handler; a hook confirmation would hide it.
        const decision = hostToolGuard(definition, availableTools, input.toolName);
        if (decision?.permissionDecision === "deny") return decision;
        try {
          await token();
        } catch {
          return { permissionDecision: "deny", permissionDecisionReason: "The worker no longer has an active execution grant." };
        }
        activity();
        return undefined;
      },
    },
  };
  session = retained
    ? await client.resumeSession(spec.workerId, { ...options, continuePendingWork: false })
    : await client.createSession(options);
  if (!retained) await writeFile(marker, JSON.stringify({ workerId: spec.workerId, digest: spec.harness.digest }), { mode: 0o600 });
  if (spec.approvalMode !== "manual") {
    const applied = await session.rpc.permissions.setMode({
      mode: spec.approvalMode === "assisted" ? "assisted" : "allow-all",
      ...(spec.approvalMode === "assisted" && spec.judgeModel ? { assistedApprovalModel: spec.judgeModel } : {}),
    });
    if (!applied.success) throw new Error("The runtime refused the worker's approval mode.");
  }
  session.on(onEvent);
  send({ kind: "ready" });
  control = setInterval(() => { void tick(spec); }, CONTROL_INTERVAL_MS);
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(control);
  if (turn) clearTimeout(turn.timer);
  for (const entry of pendingTokens.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("The worker is stopping."));
  }
  pendingTokens.clear();
  for (const entry of pendingCalls.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ status: 0, body: undefined });
  }
  pendingCalls.clear();
  const failures: unknown[] = [];
  for (const action of [() => session?.abort(), () => session?.disconnect()]) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
  const errors = await client?.stop();
  if (failures.length || errors?.length) {
    process.exitCode = 1;
    send({ kind: "diagnostic", message: "The Copilot runtime reported shutdown errors." });
  }
  process.disconnect?.();
}

function safeError(message: string, error?: unknown): string {
  if (error instanceof Error) {
    message = `${message} ${error.message.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")}`;
  }
  return message.slice(0, 500);
}

function fail(message: string, error?: unknown): void {
  send({ kind: "failed", message: safeError(message, error) });
  process.exitCode = 1;
  void stop().catch(() => { process.exitCode = 1; });
}

process.on("message", (value: unknown) => {
  const parsed = WorkerSupervisorMessage.safeParse(value);
  if (!parsed.success) return fail("Invalid supervisor protocol message.");
  const message = parsed.data;
  if (message.kind === "token") {
    const entry = pendingTokens.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingTokens.delete(message.id);
    if (message.token) entry.resolve(message.token);
    else entry.reject(new Error(message.error ?? "The inference grant was refused."));
  } else if (message.kind === "result") {
    const entry = pendingCalls.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingCalls.delete(message.id);
    entry.resolve({ status: message.status, body: message.body });
  } else if (message.kind === "start") {
    if (started) return fail("The worker owner was started twice.");
    started = true;
    void start(message.config).catch((error: unknown) => fail("The worker could not start.", error));
  } else {
    void stop().catch(() => fail("Worker shutdown failed."));
  }
});
process.once("disconnect", () => { void stop().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
