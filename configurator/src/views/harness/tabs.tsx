import clsx from "clsx";
import type { ReactNode } from "react";
import type { BuiltinToolGroup } from "@copilot-agent/contracts";
import type { HarnessDetail, HarnessDocument, HarnessManifest, Issue, SkillDefinition } from "../../../server/types";
import { DecisionList } from "../../components/LivePlan";
import { ArrowRight, Copilot, Plus, Trash2, Wrench } from "../../components/icons";
import { Badge, ChipsInput, Empty, Field, Flash, HelpButton, IssueList, JsonEditor, NumberInput, SegmentedControl, Toggle } from "../../components/ui";
import { useApp } from "../../state";

export type Tab = "overview" | "prompt" | "model" | "tools" | "permissions" | "agents" | "skills" | "input" | "output" | "limits" | "runtime";
export const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "prompt", label: "Prompt" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools" },
  { id: "permissions", label: "Permissions" },
  { id: "agents", label: "Sub-agents" },
  { id: "skills", label: "Skills" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "limits", label: "Limits & retry" },
  { id: "runtime", label: "Runtime" },
];

export function tabFor(path: string): Tab {
  switch (path.split(".")[0]) {
    case "instructions":
    case "instructionsFile":
    case "prompt":
      return "prompt";
    case "model":
      return "model";
    case "tools":
    case "builtinTools":
      return "tools";
    case "permissions":
      return "permissions";
    case "agents":
      return "agents";
    case "skills":
      return "skills";
    case "input":
      return "input";
    case "output":
      return "output";
    case "limits":
    case "retry":
      return "limits";
    case "runners":
      return "runtime";
    default:
      return "overview";
  }
}

export type Update = (mutate: (d: HarnessDocument) => void, key?: string) => void;

const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const SECTIONS: Array<{ name: string; label: string; about: string }> = [
  { name: "preamble", label: "Preamble", about: "Opening framing of the prompt." },
  { name: "identity", label: "Identity", about: "Who the agent is (GitHub Copilot by default)." },
  { name: "tone", label: "Tone", about: "Response style and length." },
  { name: "tool_efficiency", label: "Tool efficiency", about: "Guidance on batching and parallel tool calls." },
  { name: "environment_context", label: "Environment context", about: "Working directory, OS and session details." },
  { name: "code_change_rules", label: "Code change rules", about: "Rules for editing code and files." },
  { name: "guidelines", label: "Guidelines", about: "General working guidelines." },
  { name: "safety", label: "Safety", about: "Safety and content rules." },
  { name: "tool_instructions", label: "Tool instructions", about: "Usage notes for the available tools." },
  { name: "custom_instructions", label: "Custom instructions", about: "Repository instructions (discovery is off in jobs)." },
  { name: "runtime_instructions", label: "Runtime instructions", about: "Notes supplied by the runtime host." },
  { name: "last_instructions", label: "Last instructions", about: "Final reminders at the end of the prompt." },
];

export function HarnessTab({ tab, draft, update, issues, effective, detail }: {
  tab: Tab;
  draft: HarnessDocument;
  update: Update;
  issues: Issue[];
  effective?: HarnessDetail["effective"];
  detail?: Pick<HarnessDetail, "decisions" | "requiredCapabilities"> & Partial<Pick<HarnessDetail, "policy">>;
}) {
  const { workspace } = useApp();
  const m = draft.manifest;
  const policy = workspace!.policy;
  const errorAt = (prefix: string) => issues.find((i) => i.level === "error" && (i.path === prefix || i.path.startsWith(`${prefix}.`)))?.message;
  const set = (mutate: (x: HarnessManifest) => void, key?: string) => update((d) => mutate(d.manifest), key);

  switch (tab) {
    case "overview":
      return (
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" help="harness.name" hint="Create a new harness to use a different name.">
              <input className="input" value={m.name} disabled />
            </Field>
            <Field label="Version" help="harness.version" error={errorAt("version")} hint="Change the version, then save to keep both versions or replace the selected one.">
              <input className="input font-mono" value={m.version} onChange={(e) => set((x) => void (x.version = e.target.value), "version")} />
            </Field>
            <Field label="Description" help="harness.description" className="md:col-span-2" error={errorAt("description")}>
              <textarea className="input" rows={3} value={m.description} onChange={(e) => set((x) => void (x.description = e.target.value), "description")} />
            </Field>
          </div>
          <div className="card grid grid-cols-2 gap-px overflow-hidden bg-[var(--borderColor-muted)] sm:grid-cols-4">
            <Summary label="Model" value={effective?.model ?? "not approved"} detail={m.model.reasoningEffort ? `reasoning ${m.model.reasoningEffort}` : undefined} />
            <Summary label="Prompt" value={m.prompt?.mode ?? "replace"} detail={m.prompt?.sections?.length ? `${m.prompt.sections.length} section(s) changed` : undefined} />
            <Summary label="Custom tools" value={`${m.tools.length} + submit_result`} detail={m.tools.some((t) => t.delegatedOnly) ? "some delegated only" : undefined} />
            <Summary label="Built-in tools" value={m.builtinTools?.length ? m.builtinTools.join(", ") : "none"} detail={permissionSummary(m.permissions)} />
            <Summary label="Sub-agents" value={`${m.agents?.length ?? 0} custom${m.builtinTools?.includes("agents") ? " + built-ins" : ""}`} detail={m.agents?.map((a) => a.displayName ?? a.name).join(", ")} />
            <Summary label="Skills" value={String(draft.skills.length)} detail={draft.skills.map((s) => s.name).join(", ")} />
            <Summary label="Runtime" value={m.runners.allowedProfiles.join(", ") || "none"} detail={`default ${m.runners.defaultProfile}`} />
            <Summary
              label="Limits"
              value={`${effective?.maxDurationSeconds ?? "?"}s · ${effective?.maxAttempts ?? "?"} attempt(s)`}
              detail={`${effective?.tokenBudget?.toLocaleString() ?? "?"} tokens · ${m.retry.safeToRetry ? "safe to retry" : "review on uncertainty"}${detail?.policy?.overridden.length ? " · harness policy override" : ""}`}
            />
          </div>
          {detail && detail.decisions.length > 0 && (
            <div className="2xl:hidden">
              <h3 className="mb-2 text-sm font-semibold">What the platform does with this harness</h3>
              <DecisionList decisions={detail.decisions} />
            </div>
          )}
        </div>
      );

    case "prompt":
      return <PromptTab draft={draft} update={update} errorAt={errorAt} />;

    case "model": {
      const cap = policy.maxReasoningEffort;
      const capIndex = cap ? EFFORTS.indexOf(cap) : EFFORTS.length - 1;
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Preferred model" help="model.preferred" error={errorAt("model.preferred") ?? errorAt("model")}>
            <input
              className="input"
              list="approved-models"
              value={m.model.preferred}
              onChange={(e) =>
                set((x) => {
                  x.model.preferred = e.target.value;
                  if (e.target.value && !x.model.allowed.includes(e.target.value)) x.model.allowed = [e.target.value, ...x.model.allowed];
                }, "model.preferred")
              }
            />
            <datalist id="approved-models">
              {policy.allowedModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </Field>
          <Field label="Allowed models" help="model.allowed" hint="Fallbacks in order. Only policy-approved models can run.">
            <ChipsInput values={m.model.allowed} onChange={(values) => set((x) => void (x.model.allowed = values))} suggestions={policy.allowedModels} />
          </Field>
          <Field label="Reasoning effort" help="model.reasoningEffort" hint={cap ? `Policy maximum: ${cap}.` : "No policy cap."} error={errorAt("model.reasoningEffort")}>
            <select
              className="input"
              value={m.model.reasoningEffort ?? ""}
              onChange={(e) =>
                set((x) => {
                  if (e.target.value) x.model.reasoningEffort = e.target.value as (typeof EFFORTS)[number];
                  else delete x.model.reasoningEffort;
                })
              }
            >
              <option value="">Model default</option>
              {EFFORTS.map((effort, index) => (
                <option key={effort} value={effort} disabled={index > capIndex}>
                  {effort}
                  {index > capIndex ? " (above policy cap)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Context tier"
            help="model.contextTier"
            hint={policy.allowLongContext ? "Long context is allowed by policy." : "The policy does not allow long context."}
            error={errorAt("model.contextTier")}
          >
            <select
              className="input"
              value={m.model.contextTier ?? ""}
              onChange={(e) =>
                set((x) => {
                  if (e.target.value) x.model.contextTier = e.target.value as "default" | "long_context";
                  else delete x.model.contextTier;
                })
              }
            >
              <option value="">Model default</option>
              <option value="default">default</option>
              <option value="long_context" disabled={!policy.allowLongContext}>
                long_context{policy.allowLongContext ? "" : " (not allowed by policy)"}
              </option>
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-1 text-xs fg-muted md:col-span-2">
            Policy-approved models:
            {policy.allowedModels.map((model) => (
              <Badge key={model} tone="green">
                {model}
              </Badge>
            ))}
            <span>Served by the inference gateway from the Foundry deployments configured for each environment.</span>
          </div>
        </div>
      );
    }

    case "tools":
      return <ToolsTab draft={draft} update={update} issues={issues} />;
    case "permissions":
      return <PermissionsTab draft={draft} update={update} issues={issues} effective={effective} />;
    case "agents":
      return <AgentsTab draft={draft} update={update} issues={issues} />;
    case "skills":
      return <SkillsTab draft={draft} update={update} issues={issues} />;

    case "input": {
      const schema = m.input.schema as Record<string, unknown>;
      const examples = Array.isArray(schema.examples) ? schema.examples : [];
      const { examples: _examples, ...schemaWithoutExamples } = schema;
      const exampleError = errorAt("input.schema.examples");
      const schemaError = issues.find((i) => i.level === "error" && i.path === "input.schema")?.message;
      return (
        <div className="grid gap-4 xl:grid-cols-2">
          <Field label="Input schema (JSON Schema 2020-12)" help="input.schema" hint="Jobs whose input does not match are rejected before queuing." error={schemaError}>
            <JsonEditor
              rows={22}
              value={schemaWithoutExamples}
              onChange={(value) => set((x) => void (x.input.schema = { ...(value as object), ...(examples.length ? { examples } : {}) }), "input.schema")}
            />
          </Field>
          <Field label="Example input" hint="Prefills Try it and the job console. Must match the schema." error={exampleError}>
            <JsonEditor
              rows={22}
              value={examples[0] ?? {}}
              onChange={(value) => set((x) => void (x.input.schema = { ...(x.input.schema as object), examples: [value, ...examples.slice(1)] }), "input.example")}
            />
          </Field>
        </div>
      );
    }
    case "output":
      return (
        <Field
          label="Output schema (JSON Schema 2020-12)"
          help="output.schema"
          hint="Becomes the parameters of the agent's submit_result tool, and is validated again by the executor."
          error={errorAt("output")}
        >
          <JsonEditor rows={24} value={m.output.schema} onChange={(value) => set((x) => void (x.output.schema = value as Record<string, unknown>), "output.schema")} />
        </Field>
      );
    case "limits":
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Max duration per attempt (seconds)"
            help="limits.maxDurationSeconds"
            hint={`Effective: ${effective?.maxDurationSeconds ?? "?"}s (policy max ${policy.maxDurationSeconds}s).`}
            error={errorAt("limits.maxDurationSeconds")}
          >
            <NumberInput value={m.limits.maxDurationSeconds} min={10} max={3600} onChange={(v) => set((x) => void (x.limits.maxDurationSeconds = v), "limits.duration")} />
          </Field>
          <Field
            label="Inference token budget per job"
            help="limits.maxInferenceTokens"
            hint={`Effective: ${effective?.tokenBudget?.toLocaleString() ?? "?"} (policy max ${policy.maxInferenceTokensPerJob.toLocaleString()}).`}
            error={errorAt("limits.maxInferenceTokens")}
          >
            <NumberInput value={m.limits.maxInferenceTokens} min={1000} step={1000} onChange={(v) => set((x) => void (x.limits.maxInferenceTokens = v), "limits.tokens")} />
          </Field>
          <Field label="Max attempts" help="retry.maxAttempts" hint={`Effective: ${effective?.maxAttempts ?? "?"} (policy max ${policy.retry.maxAttempts}).`} error={errorAt("retry.maxAttempts")}>
            <NumberInput value={m.retry.maxAttempts} min={1} max={5} onChange={(v) => set((x) => void (x.retry.maxAttempts = v), "retry.attempts")} />
          </Field>
          <div className="pt-6">
            <Toggle
              checked={m.retry.safeToRetry}
              onChange={(checked) => set((x) => void (x.retry.safeToRetry = checked))}
              label="Safe to retry after an uncertain outcome"
              help="retry.safeToRetry"
              description="Only for read-only work. Otherwise a lost executor sends the job to needs_review instead of retrying."
            />
          </div>
        </div>
      );
    case "runtime":
      return <RuntimeTab draft={draft} update={update} issues={issues} required={detail?.requiredCapabilities ?? []} />;
  }
}

function Summary({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-[var(--bgColor-default)] p-3">
      <div className="section-label">{label}</div>
      <div className="truncate font-semibold" title={value}>
        {value}
      </div>
      {detail && (
        <div className="truncate text-xs fg-muted" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function PromptTab({ draft, update, errorAt }: { draft: HarnessDocument; update: Update; errorAt: (prefix: string) => string | undefined }) {
  const m = draft.manifest;
  const mode = m.prompt?.mode ?? "replace";
  const sections = m.prompt?.sections ?? [];
  const setMode = (next: "replace" | "append" | "customize") =>
    update((d) => {
      if (next === "replace") delete d.manifest.prompt;
      else if (next === "append") d.manifest.prompt = { mode: "append" };
      else d.manifest.prompt = { mode: "customize", sections: d.manifest.prompt?.sections ?? [] };
    });
  const setSection = (name: string, action: string, content?: string) =>
    update(
      (d) => {
        const existing = d.manifest.prompt?.sections?.find((s) => s.name === name);
        const list = (d.manifest.prompt?.sections ?? []).filter((s) => s.name !== name);
        if (action !== "keep") {
          list.push({ name: name as never, action: action as never, content: content ?? existing?.content ?? "" });
        }
        const order = SECTIONS.map((s) => s.name);
        list.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
        d.manifest.prompt = { mode: "customize", sections: list };
      },
      content !== undefined ? `section.${name}` : undefined,
    );

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex items-center gap-1">
          <span className="label !mb-0">Prompt mode</span>
          <HelpButton topic="prompt.mode" />
        </div>
        <SegmentedControl
          label="Prompt mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "replace", label: "Replace" },
            { value: "append", label: "Append" },
            { value: "customize", label: "Customize" },
          ]}
        />
        <PromptOrder mode={mode} changed={sections.length} file={m.instructionsFile} />
      </div>

      {mode === "customize" && (
        <div className="card">
          <div className="box-header">
            <div>
              <h3 className="flex items-center gap-1 text-sm font-semibold leading-6">
                Foundation prompt sections <HelpButton topic="prompt.sections" />
              </h3>
              <p className="text-xs fg-muted">Sections left on “Keep” stay as Copilot ships them.</p>
            </div>
            <Badge tone="done">{sections.length} changed</Badge>
          </div>
          {SECTIONS.map((section) => {
            const current = sections.find((s) => s.name === section.name);
            const action = current?.action ?? "keep";
            const sectionIndex = sections.findIndex((s) => s.name === section.name);
            const error = sectionIndex >= 0 ? errorAt(`prompt.sections.${sectionIndex}`) : undefined;
            return (
              <div key={section.name} className="box-row">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-[200px] flex-1">
                    <div className="font-semibold">
                      {section.label} <code className="ml-1 text-[11px] fg-muted">{section.name}</code>
                    </div>
                    <div className="text-xs fg-muted">{section.about}</div>
                  </div>
                  <select className="input !w-40" aria-label={`${section.label} action`} value={action} onChange={(e) => setSection(section.name, e.target.value)}>
                    <option value="keep">Keep</option>
                    <option value="replace">Replace</option>
                    <option value="prepend">Prepend</option>
                    <option value="append">Append</option>
                    <option value="remove">Remove</option>
                  </select>
                </div>
                {current && action !== "remove" && (
                  <textarea
                    className="input-mono mt-2"
                    rows={3}
                    aria-label={`${section.label} content`}
                    placeholder={`Text to ${action}…`}
                    value={current.content}
                    onChange={(e) => setSection(section.name, action, e.target.value)}
                  />
                )}
                {error && <p className="mt-1 text-xs fg-danger">{error}</p>}
              </div>
            );
          })}
        </div>
      )}

      <Field label={`Instructions (${m.instructionsFile})`} help="harness.instructions" error={errorAt("instructions")}>
        <textarea
          className="input-mono"
          rows={18}
          value={draft.instructions}
          onChange={(e) => {
            const value = e.target.value;
            update((d) => void (d.instructions = value), "instructions");
          }}
        />
      </Field>
      <p className="-mt-3 text-right text-xs fg-muted">{draft.instructions.length.toLocaleString()} / 100,000 characters</p>
    </div>
  );
}

function PromptOrder({ mode, changed, file }: { mode: string; changed: number; file: string }) {
  const block = (label: string, detail: string, tone: "done" | "accent" | "muted") => (
    <div
      className={clsx(
        "rounded-md border px-3 py-2 text-xs",
        tone === "done" && "border-[var(--borderColor-done-muted)] bg-[var(--bgColor-done-muted)]",
        tone === "accent" && "border-[var(--borderColor-accent-muted)] bg-[var(--bgColor-accent-muted)]",
        tone === "muted" && "border-muted bg-muted",
      )}
    >
      <div className="font-semibold">{label}</div>
      <div className="fg-muted">{detail}</div>
    </div>
  );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="System prompt order">
      {mode !== "replace" && (
        <>
          {block("Copilot foundation prompt", mode === "customize" ? `${changed} section(s) changed` : "about 6.7 KB, as shipped", "done")}
          <ArrowRight className="fg-muted" />
        </>
      )}
      {block("Your instructions", file, "accent")}
      <ArrowRight className="fg-muted" />
      {block("Result contract", "added by the runner", "muted")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function ToolsTab({ draft, update, issues }: { draft: HarnessDocument; update: Update; issues: Issue[] }) {
  const { workspace } = useApp();
  const bindings = workspace!.bindings;
  const tools = draft.manifest.tools;
  const agents = draft.manifest.agents ?? [];
  const add = (bindingId: string) => {
    const binding = bindings.find((b) => b.id === bindingId);
    if (!binding) return;
    const base = bindingId.split(":").at(-1)!.replace(/[^a-z0-9_]/g, "_");
    let name = `compute_${base}`;
    for (let i = 2; tools.some((t) => t.name === name); i++) name = `compute_${base}_${i}`;
    update((d) => void d.manifest.tools.push({ name, kind: binding.kind, description: binding.description, binding: bindingId }));
  };
  const rename = (index: number, next: string) =>
    update((d) => {
      const previous = d.manifest.tools[index]!.name;
      d.manifest.tools[index]!.name = next;
      for (const agent of d.manifest.agents ?? []) agent.tools = agent.tools.map((t) => (t === previous ? next : t));
    }, `tools.${index}.name`);
  return (
    <div className="space-y-4">
      <BuiltinToolsSection draft={draft} update={update} issues={issues} />
      <h3 className="pt-2 text-sm font-semibold">Custom harness tools</h3>
      <p className="fg-muted">
        Custom tools are requested here and implemented by execution profiles. Copilot built-ins are configured separately above.
        The agent always also gets <code>submit_result</code>. A new
        implementation needs runner code and a binding listed in each profile (see docs/RUNNER-PROTOCOL.md). <HelpButton topic="tools" />
      </p>
      {tools.length === 0 && <Empty>No custom harness tools. This does not disable the Copilot built-ins selected above.</Empty>}
      {tools.map((tool, index) => {
        const error = (field: string) => issues.find((i) => i.path === `tools.${index}.${field}`)?.message;
        const users = agents.filter((a) => a.tools.includes(tool.name));
        return (
          <div key={index} className="card">
            <div className="box-header !py-2">
              <div className="flex items-center gap-2">
                <Wrench className="fg-muted" />
                <code className="!bg-transparent font-semibold">{tool.name || "unnamed"}</code>
                <Badge>{tool.kind}</Badge>
                {tool.delegatedOnly && <Badge tone="done">delegated only</Badge>}
              </div>
              <button type="button" className="btn-danger btn-sm btn-icon" aria-label={`Remove tool ${tool.name}`} onClick={() => update((d) => void d.manifest.tools.splice(index, 1))}>
                <Trash2 />
              </button>
            </div>
            <div className="card-pad grid gap-3 md:grid-cols-2">
              <Field label="Tool name" hint="What the model calls. Lowercase, digits, underscores." error={error("name")}>
                <input className="input font-mono" value={tool.name} onChange={(e) => rename(index, e.target.value)} />
              </Field>
              <Field label="Implementation" help="tool.binding" error={error("binding")}>
                <select
                  className="input"
                  value={tool.binding}
                  onChange={(e) =>
                    update((d) => {
                      const b = bindings.find((x) => x.id === e.target.value);
                      d.manifest.tools[index]!.binding = e.target.value;
                      if (b) d.manifest.tools[index]!.kind = b.kind;
                    })
                  }
                >
                  {!bindings.some((b) => b.id === tool.binding) && <option value={tool.binding}>{tool.binding} (unavailable)</option>}
                  {bindings.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.id} — {b.profiles.join(", ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Description for the model" className="md:col-span-2" error={error("description")}>
                <textarea
                  className="input"
                  rows={2}
                  value={tool.description}
                  onChange={(e) => update((d) => void (d.manifest.tools[index]!.description = e.target.value), `tools.${index}.description`)}
                />
              </Field>
              <div className="md:col-span-2">
                <Toggle
                  checked={!!tool.delegatedOnly}
                  help="tool.delegatedOnly"
                  onChange={(checked) =>
                    update((d) => {
                      if (checked) d.manifest.tools[index]!.delegatedOnly = true;
                      else delete d.manifest.tools[index]!.delegatedOnly;
                    })
                  }
                  label="Delegated only"
                  description={
                    users.length > 0
                      ? `Used by sub-agents: ${users.map((a) => a.displayName ?? a.name).join(", ")}.`
                      : agents.length > 0
                        ? "No sub-agent lists this tool yet; add it in Sub-agents."
                        : "Add a sub-agent first; the coordinator would otherwise have no way to call it."
                  }
                />
                {error("delegatedOnly") && <p className="mt-1 text-xs fg-danger">{error("delegatedOnly")}</p>}
              </div>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <span className="fg-muted">Add a tool:</span>
        {bindings.map((b) => (
          <button key={b.id} type="button" className="btn-secondary btn-sm" onClick={() => add(b.id)} title={b.description}>
            <Plus /> {b.id}
          </button>
        ))}
      </div>
      {issues.some((i) => i.path === "tools") && <IssueList issues={issues.filter((i) => i.path === "tools")} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Built-in tools and permissions
// ---------------------------------------------------------------------------

const GROUPS: Array<{ id: BuiltinToolGroup; label: string; tools: string; risk: string }> = [
  { id: "files", label: "Files", tools: "view, glob, grep, create, edit, apply_patch", risk: "Reads and changes files in the workspace." },
  { id: "shell", label: "Shell", tools: "bash or PowerShell (and their read, write, stop and list tools)", risk: "Runs any command the runner user can run." },
  { id: "web", label: "Web", tools: "web_fetch", risk: "Fetches URLs; egress is not restricted." },
  { id: "agents", label: "Built-in agents", tools: "task, read_agent, list_agents, write_agent", risk: "Copilot's explore and general-purpose agents use the same tools and rules." },
];
const KINDS: Array<{ id: "read" | "write" | "shell" | "url"; label: string; detail: string }> = [
  { id: "read", label: "Read files", detail: "Reading files or folders. With Ask, reads inside the workspace run without a prompt, as in the Copilot CLI." },
  { id: "write", label: "Write files", detail: "Creating or editing files (the request includes a diff)." },
  { id: "shell", label: "Shell commands", detail: "Running a command (the request includes the full command). With Ask, read-only commands that stay in the workspace run without a prompt." },
  { id: "url", label: "Web access", detail: "Fetching a URL." },
];
type Mode = "deny" | "ask" | "allow";

export function permissionSummary(permissions: HarnessManifest["permissions"]): string {
  if (!permissions) return "every action denied";
  const modes = KINDS.map((kind) => permissions.kinds?.[kind.id] ?? permissions.default);
  if (modes.every((mode) => mode === "allow")) return "yolo: everything allowed";
  const ask = KINDS.filter((_, i) => modes[i] === "ask").map((k) => k.id);
  const allow = KINDS.filter((_, i) => modes[i] === "allow").map((k) => k.id);
  return [ask.length ? `asks for ${ask.join(", ")}` : "", allow.length ? `allows ${allow.join(", ")}` : "", permissions.questions ? "questions on" : ""]
    .filter(Boolean)
    .join(" · ") || "every action denied";
}

function BuiltinToolsSection({ draft, update, issues }: { draft: HarnessDocument; update: Update; issues: Issue[] }) {
  const { workspace } = useApp();
  const allowed = new Set(workspace!.policy.builtinTools ?? []);
  const groups = draft.manifest.builtinTools ?? [];
  const toggle = (group: BuiltinToolGroup, on: boolean) =>
    update((d) => {
      const next = BUILTIN_GROUP_ORDER.filter((g) => (g === group ? on : (d.manifest.builtinTools ?? []).includes(g)));
      if (next.length) d.manifest.builtinTools = next;
      else delete d.manifest.builtinTools;
    });
  return (
    <div className="card">
      <div className="box-header">
        <div>
          <h3 className="flex items-center gap-1 text-sm font-semibold leading-6">
            <Copilot className="fg-done" /> Built-in Copilot tools <HelpButton topic="builtinTools" />
          </h3>
          <p className="text-xs fg-muted">GitHub Copilot's own tools. Each action follows the rules on the Permissions tab.</p>
        </div>
        <Badge tone={groups.length ? "done" : "neutral"}>{groups.length ? `${groups.length} group(s)` : "off"}</Badge>
      </div>
      {GROUPS.map((group) => {
        const on = groups.includes(group.id);
        const blocked = !allowed.has(group.id);
        const error = issues.find((i) => i.path.startsWith("builtinTools") && i.message.includes(`'${group.id}'`))?.message;
        return (
          <div key={group.id} className="box-row">
            <Toggle
              checked={on}
              onChange={(checked) => toggle(group.id, checked)}
              label={
                <span className="flex items-center gap-2">
                  {group.label}
                  {blocked && <Badge tone="amber">not allowed by policy</Badge>}
                </span>
              }
              description={
                <>
                  <code className="text-[11px]">{group.tools}</code> · {group.risk}
                </>
              }
            />
            {error && <p className="mt-1 text-xs fg-danger">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}

const BUILTIN_GROUP_ORDER: BuiltinToolGroup[] = ["files", "shell", "web", "agents"];

function ModeControl({ value, onChange, allowedModes, label, inherited }: {
  value: Mode | undefined;
  onChange: (mode: Mode | undefined) => void;
  allowedModes: Set<string>;
  label: string;
  inherited?: Mode;
}) {
  const options: Array<{ value: Mode | "default"; label: string }> = [
    ...(inherited ? [{ value: "default" as const, label: `Default (${inherited})` }] : []),
    { value: "deny", label: "Deny" },
    { value: "ask", label: "Ask me" },
    { value: "allow", label: "Allow" },
  ];
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md bg-[var(--controlTrack-bgColor-rest)] p-0.5">
      {options.map((option) => {
        const selected = (value ?? "default") === option.value;
        const disabled = option.value !== "default" && option.value !== "deny" && !allowedModes.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={disabled ? "Not allowed by the operator policy" : undefined}
            onClick={() => onChange(option.value === "default" ? undefined : (option.value as Mode))}
            className={clsx(
              "h-7 rounded-md px-3 text-sm disabled:cursor-not-allowed disabled:opacity-40",
              selected
                ? clsx(
                    "border font-semibold",
                    option.value === "allow"
                      ? "border-[var(--borderColor-attention-emphasis)] bg-[var(--bgColor-attention-muted)]"
                      : option.value === "ask"
                        ? "border-[var(--borderColor-accent-emphasis)] bg-[var(--bgColor-accent-muted)]"
                        : "border-[var(--controlKnob-borderColor-rest)] bg-[var(--controlKnob-bgColor-rest)]",
                  )
                : "border border-transparent fg-muted",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function PermissionsTab({ draft, update, issues, effective }: {
  draft: HarnessDocument;
  update: Update;
  issues: Issue[];
  effective?: HarnessDetail["effective"];
}) {
  const { workspace } = useApp();
  const policy = workspace!.policy;
  const allowedModes = new Set<string>(["deny", ...(policy.permissionModes ?? [])]);
  const permissions = draft.manifest.permissions;
  const errorAt = (prefix: string) => issues.find((i) => i.level === "error" && (i.path === prefix || i.path.startsWith(`${prefix}.`)))?.message;
  const set = (mutate: (p: NonNullable<HarnessManifest["permissions"]>) => void) =>
    update((d) => {
      const next = structuredClone(d.manifest.permissions ?? { default: "deny" as Mode });
      mutate(next);
      if (next.kinds && Object.values(next.kinds).every((v) => v === undefined)) delete next.kinds;
      d.manifest.permissions = next;
    });
  const preset = (name: "deny" | "cli" | "yolo") =>
    update((d) => {
      if (name === "deny") {
        delete d.manifest.permissions;
        return;
      }
      const questions = d.manifest.permissions?.questions;
      const timeoutSeconds = d.manifest.permissions?.timeoutSeconds;
      d.manifest.permissions = name === "yolo" ? { default: "allow" } : { default: "ask" };
      if (questions) d.manifest.permissions.questions = true;
      if (timeoutSeconds) d.manifest.permissions.timeoutSeconds = timeoutSeconds;
    });
  const timeout = permissions?.timeoutSeconds ?? 600;

  return (
    <div className="space-y-5">
      {!draft.manifest.builtinTools?.length && (
        <Flash>
          Permissions apply to built-in Copilot tools. Enable them on the Tools tab; harness tools (bindings) never ask for permission.
        </Flash>
      )}
      {issues.filter((i) => i.path === "permissions" && i.level === "warning").map((i) => (
        <Flash key={i.message} tone="warn">
          {i.message}
        </Flash>
      ))}
      <div>
        <div className="mb-2 flex items-center gap-1">
          <span className="label !mb-0">Presets</span>
          <HelpButton topic="permissions.default" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => preset("deny")}>
            Deny everything
          </button>
          <button type="button" className="btn-secondary btn-sm" disabled={!allowedModes.has("ask")} onClick={() => preset("cli")}>
            Copilot CLI defaults
          </button>
          <button type="button" className="btn-secondary btn-sm" disabled={!allowedModes.has("allow")} onClick={() => preset("yolo")}>
            Yolo: allow everything
          </button>
        </div>
      </div>

      <div className="card">
        <div className="box-header">
          <div>
            <h3 className="text-sm font-semibold leading-6">Rules</h3>
            <p className="text-xs fg-muted">
              Policy allows: deny{policy.permissionModes?.length ? `, ${policy.permissionModes.join(", ")}` : " only"}.
            </p>
          </div>
          <Badge tone={permissions ? "done" : "neutral"}>{permissionSummary(permissions)}</Badge>
        </div>
        <div className="box-row flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">Default</div>
            <div className="text-xs fg-muted">Any request without its own rule, including MCP and other kinds.</div>
            {errorAt("permissions.default") && <p className="text-xs fg-danger">{errorAt("permissions.default")}</p>}
          </div>
          <ModeControl
            label="Default permission"
            value={permissions?.default ?? "deny"}
            allowedModes={allowedModes}
            onChange={(mode) => set((p) => void (p.default = mode ?? "deny"))}
          />
        </div>
        {KINDS.map((kind) => (
          <div key={kind.id} className="box-row flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">{kind.label}</div>
              <div className="text-xs fg-muted">{kind.detail}</div>
              {errorAt(`permissions.kinds.${kind.id}`) && <p className="text-xs fg-danger">{errorAt(`permissions.kinds.${kind.id}`)}</p>}
            </div>
            <ModeControl
              label={kind.label}
              value={permissions?.kinds?.[kind.id]}
              inherited={permissions?.default ?? "deny"}
              allowedModes={allowedModes}
              onChange={(mode) =>
                set((p) => {
                  p.kinds = { ...p.kinds, [kind.id]: mode };
                })
              }
            />
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Toggle
            checked={!!permissions?.questions}
            help="permissions.questions"
            onChange={(checked) =>
              set((p) => {
                if (checked) p.questions = true;
                else delete p.questions;
              })
            }
            label="Let the agent ask questions"
            description={allowedModes.has("ask") ? "Questions appear in the job console and Try it." : "Needs the ask mode in the operator policy."}
          />
          {errorAt("permissions.questions") && <p className="mt-1 text-xs fg-danger">{errorAt("permissions.questions")}</p>}
        </div>
        <Field
          label="Answer timeout (seconds)"
          help="permissions.timeoutSeconds"
          hint={`Waiting counts toward the attempt deadline (${effective?.maxDurationSeconds ?? "?"}s).`}
          error={errorAt("permissions.timeoutSeconds")}
        >
          <NumberInput
            value={timeout}
            min={30}
            max={3600}
            onChange={(v) =>
              set((p) => {
                if (Number.isFinite(v) && v !== 600) p.timeoutSeconds = v;
                else delete p.timeoutSeconds;
              })
            }
          />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

function CheckboxGroup({ options, values, onChange, empty, label }: {
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
  empty: ReactNode;
  label: string;
}) {
  if (options.length === 0) return <p className="text-xs fg-muted">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((option) => {
        const checked = values.includes(option);
        return (
          <label key={option} className={clsx("badge cursor-pointer !py-0.5", checked && "badge-accent")}>
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={checked}
              onChange={(e) => onChange(e.target.checked ? [...values, option] : values.filter((v) => v !== option))}
            />
            <span className="font-mono">{option}</span>
          </label>
        );
      })}
    </div>
  );
}

type AgentDef = NonNullable<HarnessManifest["agents"]>[number];

function AgentsTab({ draft, update, issues }: { draft: HarnessDocument; update: Update; issues: Issue[] }) {
  const { workspace } = useApp();
  const policy = workspace!.policy;
  const agents = draft.manifest.agents ?? [];
  const builtinAgents = draft.manifest.builtinTools?.includes("agents") ?? false;
  const builtinAgentsBlocked = builtinAgents && !policy.builtinTools?.includes("agents");
  const toolNames = draft.manifest.tools.map((t) => t.name);
  const skillNames = draft.skills.map((s) => s.name);
  const add = () =>
    update((d) => {
      const list = d.manifest.agents ?? [];
      let name = "specialist";
      for (let i = 2; list.some((a) => a.name === name); i++) name = `specialist-${i}`;
      list.push({
        name,
        displayName: "Specialist",
        description: "Describe what this sub-agent does and what to give it.",
        instructions: "You are a specialist. Describe the method here.",
        tools: [],
      });
      d.manifest.agents = list;
    });
  const remove = (index: number) =>
    update((d) => {
      d.manifest.agents!.splice(index, 1);
      if (d.manifest.agents!.length === 0) {
        delete d.manifest.agents;
        for (const tool of d.manifest.tools) delete tool.delegatedOnly;
      }
    });
  const setAgent = (index: number, mutate: (a: AgentDef) => void, key?: string) => update((d) => mutate(d.manifest.agents![index]!), key);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="box-header">
          <h3 className="flex items-center gap-1 text-sm font-semibold">
            <Copilot className="fg-done" /> Built-in Copilot agents
          </h3>
          <Badge tone={builtinAgentsBlocked ? "amber" : builtinAgents ? "done" : "neutral"}>
            {builtinAgentsBlocked ? "Not allowed by policy" : builtinAgents ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <div className="card-pad space-y-2 text-sm">
          <p>
            {builtinAgents
              ? "The harness selects Copilot's runtime-provided agents, such as explore and general-purpose. They do not need custom definitions below."
              : "Enable the Built-in agents group on the Tools tab to use Copilot's runtime-provided agents."}
          </p>
          <p className="fg-muted">
            The installed runtime determines which built-in agents are available. Managed permissions, model policy and limits still apply.
          </p>
        </div>
      </div>
      <h3 className="pt-2 text-sm font-semibold">Custom sub-agents</h3>
      <Flash icon={<Copilot />}>
        Define additional specialists here. The coordinating agent delegates to them with the SDK's task tool using their configured
        instructions, tools and skills. This list is separate from Copilot's built-in agents. <HelpButton topic="agents" />
      </Flash>
      {agents.length === 0 && <Empty>
        {builtinAgents
          ? "No custom sub-agents. Built-in agents are configured separately above."
          : "No custom or built-in sub-agents are enabled. The coordinator works without delegation."}
      </Empty>}
      {agents.map((agent, index) => {
        const error = (field: string) => issues.find((i) => i.path === `agents.${index}.${field}` || i.path.startsWith(`agents.${index}.${field}.`))?.message;
        return (
          <div key={index} className="card">
            <div className="box-header !py-2">
              <div className="flex items-center gap-2">
                <Copilot className="fg-done" />
                <span className="font-semibold">{agent.displayName ?? agent.name}</span>
                <code className="text-[11px] fg-muted">{agent.name}</code>
                <Badge>{agent.tools.length} tool(s)</Badge>
                {agent.skills?.length ? <Badge tone="done">{agent.skills.length} skill(s)</Badge> : null}
              </div>
              <button type="button" className="btn-danger btn-sm btn-icon" aria-label={`Remove sub-agent ${agent.name}`} onClick={() => remove(index)}>
                <Trash2 />
              </button>
            </div>
            <div className="card-pad grid gap-3 md:grid-cols-2">
              <Field label="Name" hint="Lowercase slug the coordinator uses." error={error("name")}>
                <input className="input font-mono" value={agent.name} onChange={(e) => setAgent(index, (a) => void (a.name = e.target.value), `agents.${index}.name`)} />
              </Field>
              <Field label="Display name" error={error("displayName")}>
                <input
                  className="input"
                  value={agent.displayName ?? ""}
                  onChange={(e) =>
                    setAgent(
                      index,
                      (a) => {
                        if (e.target.value) a.displayName = e.target.value;
                        else delete a.displayName;
                      },
                      `agents.${index}.displayName`,
                    )
                  }
                />
              </Field>
              <Field label="Description" help="agent.description" className="md:col-span-2" error={error("description")}>
                <textarea className="input" rows={2} value={agent.description} onChange={(e) => setAgent(index, (a) => void (a.description = e.target.value), `agents.${index}.description`)} />
              </Field>
              <Field label="Instructions" help="agent.instructions" className="md:col-span-2" error={error("instructions")}>
                <textarea
                  className="input-mono"
                  rows={6}
                  value={agent.instructions}
                  onChange={(e) => setAgent(index, (a) => void (a.instructions = e.target.value), `agents.${index}.instructions`)}
                />
              </Field>
              <Field label="Tools" help="agent.tools" error={error("tools")}>
                <CheckboxGroup
                  label={`${agent.name} tools`}
                  options={toolNames}
                  values={agent.tools}
                  onChange={(values) => setAgent(index, (a) => void (a.tools = values))}
                  empty="Add tools to the harness first."
                />
              </Field>
              <Field label="Preloaded skills" help="agent.skills" error={error("skills")}>
                <CheckboxGroup
                  label={`${agent.name} skills`}
                  options={skillNames}
                  values={agent.skills ?? []}
                  onChange={(values) =>
                    setAgent(index, (a) => {
                      if (values.length) a.skills = values;
                      else delete a.skills;
                    })
                  }
                  empty="Add skills in the Skills tab."
                />
              </Field>
              <Field label="Model" help="agent.model" error={error("model")}>
                <select
                  className="input"
                  value={agent.model ?? ""}
                  onChange={(e) =>
                    setAgent(index, (a) => {
                      if (e.target.value) a.model = e.target.value;
                      else delete a.model;
                    })
                  }
                >
                  <option value="">Same as coordinator</option>
                  {draft.manifest.model.allowed.map((model) => (
                    <option key={model} value={model} disabled={!policy.allowedModels.includes(model)}>
                      {model}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reasoning effort" error={error("reasoningEffort")}>
                <select
                  className="input"
                  value={agent.reasoningEffort ?? ""}
                  onChange={(e) =>
                    setAgent(index, (a) => {
                      if (e.target.value) a.reasoningEffort = e.target.value as (typeof EFFORTS)[number];
                      else delete a.reasoningEffort;
                    })
                  }
                >
                  <option value="">Inherit</option>
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn-secondary" onClick={add} disabled={agents.length >= 8}>
        <Plus /> Add custom sub-agent
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function SkillsTab({ draft, update, issues }: { draft: HarnessDocument; update: Update; issues: Issue[] }) {
  const agents = draft.manifest.agents ?? [];
  const add = () =>
    update((d) => {
      let name = "new-skill";
      for (let i = 2; d.skills.some((s) => s.name === name); i++) name = `new-skill-${i}`;
      d.skills.push({ name, description: "Say when the agent should use this skill.", content: "# Steps\n\n1. Describe the procedure." });
    });
  const rename = (index: number, next: string) =>
    update((d) => {
      const previous = d.skills[index]!.name;
      d.skills[index]!.name = next;
      for (const agent of d.manifest.agents ?? []) {
        if (agent.skills) agent.skills = agent.skills.map((s) => (s === previous ? next : s));
      }
    }, `skills.${index}.name`);
  const remove = (index: number) =>
    update((d) => {
      const [removed] = d.skills.splice(index, 1);
      for (const agent of d.manifest.agents ?? []) {
        if (agent.skills) {
          agent.skills = agent.skills.filter((s) => s !== removed!.name);
          if (agent.skills.length === 0) delete agent.skills;
        }
      }
    });
  const setSkill = (index: number, mutate: (s: SkillDefinition) => void, key: string) => update((d) => mutate(d.skills[index]!), key);

  return (
    <div className="space-y-4">
      <p className="fg-muted">
        Skills are Markdown procedures packaged with the harness as <code>skills/&lt;name&gt;/SKILL.md</code>. The coordinator loads them
        on demand by description; sub-agents can preload them. <HelpButton topic="skills" />
      </p>
      {draft.skills.length === 0 && <Empty>No skills.</Empty>}
      {draft.skills.map((skill, index) => {
        const error = (field: string) => issues.find((i) => i.path === `skills.${index}.${field}`)?.message;
        const preloaded = agents.filter((a) => a.skills?.includes(skill.name)).map((a) => a.displayName ?? a.name);
        return (
          <div key={index} className="card">
            <div className="box-header !py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-semibold">{skill.name}</span>
                <code className="truncate text-[11px] fg-muted">
                  harnesses/{draft.folder}/skills/{skill.name}/SKILL.md
                </code>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="brand">on demand</Badge>
                {preloaded.length > 0 && <Badge tone="done">preloaded: {preloaded.join(", ")}</Badge>}
                <button type="button" className="btn-danger btn-sm btn-icon" aria-label={`Remove skill ${skill.name}`} onClick={() => remove(index)}>
                  <Trash2 />
                </button>
              </div>
            </div>
            <div className="card-pad grid gap-3 md:grid-cols-[240px_1fr]">
              <Field label="Name" hint="Folder name; lowercase slug." error={error("name")}>
                <input className="input font-mono" value={skill.name} onChange={(e) => rename(index, e.target.value)} />
              </Field>
              <Field label="Description" help="skill.description" error={error("description")}>
                <input className="input" value={skill.description} onChange={(e) => setSkill(index, (s) => void (s.description = e.target.value), `skills.${index}.description`)} />
              </Field>
              <Field label="Content (Markdown)" className="md:col-span-2" error={error("content")}>
                <textarea className="input-mono" rows={10} value={skill.content} onChange={(e) => setSkill(index, (s) => void (s.content = e.target.value), `skills.${index}.content`)} />
              </Field>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn-secondary" onClick={add} disabled={draft.skills.length >= 10}>
        <Plus /> Add skill
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runtime (execution profiles)
// ---------------------------------------------------------------------------

function RuntimeTab({ draft, update, issues, required }: { draft: HarnessDocument; update: Update; issues: Issue[]; required: string[] }) {
  const { workspace } = useApp();
  const runners = draft.manifest.runners;
  const needed = draft.manifest.tools.map((t) => t.binding);
  return (
    <div className="space-y-3">
      <p className="fg-muted">
        Choose which runner implementations may run this harness. Callers can pick any allowed profile; the default is used otherwise.{" "}
        <HelpButton topic="runners.allowedProfiles" />
      </p>
      {required.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 text-xs fg-muted">
          This harness needs runner support for:
          {required.map((r) => (
            <Badge key={r} tone="done">
              {r}
            </Badge>
          ))}
        </p>
      )}
      {workspace!.profiles.map((profile) => {
        const allowed = runners.allowedProfiles.includes(profile.id);
        const approved = workspace!.policy.allowedProfiles.includes(profile.id);
        const missing = needed.filter((b) => !profile.toolBindings.includes(b));
        const unsupported = required.filter((c) => !profile.capabilities.includes(c));
        return (
          <div key={profile.id} className={clsx("card p-4", allowed && "!border-[var(--borderColor-accent-emphasis)]")}>
            <div className="flex flex-wrap items-center gap-3">
              <Toggle
                checked={allowed}
                onChange={(checked) =>
                  update((d) => {
                    const m = d.manifest;
                    const list = m.runners.allowedProfiles.filter((p) => p !== profile.id);
                    m.runners.allowedProfiles = checked ? [...list, profile.id] : list;
                    if (!m.runners.allowedProfiles.includes(m.runners.defaultProfile)) m.runners.defaultProfile = m.runners.allowedProfiles[0] ?? "";
                  })
                }
                label={profile.displayName}
                description={`${profile.id} · ${profile.language} · ${profile.sdk} ${profile.sdkVersion}`}
              />
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Badge tone={profile.firstParty ? "brand" : "blue"}>{profile.firstParty ? "reference runner" : "customer runner"}</Badge>
                <Badge tone={approved ? "green" : "amber"}>{approved ? "policy approved" : "not approved"}</Badge>
                {missing.length > 0 && <Badge tone="red">missing {missing.join(", ")}</Badge>}
                {unsupported.length > 0 && <Badge tone="red">no {unsupported.join(", ")}</Badge>}
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="radio"
                    name="default-profile"
                    disabled={!allowed}
                    checked={runners.defaultProfile === profile.id}
                    onChange={() => update((d) => void (d.manifest.runners.defaultProfile = profile.id))}
                  />
                  default
                </label>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1 pl-6 text-xs fg-muted">
              Capabilities:
              {profile.capabilities.map((c) => (
                <code key={c} className={clsx("text-[11px]", required.includes(c) && "fg-done")}>
                  {c}
                </code>
              ))}
            </div>
          </div>
        );
      })}
      <IssueList issues={issues} empty="Runtime selection is valid." />
    </div>
  );
}
