/**
 * Help content for every setting the configurator edits. Each topic explains what the setting does
 * in this service (not in the SDK in general), what each choice changes, and where the platform
 * enforces limits regardless of the harness.
 */
export interface HelpTopic {
  title: string;
  /** Field or option name as it appears in the files. */
  option?: string;
  /** Who owns the setting. */
  scope?: "Harness" | "Operator policy" | "Local machine" | "Azure target" | "Sub-agent" | "Skill";
  summary: string;
  effects?: Array<{ when: string; then: string }>;
  example?: string;
  boundary?: string;
}

export const help: Record<string, HelpTopic> = {
  // Harness identity
  "harness.name": {
    title: "Harness name",
    option: "name",
    scope: "Harness",
    summary: "The identifier callers use in POST /v1/jobs. Lowercase letters, digits and hyphens.",
    effects: [{ when: "Renaming", then: "Creates a different harness; callers using the old name get harness_not_found." }],
    example: '{ "harness": { "name": "insights-team" }, "input": { ... } }',
  },
  "harness.version": {
    title: "Version",
    option: "version",
    scope: "Harness",
    summary:
      "Semantic version of this published harness. Each version is immutable once deployed; jobs record the exact version and content digest they ran with.",
    effects: [
      { when: "Caller omits a version", then: "The highest published version runs." },
      { when: "Content changes without a bump", then: "The configurator warns: two different definitions would share one version." },
    ],
  },
  "harness.description": {
    title: "Description",
    option: "description",
    scope: "Harness",
    summary: "Shown in GET /v1/harnesses, the job console and Try it. Describe what the harness does and its input.",
  },
  "harness.instructions": {
    title: "Instructions",
    option: "instructionsFile",
    scope: "Harness",
    summary:
      "Your system instructions, stored as a Markdown file next to harness.json. The runner always appends a short result contract telling the agent to call submit_result.",
    boundary: "Instructions cannot grant tools, models or limits; those come from the harness fields and the operator policy.",
  },

  // Prompt
  "prompt.mode": {
    title: "Prompt mode",
    option: "prompt.mode",
    scope: "Harness",
    summary: "How your instructions combine with GitHub Copilot's foundation prompt (the Copilot agent's built-in system prompt).",
    effects: [
      { when: "Replace (default)", then: "Your instructions are the entire system prompt. Smallest and most predictable." },
      { when: "Append", then: "Copilot's foundation prompt (about 6.7 KB of agent guidance) comes first, then your instructions." },
      { when: "Customize", then: "The foundation prompt with chosen sections replaced, extended or removed, then your instructions." },
    ],
    boundary: "In every mode the session runs in empty mode with an explicit tool allowlist; the foundation prompt does not add tools.",
  },
  "prompt.sections": {
    title: "Prompt sections",
    option: "prompt.sections[]",
    scope: "Harness",
    summary: "Customize mode only. Change named sections of the foundation prompt; unlisted sections stay as Copilot ships them.",
    effects: [
      { when: "Replace", then: "Your text replaces the section." },
      { when: "Append / Prepend", then: "Your text is added after or before the section." },
      { when: "Remove", then: "The section is dropped (useful for code-editing guidance a data job does not need)." },
    ],
    example: '{ "name": "identity", "action": "replace", "content": "You are the lead analyst..." }',
  },

  // Model
  "model.preferred": {
    title: "Preferred model",
    option: "model.preferred",
    scope: "Harness",
    summary: "The model jobs use when the operator policy approves it. Must be one of the allowed models.",
    effects: [{ when: "Not approved by policy", then: "Jobs fall back to the first allowed model the policy approves." }],
    boundary: "The inference gateway only routes models in the job's capability token; the runner never sees provider credentials.",
  },
  "model.allowed": {
    title: "Allowed models",
    option: "model.allowed",
    scope: "Harness",
    summary: "Models this harness is known to work with. Admission picks the first one the operator policy also approves.",
  },
  "model.reasoningEffort": {
    title: "Reasoning effort",
    option: "model.reasoningEffort",
    scope: "Harness",
    summary: "Asks reasoning models to think more (higher) or less (lower) before answering. Leave unset to use the model default.",
    effects: [
      { when: "Higher", then: "Usually better answers on multi-step problems; more tokens and time." },
      { when: "Model without reasoning support", then: "The setting is ignored." },
    ],
    boundary: "Capped by the operator policy's maximum reasoning effort; jobs above the cap are rejected at admission.",
  },
  "model.contextTier": {
    title: "Context tier",
    option: "model.contextTier",
    scope: "Harness",
    summary: "Requests the model's long-context variant for large inputs.",
    boundary: "Allowed only when the operator policy enables long context.",
  },

  // Tools
  tools: {
    title: "Custom harness tools",
    option: "tools[]",
    scope: "Harness",
    summary:
      "Additional tools requested by binding; the execution profile supplies the implementation. submit_result is always added by the batch runner. An empty list does not disable Copilot built-ins.",
    boundary: "Every custom binding must be provided by each allowed execution profile. Copilot's built-in tools are enabled separately through policy-approved builtinTools groups.",
  },
  "tool.binding": {
    title: "Binding",
    option: "tools[].binding",
    scope: "Harness",
    summary: "Which implementation in the execution profile backs this tool, e.g. python:stats runs tools/python/stats.py.",
    effects: [{ when: "A profile lacks the binding", then: "Validation fails and admission rejects jobs for that profile." }],
  },
  "tool.delegatedOnly": {
    title: "Delegated only",
    option: "tools[].delegatedOnly",
    scope: "Harness",
    summary: "Hide the tool from the coordinating agent. Only sub-agents that list the tool can call it.",
    effects: [{ when: "On", then: "The coordinator must delegate to a sub-agent to use the tool. Requires at least one sub-agent that lists it." }],
  },

  // Agents
  agents: {
    title: "Custom sub-agents",
    option: "agents[]",
    scope: "Harness",
    summary:
      "Additional specialists the coordinating agent can delegate to. Each has its own instructions, a subset of the harness tools and skills, and optionally its own model. This list does not enumerate Copilot's built-in agents.",
    effects: [
      { when: "Any custom sub-agent defined", then: "The coordinator gets the task tool for delegation to those specialists." },
      { when: "Built-in agents group enabled", then: "Copilot's runtime-provided agents are available without custom definitions. An empty agents[] list does not disable them." },
      { when: "Built-in agents group disabled", then: "Only the configured custom sub-agents are enabled." },
    ],
    boundary: "Custom sub-agents use the declared tools and skills. Built-in availability depends on the installed runtime. Managed job permission rules, approved models and limits still apply.",
  },
  "agent.description": {
    title: "Description",
    option: "agents[].description",
    scope: "Sub-agent",
    summary: "What the coordinator reads to decide when to delegate. Say what the agent does and what to give it.",
  },
  "agent.instructions": {
    title: "Instructions",
    option: "agents[].instructions",
    scope: "Sub-agent",
    summary: "The sub-agent's own system prompt. It does not see the coordinator's instructions.",
  },
  "agent.tools": {
    title: "Tools",
    option: "agents[].tools",
    scope: "Sub-agent",
    summary: "Harness tools this sub-agent may call. Empty means it can only reason over what it is given.",
  },
  "agent.skills": {
    title: "Preloaded skills",
    option: "agents[].skills",
    scope: "Sub-agent",
    summary: "Skills injected into the sub-agent's context when it starts, so it follows them without loading them first.",
  },
  "agent.model": {
    title: "Model override",
    option: "agents[].model",
    scope: "Sub-agent",
    summary: "Run this sub-agent on a different allowed model, e.g. a smaller model for routine steps.",
    boundary: "Must be in the harness's allowed models and approved by the policy; the gateway grants it to the job.",
  },

  // Skills
  skills: {
    title: "Skills",
    option: "skills[]",
    scope: "Harness",
    summary:
      "Reusable instructions the agent loads by name when relevant. Stored as skills/<name>/SKILL.md in the harness folder and packaged into the published snapshot.",
    effects: [
      { when: "Coordinator", then: "Sees each skill's description and loads the body with the skill tool when needed." },
      { when: "Sub-agent with preloaded skills", then: "Gets the body in its context from the start." },
    ],
  },
  "skill.description": {
    title: "Skill description",
    option: "description (frontmatter)",
    scope: "Skill",
    summary: "The agent decides whether to load the skill from this sentence. Say when it applies.",
  },

  // Built-in tools and permissions
  builtinTools: {
    title: "Built-in Copilot tools",
    option: "builtinTools[]",
    scope: "Harness",
    summary:
      "GitHub Copilot's own tools, enabled in groups. They run in the runner container, in the attempt's private workspace, as an unprivileged user that only this executor slot uses.",
    effects: [
      { when: "Files", then: "view, glob, grep, create, edit and apply_patch in the workspace." },
      { when: "Shell", then: "Run commands (bash in the container), read their output, stop them." },
      { when: "Web", then: "Fetch URLs (web_fetch)." },
      { when: "Agents", then: "Copilot's built-in sub-agents (explore, general-purpose and others) and the task tools." },
    ],
    boundary:
      "Every action that the SDK asks permission for follows the harness permission rules. The operator policy decides which groups are allowed. The workspace is deleted after the attempt.",
  },
  "permissions.default": {
    title: "Permission rules",
    option: "permissions.default / permissions.kinds",
    scope: "Harness",
    summary: "What happens when the agent asks to read or write a file, run a shell command, or fetch a URL. Kinds you do not set use the default.",
    effects: [
      { when: "Deny", then: "The action is refused and the agent is told why. This is what harnesses without permissions do." },
      { when: "Ask", then: "Copilot CLI defaults: reads inside the workspace, read-only commands that stay in it and read-only MCP tools run. Anything else waits until the person who submitted the job approves or denies it in the job console or Try it." },
      { when: "Allow", then: "The action runs without review (yolo). Use only with disposable workspaces and trusted inputs." },
    ],
    example: '{ "default": "ask", "questions": true }',
    boundary:
      "Harness tools (bindings) never ask. The operator policy decides whether ask and allow can be used. Approving for the run covers similar requests only: the same command names, all file changes, reads in that folder, the same website, or the same tool.",
  },
  "permissions.questions": {
    title: "Questions",
    option: "permissions.questions",
    scope: "Harness",
    summary: "Gives the agent the ask_user tool. Its questions (free text or multiple choice) appear in the job console and Try it for the requester to answer.",
    boundary: "Unanswered questions expire; the agent is told to continue with its best judgement.",
  },
  "permissions.timeoutSeconds": {
    title: "Answer timeout",
    option: "permissions.timeoutSeconds",
    scope: "Harness",
    summary: "How long one approval or question waits for a person. When it expires the action is denied.",
    boundary: "Waiting counts toward the attempt deadline, so set the maximum duration high enough for people to respond.",
  },
  "policy.builtinTools": {
    title: "Allowed built-in tools",
    option: "builtinTools",
    scope: "Operator policy",
    summary: "Built-in Copilot tool groups harnesses may enable. Jobs from harnesses that use other groups are rejected at admission.",
  },
  "policy.permissionModes": {
    title: "Allowed permission modes",
    option: "permissionModes",
    scope: "Operator policy",
    summary: "Besides deny, whether harnesses may route actions to people (ask) or approve them automatically (allow).",
  },

  // Schemas
  "input.schema": {
    title: "Input schema",
    option: "input.schema",
    scope: "Harness",
    summary: "JSON Schema (2020-12) for the job input. The API rejects non-matching input with 400 before any agent runs.",
    effects: [{ when: "examples[]", then: "Prefill the job console and Try it, and are validated against the schema." }],
  },
  "output.schema": {
    title: "Output schema",
    option: "output.schema",
    scope: "Harness",
    summary: "JSON Schema for the result. The agent submits through submit_result, which rejects non-matching output so the agent can correct it.",
  },

  // Limits
  "limits.maxDurationSeconds": {
    title: "Maximum duration",
    option: "limits.maxDurationSeconds",
    scope: "Harness",
    summary: "Wall-clock deadline for one attempt. Callers can shorten it per job with deadlineSeconds.",
    boundary: "The effective value is the smallest of harness, caller and policy.",
  },
  "limits.maxInferenceTokens": {
    title: "Token budget",
    option: "limits.maxInferenceTokens",
    scope: "Harness",
    summary: "Total input plus output tokens per attempt. The gateway stops serving the job when the budget is spent.",
    boundary: "Capped by the policy's per-job token limit.",
  },
  "retry.safeToRetry": {
    title: "Safe to retry",
    option: "retry.safeToRetry",
    scope: "Harness",
    summary: "Whether an attempt with an uncertain outcome (lost executor, crash) can be re-run automatically.",
    effects: [
      { when: "On", then: "Uncertain attempts are retried up to the attempt limit." },
      { when: "Off", then: "Uncertain attempts end as needs_review for a person to check side effects." },
    ],
  },
  "retry.maxAttempts": {
    title: "Maximum attempts",
    option: "retry.maxAttempts",
    scope: "Harness",
    summary: "Attempts per job, including the first.",
    boundary: "Capped by the policy's retry limit.",
  },
  "runners.allowedProfiles": {
    title: "Execution profiles",
    option: "runners.allowedProfiles",
    scope: "Harness",
    summary: "Runner images this harness may run on (for example the TypeScript reference runner or a customer Python runner).",
    boundary: "Each profile must provide every tool binding and runner capability the harness needs, and be approved by the policy.",
  },
  "runners.defaultProfile": {
    title: "Default profile",
    option: "runners.defaultProfile",
    scope: "Harness",
    summary: "Used when the caller does not pick a profile.",
  },

  // Policy
  "policy.scope": {
    title: "Base policy and harness overrides",
    option: "policy/execution-policy.json, policy/harnesses/<harness>.json",
    scope: "Operator policy",
    summary:
      "The base policy applies to every harness. An override file for one harness replaces whole cards (agents and models, limits, tools and permissions, model options, required controls) for every version of that harness; everything else is inherited.",
    effects: [
      { when: "Base policy", then: "Edits apply to all harnesses without an override for that setting." },
      { when: "A harness", then: "Turn on Override for this harness on a card to replace those settings. Turning every card off removes the override file." },
    ],
    boundary:
      "Lease timing and per-caller limits are always global. Harness definitions cannot select a policy. The job API refuses to start when an override names a harness that does not exist. Jobs record the digest of the effective policy that admitted them.",
  },
  "policy.allowedProfiles": {
    title: "Approved profiles",
    option: "allowedProfiles",
    scope: "Operator policy",
    summary: "Execution profiles executors may run. Harnesses can only narrow this list.",
  },
  "policy.allowedModels": {
    title: "Approved models",
    option: "allowedModels",
    scope: "Operator policy",
    summary: "Models any job may use. The gateway also needs a route for each.",
  },
  "policy.maxDurationSeconds": {
    title: "Maximum duration",
    option: "maxDurationSeconds",
    scope: "Operator policy",
    summary: "Upper bound on any attempt's duration across all harnesses.",
  },
  "policy.maxInferenceTokensPerJob": {
    title: "Token ceiling per job",
    option: "maxInferenceTokensPerJob",
    scope: "Operator policy",
    summary: "Upper bound on any harness's token budget.",
  },
  "policy.maxConcurrentAttemptsPerPrincipal": {
    title: "Concurrent attempts per caller",
    option: "maxConcurrentAttemptsPerPrincipal",
    scope: "Operator policy",
    summary: "How many attempts one caller can have running at once; extra jobs wait in the queue.",
  },
  "policy.maxQueuedJobsPerPrincipal": {
    title: "Queued jobs per caller",
    option: "maxQueuedJobsPerPrincipal",
    scope: "Operator policy",
    summary: "Submissions beyond this are rejected with 429.",
  },
  "policy.retry": {
    title: "Retry ceiling and backoff",
    option: "retry.maxAttempts / retry.backoffSeconds",
    scope: "Operator policy",
    summary: "Upper bound on attempts per job and the delay before a retry.",
  },
  "policy.leaseSeconds": {
    title: "Lease",
    option: "leaseSeconds",
    scope: "Operator policy",
    summary: "How long an executor owns an attempt without a heartbeat before the dispatcher treats it as lost.",
  },
  "policy.processIsolation": {
    title: "Process isolation",
    option: "requirements.processIsolation",
    scope: "Operator policy",
    summary: "Whether runners must run as a separate unprivileged user from the executor.",
    effects: [{ when: "uid", then: "Runners cannot read the executor's credentials or other jobs' workspaces." }],
  },
  "policy.egress": {
    title: "Egress",
    option: "requirements.egress",
    scope: "Operator policy",
    summary: "Whether runner network access must be limited to the inference gateway.",
    boundary:
      "No shipped executor enforces gateway-only egress. Jobs whose effective policy requires it are only claimed when that policy acknowledges the gap; otherwise they stay queued and record that they are waiting for an eligible executor.",
  },
  "policy.acknowledgedGaps": {
    title: "Acknowledged gaps",
    option: "acknowledgedGaps",
    scope: "Operator policy",
    summary: "Requirements you accept are not enforced by the executor that runs a job. Every attempt records the gaps it ran with.",
  },
  "policy.maxReasoningEffort": {
    title: "Maximum reasoning effort",
    option: "maxReasoningEffort",
    scope: "Operator policy",
    summary: "Highest reasoning effort a harness or sub-agent may request. Unset means no cap.",
  },
  "policy.allowLongContext": {
    title: "Allow long context",
    option: "allowLongContext",
    scope: "Operator policy",
    summary: "Whether harnesses may request the long-context model tier.",
  },

  // Local
  "local.foundryEndpoint": {
    title: "Foundry endpoint",
    option: "Parameters:foundry-endpoint",
    scope: "Local machine",
    summary: "The Azure AI Foundry (OpenAI-compatible) endpoint the local inference gateway calls, using your Azure CLI sign-in.",
    example: "https://<account>.openai.azure.com/openai/v1",
  },
  "local.foundryDeployments": {
    title: "Foundry deployments",
    option: "Parameters:foundry-deployments",
    scope: "Local machine",
    summary: "Model deployment names the gateway routes. Each should match a model in the policy.",
  },
  "local.registries": {
    title: "Package registries",
    option: "npm / pip / NuGet",
    scope: "Local machine",
    summary: "Mirror or proxy feeds used when building images and restoring the Aspire CLI. Leave empty to use public registries.",
  },

  // Target
  "target.subscription": {
    title: "Subscription and tenant",
    option: "Azure__SubscriptionId / Azure__TenantId",
    scope: "Azure target",
    summary: "Where aspire deploy creates the Container Apps environment, registry, Postgres and identities.",
  },
  "target.resourceGroup": {
    title: "Resource group and location",
    option: "Azure__ResourceGroup / Azure__Location",
    scope: "Azure target",
    summary: "Created if missing. All platform resources go here.",
  },
  "target.foundry": {
    title: "Model provider",
    option: "foundry-*",
    scope: "Azure target",
    summary: "An existing Foundry account. The deployed gateway's managed identity is granted access to call it.",
  },
};
