import type { HarnessDefinition, HarnessSnapshot, PolicySet } from "@copilot-agent/contracts";
import { HttpError } from "./http.js";
import { canonicalJson, createAjv, sha256Hex } from "./registry.js";

/**
 * Admits a conversation harness definition a caller submitted (`POST /v1/sessions` with `definition`) as an unpublished
 * snapshot with its content digest, or throws the refusal. The caller still applies every hosting and policy check a
 * published harness gets. Submitted definitions take the base policy: a name that is published (and so may have a
 * per-harness override) is refused rather than borrowing that harness's policy.
 */
export function inlineHarnessSnapshot(
  definition: HarnessDefinition,
  published: ReadonlyMap<string, readonly HarnessSnapshot[]>,
  policies: PolicySet,
): HarnessSnapshot {
  assertInlineAllowed(policies);
  if (published.has(definition.name)) {
    throw new HttpError(409, "harness_name_published",
      `'${definition.name}' is a published harness. Start it by name, or give the submitted definition another name.`, { path: "definition.name" });
  }
  if (definition.interaction !== "conversation") {
    throw new HttpError(422, "policy_rejected",
      "Submitted definitions start conversations: set interaction to \"conversation\". Batch harnesses must be published.", { path: "definition.interaction" });
  }
  const ajv = createAjv();
  for (const [label, schema] of [["input", definition.input.schema], ["output", definition.output.schema]] as const) {
    try {
      ajv.compile(schema);
    } catch (error) {
      throw new HttpError(400, "invalid_request", `The definition's ${label} schema is invalid: ${(error as Error).message}`, { path: `definition.${label}.schema` });
    }
  }
  return { definition, digest: `sha256:${sha256Hex(canonicalJson(definition))}` };
}

/** Refuses submitted definitions, including activating or connecting to their sessions, unless the base policy allows them. */
export function assertInlineAllowed(policies: PolicySet): void {
  if (policies.base.allowInlineHarnesses !== true) {
    throw new HttpError(403, "inline_harnesses_disabled",
      "This deployment does not accept submitted harness definitions. An operator can allow them with allowInlineHarnesses in the execution policy.",
      { prerequisite: { kind: "policy", name: "allowInlineHarnesses" } });
  }
}
