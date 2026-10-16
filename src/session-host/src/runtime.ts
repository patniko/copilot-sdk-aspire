import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  CopilotClient, RuntimeConnection, type AhpHost, type AhpHostOptions, type CopilotSession, type PermissionHandler, type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { humanAuthorityMessages, type RuntimeApprovalMode } from "@copilot-agent/contracts";
import { SessionFileStore, type SessionFileLease } from "@copilot-agent/job-store";
import { z } from "zod";
import type { SharedSessionSettings } from "./harness-session.js";
import { postgresSessionFilesystem, providerKey } from "./postgres-filesystem.js";
import { SessionWorkspace } from "./workspace.js";

export interface SharedActivationContext {
  lease: SessionFileLease;
  signal: AbortSignal;
  workspace: SessionWorkspace;
  /** Provider path for application state kept with the session's history, outside the user-visible workspace. */
  stateDirectory: string;
  /**
   * The person's own messages in this session's runtime history, exactly as sent and oldest first: the only source of
   * inherited human authority for an orchestrator's workers.
   */
  humanMessages: () => Promise<string[]>;
}
/** The approval modes an activation starts in and offers to attached clients. */
export interface SharedApprovalModes {
  initial: RuntimeApprovalMode;
  available: RuntimeApprovalMode[];
  /** The assisted judge's model; the session model when omitted. */
  judgeModel?: string;
}
export interface SharedSessionOptions {
  id: string;
  principal: string;
  githubUserId: number;
  model: string;
  /** Shorthand for a replacing system message when `settings` is omitted. */
  instructions?: string;
  /** Harness-derived session settings; see `sharedSessionSettings`. */
  settings?: Omit<SharedSessionSettings, "builtinTools"> & { builtinTools?: string[]; managedSettings?: SessionConfig["managedSettings"] };
  /** Identity of the session's immutable configuration; a retained session resumes only with the same identity. */
  configuration?: string;
  provider: NonNullable<SessionConfig["provider"]> | ((context: SharedActivationContext) => NonNullable<SessionConfig["provider"]>);
  tools?: SessionConfig["tools"] | ((context: SharedActivationContext) => NonNullable<SessionConfig["tools"]> | Promise<NonNullable<SessionConfig["tools"]>>);
  /** Answers the runtime's permission requests; omitted means every request is refused. */
  permissions?: (context: SharedActivationContext) => PermissionHandler;
  approval?: SharedApprovalModes;
  hooks?: (context: SharedActivationContext) => SessionConfig["hooks"];
  onEvent?: (context: SharedActivationContext, event: SessionEvent) => void;
  onActivity?: (context: SharedActivationContext) => void;
}
interface Activation {
  lease: SessionFileLease;
  lifetime: AbortController;
  session: CopilotSession;
  host: AhpHost;
  heartbeat: NodeJS.Timeout;
  close?: Promise<void>;
}
const snapshot = z.object({
  schemaVersion: z.literal(2),
  configuration: z.string().min(1).max(500),
  githubUserId: z.number().int().positive(),
}).strict();
const rejectAll: PermissionHandler = async () => ({ kind: "reject", feedback: "This shared session permits only its application tools." });

/**
 * The runtime offers assisted approval only behind its experimental `AUTO_APPROVAL` feature flag, which the in-process
 * engine reads from this process's environment when its client starts; without it, `setMode("assisted")` is refused.
 * The worker sets the flag itself rather than relying on its host environment. It only makes the mode available:
 * managed settings and the AHP host's approval ceiling still keep every session within the modes its policy allows.
 */
export function enableAssistedApprovals(environment: NodeJS.ProcessEnv = process.env): void {
  environment.AUTO_APPROVAL = "true";
}

/** Thrown when the runtime will not hold a session's approval mode; the session must not run in another mode instead. */
export class ApprovalModeRefused extends Error {
  constructor(readonly mode: RuntimeApprovalMode, readonly actual?: string) {
    super(`The runtime refused approval mode '${mode}'${actual ? ` and reports '${actual}'` : ""}.`);
    this.name = "ApprovalModeRefused";
  }
}

const RECORDED_MODES = new Map<string, RuntimeApprovalMode>([
  ["allow-all", "allow-all"], ["on", "allow-all"], ["assisted", "assisted"], ["auto", "assisted"], ["manual", "manual"], ["off", "manual"],
]);

/**
 * The approval mode a session's history last recorded, which the runtime restores when it resumes the session: the last
 * `session.permissions_changed` event, read as the runtime reads it, or manual approval when there is none. A recorded
 * mode the current policy no longer allows yields manual approval, the floor, which is also what the runtime restores.
 */
export function recordedApprovalMode(events: ReadonlyArray<{ type: string; data?: unknown }>, available: readonly RuntimeApprovalMode[]): RuntimeApprovalMode {
  let recorded: RuntimeApprovalMode = "manual";
  for (const event of events) {
    if (event.type !== "session.permissions_changed") continue;
    const data = (event.data ?? {}) as { mode?: unknown; allowAllPermissionMode?: unknown; allowAllPermissions?: unknown };
    const named = typeof data.mode === "string" ? data.mode : typeof data.allowAllPermissionMode === "string" ? data.allowAllPermissionMode : undefined;
    recorded = (named !== undefined ? RECORDED_MODES.get(named) : undefined) ?? (data.allowAllPermissions === true ? "allow-all" : "manual");
  }
  return available.includes(recorded) ? recorded : "manual";
}

/**
 * Puts a session in `mode` and confirms that the runtime reports it in force. A refusal, such as assisted approval
 * without the runtime's feature flag or a mode that managed settings disable, throws `ApprovalModeRefused` instead of
 * leaving the session in another mode.
 */
export async function applyApprovalMode(
  permissions: Pick<CopilotSession["rpc"]["permissions"], "getMode" | "setMode">,
  mode: RuntimeApprovalMode,
  judgeModel?: string,
): Promise<void> {
  let actual: string | undefined;
  try {
    if (mode !== "manual" || (await permissions.getMode()).mode !== "manual") {
      await permissions.setMode({ mode, ...(mode === "assisted" && judgeModel ? { assistedApprovalModel: judgeModel } : {}) });
    }
    actual = (await permissions.getMode()).mode;
  } catch {
    actual = undefined;
  }
  if (actual !== mode) throw new ApprovalModeRefused(mode, actual);
}

/**
 * A bounded local prototype: many published conversations share one in-process SDK client.
 * Returned listener tokens are internal provisioning material, never public API responses.
 */
export class SharedSessionRuntime {
  readonly #client: CopilotClient;
  readonly #activations = new Map<string, Activation>();
  readonly #opening = new Set<string>();
  readonly #models = new Set<string>();
  readonly #worker = randomUUID();
  #stopping = false;

  constructor(
    private readonly root: string,
    private readonly files: SessionFileStore,
    private readonly report: (event: string, sessionId: string) => void,
    private readonly maximumSessions = 16,
  ) {
    if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1 || maximumSessions > 100) throw new Error("Invalid shared runtime capacity.");
    if (process.env.COPILOT_AHP_FACTORY_PROFILE !== "managed") {
      throw new Error("Set COPILOT_AHP_FACTORY_PROFILE=managed before starting the in-process shared runtime; AHP identity must not replace application provider configuration.");
    }
    enableAssistedApprovals();
    this.#client = new CopilotClient({
      connection: RuntimeConnection.forInProcess(),
      mode: "empty",
      baseDirectory: join(root, "runtime"),
      useLoggedInUser: false,
      logLevel: process.env.LOG_LEVEL === "debug" ? "debug" : "error",
      onListModels: () => [...this.#models].map((id) => ({
        id, name: id,
        capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128_000 } },
      })),
      sessionFs: {
        initialCwd: join(root, "anchors"),
        sessionStatePath: join(root, "session-state"),
        conventions: process.platform === "win32" ? "windows" : "posix",
        capabilities: { binary: true },
      },
    });
  }

  async start(): Promise<void> {
    await mkdir(join(this.root, "anchors"), { recursive: true });
    await this.#client.start();
  }

  async open(options: SharedSessionOptions): Promise<{ id: string; url: string; token: string; sessionUri: string; lease: SessionFileLease }> {
    if (this.#stopping) throw new Error("The shared runtime is stopping.");
    if (!z.string().uuid().safeParse(options.id).success || !options.principal || !Number.isSafeInteger(options.githubUserId) || options.githubUserId < 1) {
      throw new Error("Invalid shared session identity.");
    }
    if (this.#activations.has(options.id) || this.#opening.has(options.id)) throw new Error("The shared session is already active.");
    if (this.#activations.size + this.#opening.size >= this.maximumSessions) throw new Error("The shared runtime is at capacity.");
    this.#opening.add(options.id);
    this.#models.add(options.model);
    let lease: SessionFileLease | undefined;
    let host: AhpHost | undefined;
    let session: CopilotSession | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const lifetime = new AbortController();
    try {
      lease = await this.files.acquire(options.id, options.principal, this.#worker);
      const activeLease = lease;
      let renewing = false;
      heartbeat = setInterval(() => {
        if (renewing || lifetime.signal.aborted) return;
        renewing = true;
        void this.files.heartbeat(activeLease).catch(() => {
          lifetime.abort();
          const current = this.#activations.get(options.id);
          if (current && current.lease.epoch !== activeLease.epoch) return;
          this.report("session.storage_lease_lost", options.id);
          void this.close(options.id).catch(() => this.report("session.close_failed", options.id));
        }).finally(() => { renewing = false; });
      }, 8_000);
      const anchorDirectory = join(this.root, "anchors", options.id);
      await mkdir(anchorDirectory, { recursive: true });
      const anchor = await realpath(anchorDirectory);
      const storage = postgresSessionFilesystem(this.files, lease, process.platform === "win32" ? "windows" : "posix");
      await storage.mkdir(anchor, true);
      const workspace = new SessionWorkspace(anchor, storage, lifetime.signal, (operation) => this.report(`session.fs.${operation}.failed`, options.id));
      const stateDirectory = join(this.root, "session-state");
      const context: SharedActivationContext = {
        lease, signal: lifetime.signal, workspace, stateDirectory,
        humanMessages: async () => {
          if (!session || lifetime.signal.aborted) throw new Error("The shared conversation is not active.");
          return humanAuthorityMessages(await session.getEvents());
        },
      };
      const tools = typeof options.tools === "function" ? await options.tools(context) : options.tools ?? [];
      const metadataPath = join(stateDirectory, "application-snapshot.json");
      const current = snapshot.parse({
        schemaVersion: 2, githubUserId: options.githubUserId,
        configuration: options.configuration ?? `sha256:${createHash("sha256").update(`${options.model}\0${options.instructions ?? ""}`).digest("hex")}`,
      });
      const resume = await storage.exists(metadataPath);
      if (resume) {
        const retained = snapshot.safeParse(JSON.parse(await storage.readFile(metadataPath)));
        if (!retained.success || JSON.stringify(retained.data) !== JSON.stringify(current)) {
          throw new Error("The retained session configuration differs; create a new session rather than replacing its policy.");
        }
      } else {
        await storage.writeFile(metadataPath, JSON.stringify(current));
      }
      const { builtinTools = [], managedSettings, ...settings } = options.settings ?? {
        systemMessage: { mode: "replace" as const, content: options.instructions ?? "" }, excludedBuiltinAgents: [],
      };
      if (!settings.systemMessage.content && settings.systemMessage.mode === "replace") throw new Error("A shared session needs instructions.");
      const config: SessionConfig = {
        ...settings,
        sessionId: options.id,
        workingDirectory: anchor,
        model: options.model,
        provider: typeof options.provider === "function" ? options.provider(context) : options.provider,
        tools,
        availableTools: [...tools.map((tool) => `custom:${tool.name}`), ...builtinTools.map((name) => `builtin:${name}`)],
        ...(managedSettings ? { managedSettings } : {}),
        enableConfigDiscovery: false,
        skipCustomInstructions: true,
        streaming: true,
        onPermissionRequest: options.permissions?.(context) ?? rejectAll,
        createSessionFsProvider: () => workspace.sessionFs,
        hooks: options.hooks?.(context),
      };
      session = resume
        ? await this.#client.resumeSession(options.id, { ...config, continuePendingWork: false })
        : await this.#client.createSession(config);
      const original = session;
      session.on((event) => options.onEvent?.(context, event));
      const approval = options.approval;
      if (approval) {
        // A new session starts in its harness's mode; a resumed one returns to the mode its history records. Either must
        // hold before publication, because the AHP host adopts the mode in force when it publishes the session.
        const mode = resume ? recordedApprovalMode(await session.getEvents(), approval.available) : approval.initial;
        await applyApprovalMode(session.rpc.permissions, mode, approval.judgeModel);
      }
      const hostOptions: AhpHostOptions = {
        computeId: options.id,
        workingDirectory: anchor,
        expectedOwner: { githubApiUrl: "https://api.github.com", userId: options.githubUserId },
        localServer: { hostname: "127.0.0.1", port: 0 },
        // The ceiling an attached client can switch within; the host advertises and enforces it.
        ...(approval ? { approvalModes: { available: [...approval.available], default: approval.initial } } : {}),
        onWorkspaceResource: (request, invocation) => {
          options.onActivity?.(context);
          return workspace.onResource(request, invocation);
        },
        createSession: async () => { throw new Error("Create shared conversations through the application; attach to the published session."); },
        resumeSession: async ({ sessionId }) => {
          if (sessionId !== options.id || lifetime.signal.aborted) throw new Error("The requested shared conversation is unavailable.");
          return original;
        },
        onExit: () => {
          const current = this.#activations.get(options.id);
          if (current && (current.close || current.lease.epoch !== activeLease.epoch)) return;
          lifetime.abort();
          this.report("session.host_exited", options.id);
          void this.close(options.id).catch(() => this.report("session.close_failed", options.id));
        },
      };
      host = await this.#client.startAhpHost(hostOptions);
      const publication = await host.publishSession(options.id);
      if (!host.url || !host.token || lifetime.signal.aborted || this.#stopping) throw new Error("Shared host startup did not complete.");
      this.#activations.set(options.id, { lease, lifetime, host, session, heartbeat });
      this.report(resume ? "session.resumed" : "session.created", options.id);
      return { id: options.id, url: host.url, token: host.token, sessionUri: publication.sessionUri, lease };
    } catch (error) {
      lifetime.abort();
      clearInterval(heartbeat);
      try { await host?.dispose(); }
      finally {
        try { await session?.disconnect(); }
        finally { if (lease) await this.files.release(lease); }
      }
      throw error;
    } finally { this.#opening.delete(options.id); }
  }

  async close(id: string): Promise<void> {
    const activation = this.#activations.get(id);
    if (!activation) return;
    if (!activation.close) {
      activation.close = this.#close(id, activation).catch((error) => {
        activation.close = undefined;
        throw error;
      });
    }
    return activation.close;
  }

  /**
   * Provider keys of a session's runtime state directory and workspace anchor, derived exactly as `open` stores them:
   * the areas a promotion snapshot reads. `workspacePath` is the anchor as the conversation's history names it.
   */
  async storageAreas(id: string): Promise<{ state: string; workspace: string; workspacePath: string }> {
    if (!z.string().uuid().safeParse(id).success) throw new Error("Invalid shared session identity.");
    const anchorDirectory = join(this.root, "anchors", id);
    await mkdir(anchorDirectory, { recursive: true });
    const conventions = process.platform === "win32" ? "windows" : "posix";
    const anchor = await realpath(anchorDirectory);
    return {
      state: providerKey(join(this.root, "session-state"), conventions).key,
      workspace: providerKey(anchor, conventions).key,
      workspacePath: anchor,
    };
  }

  async sendSystem(id: string, prompt: string): Promise<string> {
    const activation = this.#activations.get(id);
    if (!activation || activation.close || activation.lifetime.signal.aborted) throw new Error("The shared conversation is not active.");
    return activation.session.send({ prompt, source: "system" });
  }

  /** The approval mode the runtime reports in force for an active conversation. */
  async approvalMode(id: string): Promise<string> {
    const activation = this.#activations.get(id);
    if (!activation || activation.close) throw new Error("The shared conversation is not active.");
    return (await activation.session.rpc.permissions.getMode()).mode;
  }

  /**
   * Asks the runtime for an approval mode, as an attached client's mode switch does. Managed settings refuse modes the
   * harness's policy does not allow; the result is the mode in force afterwards.
   */
  async requestApprovalMode(id: string, mode: RuntimeApprovalMode): Promise<string> {
    const activation = this.#activations.get(id);
    if (!activation || activation.close || activation.lifetime.signal.aborted) throw new Error("The shared conversation is not active.");
    try { return (await activation.session.rpc.permissions.setMode({ mode })).mode; }
    catch { return (await activation.session.rpc.permissions.getMode()).mode; }
  }

  async hasSystemMessage(id: string, marker: string): Promise<boolean> {
    const activation = this.#activations.get(id);
    if (!activation || activation.close) throw new Error("The shared conversation is not active.");
    return (await activation.session.getEvents()).some((event) =>
      event.type === "user.message" && event.data.source === "system" && event.data.content.includes(marker));
  }

  async #close(id: string, activation: Activation): Promise<void> {
    clearInterval(activation.heartbeat);
    const failures: unknown[] = [];
    for (const action of [
      () => activation.session.abort(),
      () => activation.host.dispose(),
      () => activation.session.disconnect(),
    ]) {
      try { await action(); }
      catch (error) { failures.push(error); }
    }
    activation.lifetime.abort();
    if (failures.length) {
      this.report("session.deactivation_failed", id);
      throw new AggregateError(failures, "The shared activation could not be completely stopped; its lease was not released.");
    }
    await this.files.release(activation.lease);
    this.#activations.delete(id);
    this.report("session.deactivated", id);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#opening.size) throw new Error("Wait for pending session activations before stopping the shared runtime.");
    try {
      await Promise.all([...this.#activations.keys()].map((id) => this.close(id)));
    } finally {
      const failures = await this.#client.stop();
      if (failures.length) throw new Error("Shared runtime shutdown failed.");
    }
  }
}
