import type { HarnessDefinition, HarnessSnapshot } from "@copilot-agent/contracts";

export function inputHarness(timeoutSeconds = 2): HarnessSnapshot {
  const definition: HarnessDefinition = {
    schemaVersion: "1",
    name: "input-fixture",
    version: "1.0.0",
    description: "Test-only interactive harness for input request integration coverage.",
    instructions: "Ask for the requested input and return the received response.",
    model: { preferred: "grok-4.6", allowed: ["grok-4.6"] },
    tools: [],
    permissions: {
      default: "deny",
      kinds: { read: "ask", write: "ask", shell: "ask", url: "ask" },
      questions: true,
      timeoutSeconds,
    },
    input: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ask"],
        properties: {
          ask: {
            anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: { type: "object", additionalProperties: true } }],
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["response", "responses"],
        properties: {
          response: {},
          responses: { type: "array", items: {} },
        },
      },
    },
    limits: { maxDurationSeconds: 20, maxInferenceTokens: 1000 },
    retry: { safeToRetry: true, maxAttempts: 1 },
    runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
  };
  return { definition, digest: `test:${definition.name}:${timeoutSeconds}` };
}
