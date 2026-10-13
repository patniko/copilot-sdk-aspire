import { useEffect, useRef, useState } from "react";
import type { AuthoringDraft, AuthoringKind, HarnessDocument, ToolCodeProposal } from "../../../server/types";
import { api, errorMessage } from "../../api";
import { Copilot, Download, Plus } from "../../components/icons";
import { Field, Flash, Modal, SegmentedControl, Spinner } from "../../components/ui";
import type { Update } from "./tabs";

const LABELS = { agent: "custom sub-agent", skill: "skill", tool: "custom tool" } as const;
const EXAMPLES = {
  agent: "A reviewer who checks the coordinator's conclusions, spots unsupported claims, and suggests concise corrections.",
  skill: "A repeatable checklist for reviewing an analysis: check assumptions, missing values, and whether conclusions follow from the evidence.",
  tool: "Compute descriptive statistics for a numeric series, including count, mean, standard deviation, and quartiles.",
};

/** Uses the editor's existing undo, draft storage, validation, versioning and save path. */
export function addAuthoringDraft(document: HarnessDocument, draft: Exclude<AuthoringDraft, { kind: "tool-code" }>): void {
  if (draft.kind === "agent") document.manifest.agents = [...(document.manifest.agents ?? []), draft.agent];
  else if (draft.kind === "skill") document.skills.push(draft.skill);
  else document.manifest.tools.push(draft.tool);
}

export function CreateWithCopilot({ kind, draft, update, onManual, disabled }: {
  kind: keyof typeof LABELS;
  draft: HarnessDocument;
  update: Update;
  onManual?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setOpen(true)}>
        <Plus /> Add {LABELS[kind]}
      </button>
      {open && <AuthoringDialog
        key={draft.folder}
        kind={kind}
        draft={draft}
        onClose={() => setOpen(false)}
        onManual={onManual}
        onAdd={(result) => update((document) => addAuthoringDraft(document, result))}
      />}
    </>
  );
}

export function AuthoringDialog({ kind, draft, onClose, onManual, onAdd }: {
  kind: keyof typeof LABELS;
  draft: HarnessDocument;
  onClose: () => void;
  onManual?: () => void;
  onAdd: (result: Exclude<AuthoringDraft, { kind: "tool-code" }>) => void;
}) {
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState<AuthoringKind>(kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [proposal, setProposal] = useState<ToolCodeProposal>();
  const request = useRef<AbortController | undefined>(undefined);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;

  useEffect(() => () => request.current?.abort(), []);

  function cancel() {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
  }

  function manual() {
    cancel();
    onManual?.();
    onClose();
  }

  async function generate() {
    if (request.current || !description.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    const snapshot = JSON.stringify(draft);
    setBusy(true);
    setError(undefined);
    setProposal(undefined);
    try {
      const result = await api<AuthoringDraft>("/api/authoring/draft", {
        method: "POST",
        body: { kind: target, description, document: draft },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (snapshot !== JSON.stringify(currentDraft.current)) {
        setError("The harness changed while Copilot was drafting. Generate again using the current configuration.");
        return;
      }
      if (result.kind === "tool-code") setProposal(result.proposal);
      else {
        onAdd(result);
        onClose();
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }

  return (
    <Modal
      title={`Create ${LABELS[kind]}`}
      subtitle="Describe what you need, or go straight to the full form."
      wide={!!proposal}
      onClose={() => { cancel(); onClose(); }}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={manual}>
            Show full form
          </button>
          {busy ? (
            <button type="button" className="btn-secondary" onClick={cancel}>Cancel generation</button>
          ) : (
            <button type="button" className="btn-primary" disabled={!description.trim()} onClick={() => void generate()}>
              <Copilot /> {proposal ? "Regenerate proposal" : "Generate draft"}
            </button>
          )}
        </>
      }
    >
      {kind === "tool" && (
        <Field label="What to create">
          <SegmentedControl
            label="Tool draft type"
            value={target}
            onChange={(value) => { setTarget(value as "tool" | "tool-code"); setProposal(undefined); setError(undefined); }}
            options={[
              { value: "tool", label: "Existing binding", disabled: busy },
              { value: "tool-code", label: "New tool code proposal", disabled: busy },
            ]}
          />
        </Field>
      )}
      <Field label={`Describe your ${LABELS[kind]}`} hint="Include its purpose, inputs, expected output, and any constraints. Do not include secrets or private job data.">
        <textarea
          className="input"
          aria-label={`Describe your ${LABELS[kind]}`}
          rows={6}
          maxLength={8_000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={EXAMPLES[kind]}
          disabled={busy}
          autoFocus
        />
      </Field>
      <p className="text-xs fg-muted">
        Uses GitHub Copilot through the local companion server and its GitHub authentication, not the harness's Foundry model.
        Your description and configuration catalog (names, descriptions, tools, models and profile capabilities) are sent to Copilot.
        Instructions, skill bodies, schemas, examples and credentials are not included in the prompt.
      </p>
      <Flash tone={target === "tool-code" ? "warn" : "info"}>
        {target === "tool-code"
          ? "Generates code for review only. Nothing is installed, executed, or added to the harness. This does not create a Copilot built-in. Download the proposal before closing."
          : "The generated draft opens in the full editor for review. Nothing is written to disk until you save the harness."}
        {kind === "tool" && target === "tool" && " If no existing binding fits, choose New tool code proposal."}
      </Flash>
      {busy && <p role="status" className="flex items-center gap-2"><Spinner /> Drafting with Copilot (up to 90 seconds)...</p>}
      {error && <Flash tone="error">{error}</Flash>}
      {proposal && <CodeProposal proposal={proposal} />}
    </Modal>
  );
}

export function CodeProposal({ proposal }: { proposal: ToolCodeProposal }) {
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ kind: "tool-code", proposal }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${proposal.name}-proposal.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return (
    <section className="space-y-3" aria-label="Review-only tool code proposal">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{proposal.name}: review-only proposal</h3>
        <button type="button" className="btn-secondary" onClick={download}><Download /> Download proposal JSON</button>
      </div>
      <p className="whitespace-pre-wrap">{proposal.summary}</p>
      {proposal.files.map((file) => (
        <Field key={file.path} label={file.path}>
          <textarea className="input-mono" aria-label={file.path} value={file.content} readOnly rows={12} spellCheck={false} />
        </Field>
      ))}
      <Field label="Integration and verification instructions">
        <textarea className="input-mono" aria-label="Integration and verification instructions" value={proposal.instructions} readOnly rows={10} />
      </Field>
      <Flash tone="warn">
        Generated code has not been compiled, tested, or reviewed. Merge it into the platform source, implement both runner bindings,
        update the profiles, and rebuild before configuring the new binding. The configurator cannot install this proposal.
      </Flash>
    </section>
  );
}
