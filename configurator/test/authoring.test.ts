import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutionPolicy } from "@copilot-agent/contracts";
import { AuthoringRequest, AuthoringService, authoringPrompt, validateAuthoringDraft, type DraftGenerator } from "../server/authoring.js";
import { templateHarness } from "../server/repo.js";
import type { AuthoringDraft, BindingInfo, ProfileSummary } from "../server/types.js";
import type { ValidationContext } from "../server/validate.js";

const policy: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent", "python-agent"],
  allowedModels: ["approved-model"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 500_000,
  maxConcurrentAttemptsPerPrincipal: 2,
  maxQueuedJobsPerPrincipal: 10,
  retry: { maxAttempts: 2, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  maxReasoningEffort: "medium",
};
const profiles: ProfileSummary[] = ["node-ts-agent", "python-agent"].map((id) => ({
  id, displayName: id, language: id, sdk: "sdk", sdkVersion: "1", firstParty: true,
  toolBindings: ["python:stats"], capabilities: ["cancel", "structured-result", "custom-agents", "skills", "model-options"],
}));
const bindings: BindingInfo[] = [{ id: "python:stats", kind: "python", description: "Statistics", profiles: profiles.map((p) => p.id) }];
const agent: AuthoringDraft & { kind: "agent" } = {
  kind: "agent", agent: { name: "reviewer", description: "Review conclusions", instructions: "Check the evidence.", tools: [] },
};
const skill: AuthoringDraft & { kind: "skill" } = {
  kind: "skill", skill: { name: "review-checklist", description: "Review results", content: "# Review\n\nCheck the evidence." },
};
const tool: AuthoringDraft & { kind: "tool" } = {
  kind: "tool", tool: { name: "compute_stats", description: "Statistics", kind: "python", binding: "python:stats" },
};

function fixture(kind: AuthoringRequest["kind"] = "agent") {
  const document = templateHarness("sample", "approved-model", profiles.map((p) => p.id));
  const context: ValidationContext = { policy, profiles, all: [document] };
  const request: AuthoringRequest = { kind, description: "Help review results", document };
  return { document, context, request };
}

afterEach(() => vi.useRealTimers());

describe("authoring request and output contracts", () => {
  it("requires bounded, nonblank descriptions and a well-shaped document", () => {
    const { request } = fixture();
    expect(AuthoringRequest.parse(request)).toEqual(request);
    for (const description of ["", "   ", "a".repeat(8_001)]) {
      expect(AuthoringRequest.safeParse({ ...request, description }).success).toBe(false);
    }
    expect(AuthoringRequest.safeParse({ ...request, document: { manifest: {} } }).success).toBe(false);
    expect(AuthoringRequest.safeParse({ ...request, kind: "execute" }).success).toBe(false);
    expect(AuthoringRequest.safeParse({ ...request, apiKey: "not-accepted" }).success).toBe(false);
  });

  it.each([agent, skill, tool])("accepts valid $kind additions without changing the input document", (draft) => {
    const { document, context } = fixture();
    const before = structuredClone(document);
    expect(validateAuthoringDraft(draft.kind, draft, document, context, bindings)).toEqual(draft);
    expect(document).toEqual(before);
  });

  it("rejects malformed, extra, or wrong-kind output", () => {
    const { document, context } = fixture();
    for (const value of [undefined, "text", skill, { ...agent, command: "execute" }, { ...agent, agent: { ...agent.agent, instructions: "" } }]) {
      expect(() => validateAuthoringDraft("agent", value, document, context, bindings)).toThrow("invalid draft");
    }
  });

  it("rejects invented agent tools, skills and models and excessive reasoning", () => {
    const { document, context } = fixture();
    for (const fields of [
      { tools: ["missing_tool"] }, { skills: ["missing-skill"] }, { model: "unapproved" }, { reasoningEffort: "high" },
    ]) {
      expect(() => validateAuthoringDraft("agent", { ...agent, agent: { ...agent.agent, ...fields } }, document, context, bindings))
        .toThrow("cannot be added");
    }
  });

  it("uses the effective policy, not just the harness model list", () => {
    const { document, context } = fixture();
    document.manifest.model.allowed.push("unapproved");
    expect(() => validateAuthoringDraft("agent", { ...agent, agent: { ...agent.agent, model: "unapproved" } }, document, context, bindings))
      .toThrow("not approved");
  });

  it("enforces counts, duplicate names, and required runner capabilities", () => {
    const { document, context } = fixture();
    document.manifest.agents = [agent.agent];
    expect(() => validateAuthoringDraft("agent", agent, document, context, bindings)).toThrow("Duplicate agent");
    document.manifest.agents = Array.from({ length: 8 }, (_, i) => ({ ...agent.agent, name: `agent-${i}` }));
    expect(() => validateAuthoringDraft("agent", agent, document, context, bindings)).toThrow("cannot be added");
    delete document.manifest.agents;
    const unsupported = { ...context, profiles: profiles.map((p) => ({ ...p, capabilities: [] })) };
    expect(() => validateAuthoringDraft("agent", agent, document, unsupported, bindings)).toThrow("custom-agents");
    document.skills = [skill.skill];
    expect(() => validateAuthoringDraft("skill", skill, document, context, bindings)).toThrow("Duplicate skill");
    document.skills = Array.from({ length: 10 }, (_, i) => ({ ...skill.skill, name: `skill-${i}` }));
    expect(() => validateAuthoringDraft("skill", skill, document, context, bindings)).toThrow("cannot be added");
  });

  it("requires real binding kinds and both selected runners, and preserves reserved names", () => {
    const { document, context } = fixture();
    for (const changes of [{ kind: "host" }, { binding: "python:invented" }]) {
      expect(() => validateAuthoringDraft("tool", { ...tool, tool: { ...tool.tool, ...changes } }, document, context, bindings))
        .toThrow("does not match an installed binding");
    }
    const missing = { ...context, profiles: [profiles[0]!, { ...profiles[1]!, toolBindings: [] }] };
    expect(() => validateAuthoringDraft("tool", tool, document, missing, bindings)).toThrow("cannot provide");
    expect(() => validateAuthoringDraft("tool", { ...tool, tool: { ...tool.tool, name: "submit_result" } }, document, context, bindings))
      .toThrow("cannot be added");
    expect(() => validateAuthoringDraft("tool", { ...tool, tool: { ...tool.tool, delegatedOnly: true } }, document, context, bindings))
      .toThrow("cannot be added");
  });

  it("keeps new tool code inert and rejects unsafe/duplicate file labels", () => {
    const { document, context } = fixture("tool-code");
    const proposal = {
      name: "normalize", summary: "Review this implementation", files: [{ path: "tools/python/normalize.py", content: "print('proposal')" }],
      instructions: "Merge both runner integrations, update both profiles, test, rebuild, redeploy.",
    };
    const result = { kind: "tool-code", proposal };
    expect(validateAuthoringDraft("tool-code", result, document, context, bindings)).toEqual(result);
    expect(document.manifest.tools).toEqual([]);
    for (const path of ["../outside.py", "/tmp/out.py", "C:\\out.py", "tools/../out.py", "tools//out.py"]) {
      expect(() => validateAuthoringDraft("tool-code", { ...result, proposal: { ...proposal, files: [{ path, content: "text" }] } }, document, context, bindings))
        .toThrow("invalid draft");
    }
    expect(() => validateAuthoringDraft("tool-code", { ...result, proposal: { ...proposal, files: [...proposal.files, ...proposal.files] } }, document, context, bindings))
      .toThrow("invalid draft");
  });
});

describe("bounded, on-demand authoring", () => {
  it("passes only the catalog to the model and requests both runner integrations", () => {
    const { request, context } = fixture();
    request.document.instructions = "PRIVATE_INSTRUCTIONS";
    request.document.skills = [{ ...skill.skill, content: "PRIVATE_SKILL" }];
    request.document.manifest.input.schema = { private: "PRIVATE_EXAMPLE" };
    request.document.manifest.agents = [{ ...agent.agent, instructions: "PRIVATE_AGENT_INSTRUCTIONS" }];
    const prompt = authoringPrompt(request, context, bindings);
    for (const privateText of ["PRIVATE_INSTRUCTIONS", "PRIVATE_SKILL", "PRIVATE_EXAMPLE", "PRIVATE_AGENT_INSTRUCTIONS"]) {
      expect(prompt).not.toContain(privateText);
    }
    expect(prompt).toContain("python:stats");
    expect(prompt).toContain("src/harness-hosting/src/tools.ts");
    expect(prompt).toContain("execution-profiles/python-agent/runner.py");
    const limited = { ...context, profiles: [profiles[0]!, { ...profiles[1]!, toolBindings: [] }] };
    expect(authoringPrompt(request, limited, [{ ...bindings[0]!, profiles: [profiles[0]!.id] }])).not.toContain("python:stats");
  });

  it("does not call the SDK until requested; generates a schema-constrained draft", async () => {
    const transport = vi.fn<DraftGenerator>().mockResolvedValue(agent);
    const service = new AuthoringService(transport);
    expect(transport).not.toHaveBeenCalled();
    const { request, context } = fixture();
    await expect(service.generate(request, context, bindings, new AbortController().signal)).resolves.toEqual(agent);
    expect(transport).toHaveBeenCalledOnce();
    const generation = transport.mock.calls[0]![0];
    expect(generation.schema).toMatchObject({ type: "object", required: ["agent"] });
    expect(generation.validate({ agent: agent.agent })).toEqual(agent);
    expect(() => generation.validate({ agent: { ...agent.agent, tools: ["invented_tool"] } })).toThrow("cannot be added");
    expect(() => generation.validate({ skill: skill.skill })).toThrow("invalid draft");
    await service.close();
  });

  it("surfaces authentication/model failures without leaking SDK payloads and allows retry", async () => {
    const transport = vi.fn<DraftGenerator>().mockRejectedValueOnce(new Error("secret raw token")).mockResolvedValue(agent);
    const service = new AuthoringService(transport);
    const { request, context } = fixture();
    const generate = () => service.generate(request, context, bindings, new AbortController().signal);
    await expect(generate()).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("gh auth login") });
    await expect(generate()).resolves.toEqual(agent);
    await service.close();
  });

  it("refuses parallel requests and cancels active work when closing", async () => {
    const transport: DraftGenerator = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const service = new AuthoringService(transport);
    const { request, context } = fixture();
    const active = service.generate(request, context, bindings, new AbortController().signal);
    const failure = expect(active).rejects.toMatchObject({ statusCode: 408 });
    await expect(service.generate(request, context, bindings, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 });
    await service.close();
    await failure;
    await expect(service.generate(request, context, bindings, new AbortController().signal)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("does not start already-cancelled work and ignores output after cancellation", async () => {
    const transport = vi.fn<DraftGenerator>().mockImplementation(async ({ signal }) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return agent;
    });
    const service = new AuthoringService(transport);
    const { request, context } = fixture();
    const controller = new AbortController();
    await expect(service.generate(request, context, bindings, AbortSignal.abort())).rejects.toMatchObject({ statusCode: 408 });
    expect(transport).not.toHaveBeenCalled();
    await expect(service.generate(request, context, bindings, controller.signal)).rejects.toMatchObject({ statusCode: 408 });
    await service.close();
  });

  it("sets a 90-second deadline including SDK startup", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    let cancelled = false;
    const service = new AuthoringService(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    }));
    const { request, context } = fixture();
    const pending = service.generate(request, context, bindings, new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ statusCode: 408 });
    expect(timeout).toHaveBeenCalledWith(90_000);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toBe(true);
    await failure;
    timeout.mockRestore();
    await service.close();
  });
});
