import clsx from "clsx";
import { Copy, GitCommitHorizontal, Plus, RotateCcw, Save, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessDetail, HarnessDocument, HarnessManifest, Issue } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, Card, ChipsInput, Empty, Field, IssueList, JsonEditor, Modal, NumberInput, PageHeader, Spinner, Toggle } from "../components/ui";
import { useApp, useDebounced } from "../state";

type Tab = "overview" | "instructions" | "model" | "tools" | "input" | "output" | "limits" | "agents";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "instructions", label: "Instructions" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "limits", label: "Limits & retry" },
  { id: "agents", label: "Agents" },
];

function tabFor(path: string): Tab {
  const head = path.split(".")[0];
  switch (head) {
    case "instructions":
    case "instructionsFile":
      return "instructions";
    case "model":
      return "model";
    case "tools":
      return "tools";
    case "input":
      return "input";
    case "output":
      return "output";
    case "limits":
    case "retry":
      return "limits";
    case "runners":
      return "agents";
    default:
      return "overview";
  }
}

function bump(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

export function HarnessesView() {
  const { workspace, selectedHarness, setSelectedHarness, refreshWorkspace, toast, local, runTask } = useApp();
  const [detail, setDetail] = useState<HarnessDetail>();
  const [draft, setDraft] = useState<HarnessDocument>();
  const [validation, setValidation] = useState<Pick<HarnessDetail, "issues" | "effective" | "digest">>();
  const [tab, setTab] = useState<Tab>("overview");
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<"new" | "version" | "duplicate" | "delete">();

  const harnesses = workspace?.harnesses ?? [];
  const folder = selectedHarness && harnesses.some((h) => h.folder === selectedHarness) ? selectedHarness : harnesses[0]?.folder;

  const latestRequest = useRef<string | undefined>(undefined);
  const load = useCallback(
    async (target: string) => {
      latestRequest.current = target;
      try {
        const result = await api<HarnessDetail>(`/api/harnesses/${encodeURIComponent(target)}`);
        // Ignore responses for a harness the user has already navigated away from.
        if (latestRequest.current !== target) return;
        setDetail(result);
        setDraft(structuredClone(result.document));
        setValidation(result);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    },
    [toast],
  );

  useEffect(() => {
    if (folder) void load(folder);
  }, [folder, load]);

  const dirty = useMemo(() => !!detail && !!draft && JSON.stringify(detail.document) !== JSON.stringify(draft), [detail, draft]);
  const debounced = useDebounced(draft, 500);
  useEffect(() => {
    if (!debounced || !dirty) return;
    let cancelled = false;
    api<HarnessDetail>("/api/harnesses/validate", { method: "POST", body: { document: debounced } })
      .then((result) => !cancelled && setValidation(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, dirty]);

  const update = (mutate: (m: HarnessManifest) => void) =>
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next.manifest);
      return next;
    });

  const issues = validation?.issues ?? [];
  const errors = issues.filter((i) => i.level === "error");
  const issuesFor = (t: Tab) => issues.filter((i) => tabFor(i.path) === t);

  async function save(reload: boolean) {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api<HarnessDetail>(`/api/harnesses/${encodeURIComponent(draft.folder)}`, { method: "PUT", body: { document: draft } });
      setDetail(result);
      setDraft(structuredClone(result.document));
      setValidation(result);
      await refreshWorkspace();
      toast(`Saved harnesses/${draft.folder}`, "success");
      if (reload && local?.running) await runTask("local-restart-api");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, typeof harnesses>();
    for (const h of harnesses) map.set(h.name, [...(map.get(h.name) ?? []), h]);
    return [...map.entries()];
  }, [harnesses]);

  return (
    <div>
      <PageHeader
        title="Harnesses"
        description="A harness is a versioned agent definition: instructions, model, tools, and the input and output contract. Each version lives in its own folder under harnesses/ and is published when you deploy."
        actions={
          <button type="button" className="btn-primary" onClick={() => setDialog("new")}>
            <Plus className="h-4 w-4" /> New harness
          </button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-3">
          {groups.length === 0 && <Empty>No harnesses yet.</Empty>}
          {groups.map(([name, versions]) => (
            <div key={name} className="card p-3">
              <div className="mb-2 px-1 font-semibold">{name}</div>
              <ul className="space-y-1">
                {versions.map((h) => (
                  <li key={h.folder}>
                    <button
                      type="button"
                      onClick={() => {
                        if (dirty && !window.confirm("Discard unsaved changes?")) return;
                        setSelectedHarness(h.folder);
                        setTab("overview");
                      }}
                      className={clsx(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                        h.folder === folder ? "bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-200" : "hover:bg-slate-100 dark:hover:bg-slate-800",
                      )}
                    >
                      <span className="font-mono text-xs">{h.version}</span>
                      {h.latest && <Badge tone="brand">latest</Badge>}
                      {h.untracked ? <Badge tone="blue">new</Badge> : h.modified ? <Badge tone="amber">edited</Badge> : null}
                      <span className="ml-auto flex gap-1">
                        {h.errors > 0 && <Badge tone="red">{h.errors}</Badge>}
                        {h.warnings > 0 && <Badge tone="amber">{h.warnings}</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {!draft || !workspace ? (
          <Card>
            <Spinner />
          </Card>
        ) : (
          <div className="min-w-0 space-y-4">
            <div className="card card-pad">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl">
                    {draft.manifest.name} <span className="font-mono text-base text-slate-500">{draft.manifest.version}</span>
                  </h2>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">
                    harnesses/{draft.folder} · {validation?.digest ? validation.digest.slice(0, 19) + "…" : "digest unavailable"}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary" onClick={() => setDialog("version")} disabled={dirty} title="Copy this version as a new version">
                    <GitCommitHorizontal className="h-4 w-4" /> New version
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setDialog("duplicate")} disabled={dirty}>
                    <Copy className="h-4 w-4" /> Duplicate
                  </button>
                  <button type="button" className="btn-danger" aria-label="Delete version" onClick={() => setDialog("delete")}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-4 flex overflow-x-auto border-b border-slate-200 dark:border-slate-800" role="tablist">
                {TABS.map((t) => {
                  const tabIssues = issuesFor(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      className={clsx("tab", tab === t.id && "tab-active")}
                      onClick={() => setTab(t.id)}
                    >
                      {t.label}
                      {tabIssues.length > 0 && (
                        <span className={clsx("ml-1.5 inline-block h-2 w-2 rounded-full", tabIssues.some((i) => i.level === "error") ? "bg-red-500" : "bg-amber-500")} />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="pt-5">
                <HarnessTab tab={tab} draft={draft} setDraft={setDraft} update={update} issues={issuesFor(tab)} effective={validation?.effective} />
              </div>
            </div>

            <Card
              title={
                <span className="flex items-center gap-2">
                  Validation {errors.length > 0 ? <Badge tone="red">{errors.length} error(s)</Badge> : <Badge tone="green">ready</Badge>}
                </span>
              }
              subtitle="Checked with the same contracts and policy the API uses at load and admission time."
            >
              <IssueList
                issues={issues}
                empty="This harness is valid against the current policy and execution profiles."
                onSelect={(i: Issue) => setTab(tabFor(i.path))}
                onFix={() => update((m) => void (m.version = bump(m.version)))}
              />
            </Card>

            <div className="sticky bottom-14 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
              <span className="text-sm text-slate-500">{dirty ? "Unsaved changes" : "Saved"}</span>
              <div className="ml-auto flex gap-2">
                <button type="button" className="btn-ghost" disabled={!dirty} onClick={() => detail && setDraft(structuredClone(detail.document))}>
                  <RotateCcw className="h-4 w-4" /> Revert
                </button>
                {local?.running && (
                  <button type="button" className="btn-secondary" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save(true)}>
                    Save &amp; reload local API
                  </button>
                )}
                <button type="button" className="btn-primary" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save(false)}>
                  {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {dialog && (
        <HarnessDialog
          mode={dialog}
          current={draft}
          onClose={() => setDialog(undefined)}
          onDone={async (next) => {
            setDialog(undefined);
            await refreshWorkspace();
            if (next) {
              setSelectedHarness(next);
              await load(next);
            } else {
              setSelectedHarness(undefined);
            }
          }}
        />
      )}
    </div>
  );
}

function HarnessTab({ tab, draft, setDraft, update, issues, effective }: {
  tab: Tab;
  draft: HarnessDocument;
  setDraft: (fn: (d: HarnessDocument | undefined) => HarnessDocument | undefined) => void;
  update: (mutate: (m: HarnessManifest) => void) => void;
  issues: Issue[];
  effective?: HarnessDetail["effective"];
}) {
  const { workspace } = useApp();
  const m = draft.manifest;
  const policy = workspace!.policy;
  const errorAt = (prefix: string) => issues.find((i) => i.level === "error" && i.path.startsWith(prefix))?.message;

  switch (tab) {
    case "overview":
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint="Callers submit jobs with this name. Create a new harness to use a different name.">
            <input className="input" value={m.name} disabled />
          </Field>
          <Field label="Version" hint="Bump the version whenever behaviour changes; jobs record the exact version and digest." error={errorAt("version")}>
            <input className="input font-mono" value={m.version} onChange={(e) => update((x) => void (x.version = e.target.value))} />
          </Field>
          <Field label="Description" className="md:col-span-2" error={errorAt("description")}>
            <textarea className="input" rows={3} value={m.description} onChange={(e) => update((x) => void (x.description = e.target.value))} />
          </Field>
          <div className="grid gap-3 rounded-xl bg-slate-50 p-4 text-xs dark:bg-slate-800/50 sm:grid-cols-4 md:col-span-2">
            <Summary label="Model" value={effective?.model ?? "not approved"} />
            <Summary label="Tools" value={`${m.tools.length} + submit_result`} />
            <Summary label="Agents" value={m.runners.allowedProfiles.join(", ") || "none"} />
            <Summary label="Deadline" value={`${effective?.maxDurationSeconds ?? "?"}s`} />
          </div>
        </div>
      );
    case "instructions":
      return (
        <div className="space-y-2">
          <Field
            label={`Instructions (${m.instructionsFile})`}
            hint="System instructions for the agent. The runner appends the result contract (call submit_result once with a schema-valid value)."
            error={errorAt("instructions")}
          >
            <textarea
              className="input-mono"
              rows={20}
              value={draft.instructions}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((d) => (d ? { ...d, instructions: value } : d));
              }}
            />
          </Field>
          <p className="text-right text-xs text-slate-500">{draft.instructions.length.toLocaleString()} / 100,000 characters</p>
        </div>
      );
    case "model":
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Preferred model" hint="Used when the operator policy approves it." error={errorAt("model")}>
            <input
              className="input"
              list="approved-models"
              value={m.model.preferred}
              onChange={(e) =>
                update((x) => {
                  x.model.preferred = e.target.value;
                  if (e.target.value && !x.model.allowed.includes(e.target.value)) x.model.allowed = [e.target.value, ...x.model.allowed];
                })
              }
            />
            <datalist id="approved-models">
              {policy.allowedModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </Field>
          <Field label="Allowed models" hint="Fallbacks in order. Only policy-approved models can run.">
            <ChipsInput values={m.model.allowed} onChange={(values) => update((x) => void (x.model.allowed = values))} suggestions={policy.allowedModels} />
          </Field>
          <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500 md:col-span-2">
            Policy-approved models:
            {policy.allowedModels.map((model) => (
              <Badge key={model} tone="green">
                {model}
              </Badge>
            ))}
            <span>Models are served by the inference gateway from the Foundry deployments configured for each environment.</span>
          </div>
        </div>
      );
    case "tools":
      return <ToolsTab draft={draft} update={update} issues={issues} />;
    case "input": {
      const schema = m.input.schema as Record<string, unknown>;
      const examples = Array.isArray(schema.examples) ? schema.examples : [];
      const { examples: _examples, ...schemaWithoutExamples } = schema;
      const exampleError = errorAt("input.schema.examples");
      const schemaError = issues.find((i) => i.level === "error" && i.path === "input.schema")?.message;
      return (
        <div className="grid gap-4 xl:grid-cols-2">
          <Field label="Input schema (JSON Schema 2020-12)" hint="Jobs whose input does not match are rejected before queuing." error={schemaError}>
            <JsonEditor
              rows={22}
              value={schemaWithoutExamples}
              onChange={(value) => update((x) => void (x.input.schema = { ...(value as object), ...(examples.length ? { examples } : {}) }))}
            />
          </Field>
          <Field label="Example input" hint="Prefills Try it and the job console. Must match the schema." error={exampleError}>
            <JsonEditor
              rows={22}
              value={examples[0] ?? {}}
              onChange={(value) => update((x) => void (x.input.schema = { ...(x.input.schema as object), examples: [value, ...examples.slice(1)] }))}
            />
          </Field>
        </div>
      );
    }
    case "output":
      return (
        <Field label="Output schema (JSON Schema 2020-12)" hint="Becomes the parameters of the agent's submit_result tool, and is validated again by the executor." error={errorAt("output")}>
          <JsonEditor rows={24} value={m.output.schema} onChange={(value) => update((x) => void (x.output.schema = value as Record<string, unknown>))} />
        </Field>
      );
    case "limits":
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Max duration per attempt (seconds)"
            hint={`Effective: ${effective?.maxDurationSeconds ?? "?"}s (policy max ${policy.maxDurationSeconds}s).`}
            error={errorAt("limits.maxDurationSeconds")}
          >
            <NumberInput value={m.limits.maxDurationSeconds} min={10} max={3600} onChange={(v) => update((x) => void (x.limits.maxDurationSeconds = v))} />
          </Field>
          <Field
            label="Inference token budget per job"
            hint={`Effective: ${effective?.tokenBudget?.toLocaleString() ?? "?"} (policy max ${policy.maxInferenceTokensPerJob.toLocaleString()}).`}
            error={errorAt("limits.maxInferenceTokens")}
          >
            <NumberInput value={m.limits.maxInferenceTokens} min={1000} step={1000} onChange={(v) => update((x) => void (x.limits.maxInferenceTokens = v))} />
          </Field>
          <Field label="Max attempts" hint={`Effective: ${effective?.maxAttempts ?? "?"} (policy max ${policy.retry.maxAttempts}).`} error={errorAt("retry.maxAttempts")}>
            <NumberInput value={m.retry.maxAttempts} min={1} max={5} onChange={(v) => update((x) => void (x.retry.maxAttempts = v))} />
          </Field>
          <div className="pt-6">
            <Toggle
              checked={m.retry.safeToRetry}
              onChange={(checked) => update((x) => void (x.retry.safeToRetry = checked))}
              label="Safe to retry after an uncertain outcome"
              description="Only for read-only work. Otherwise a lost executor sends the job to needs_review instead of retrying."
            />
          </div>
        </div>
      );
    case "agents":
      return <AgentsTab draft={draft} update={update} issues={issues} />;
  }
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="truncate font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

function ToolsTab({ draft, update, issues }: { draft: HarnessDocument; update: (mutate: (m: HarnessManifest) => void) => void; issues: Issue[] }) {
  const { workspace } = useApp();
  const bindings = workspace!.bindings;
  const tools = draft.manifest.tools;
  const add = (bindingId: string) => {
    const binding = bindings.find((b) => b.id === bindingId);
    if (!binding) return;
    const base = bindingId.split(":").at(-1)!.replace(/[^a-z0-9_]/g, "_");
    let name = `compute_${base}`;
    for (let i = 2; tools.some((t) => t.name === name); i++) name = `compute_${base}_${i}`;
    update((m) => void m.tools.push({ name, kind: binding.kind, description: binding.description, binding: bindingId }));
  };
  return (
    <div className="space-y-4">
      <p className="text-slate-500 dark:text-slate-400">
        Tools are requested here and implemented by execution profiles. The agent always also gets <code>submit_result</code>. A new
        implementation needs runner code and a binding listed in each profile (see docs/RUNNER-PROTOCOL.md).
      </p>
      {tools.length === 0 && <Empty>No tools. The agent can still reason and submit a result.</Empty>}
      {tools.map((tool, index) => {
        const error = (field: string) => issues.find((i) => i.path === `tools.${index}.${field}`)?.message;
        return (
          <div key={index} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <Field label="Tool name" hint="What the model calls. Lowercase, digits, underscores." error={error("name")}>
                <input className="input font-mono" value={tool.name} onChange={(e) => update((m) => void (m.tools[index]!.name = e.target.value))} />
              </Field>
              <Field label="Implementation" error={error("binding")}>
                <select
                  className="input"
                  value={tool.binding}
                  onChange={(e) =>
                    update((m) => {
                      const b = bindings.find((x) => x.id === e.target.value);
                      m.tools[index]!.binding = e.target.value;
                      if (b) m.tools[index]!.kind = b.kind;
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
              <div className="flex items-end">
                <button type="button" className="btn-danger" aria-label="Remove tool" onClick={() => update((m) => void m.tools.splice(index, 1))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <Field label="Description for the model" className="md:col-span-3" error={error("description")}>
                <textarea className="input" rows={2} value={tool.description} onChange={(e) => update((m) => void (m.tools[index]!.description = e.target.value))} />
              </Field>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="h-4 w-4 text-slate-500" />
        <span className="text-slate-500">Add a tool:</span>
        {bindings.map((b) => (
          <button key={b.id} type="button" className="btn-secondary btn-sm" onClick={() => add(b.id)} title={b.description}>
            <Plus className="h-3.5 w-3.5" /> {b.id}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentsTab({ draft, update, issues }: { draft: HarnessDocument; update: (mutate: (m: HarnessManifest) => void) => void; issues: Issue[] }) {
  const { workspace } = useApp();
  const runners = draft.manifest.runners;
  const needed = draft.manifest.tools.map((t) => t.binding);
  return (
    <div className="space-y-3">
      <p className="text-slate-500 dark:text-slate-400">
        Choose which agent implementations may run this harness. Callers can pick any allowed profile; the default is used otherwise.
      </p>
      {workspace!.profiles.map((profile) => {
        const allowed = runners.allowedProfiles.includes(profile.id);
        const approved = workspace!.policy.allowedProfiles.includes(profile.id);
        const missing = needed.filter((b) => !profile.toolBindings.includes(b));
        return (
          <div key={profile.id} className={clsx("rounded-xl border p-4", allowed ? "border-brand-300 dark:border-brand-700" : "border-slate-200 dark:border-slate-800")}>
            <div className="flex flex-wrap items-center gap-3">
              <Toggle
                checked={allowed}
                onChange={(checked) =>
                  update((m) => {
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
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="radio"
                    name="default-profile"
                    className="accent-brand-600"
                    disabled={!allowed}
                    checked={runners.defaultProfile === profile.id}
                    onChange={() => update((m) => void (m.runners.defaultProfile = profile.id))}
                  />
                  default
                </label>
              </div>
            </div>
          </div>
        );
      })}
      <IssueList issues={issues} empty="Agent selection is valid." />
    </div>
  );
}

function HarnessDialog({ mode, current, onClose, onDone }: {
  mode: "new" | "version" | "duplicate" | "delete";
  current?: HarnessDocument;
  onClose: () => void;
  onDone: (folder?: string) => Promise<void>;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(mode === "duplicate" && current ? `${current.manifest.name}-copy` : "");
  const [version, setVersion] = useState(mode === "version" && current ? bump(current.manifest.version) : "1.0.0");
  const [busy, setBusy] = useState(false);
  const titles = { new: "New harness", version: "New version", duplicate: "Duplicate harness", delete: "Delete harness version" };

  async function submit() {
    setBusy(true);
    try {
      if (mode === "delete") {
        await api(`/api/harnesses/${encodeURIComponent(current!.folder)}`, { method: "DELETE" });
        toast(`Deleted harnesses/${current!.folder}`, "success");
        await onDone(undefined);
        return;
      }
      const body =
        mode === "new"
          ? { mode, name }
          : mode === "version"
            ? { mode, name: current!.manifest.name, from: current!.folder, version }
            : { mode, name, from: current!.folder };
      const result = await api<HarnessDetail>("/api/harnesses", { method: "POST", body });
      toast(`Created harnesses/${result.document.folder}`, "success");
      await onDone(result.document.folder);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={titles[mode]}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={mode === "delete" ? "btn-danger" : "btn-primary"} disabled={busy} onClick={() => void submit()}>
            {busy && <Spinner />} {mode === "delete" ? "Delete" : "Create"}
          </button>
        </>
      }
    >
      {mode === "delete" ? (
        <p>
          Delete <code>harnesses/{current?.folder}</code>? Jobs that already ran keep their snapshot, but callers can no longer submit this version once
          you deploy. Git history keeps the files.
        </p>
      ) : mode === "version" ? (
        <Field label="Version" hint={`Copies ${current?.manifest.name} ${current?.manifest.version} into a new folder. The highest version becomes the default.`}>
          <input className="input font-mono" value={version} onChange={(e) => setVersion(e.target.value)} autoFocus />
        </Field>
      ) : (
        <Field
          label="Harness name"
          hint={mode === "new" ? "Lowercase letters, digits, and hyphens. Starts from a minimal, valid template." : "Copies the current version under a new name at 1.0.0."}
        >
          <input className="input font-mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus placeholder="support-triage" />
        </Field>
      )}
    </Modal>
  );
}
