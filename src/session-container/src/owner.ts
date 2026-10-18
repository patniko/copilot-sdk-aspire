import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection, type AhpHost, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { gatewayWireApi, promotionContinuation, renderSkillMarkdown, RuntimeSessionId } from "@copilot-agent/contracts";
import { bindTools, buildSessionOptions, hostPermissionHandler, hostToolGuard } from "@copilot-agent/harness-hosting";
import { SupervisorMessage, type OwnerConfiguration } from "./protocol.js";

/**
 * The unprivileged owner of one application session. It runs the harness-driven agent loop on the session volume's
 * real filesystem and serves a loopback AHP listener. It asks the supervisor for session inference grants and never
 * holds the allocation credential.
 */
const pending = new Map<string, { resolve: (token: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const secrets = new Set<string>();
let client: CopilotClient | undefined;
let host: AhpHost | undefined;
let session: CopilotSession | undefined;
let stopping = false;
let started = false;
let activeTurn = false;
let turnTimer: NodeJS.Timeout | undefined;
/**
 * The note a session started for a move sends once after its cutover: the move's notice, or the standard continuation
 * when its history moved. The first line deduplicates delivery.
 */
let moveNote: { id: string; text: string; marker: string } | undefined;

function send(message: object): void {
  if (process.connected) process.send!(message);
}

/**
 * After a move's cutover, tells the agent once what changed. The runtime keeps history as written, so earlier messages
 * still name the shared worker's workspace path; the standard continuation maps it to this container's.
 */
async function continuePromoted(promotionId: string): Promise<void> {
  const current = session;
  const note = moveNote;
  if (!current || !note || note.id !== promotionId || stopping) return;
  const delivered = (await current.getEvents()).some((event) =>
    event.type === "user.message" && event.data.source === "system" && event.data.content.includes(note.marker));
  if (delivered) return;
  await current.send({ prompt: note.text, source: "system" });
}

function token(): Promise<string> {
  if (!process.connected || stopping) return Promise.reject(new Error("The session container supervisor is unavailable."));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The inference grant request timed out."));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    send({ kind: "token", id });
  });
}

function activity(): void {
  send({ kind: "activity", activeTurn });
}

async function start(config: OwnerConfiguration): Promise<void> {
  secrets.add(config.listenerToken);
  const { spec } = config;
  const definition = spec.harness.definition;
  await chmod(config.dataDirectory, 0o700);
  await mkdir(join(config.dataDirectory, "workspace"), { recursive: true, mode: 0o700 });
  const workspace = await realpath(join(config.dataDirectory, "workspace"));
  if (spec.promotion) {
    const text = spec.promotion.notice
      ?? (spec.promotion.history ? promotionContinuation(spec.promotion.id, workspace, spec.promotion.previousWorkspace) : undefined);
    if (text) moveNote = { id: spec.promotion.id, text, marker: text.split("\n", 1)[0]! };
  }
  const skills = join(config.dataDirectory, "skills");
  await rm(skills, { recursive: true, force: true });
  for (const skill of definition.skills ?? []) {
    await mkdir(join(skills, skill.name), { recursive: true, mode: 0o700 });
    await writeFile(join(skills, skill.name, "SKILL.md"), renderSkillMarkdown(skill), { mode: 0o600 });
  }
  const marker = join(config.dataDirectory, "session.json");
  const retained = await readFile(marker, "utf8").then((text) => JSON.parse(text) as { sessionId?: unknown; runtimeSessionId?: unknown; digest?: unknown }, (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (retained && (retained.sessionId !== spec.sessionId || retained.digest !== spec.harness.digest)) {
    throw new Error("The volume holds a different session or harness snapshot.");
  }
  // The runtime session this volume holds (recorded by the move that seeded it), the one a move starts fresh, or, for
  // a session that never moved, the application session's own ID.
  const runtimeSessionId = RuntimeSessionId.parse(retained
    ? (retained.runtimeSessionId ?? spec.sessionId)
    : (spec.promotion?.runtimeSessionId ?? spec.sessionId));
  const models = [...new Set([spec.model, ...(definition.agents ?? []).flatMap((agent) => agent.model ? [agent.model] : [])])];
  const wireApi = await gatewayWireApi(config.gatewayUrl, models);
  // The in-process runtime uses this process's working directory; it cannot take a client-level one.
  process.chdir(workspace);
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
  const owner = client;
  const tools = bindTools(definition.tools, { toolsRoot: config.toolsRoot, pythonBin: config.pythonBin, workspace }) as NonNullable<SessionConfig["tools"]>;
  // harness-hosting types its mapping against the published SDK; the shapes are identical at runtime.
  const mapped = buildSessionOptions(definition, tools.map((tool) => tool.name), skills, "conversation") as unknown as Partial<SessionConfig>;
  const availableTools = mapped.availableTools;
  if (!Array.isArray(availableTools)) throw new Error("The session container requires an explicit tool allowlist.");
  const options: SessionConfig = {
    ...mapped,
    sessionId: runtimeSessionId,
    workingDirectory: workspace,
    model: spec.model,
    tools,
    streaming: true,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    provider: {
      type: "openai", baseUrl: config.gatewayUrl, wireApi,
      bearerTokenProvider: async () => {
        if (stopping) throw new Error("The session container is stopping.");
        if (!activeTurn) {
          activeTurn = true;
          turnTimer = setTimeout(() => {
            void session?.abort().catch(() => fail("Could not abort the expired turn."));
          }, spec.maxTurnSeconds * 1000);
        }
        activity();
        return token();
      },
    },
    onPermissionRequest: hostPermissionHandler(definition) as SessionConfig["onPermissionRequest"],
    hooks: {
      onPreToolUse: async (input) => {
        const decision = hostToolGuard(definition, availableTools, input.toolName);
        if (decision?.permissionDecision === "deny") return decision;
        try {
          await token();
        } catch {
          return { permissionDecision: "deny", permissionDecisionReason: "The session no longer has an active execution grant." };
        }
        activity();
        return decision;
      },
    },
  };
  session = retained
    ? await owner.resumeSession(runtimeSessionId, { ...options, continuePendingWork: false })
    : await owner.createSession(options);
  if (!retained) await writeFile(marker, JSON.stringify({ sessionId: spec.sessionId, runtimeSessionId, digest: spec.harness.digest }), { mode: 0o600 });
  const published = session;
  published.on((event) => {
    if (event.type === "session.idle" && !event.agentId) {
      activeTurn = false;
      clearTimeout(turnTimer);
      activity();
    } else if (["user.message", "assistant.message", "tool.execution_start", "tool.execution_complete"].includes(event.type)) {
      activity();
    }
  });
  host = await owner.startAhpHost({
    computeId: spec.sessionId,
    workingDirectory: workspace,
    expectedOwner: { githubApiUrl: "https://api.github.com", userId: spec.githubUserId },
    localServer: { hostname: "127.0.0.1", port: config.port, token: config.listenerToken },
    createSession: async () => { throw new Error("Sessions are provisioned by the application; attach to the published session."); },
    resumeSession: async ({ sessionId, signal }) => {
      signal.throwIfAborted();
      if (sessionId !== runtimeSessionId || stopping) throw new Error("The requested session is not hosted by this container.");
      return published;
    },
    onExit: () => { if (!stopping) fail("The AHP hosting task stopped."); },
  });
  await host.publishSession(runtimeSessionId);
  send({ kind: "ready" });
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(turnTimer);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("The session container is stopping."));
  }
  pending.clear();
  const failures: unknown[] = [];
  for (const action of [() => session?.abort(), () => host?.dispose(), () => session?.disconnect()]) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
  const errors = await client?.stop();
  if (failures.length || errors?.length) {
    process.exitCode = 1;
    send({ kind: "failed", message: "The Copilot runtime reported shutdown errors." });
  }
  process.disconnect?.();
}

function safeError(message: string, error?: unknown): string {
  if (error instanceof Error) {
    let detail = error.message;
    for (const secret of secrets) detail = detail.split(secret).join("[redacted]");
    detail = detail.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
    message = `${message} ${detail}`;
  }
  return message.slice(0, 500);
}

function fail(message: string, error?: unknown): void {
  send({ kind: "failed", message: safeError(message, error) });
  process.exitCode = 1;
  void stop().catch(() => { process.exitCode = 1; });
}

process.on("message", (value: unknown) => {
  const parsed = SupervisorMessage.safeParse(value);
  if (!parsed.success) return fail("Invalid supervisor protocol message.");
  const message = parsed.data;
  if (message.kind === "token") {
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.token) entry.resolve(message.token);
    else entry.reject(new Error(message.error ?? "The inference grant was refused."));
  } else if (message.kind === "start") {
    if (started) return fail("The session container owner was started twice.");
    started = true;
    void start(message.config).catch((error: unknown) => fail("The session could not start.", error));
  } else if (message.kind === "promoted") {
    void continuePromoted(message.id).catch(() => send({ kind: "diagnostic", message: "The promotion continuation could not be sent." }));
  } else {
    void stop().catch(() => fail("Session container shutdown failed."));
  }
});
process.once("disconnect", () => { void stop().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
