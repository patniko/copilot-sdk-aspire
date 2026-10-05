import { BUILTIN_TOOL_GROUPS, type BuiltinToolGroup, PROMPT_SECTIONS, REASONING_EFFORTS, SLUG } from "@copilot-agent/contracts";
import { createFromTemplate } from "./templates.js";
import type { ExecutionPolicy, HarnessDocument, ImportReport, ProfileSummary } from "./types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function slugify(value: string | undefined, fallback: string): string {
  let slug = (value ?? fallback)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!slug || !/^[a-z]/.test(slug)) {
    slug = `h-${slug || fallback}`;
  }
  if (slug.length < 2) {
    slug = `${slug}-h`;
  }
  slug = slug.slice(0, 63).replace(/-+$/g, "");
  return SLUG.test(slug) ? slug : fallback;
}

function uniqueSlug(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `-${index++}`;
    candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function effortAllowed(effort: string, cap: string | undefined): boolean {
  if (!cap) {
    return true;
  }
  return REASONING_EFFORTS.indexOf(effort as never) <= REASONING_EFFORTS.indexOf(cap as never);
}

function approvedProfiles(policy: ExecutionPolicy, profiles: ProfileSummary[]): string[] {
  const approved = profiles.filter((profile) => policy.allowedProfiles.includes(profile.id)).map((profile) => profile.id);
  return approved.length ? approved : policy.allowedProfiles;
}

function addOnce(items: string[], message: string): void {
  if (!items.includes(message)) {
    items.push(message);
  }
}

export function mapPlannerPlan(
  plan: JsonObject,
  nameOverride: string | undefined,
  policy: ExecutionPolicy,
  profiles: ProfileSummary[],
): { document: HarnessDocument; report: ImportReport } {
  const report: ImportReport = { mapped: [], needsWork: [], notApplicable: [] };
  const displayName = text(nameOverride) ?? text(plan.name) ?? "imported harness";
  const name = slugify(displayName, "imported-harness");
  const modelPlan = isObject(plan.model) ? plan.model : {};
  const requestedModel = text(modelPlan.id);
  const model = requestedModel && policy.allowedModels.includes(requestedModel) ? requestedModel : (policy.allowedModels[0] ?? "gpt-4.1");
  if (requestedModel && requestedModel !== model) {
    report.needsWork.push(`Model '${requestedModel}' is not approved by the operator policy; using '${model}'.`);
  } else if (requestedModel) {
    report.mapped.push(`Model '${requestedModel}' was carried into the harness.`);
  }

  const document = createFromTemplate("structured-answer", name, model, approvedProfiles(policy, profiles));
  document.manifest.description = `Imported from Harness Builder plan '${displayName}'.`;
  document.manifest.version = document.manifest.version || "1.0.0";
  document.skills = [];

  mapPrompt(plan, document, report);
  mapModelOptions(modelPlan, document, policy, report);
  mapAgents(plan, document, policy, report);
  mapBuiltinToolsAndPermissions(plan, document, policy, report);
  mapUnsupportedFields(plan, report);
  report.needsWork.push("Define the job input and output schemas.");

  return { document, report };
}

const TOOL_GROUPS: Record<string, BuiltinToolGroup> = {
  view: "files",
  glob: "files",
  grep: "files",
  create: "files",
  edit: "files",
  apply_patch: "files",
  str_replace_editor: "files",
  bash: "shell",
  read_bash: "shell",
  write_bash: "shell",
  stop_bash: "shell",
  list_bash: "shell",
  powershell: "shell",
  read_powershell: "shell",
  write_powershell: "shell",
  stop_powershell: "shell",
  list_powershell: "shell",
  web_fetch: "web",
  web_search: "web",
  task: "agents",
  read_agent: "agents",
  list_agents: "agents",
  write_agent: "agents",
};

/** Built-in tools the plan kept become tool groups; its permission mode becomes harness permissions. */
function mapBuiltinToolsAndPermissions(plan: JsonObject, document: HarnessDocument, policy: ExecutionPolicy, report: ImportReport): void {
  const groups = new Set<BuiltinToolGroup>();
  let questions = false;
  let overrides = 0;
  if (isObject(plan.tools)) {
    for (const [toolName, raw] of Object.entries(plan.tools)) {
      if (!isObject(raw) || (raw.action !== "keep" && raw.action !== "override")) continue;
      if (raw.action === "override") overrides += 1;
      if (toolName === "ask_user") questions = true;
      const group = TOOL_GROUPS[toolName];
      if (group) groups.add(group);
    }
  }
  if (plan.inventory === "coding-defaults" || plan.clientMode === "copilot-cli") {
    for (const group of BUILTIN_TOOL_GROUPS) groups.add(group);
    questions = true;
  }
  if (overrides > 0) {
    report.needsWork.push(`${overrides} built-in tool override(s) are not supported; the built-in implementations are used.`);
  }
  const allowedGroups = new Set(policy.builtinTools ?? []);
  const kept = BUILTIN_TOOL_GROUPS.filter((group) => groups.has(group) && allowedGroups.has(group));
  const blocked = BUILTIN_TOOL_GROUPS.filter((group) => groups.has(group) && !allowedGroups.has(group));
  if (blocked.length > 0) {
    report.needsWork.push(`Built-in tool groups not allowed by the operator policy were dropped: ${blocked.join(", ")}.`);
  }
  if (kept.length > 0) {
    document.manifest.builtinTools = kept;
    report.mapped.push(`Built-in tools were carried into the harness as groups: ${kept.join(", ")}.`);
  }

  const planPolicy = isObject(plan.policy) ? plan.policy : {};
  const permissionMode = text(planPolicy.permissionMode);
  const modes = new Set(policy.permissionModes ?? []);
  if (kept.length === 0 && !questions && !permissionMode) return;
  if (permissionMode === "allow-all") {
    if (modes.has("allow")) {
      document.manifest.permissions = { default: "allow", ...(questions && modes.has("ask") ? { questions: true } : {}) };
      report.mapped.push("Permission mode allow-all became permissions that approve every action automatically.");
    } else if (modes.has("ask")) {
      document.manifest.permissions = { default: "ask", kinds: { read: "ask" }, ...(questions ? { questions: true } : {}) };
      report.needsWork.push("Permission mode allow-all is not allowed by the operator policy; every action asks the requester instead.");
    } else {
      report.needsWork.push("Permission mode allow-all is not allowed by the operator policy; built-in tool actions will be denied.");
    }
  } else if (modes.has("ask")) {
    document.manifest.permissions = {
      default: "ask",
      kinds: { read: modes.has("allow") ? "allow" : "ask", write: "ask", shell: "ask", url: "ask" },
      ...(questions ? { questions: true } : {}),
    };
    report.mapped.push(
      permissionMode === "host"
        ? "Permission mode host became approvals routed to the requester (reads are allowed)."
        : "Built-in tool actions ask the requester before running (reads are allowed).",
    );
  } else if (kept.length > 0) {
    report.needsWork.push("The operator policy does not allow the ask or allow permission modes, so built-in tool actions will be denied.");
  }
  if (document.manifest.permissions) {
    document.manifest.retry = { ...document.manifest.retry, safeToRetry: false, maxAttempts: 1 };
  }
  if (planPolicy.preToolHook === true || planPolicy.postToolHook === true) {
    report.notApplicable.push("Pre- and post-tool hooks are not supported by hosted harness sessions.");
  }
}

function mapPrompt(plan: JsonObject, document: HarnessDocument, report: ImportReport): void {
  const prompt = isObject(plan.prompt) ? plan.prompt : {};
  const mode = text(prompt.mode);
  const content = typeof prompt.content === "string" ? prompt.content.trim() : "";
  document.instructions = content || "Describe the task for this harness.";
  if (content) {
    report.mapped.push("Prompt content became the harness instructions.");
  } else {
    report.needsWork.push("Prompt content was empty; add task-specific instructions.");
  }

  if (mode === "default") {
    document.manifest.prompt = { mode: "append" };
    report.mapped.push("Prompt mode default used Copilot's prompt; mapped to append.");
    return;
  }
  if (mode === "replace" || mode === "append") {
    document.manifest.prompt = { mode };
    report.mapped.push(`Prompt mode '${mode}' was carried into the harness.`);
    return;
  }
  if (mode === "customize") {
    const sections: NonNullable<HarnessDocument["manifest"]["prompt"]>["sections"] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(prompt.sections) ? prompt.sections : []) {
      if (!isObject(raw)) {
        continue;
      }
      const sectionName = text(raw.name);
      const action = text(raw.action);
      if (action === "preserve") {
        report.notApplicable.push(`Prompt section '${sectionName ?? "unknown"}': preserve is the default.`);
        continue;
      }
      if (!sectionName || !PROMPT_SECTIONS.includes(sectionName as never)) {
        report.needsWork.push(`Prompt section '${sectionName ?? "unknown"}' is not a supported foundation prompt section.`);
        continue;
      }
      if (seen.has(sectionName)) {
        report.needsWork.push(`Prompt section '${sectionName}' was repeated; keep one edit.`);
        continue;
      }
      if (action !== "replace" && action !== "append" && action !== "prepend" && action !== "remove") {
        report.needsWork.push(`Prompt section '${sectionName}' uses unsupported action '${action ?? "unknown"}'.`);
        continue;
      }
      const sectionContent = typeof raw.content === "string" ? raw.content.trim() : "";
      if (action !== "remove" && !sectionContent) {
        report.needsWork.push(`Prompt section '${sectionName}' needs content for '${action}'.`);
        continue;
      }
      seen.add(sectionName);
      sections.push({
        name: sectionName as NonNullable<typeof sections>[number]["name"],
        action: action as NonNullable<typeof sections>[number]["action"],
        content: action === "remove" ? "" : sectionContent,
      });
    }
    document.manifest.prompt = { mode: "customize", ...(sections.length ? { sections } : {}) };
    report.mapped.push("Prompt customization was carried into the harness.");
    return;
  }
  if (mode) {
    report.needsWork.push(`Prompt mode '${mode}' is not supported; using replace.`);
  }
  document.manifest.prompt = { mode: "replace" };
}

function mapModelOptions(
  modelPlan: JsonObject,
  document: HarnessDocument,
  policy: ExecutionPolicy,
  report: ImportReport,
): void {
  const connectionFields = ["provider", "endpoint", "credential", "credentialEnv", "wireApi"].filter((key) => has(modelPlan, key));
  if (connectionFields.length > 0) {
    report.notApplicable.push("Model provider, endpoint, credential and wire API are owned by the inference gateway.");
  }

  const effort = text(modelPlan.reasoningEffort);
  if (effort && effort !== "default") {
    if (!REASONING_EFFORTS.includes(effort as never)) {
      report.needsWork.push(`Reasoning effort '${effort}' is not supported.`);
    } else {
      const selected = effortAllowed(effort, policy.maxReasoningEffort) ? effort : policy.maxReasoningEffort!;
      if (selected !== effort) {
        report.needsWork.push(`Reasoning effort '${effort}' exceeds the policy maximum; using '${selected}'.`);
      }
      document.manifest.model = { ...document.manifest.model, reasoningEffort: selected as never };
      report.mapped.push(`Reasoning effort '${selected}' was carried into the harness.`);
    }
  }

  const contextTier = text(modelPlan.contextTier);
  if (contextTier === "long_context") {
    if (policy.allowLongContext) {
      document.manifest.model = { ...document.manifest.model, contextTier };
      report.mapped.push("Long-context tier was carried into the harness.");
    } else {
      report.needsWork.push("Long-context tier is not approved by the operator policy.");
    }
  }
}

function mapAgents(plan: JsonObject, document: HarnessDocument, policy: ExecutionPolicy, report: ImportReport): void {
  if (!Array.isArray(plan.agents)) {
    return;
  }
  const used = new Set<string>();
  const agents = [];
  for (const [index, raw] of plan.agents.entries()) {
    if (!isObject(raw)) {
      continue;
    }
    const rawName = text(raw.name) ?? text(raw.id) ?? `agent-${index + 1}`;
    const name = uniqueSlug(slugify(rawName, `agent-${index + 1}`), used);
    const agent = {
      name,
      description: text(raw.description) ?? "Imported sub-agent.",
      instructions: text(raw.prompt) ?? "Describe this sub-agent's task.",
      tools: [] as string[],
    } as NonNullable<HarnessDocument["manifest"]["agents"]>[number];
    const agentModel = text(raw.model);
    if (agentModel && policy.allowedModels.includes(agentModel)) {
      agent.model = agentModel;
    } else if (agentModel) {
      report.needsWork.push(`Sub-agent ${name}: model '${agentModel}' is not approved and was dropped.`);
    }
    const requestedTools = Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim() !== "") : [];
    if (requestedTools.length > 0) {
      report.needsWork.push(`Sub-agent ${name}: tools ${requestedTools.join(", ")} need harness tool bindings.`);
    }
    agents.push(agent);
  }
  if (agents.length > 0) {
    document.manifest.agents = agents;
    report.mapped.push(`${agents.length} sub-agent${agents.length === 1 ? " was" : "s were"} carried into the harness.`);
  }
}

function mapUnsupportedFields(plan: JsonObject, report: ImportReport): void {
  const customTools = Array.isArray(plan.customTools) ? plan.customTools : [];
  for (const raw of customTools) {
    const name = isObject(raw) ? (text(raw.name) ?? text(raw.id) ?? "unnamed") : "unnamed";
    report.needsWork.push(`Custom tool '${name}' needs an implementation binding in an execution profile (host or Python).`);
  }

  const mcpServers = Array.isArray(plan.mcpServers) ? plan.mcpServers : [];
  for (const raw of mcpServers) {
    const name = isObject(raw) ? (text(raw.name) ?? text(raw.id) ?? "unnamed") : "unnamed";
    report.needsWork.push(`MCP server '${name}' is not supported by harness sessions yet.`);
  }

  if (has(plan, "rootExcludedTools")) {
    report.notApplicable.push("Root excluded tools are a Harness Builder UI setting; harness sessions expose only listed tools.");
  }
  if (has(plan, "context")) {
    report.notApplicable.push("Skills are packaged inside the harness folder; add them in the Skills tab.");
  }
  const fieldNotes: Record<string, string> = {
    preset: "Presets are builder UI shortcuts; the harness stores explicit fields.",
    clientMode: "Client mode is not part of hosted harness sessions; built-in tools are listed explicitly.",
    inventory: "Inventory and discovery data are not deployed with a harness.",
    identity: "Runtime identity comes from the caller and the gateway.",
    session: "Session settings are client behavior, not harness definition.",
    events: "Event wiring is implemented by the hosted runner.",
    target: "Deployment targets are configured outside the harness.",
    evaluation: "Evaluation settings are not part of the runtime harness definition.",
    selectedAgent: "Selected agent is builder UI state; hosted jobs start with the coordinator.",
  };
  for (const [field, note] of Object.entries(fieldNotes)) {
    if (has(plan, field)) {
      addOnce(report.notApplicable, note);
    }
  }
}
