import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { CopilotClient, type AhpHost, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { HostedSession, renderSkillMarkdown, type HostControlRequest } from "@copilot-agent/contracts";
import { bindTools, buildSessionOptions } from "@copilot-agent/harness-hosting";
import { SupervisorMessage, type OwnerConfiguration } from "./protocol.js";
import { hostPermissionHandler, hostToolGuard } from "./policy.js";

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const sessions = new Map<string, CopilotSession>();
const secrets = new Set<string>();
let client: CopilotClient | undefined;
let host: AhpHost | undefined;
let stopping = false;
let activeSession: string | undefined;
let turnTimer: NodeJS.Timeout | undefined;

function control(request: HostControlRequest): Promise<unknown> {
  if (!process.connected || stopping) return Promise.reject(new Error("The host supervisor is unavailable."));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The host control request timed out."));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    process.send!({ kind: "control", id, request });
  });
}

async function start(config: OwnerConfiguration): Promise<void> {
  secrets.add(config.connectionToken);
  if (config.githubToken) secrets.add(config.githubToken);
  const workspace = join(config.dataDirectory, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const workspacePath = await realpath(workspace);
  const runtimeEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) runtimeEnv[key] = process.env[key]!;
  }
  runtimeEnv.COPILOT_AHP_EXPECTED_OWNER = JSON.stringify({ githubApiUrl: "https://api.github.com", userId: config.ownerUserId });
  client = new CopilotClient({
    mode: "empty",
    baseDirectory: join(config.dataDirectory, "copilot-home"),
    workingDirectory: workspacePath,
    env: runtimeEnv,
    useLoggedInUser: false,
    ...(config.githubToken ? { gitHubToken: config.githubToken } : {}),
    logLevel: "error",
    onListModels: () => [{
      id: config.model, name: config.model,
      capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128_000 } },
    }],
  });
  await client.start();
  const owner = client;

  async function materialize(id: string, selected: Omit<SessionConfig, "onPermissionRequest">, resume: boolean): Promise<CopilotSession> {
    if (selected.gitHubToken) secrets.add(selected.gitHubToken);
    if (stopping) throw new Error("The host is stopping.");
    if (sessions.has(id)) return sessions.get(id)!;
    const admitted = HostedSession.parse(await control({ operation: "session", sessionId: id, resume }));
    if (selected.model && selected.model !== admitted.model) throw new Error("The requested model is not admitted by the host.");
    const cwd = await realpath(selected.workingDirectory ?? workspacePath);
    const fromRoot = relative(workspacePath, cwd);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("The requested workspace is outside the host workspace.");
    }
    const definition = admitted.harness.definition;
    const skills = join(config.dataDirectory, "skills", id);
    for (const skill of definition.skills ?? []) {
      await mkdir(join(skills, skill.name), { recursive: true, mode: 0o700 });
      await writeFile(join(skills, skill.name, "SKILL.md"), renderSkillMarkdown(skill), { mode: 0o600 });
    }
    const tools = bindTools(definition.tools, { toolsRoot: "/app/tools", pythonBin: "/opt/python-agent/bin/python", workspace: cwd });
    const mapped = buildSessionOptions(definition, tools.map((tool) => tool.name), skills, "conversation");
    const availableTools = mapped.availableTools;
    if (!Array.isArray(availableTools)) throw new Error("The host requires an explicit tool allowlist.");
    const token = async (): Promise<string> => {
      if (stopping) throw new Error("The host is stopping.");
      if (activeSession && activeSession !== id) throw new Error("Another hosted session is running. Wait or abort its turn.");
      const response = await control({ operation: "token", sessionId: id });
      if (activeSession && activeSession !== id) throw new Error("Another hosted session is running. Wait or abort its turn.");
      if (!response || typeof response !== "object" || !("token" in response) || typeof response.token !== "string") {
        throw new Error("The host returned an invalid inference grant.");
      }
      if (!activeSession) {
        activeSession = id;
        turnTimer = setTimeout(() => {
          void sessions.get(id)?.abort().catch(() => fail("Could not abort the expired turn."));
        }, Math.min(config.maxTurnSeconds, definition.limits.maxDurationSeconds) * 1000);
      }
      return response.token;
    };
    const options: SessionConfig = {
      ...selected,
      ...mapped,
      model: admitted.model,
      tools,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      provider: { type: "openai", baseUrl: config.gatewayUrl, wireApi: "completions", bearerTokenProvider: token },
      onPermissionRequest: hostPermissionHandler(definition),
      hooks: {
        onPreToolUse: async (input) => {
          const decision = hostToolGuard(definition, availableTools, input.toolName);
          if (decision?.permissionDecision === "deny") return decision;
          try {
            await control({ operation: "token", sessionId: id });
          } catch {
            return { permissionDecision: "deny", permissionDecisionReason: "The session no longer has an active execution grant." };
          }
          return decision;
        },
      },
    };
    const session = resume ? await owner.resumeSession(id, options) : await owner.createSession({ ...options, sessionId: id });
    sessions.set(id, session);
    session.on((event) => {
      if (event.type === "session.idle" && activeSession === id && !event.agentId) {
        activeSession = undefined;
        clearTimeout(turnTimer);
      }
    });
    return session;
  }

  host = await owner.startAhpHost({
    ...(config.transport === "direct" || config.transport === "both" ? {
      localServer: { hostname: "0.0.0.0", port: config.port, token: config.connectionToken },
    } : {}),
    ...(config.transport === "github" || config.transport === "both" ? {
      githubEnvironment: { name: `Aspire demo (${config.owner})`, computeId: config.computeId },
    } : {}),
    createSession: async ({ config: selected, signal }) => {
      signal.throwIfAborted();
      if (!selected.sessionId) throw new Error("AHP did not supply a session identity.");
      try {
        return await materialize(selected.sessionId, selected, false);
      } catch (error) {
        process.send!({ kind: "diagnostic", message: safeError("Session creation failed.", error) });
        throw error;
      }
    },
    resumeSession: async ({ sessionId, config: selected, signal }) => {
      signal.throwIfAborted();
      try {
        return await materialize(sessionId, selected, true);
      } catch (error) {
        process.send!({ kind: "diagnostic", message: safeError("Session resume failed.", error) });
        throw error;
      }
    },
    onExit: () => { if (!stopping) fail("The AHP hosting task stopped."); },
  });
  process.send!({ kind: "ready", environmentId: host.environmentId });
}

async function close(ids: string[]): Promise<void> {
  for (const id of ids) {
    const session = sessions.get(id);
    if (!session) continue;
    await session.abort();
    await session.disconnect();
    sessions.delete(id);
    if (activeSession === id) {
      clearTimeout(turnTimer);
      activeSession = undefined;
    }
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(turnTimer);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("The host is stopping."));
  }
  pending.clear();
  await close([...sessions.keys()]);
  await host?.dispose();
  await client?.stop();
  process.disconnect?.();
}

function safeError(message: string, error?: unknown): string {
  if (error instanceof Error) {
    let detail = error.message;
    for (const secret of secrets) detail = detail.split(secret).join("[redacted]");
    detail = detail.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
    message = `${message} ${detail}`.slice(0, 500);
  }
  return message;
}

function fail(message: string, error?: unknown): void {
  message = safeError(message, error);
  if (process.connected) process.send!({ kind: "failed", message });
  void stop().catch(() => { process.exitCode = 1; });
  process.exitCode = 1;
}

let started = false;
process.on("message", (value: unknown) => {
  const message = SupervisorMessage.safeParse(value);
  if (!message.success) return fail("Invalid supervisor protocol message.");
  const body = message.data;
  if (body.kind === "response") {
    const entry = pending.get(body.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(body.id);
    if (body.error) entry.reject(new Error(body.error));
    else entry.resolve(body.result);
  } else if (body.kind === "start") {
    if (started) return fail("The host was started twice.");
    started = true;
    void start(body.config).catch((error: unknown) => fail("The managed AHP host could not start.", error));
  } else if (body.kind === "close") {
    void close(body.sessionIds).catch(() => fail("A closed session could not be stopped."));
  } else {
    void stop().catch(() => fail("Host shutdown failed."));
  }
});
process.once("disconnect", () => { void stop().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
