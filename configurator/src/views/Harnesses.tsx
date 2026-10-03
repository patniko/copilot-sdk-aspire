import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessDetail, HarnessDocument, HarnessExport, Issue } from "../../server/types";
import { api, errorMessage } from "../api";
import { Boxes, Copilot, Copy, Download, GitCommitHorizontal, Plus, RotateCcw, Save, Trash2 } from "../components/icons";
import { Badge, Card, Counter, Empty, Flash, IssueList, PageHeader, Spinner } from "../components/ui";
import { clearDraft, readDraft, useDraftAutosave, useHistory, useRegisterEditorActions, type Draft } from "../history";
import { useApp, useDebounced } from "../state";
import { bump, ChangesPanel, HarnessDialog, ImportDialog } from "./harness/dialogs";
import { HarnessTab, tabFor, TABS, type Tab, type Update } from "./harness/tabs";
import { UploadIcon } from "@primer/octicons-react";

export function HarnessesView() {
  const { workspace, selectedHarness, setSelectedHarness, refreshWorkspace, toast, local, runTask, setEditorDetail } = useApp();
  const [saved, setSaved] = useState<HarnessDetail>();
  const history = useHistory<HarnessDocument | undefined>(undefined);
  const draft = history.value;
  const [validation, setValidation] = useState<HarnessDetail>();
  const [tab, setTab] = useState<Tab>("overview");
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<"new" | "version" | "duplicate" | "delete" | "import">();
  const [pendingDraft, setPendingDraft] = useState<Draft<HarnessDocument> & { stale: boolean }>();
  const [savedAt, setSavedAt] = useState(0);

  const harnesses = workspace?.harnesses ?? [];
  const folder = selectedHarness && harnesses.some((h) => h.folder === selectedHarness) ? selectedHarness : harnesses[0]?.folder;
  const baseline = useMemo(() => (saved ? JSON.stringify(saved.document) : undefined), [saved]);

  const latestRequest = useRef<string | undefined>(undefined);
  const load = useCallback(
    async (target: string) => {
      latestRequest.current = target;
      try {
        const result = await api<HarnessDetail>(`/api/harnesses/${encodeURIComponent(target)}`);
        // Ignore responses for a harness the user has already navigated away from.
        if (latestRequest.current !== target) return;
        setSaved(result);
        history.reset(structuredClone(result.document));
        setValidation(result);
        const stored = readDraft<HarnessDocument>(target);
        const current = JSON.stringify(result.document);
        if (stored && JSON.stringify(stored.value) !== current) {
          setPendingDraft({ ...stored, stale: stored.baseline !== current });
        } else {
          if (stored) clearDraft(target);
          setPendingDraft(undefined);
        }
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast],
  );

  useEffect(() => {
    if (folder) void load(folder);
  }, [folder, load]);

  const dirty = !!baseline && !!draft && JSON.stringify(draft) !== baseline;
  useDraftAutosave(folder, draft, baseline, !pendingDraft);

  const debounced = useDebounced(draft, 400);
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
  useEffect(() => {
    if (!dirty && saved) setValidation(saved);
  }, [dirty, saved]);

  useEffect(() => {
    setEditorDetail(validation && draft ? { ...validation, document: draft } : undefined);
  }, [validation, draft, setEditorDetail]);
  useEffect(() => () => setEditorDetail(undefined), [setEditorDetail]);

  const update: Update = useCallback(
    (mutate, key) =>
      history.set((current) => {
        if (!current) return current;
        const next = structuredClone(current);
        mutate(next);
        return next;
      }, key),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history.set],
  );

  const issues = validation?.issues ?? [];
  const errors = issues.filter((i) => i.level === "error");
  const issuesFor = (t: Tab) => issues.filter((i) => tabFor(i.path) === t);

  const save = useCallback(
    async (reload: boolean) => {
      if (!draft) return;
      if (errors.length > 0) {
        toast(`Fix ${errors.length} error(s) before saving.`, "error");
        setTab(tabFor(errors[0]!.path));
        return;
      }
      setSaving(true);
      try {
        const result = await api<HarnessDetail>(`/api/harnesses/${encodeURIComponent(draft.folder)}`, { method: "PUT", body: { document: draft } });
        setSaved(result);
        history.reset(structuredClone(result.document));
        setValidation(result);
        clearDraft(draft.folder);
        setSavedAt(Date.now());
        await refreshWorkspace();
        toast(`Saved harnesses/${draft.folder}`, "success");
        if (reload && local?.running) await runTask("local-restart-api");
      } catch (error) {
        toast(errorMessage(error), "error");
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, errors.length, local?.running, refreshWorkspace, runTask, toast],
  );

  const exportJson = useCallback(async () => {
    if (!draft) return;
    try {
      const result = await api<HarnessExport>(`/api/harnesses/${encodeURIComponent(draft.folder)}/export`);
      const blob = new Blob([`${JSON.stringify(result.definition, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${draft.manifest.name}-${draft.manifest.version}.harness.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(dirty ? "Exported the saved version (unsaved edits are not included)." : `Exported ${result.digest.slice(0, 19)}…`, dirty ? "info" : "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }, [draft, dirty, toast]);

  useRegisterEditorActions(
    draft
      ? {
          label: `${draft.manifest.name} ${draft.manifest.version}`,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          undo: history.undo,
          redo: history.redo,
          dirty,
          saving,
          save: () => void save(false),
          exportJson: () => void exportJson(),
        }
      : undefined,
  );

  const groups = useMemo(() => {
    const map = new Map<string, typeof harnesses>();
    for (const h of harnesses) map.set(h.name, [...(map.get(h.name) ?? []), h]);
    return [...map.entries()];
  }, [harnesses]);

  const select = (next: string) => {
    if (next === folder) return;
    // Unsaved edits stay in the browser draft for this folder and are offered on return.
    setSelectedHarness(next);
    setTab("overview");
  };

  return (
    <div>
      <PageHeader
        title="Harnesses"
        leading={<Boxes size={24} className="fg-muted" />}
        description="A harness is a versioned agent definition: prompt, model, tools, sub-agents, skills and the input and output contract. Each version lives in its own folder under harnesses/ and is published when you deploy."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDialog("import")}>
              <UploadIcon size={16} /> Import plan
            </button>
            <button type="button" className="btn-primary" onClick={() => setDialog("new")}>
              <Plus /> New harness
            </button>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label="Harness versions" className="space-y-4 xl:sticky xl:top-[120px] xl:self-start">
          {groups.length === 0 && <Empty>No harnesses yet.</Empty>}
          {groups.map(([name, versions]) => (
            <div key={name}>
              <div className="mb-1 flex items-center gap-1.5 px-2 text-xs font-semibold fg-muted">
                {name}
                <Counter>{versions.length}</Counter>
              </div>
              <ul className="space-y-0.5 pl-2">
                {versions.map((h) => (
                  <li key={h.folder}>
                    <button type="button" onClick={() => select(h.folder)} aria-current={h.folder === folder ? "page" : undefined} className="navlist-item">
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
        </nav>

        {!draft || !workspace ? (
          <Card>
            <Spinner />
          </Card>
        ) : (
          <div className="min-w-0 space-y-4">
            {pendingDraft && (
              <Flash
                tone="warn"
                actions={
                  <>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        clearDraft(draft.folder);
                        setPendingDraft(undefined);
                      }}
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => {
                        history.set(structuredClone({ ...pendingDraft.value, folder: draft.folder }));
                        setPendingDraft(undefined);
                      }}
                    >
                      Restore draft
                    </button>
                  </>
                }
              >
                <strong>Unsaved draft from {new Date(pendingDraft.savedAt).toLocaleString()}.</strong>{" "}
                {pendingDraft.stale
                  ? "The files on disk changed after this draft was saved; restoring replaces those changes when you save."
                  : "Restore it to keep editing, or discard it."}
              </Flash>
            )}

            <div className="card">
              <div className="flex flex-wrap items-start gap-3 p-4 pb-0">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                    {(draft.manifest.agents?.length ?? 0) > 0 && <Copilot className="fg-done" size={20} />}
                    {draft.manifest.name}
                    <span className="font-mono text-base font-normal fg-muted">{draft.manifest.version}</span>
                    {dirty ? <Badge tone="amber">unsaved</Badge> : <Badge tone="green">saved</Badge>}
                  </h2>
                  <p className="mt-0.5 font-mono text-xs fg-muted">
                    harnesses/{draft.folder} · {validation?.digest ? `${validation.digest.slice(0, 19)}…` : "digest unavailable"}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void exportJson()} title="Download the resolved definition the API loads">
                    <Download /> Export JSON
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setDialog("version")} disabled={dirty} title="Copy this version as a new version">
                    <GitCommitHorizontal /> New version
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setDialog("duplicate")} disabled={dirty}>
                    <Copy /> Duplicate
                  </button>
                  <button type="button" className="btn-danger btn-sm btn-icon" aria-label="Delete version" onClick={() => setDialog("delete")}>
                    <Trash2 />
                  </button>
                </div>
              </div>
              <div className="tabs mt-2 px-4" role="tablist">
                {TABS.map((t) => {
                  const tabIssues = issuesFor(t.id);
                  const count =
                    t.id === "tools"
                      ? draft.manifest.tools.length
                      : t.id === "agents"
                        ? draft.manifest.agents?.length ?? 0
                        : t.id === "skills"
                          ? draft.skills.length
                          : undefined;
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
                      {count !== undefined && <Counter>{count}</Counter>}
                      {tabIssues.length > 0 && (
                        <span
                          aria-label={`${tabIssues.length} issue(s)`}
                          className={clsx(
                            "inline-block h-2 w-2 rounded-full",
                            tabIssues.some((i) => i.level === "error") ? "bg-[var(--bgColor-danger-emphasis)]" : "bg-[var(--bgColor-attention-emphasis)]",
                          )}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="p-4">
                <HarnessTab tab={tab} draft={draft} update={update} issues={issuesFor(tab)} effective={validation?.effective} detail={validation} />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
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
                  onFix={() => update((d) => void (d.manifest.version = bump(d.manifest.version)))}
                />
              </Card>
              <ChangesPanel folder={draft.folder} refreshKey={`${draft.folder}:${savedAt}`} />
            </div>

            <div className="sticky bottom-14 z-20 flex flex-wrap items-center gap-2 rounded-md border border-default bg-[var(--overlay-bgColor)] p-3 shadow-[var(--shadow-floating-small)]">
              <span className="text-sm fg-muted">{dirty ? "Unsaved changes · draft kept in this browser" : "All changes saved to disk"}</span>
              <div className="ml-auto flex gap-2">
                <button type="button" className="btn-secondary" disabled={!dirty} onClick={() => saved && history.set(structuredClone(saved.document))}>
                  <RotateCcw /> Revert
                </button>
                {local?.running && (
                  <button type="button" className="btn-secondary" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save(true)}>
                    Save &amp; reload local API
                  </button>
                )}
                <button type="button" className="btn-primary" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save(false)}>
                  {saving ? <Spinner /> : <Save />} Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {dialog === "import" ? (
        <ImportDialog
          onClose={() => setDialog(undefined)}
          onDone={async (next) => {
            setDialog(undefined);
            await refreshWorkspace();
            setSelectedHarness(next);
            await load(next);
          }}
        />
      ) : (
        dialog && (
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
        )
      )}
    </div>
  );
}
