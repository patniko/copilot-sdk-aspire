import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessDetail, HarnessDocument, HarnessExport, Issue } from "../../server/types";
import { api, errorMessage } from "../api";
import { Boxes, Copilot, Copy, Download, GitCommitHorizontal, Plus, RotateCcw, Save, Trash2 } from "../components/icons";
import { Badge, Card, Flash, IssueList, Modal, PageHeader, Spinner } from "../components/ui";
import { clearDraft, readDraft, useDraftAutosave, useHistory, useRegisterEditorActions, type Draft } from "../history";
import { useApp, useDebounced } from "../state";
import { bump, ChangesPanel, HarnessDialog, ImportDialog } from "./harness/dialogs";
import { HarnessNavigation, HarnessSections } from "./harness/navigation";
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
  const [saveChoice, setSaveChoice] = useState<{ reload: boolean }>();
  const [discardOpen, setDiscardOpen] = useState(false);
  const savingRef = useRef(false);

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
    return () => { latestRequest.current = undefined; };
  }, [folder, load]);

  const dirty = !!baseline && !!draft && JSON.stringify(draft) !== baseline;
  useDraftAutosave(draft?.folder, draft, baseline, !pendingDraft && draft?.folder === folder);

  const debounced = useDebounced(draft, 400);
  useEffect(() => {
    if (!debounced || !dirty) return;
    let cancelled = false;
    api<HarnessDetail>("/api/harnesses/validate", { method: "POST", body: { document: debounced } })
      .then((result) => !cancelled && setValidation(result))
      .catch((error) => !cancelled && toast(errorMessage(error), "error"));
    return () => {
      cancelled = true;
    };
  }, [debounced, dirty, toast]);
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

  const issues = validation && JSON.stringify(validation.document) === JSON.stringify(draft) ? validation.issues : [];
  const errors = issues.filter((i) => i.level === "error");
  const issuesFor = (t: Tab) => issues.filter((i) => tabFor(i.path) === t);

  const persist = useCallback(
    async (reload: boolean, mode: "update" | "version") => {
      if (!draft || draft.folder !== folder || savingRef.current) return;
      if (errors.length > 0) {
        toast(`Fix ${errors.length} error(s) before saving.`, "error");
        setTab(tabFor(errors[0]!.path));
        return;
      }
      savingRef.current = true;
      setSaving(true);
      try {
        const result = mode === "version"
          ? await api<HarnessDetail>("/api/harnesses", {
              method: "POST",
              body: { mode, name: draft.manifest.name, from: draft.folder, version: draft.manifest.version, document: draft },
            })
          : await api<HarnessDetail>(`/api/harnesses/${encodeURIComponent(draft.folder)}`, { method: "PUT", body: { document: draft } });
        clearDraft(draft.folder);
        clearDraft(result.document.folder);
        setSaveChoice(undefined);
        setPendingDraft(undefined);
        if (latestRequest.current !== draft.folder) {
          await refreshWorkspace();
          toast(`Saved harnesses/${result.document.folder}`, "success");
          if (reload && local?.running) await runTask("local-restart-api");
          return;
        }
        setSaved(result);
        history.reset(structuredClone(result.document));
        setValidation(result);
        setSavedAt(Date.now());
        await refreshWorkspace();
        setSelectedHarness(result.document.folder);
        toast(`Saved harnesses/${result.document.folder}`, "success");
        if (reload && local?.running) await runTask("local-restart-api");
      } catch (error) {
        toast(errorMessage(error), "error");
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, folder, errors, local?.running, refreshWorkspace, runTask, toast, setSelectedHarness],
  );

  const save = useCallback(async (reload: boolean) => {
    if (!draft || !saved || !dirty || draft.folder !== folder || savingRef.current || saveChoice || discardOpen) return;
    if (errors.length > 0) {
      toast(`Fix ${errors.length} error(s) before saving.`, "error");
      setTab(tabFor(errors[0]!.path));
      return;
    }
    if (draft.manifest.version !== saved.document.manifest.version) {
      setSaveChoice({ reload });
      return;
    }
    await persist(reload, "update");
  }, [draft, saved, dirty, folder, saveChoice, discardOpen, errors, toast, persist]);

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
          canUndo: history.canUndo && !saving && !saveChoice && !discardOpen,
          canRedo: history.canRedo && !saving && !saveChoice && !discardOpen,
          undo: history.undo,
          redo: history.redo,
          dirty,
          saving,
          save: () => void save(false),
          exportJson: () => void exportJson(),
        }
      : undefined,
  );

  const select = (next: string) => {
    if (next === folder || savingRef.current) return;
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
      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <HarnessNavigation harnesses={harnesses} selected={folder} disabled={saving} onSelect={select} />

        {!draft || draft.folder !== folder || !workspace ? (
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

            <fieldset className="card min-w-0" disabled={saving}>
              <div className="flex flex-wrap items-start gap-3 p-4 pb-0">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                    {((draft.manifest.agents?.length ?? 0) > 0 || draft.manifest.builtinTools?.includes("agents")) && <Copilot className="fg-done" size={20} />}
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
              <HarnessSections selected={tab} issues={issues} onSelect={setTab} />
              <div id="harness-section" role="region" aria-label={TABS.find((item) => item.id === tab)?.label} className="p-4">
                <HarnessTab tab={tab} draft={draft} update={update} issues={issuesFor(tab)} effective={validation?.effective} detail={validation} />
              </div>
            </fieldset>

            <div className="sticky bottom-14 z-20 flex flex-wrap items-center gap-3 rounded-md border border-default bg-[var(--overlay-bgColor)] p-3 shadow-[var(--shadow-floating-small)]">
              <div className="text-sm">
                <span className="font-medium">{dirty ? "Unsaved changes" : "All changes saved"}</span>
                <p className="text-xs fg-muted">
                  {dirty && saved && draft.manifest.version !== saved.document.manifest.version
                    ? `${saved.document.manifest.version} to ${draft.manifest.version}: choose how to save this version.`
                    : dirty ? "Your draft is kept in this browser. Save to write it to disk." : "Saved to disk. Reload locally or deploy to activate changes."}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                <button type="button" className="btn-ghost" disabled={!dirty || saving} onClick={() => setDiscardOpen(true)}>
                  <RotateCcw /> Discard changes
                </button>
                {local?.running && (
                  <button type="button" className="btn-secondary" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save(true)}>
                    Save &amp; reload local API
                  </button>
                )}
                <button type="button" className="btn-primary" disabled={!dirty || errors.length > 0 || saving} onClick={() => void save(false)}>
                  {saving ? <Spinner /> : <Save />} Save changes
                </button>
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

          </div>
        )}
      </div>

      {saveChoice && draft && saved && (
        <Modal title="Save version change" onClose={() => !savingRef.current && setSaveChoice(undefined)}>
          <p>
            You changed <strong>{draft.manifest.name}</strong> from <code>{saved.document.manifest.version}</code> to <code>{draft.manifest.version}</code>.
            Both choices include all your current edits.
          </p>
          <div className="card card-pad space-y-2">
            <h3>Keep both versions</h3>
            <p className="text-sm fg-muted">Save a new folder for {draft.manifest.version}. Version {saved.document.manifest.version} stays unchanged.</p>
            <button type="button" className="btn-primary" disabled={saving} onClick={() => void persist(saveChoice.reload, "version")}>
              {saving ? <Spinner /> : <GitCommitHorizontal />} Save as new version
            </button>
          </div>
          <div className="card card-pad space-y-2">
            <h3>Replace the selected version</h3>
            <p className="text-sm fg-muted">
              Update <code>harnesses/{draft.folder}</code> to {draft.manifest.version}. This does not keep a separate copy of {saved.document.manifest.version}.
            </p>
            <button type="button" className="btn-secondary" disabled={saving} onClick={() => void persist(saveChoice.reload, "update")}>
              Update existing
            </button>
          </div>
          {saveChoice.reload && <p className="text-xs fg-muted">The local API will reload after a successful save.</p>}
          <button type="button" className="btn-ghost" disabled={saving} onClick={() => setSaveChoice(undefined)}>Cancel</button>
        </Modal>
      )}

      {discardOpen && saved && (
        <Modal
          title="Discard unsaved changes?"
          onClose={() => setDiscardOpen(false)}
          footer={<>
            <button type="button" className="btn-secondary" onClick={() => setDiscardOpen(false)}>Keep editing</button>
            <button type="button" className="btn-danger" onClick={() => {
              history.reset(structuredClone(saved.document));
              setValidation(saved);
              clearDraft(saved.document.folder);
              setPendingDraft(undefined);
              setDiscardOpen(false);
            }}>Discard changes</button>
          </>}
        >
          <p>Restore <strong>{saved.document.manifest.name} {saved.document.manifest.version}</strong> to its last saved state. Your unsaved edits and browser draft will be removed; files on disk will not change.</p>
        </Modal>
      )}

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
