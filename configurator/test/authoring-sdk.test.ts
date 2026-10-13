import { stat } from "node:fs/promises";
import type { CopilotClientOptions, SessionConfig } from "@github/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateWithCopilot } from "../server/authoring.js";
import type { AuthoringDraft } from "../server/types.js";

const sdk = vi.hoisted(() => ({
  options: undefined as CopilotClientOptions | undefined,
  session: undefined as SessionConfig | undefined,
  submit: undefined as ((args: unknown) => Promise<unknown>) | undefined,
  start: vi.fn<() => Promise<void>>(),
  send: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
}));
const draft: AuthoringDraft = {
  kind: "agent", agent: { name: "reviewer", description: "Review", instructions: "Review.", tools: [] },
};
const validate = vi.fn<(payload: unknown) => AuthoringDraft>(() => draft);
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    constructor(options: CopilotClientOptions) { sdk.options = options; }
    start = sdk.start;
    forceStop = sdk.stop;
    async createSession(config: SessionConfig) {
      sdk.session = config;
      return { sendAndWait: sdk.send };
    }
  },
  defineTool: (name: string, config: { handler: (value: unknown) => Promise<unknown> }) => {
    sdk.submit = config.handler;
    return { name, ...config };
  },
}));

beforeEach(() => {
  sdk.options = undefined;
  sdk.session = undefined;
  sdk.submit = undefined;
  sdk.start.mockReset().mockResolvedValue();
  sdk.stop.mockReset().mockResolvedValue();
  sdk.send.mockReset().mockImplementation(async () => { await sdk.submit!({ kind: "agent" }); });
  validate.mockReset().mockReturnValue(draft);
});
afterEach(() => vi.unstubAllEnvs());

const generation = (signal = new AbortController().signal) =>
  generateWithCopilot({ prompt: "Synthetic test only", schema: { type: "object" }, signal, validate });

describe("Copilot drafting transport", () => {
  it("uses a request-private empty session with only the submission tool and cleans up", async () => {
    vi.stubEnv("UNRELATED_SERVICE_KEY", "must-not-inherit");
    await expect(generation()).resolves.toEqual(draft);
    expect(validate).toHaveBeenCalledOnce();
    expect(sdk.options).toMatchObject({ mode: "empty", useLoggedInUser: true, logLevel: "none" });
    expect(sdk.options?.env).not.toHaveProperty("UNRELATED_SERVICE_KEY");
    expect(sdk.options?.workingDirectory).toBe(sdk.options?.baseDirectory);
    expect(sdk.session).toMatchObject({
      availableTools: ["custom:submit_draft"],
      enableConfigDiscovery: false, skipCustomInstructions: true, enableFileHooks: false, enableSkills: false,
      enableSessionStore: false, enableHostGitOperations: false, enableSessionTelemetry: false, remoteSession: "off",
      infiniteSessions: { enabled: false },
    });
    expect(sdk.session?.tools).toHaveLength(1);
    expect(sdk.session?.provider).toBeUndefined();
    expect(sdk.session?.model).toBeUndefined();
    const permission = await sdk.session!.onPermissionRequest!({
      kind: "shell", toolCallId: "test", intention: "test", fullCommandText: "echo test", commands: [],
      hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [], canOfferSessionApproval: false,
    }, { sessionId: "synthetic" });
    expect(permission).toEqual({ kind: "denied-no-approval-rule-and-could-not-request-from-user" });
    expect(sdk.stop).toHaveBeenCalledOnce();
    await expect(stat(sdk.options!.baseDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up after authentication/startup failure", async () => {
    sdk.start.mockRejectedValue(new Error("start failed"));
    await expect(generation()).rejects.toThrow("start failed");
    expect(sdk.send).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalledOnce();
    await expect(stat(sdk.options!.baseDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a stalled startup without starting a session later", async () => {
    let finish!: () => void;
    sdk.start.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const active = generation(controller.signal);
    const failure = expect(active).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(sdk.start).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await failure;
    finish();
    await vi.waitFor(() => expect(sdk.stop).toHaveBeenCalledTimes(2));
    expect(sdk.session).toBeUndefined();
    await expect(stat(sdk.options!.baseDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels inference and rejects late submissions", async () => {
    sdk.send.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const active = generation(controller.signal);
    const failure = expect(active).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(sdk.send).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await failure;
    expect(sdk.stop).toHaveBeenCalledOnce();
    await expect(sdk.submit!({ kind: "agent" })).rejects.toThrow("cancelled");
    expect(validate).not.toHaveBeenCalled();
  });

  it("reports invalid submissions to the model so it can correct them before completing", async () => {
    validate.mockImplementationOnce(() => { throw new Error("agent.tools: unknown tool"); }).mockReturnValue(draft);
    sdk.send.mockImplementation(async () => {
      await expect(sdk.submit!({ agent: { tools: ["invented"] } })).rejects.toThrow("unknown tool");
      await sdk.submit!({ agent: { tools: [] } });
    });
    await expect(generation()).resolves.toEqual(draft);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("reports missing and oversized structured results", async () => {
    sdk.send.mockResolvedValue(undefined);
    await expect(generation()).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("structured draft") });
    sdk.send.mockImplementation(async () => { await sdk.submit!({ text: "x".repeat(200_001) }); });
    await expect(generation()).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("too large") });
    expect(sdk.stop).toHaveBeenCalledTimes(2);
  });
});
