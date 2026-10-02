import { describe, expect, it } from "vitest";
import {
  HarnessDefinition,
  JsonLineDecoder,
  RunnerToExecutor,
  securityGaps,
  type ExecutionPolicy,
  type ExecutorCapabilities,
} from "@copilot-agent/contracts";

const policy: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["m"],
  maxDurationSeconds: 60,
  maxInferenceTokensPerJob: 10_000,
  maxConcurrentAttemptsPerPrincipal: 1,
  maxQueuedJobsPerPrincipal: 1,
  retry: { maxAttempts: 1, backoffSeconds: 1 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: [],
};

const executor = (overrides: Partial<ExecutorCapabilities>): ExecutorCapabilities => ({
  executorId: "e",
  profiles: ["node-ts-agent"],
  processIsolation: "uid",
  egress: "gateway-only",
  platform: "linux-x64",
  ...overrides,
});

describe("securityGaps", () => {
  it("reports nothing when the executor enforces every requirement", () => {
    expect(securityGaps(policy, executor({}))).toEqual([]);
  });

  it("reports each requirement the executor cannot enforce", () => {
    expect(securityGaps(policy, executor({ processIsolation: "none", egress: "none" }))).toEqual([
      "process-isolation-not-enforced",
      "egress-not-enforced",
    ]);
  });
});

describe("JsonLineDecoder", () => {
  it("splits lines across chunks and skips blanks", () => {
    const decoder = new JsonLineDecoder(1024);
    expect(decoder.push('{"a":1}\n\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(":2}\n")).toEqual(['{"b":2}']);
  });

  it("reports oversized lines without buffering them", () => {
    const decoder = new JsonLineDecoder(8);
    expect(decoder.push("0123456789")).toEqual([]);
    expect(decoder.push("abc\n{}\n")).toEqual([null, "{}"]);
  });
});

describe("runner protocol", () => {
  it("rejects unknown event kinds so raw SDK events cannot leak through", () => {
    const parsed = RunnerToExecutor.safeParse({ type: "event", event: { kind: "assistant.message", content: "x" } });
    expect(parsed.success).toBe(false);
  });

  it("accepts a well-formed failure", () => {
    const parsed = RunnerToExecutor.safeParse({
      type: "failure",
      code: "inference_error",
      message: "x",
      retryable: true,
      uncertainEffects: false,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("HarnessDefinition", () => {
  it("requires the preferred model to be allowed and the default profile to be listed", () => {
    const base = {
      schemaVersion: "1",
      name: "h-one",
      version: "1.0.0",
      description: "d",
      instructions: "i",
      model: { preferred: "a", allowed: ["b"] },
      tools: [],
      input: { schema: {} },
      output: { schema: {} },
      limits: { maxDurationSeconds: 60, maxInferenceTokens: 1000 },
      retry: { safeToRetry: true, maxAttempts: 1 },
      runners: { allowedProfiles: ["p-one"], defaultProfile: "p-two" },
    };
    const result = HarnessDefinition.safeParse(base);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join(" ")).toMatch(/preferred|defaultProfile/);
  });
});
