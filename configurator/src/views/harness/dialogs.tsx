import clsx from "clsx";
import { useEffect, useState } from "react";
import type { HarnessChanges, HarnessDetail, HarnessDocument, ImportResult, TemplateInfo } from "../../../server/types";
import { api, errorMessage } from "../../api";
import { CheckCircle2, Copilot, Download, FileCode2, XCircle } from "../../components/icons";
import { Badge, Counter, Field, Flash, IssueList, Modal, Spinner } from "../../components/ui";
import { useApp } from "../../state";
import { AlertIcon, DiffAddedIcon, DiffModifiedIcon, DiffRemovedIcon } from "@primer/octicons-react";

export function bump(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return /^[a-z]/.test(slug) ? slug : `h-${slug}`.slice(0, 63);
}

// ---------------------------------------------------------------------------
// New / version / duplicate / delete
// ---------------------------------------------------------------------------

export function HarnessDialog({ mode, current, onClose, onDone }: {
  mode: "new" | "version" | "duplicate" | "delete";
  current?: HarnessDocument;
  onClose: () => void;
  onDone: (folder?: string) => Promise<void>;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(mode === "duplicate" && current ? `${current.manifest.name}-copy` : "");
  const [version, setVersion] = useState(mode === "version" && current ? bump(current.manifest.version) : "1.0.0");
  const [template, setTemplate] = useState<TemplateInfo["id"]>("structured-answer");
  const [templates, setTemplates] = useState<TemplateInfo[]>();
  const [busy, setBusy] = useState(false);
  const titles = { new: "Create a harness", version: "New version", duplicate: "Duplicate harness", delete: "Delete harness version" };

  useEffect(() => {
    if (mode !== "new") return;
    api<{ templates: TemplateInfo[] }>("/api/templates")
      .then((r) => setTemplates(r.templates))
      .catch((error) => toast(errorMessage(error), "error"));
  }, [mode, toast]);

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
          ? { mode, name, template }
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
      subtitle={mode === "new" ? "Start from a template. Every template validates against the current policy and execution profiles." : undefined}
      wide={mode === "new"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={mode === "delete" ? "btn-danger" : "btn-primary"}
            disabled={busy || ((mode === "new" || mode === "duplicate") && !name)}
            onClick={() => void submit()}
          >
            {busy && <Spinner />} {mode === "delete" ? "Delete" : "Create"}
          </button>
        </>
      }
    >
      {mode === "delete" ? (
        <p>
          Delete <code>harnesses/{current?.folder}</code>? Jobs that already ran keep their snapshot, but callers can no longer submit this
          version once you deploy. Git history keeps the files.
        </p>
      ) : mode === "version" ? (
        <Field label="Version" hint={`Copies ${current?.manifest.name} ${current?.manifest.version} into a new folder. The highest version becomes the default.`}>
          <input className="input font-mono" value={version} onChange={(e) => setVersion(e.target.value)} autoFocus />
        </Field>
      ) : (
        <>
          <Field
            label="Harness name"
            help="harness.name"
            hint={mode === "new" ? "Lowercase letters, digits, and hyphens." : "Copies the current version under a new name at 1.0.0."}
          >
            <input className="input font-mono md:!w-80" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus placeholder="support-triage" />
          </Field>
          {mode === "new" && (templates ? <TemplateGrid templates={templates} value={template} onChange={setTemplate} /> : <Spinner />)}
        </>
      )}
    </Modal>
  );
}

function TemplateGrid({ templates, value, onChange }: { templates: TemplateInfo[]; value: TemplateInfo["id"]; onChange: (id: TemplateInfo["id"]) => void }) {
  const rows: Array<{ label: string; cell: (t: TemplateInfo) => React.ReactNode }> = [
    { label: "Best for", cell: (t) => <span className="text-xs">{t.bestFor}</span> },
    { label: "Prompt", cell: (t) => <Badge tone={t.promptMode === "replace" ? "neutral" : "done"}>{t.promptMode}</Badge> },
    { label: "Tools", cell: (t) => <Counter>{t.tools}</Counter> },
    { label: "Sub-agents", cell: (t) => <Counter>{t.agents}</Counter> },
    { label: "Skills", cell: (t) => <Counter>{t.skills}</Counter> },
    {
      label: "Built-in tools",
      cell: (t) =>
        t.builtinTools.length ? (
          <span className="flex flex-wrap gap-1">
            {t.builtinTools.map((g) => (
              <Badge key={g} tone="done">
                {g}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-xs fg-muted">none</span>
        ),
    },
    { label: "Permissions", cell: (t) => <span className="text-xs">{t.permissions}</span> },
    { label: "Reasoning", cell: (t) => <span className="text-xs">{t.reasoningEffort ?? "model default"}</span> },
    { label: "Runs on", cell: (t) => <span className="text-xs">{t.profiles.join(", ") || "no approved profile"}</span> },
  ];
  return (
    <div role="radiogroup" aria-label="Template" className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="w-28" />
            {templates.map((t) => (
              <th key={t.id} className="p-1 align-top">
                <button
                  type="button"
                  role="radio"
                  aria-checked={value === t.id}
                  disabled={t.profiles.length === 0}
                  onClick={() => onChange(t.id)}
                  className={clsx(
                    "card h-full w-full p-3 text-left font-normal transition-colors disabled:opacity-50",
                    value === t.id ? "!border-[var(--borderColor-accent-emphasis)] bg-[var(--bgColor-accent-muted)]" : "hover:bg-[var(--bgColor-muted)]",
                  )}
                >
                  <div className="flex items-center gap-2 font-semibold">
                    {t.agents > 0 || t.builtinTools.length > 0 ? <Copilot className="fg-done" /> : <FileCode2 className="fg-muted" />}
                    {t.title}
                  </div>
                  <div className="mt-1 text-xs fg-muted">{t.summary}</div>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th className="table-cell whitespace-nowrap text-xs font-semibold fg-muted">{row.label}</th>
              {templates.map((t) => (
                <td key={t.id} className={clsx("table-cell", value === t.id && "bg-[var(--bgColor-accent-muted)]")}>
                  {row.cell(t)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import a Harness Builder plan
// ---------------------------------------------------------------------------

export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (folder: string) => Promise<void> }) {
  const { toast } = useApp();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [result, setResult] = useState<ImportResult>();
  const [busy, setBusy] = useState(false);
  const [parseError, setParseError] = useState<string>();

  async function preview(source = text) {
    setParseError(undefined);
    let plan: unknown;
    try {
      plan = JSON.parse(source);
    } catch (error) {
      setParseError((error as Error).message);
      setResult(undefined);
      return;
    }
    setBusy(true);
    try {
      const mapped = await api<ImportResult>("/api/import/planner", { method: "POST", body: { plan, ...(name ? { name } : {}) } });
      setResult(mapped);
      if (!name) setName(mapped.document.manifest.name);
    } catch (error) {
      toast(errorMessage(error), "error");
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!result) return;
    setBusy(true);
    try {
      const created = await api<HarnessDetail>("/api/harnesses", { method: "POST", body: { mode: "import", name, document: result.document } });
      toast(`Imported into harnesses/${created.document.folder}`, "success");
      await onDone(created.document.folder);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  const errors = result?.issues.filter((i) => i.level === "error").length ?? 0;
  return (
    <Modal
      title="Import a Harness Builder plan"
      subtitle="Paste or open a plan JSON exported from the Harness Builder. Nothing is written until you create the harness."
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" disabled={busy || !text} onClick={() => void preview()}>
            {busy && !result ? <Spinner /> : null} Preview mapping
          </button>
          <button type="button" className="btn-primary" disabled={busy || !result || !name} onClick={() => void create()}>
            {busy && result ? <Spinner /> : null} Create harness
          </button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Plan JSON" error={parseError && `Invalid JSON: ${parseError}`}>
            <textarea
              className="input-mono"
              rows={16}
              spellCheck={false}
              value={text}
              placeholder='{ "schemaVersion": 2, "name": "...", "prompt": { ... }, "agents": [ ... ] }'
              onChange={(e) => {
                setText(e.target.value);
                setResult(undefined);
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn-secondary btn-sm cursor-pointer">
              <Download /> Open file…
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 1_000_000) {
                    toast("Plan files are limited to 1 MB.", "error");
                    return;
                  }
                  const content = await file.text();
                  setText(content);
                  void preview(content);
                }}
              />
            </label>
          </div>
          <Field label="Harness name" help="harness.name" hint="Defaults to the plan name, converted to a slug.">
            <input className="input font-mono" value={name} onChange={(e) => setName(slugify(e.target.value))} placeholder="imported-harness" />
          </Field>
        </div>
        <div className="space-y-3">
          {!result ? (
            <Flash>
              The importer maps what a hosted job can run: prompt mode and sections, instructions, model choice and reasoning, and
              sub-agents. It lists everything else, so nothing is dropped silently.
            </Flash>
          ) : (
            <>
              <ReportSection
                title="Mapped"
                icon={<CheckCircle2 className="fg-success" />}
                items={result.report.mapped}
                empty="Nothing mapped."
              />
              <ReportSection
                title="Needs work"
                icon={<AlertIcon size={16} className="fg-attention" />}
                items={result.report.needsWork}
                empty="Nothing to finish."
              />
              <ReportSection
                title="Not applicable to hosted jobs"
                icon={<XCircle className="fg-muted" />}
                items={result.report.notApplicable}
                empty="Nothing skipped."
              />
              <div className="card">
                <div className="box-header !py-2">
                  <span className="text-sm font-semibold">Validation of the imported harness</span>
                  {errors > 0 ? <Badge tone="red">{errors} error(s)</Badge> : <Badge tone="green">valid</Badge>}
                </div>
                <div className="card-pad">
                  <IssueList issues={result.issues} empty="Ready to run against the current policy." />
                  {errors > 0 && <p className="hint">You can create it now and fix the errors in the editor; deploys refuse invalid harnesses.</p>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ReportSection({ title, icon, items, empty }: { title: string; icon: React.ReactNode; items: string[]; empty: string }) {
  return (
    <div className="card">
      <div className="box-header !py-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {icon} {title}
        </span>
        <Counter>{items.length}</Counter>
      </div>
      {items.length === 0 ? (
        <p className="card-pad text-xs fg-muted">{empty}</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={index} className="box-row !py-2 text-xs">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes since last commit
// ---------------------------------------------------------------------------

export function ChangesPanel({ folder, refreshKey }: { folder: string; refreshKey: string }) {
  const [changes, setChanges] = useState<HarnessChanges>();
  useEffect(() => {
    let cancelled = false;
    api<HarnessChanges>(`/api/harnesses/${encodeURIComponent(folder)}/changes`)
      .then((r) => !cancelled && setChanges(r))
      .catch(() => !cancelled && setChanges(undefined));
    return () => {
      cancelled = true;
    };
  }, [folder, refreshKey]);
  if (!changes) return null;
  const icon = { added: <DiffAddedIcon size={16} className="fg-success" />, removed: <DiffRemovedIcon size={16} className="fg-danger" />, changed: <DiffModifiedIcon size={16} className="fg-attention" /> };
  return (
    <section className="card">
      <div className="box-header">
        <div>
          <h2 className="text-sm font-semibold leading-6">Changes since last commit</h2>
          <p className="text-xs fg-muted">Saved files compared with git HEAD.</p>
        </div>
        <Counter>{changes.committed ? changes.changes.length : "new"}</Counter>
      </div>
      <div className="card-pad">
        {!changes.committed ? (
          <p className="text-xs fg-muted">This folder has not been committed yet; everything in it is new.</p>
        ) : changes.changes.length === 0 ? (
          <p className="text-xs fg-muted">No saved changes. Unsaved edits are not included.</p>
        ) : (
          <ul className="space-y-1">
            {changes.changes.map((c) => (
              <li key={c.path} className="flex items-center gap-2 text-xs">
                {icon[c.change]}
                <code>{c.path}</code>
                <span className="fg-muted">{c.change}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
