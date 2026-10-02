import { RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ExecutionPolicy, Issue } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, Card, ChipsInput, Field, IssueList, NumberInput, PageHeader, Spinner, Toggle } from "../components/ui";
import { useApp, useDebounced } from "../state";

const GAPS: Array<{ id: ExecutionPolicy["acknowledgedGaps"][number]; label: string; description: string }> = [
  {
    id: "egress-not-enforced",
    label: "Egress is not enforced",
    description: "Runners can open outbound connections other than the inference gateway. They still hold no provider credentials.",
  },
  {
    id: "process-isolation-not-enforced",
    label: "Process isolation is not enforced",
    description: "Runners share the executor's user and could read its dispatcher key.",
  },
];

export function PolicyView() {
  const { workspace, refreshWorkspace, toast } = useApp();
  const [saved, setSaved] = useState<ExecutionPolicy>();
  const [draft, setDraft] = useState<ExecutionPolicy>();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ policy?: ExecutionPolicy; issues: Issue[] }>("/api/policy")
      .then((result) => {
        setSaved(result.policy);
        setDraft(result.policy && structuredClone(result.policy));
        setIssues(result.issues);
      })
      .catch((error) => toast(errorMessage(error), "error"));
  }, [toast]);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  const debounced = useDebounced(draft, 400);
  useEffect(() => {
    if (!debounced || !dirty) return;
    api<{ issues: Issue[] }>("/api/policy/validate", { method: "POST", body: { policy: debounced } })
      .then((result) => setIssues(result.issues))
      .catch(() => undefined);
  }, [debounced, dirty]);

  if (!draft || !workspace) {
    return <Spinner />;
  }
  const update = (mutate: (p: ExecutionPolicy) => void) =>
    setDraft((current) => {
      const next = structuredClone(current!);
      mutate(next);
      return next;
    });
  const errors = issues.filter((i) => i.level === "error");

  async function save() {
    setBusy(true);
    try {
      const result = await api<{ policy: ExecutionPolicy; issues: Issue[] }>("/api/policy", { method: "PUT", body: { policy: draft } });
      setSaved(result.policy);
      setDraft(structuredClone(result.policy));
      setIssues(result.issues);
      await refreshWorkspace();
      toast("Saved policy/execution-policy.json", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Execution policy"
        description="Operator-enforced ceilings. Harnesses and callers can only narrow these. Changes apply to new jobs after the service restarts or redeploys."
        actions={
          <>
            <button type="button" className="btn-ghost" disabled={!dirty} onClick={() => setDraft(structuredClone(saved!))}>
              <RotateCcw className="h-4 w-4" /> Revert
            </button>
            <button type="button" className="btn-primary" disabled={!dirty || errors.length > 0 || busy} onClick={() => void save()}>
              {busy ? <Spinner /> : <Save className="h-4 w-4" />} Save policy
            </button>
          </>
        }
      />

      <Card title="Approved agents and models">
        <div className="space-y-2">
          {workspace.profiles.map((profile) => (
            <Toggle
              key={profile.id}
              checked={draft.allowedProfiles.includes(profile.id)}
              onChange={(checked) =>
                update((p) => {
                  const list = p.allowedProfiles.filter((id) => id !== profile.id);
                  p.allowedProfiles = checked ? [...list, profile.id] : list;
                })
              }
              label={
                <span className="flex items-center gap-2">
                  {profile.displayName}
                  <Badge tone={profile.firstParty ? "brand" : "blue"}>{profile.firstParty ? "reference" : "customer"}</Badge>
                </span>
              }
              description={`${profile.id} · ${profile.language} · ${profile.sdk} ${profile.sdkVersion} · tools: ${profile.toolBindings.join(", ") || "none"}`}
            />
          ))}
        </div>
        <Field label="Approved models" className="mt-5" hint="Model names served by the inference gateway. Each environment maps them to Foundry deployments.">
          <ChipsInput values={draft.allowedModels} onChange={(values) => update((p) => void (p.allowedModels = values))} placeholder="Add a model and press Enter" />
        </Field>
      </Card>

      <Card title="Limits">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Max duration per attempt (s)">
            <NumberInput value={draft.maxDurationSeconds} min={10} max={3600} onChange={(v) => update((p) => void (p.maxDurationSeconds = v))} />
          </Field>
          <Field label="Max inference tokens per job">
            <NumberInput value={draft.maxInferenceTokensPerJob} min={1000} step={1000} onChange={(v) => update((p) => void (p.maxInferenceTokensPerJob = v))} />
          </Field>
          <Field label="Lease seconds" hint="Executors heartbeat every third of this.">
            <NumberInput value={draft.leaseSeconds} min={10} max={600} onChange={(v) => update((p) => void (p.leaseSeconds = v))} />
          </Field>
          <Field label="Concurrent attempts per caller">
            <NumberInput value={draft.maxConcurrentAttemptsPerPrincipal} min={1} onChange={(v) => update((p) => void (p.maxConcurrentAttemptsPerPrincipal = v))} />
          </Field>
          <Field label="Open jobs per caller">
            <NumberInput value={draft.maxQueuedJobsPerPrincipal} min={1} onChange={(v) => update((p) => void (p.maxQueuedJobsPerPrincipal = v))} />
          </Field>
          <div />
          <Field label="Max attempts">
            <NumberInput value={draft.retry.maxAttempts} min={1} max={5} onChange={(v) => update((p) => void (p.retry.maxAttempts = v))} />
          </Field>
          <Field label="Retry backoff (s)" hint="Doubles after each attempt.">
            <NumberInput value={draft.retry.backoffSeconds} min={1} max={3600} onChange={(v) => update((p) => void (p.retry.backoffSeconds = v))} />
          </Field>
        </div>
      </Card>

      <Card title="Required controls" subtitle="Executors report what they enforce; work is only handed to executors that meet these or whose gaps you acknowledge.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Runner process isolation">
            <select className="input" value={draft.requirements.processIsolation} onChange={(e) => update((p) => void (p.requirements.processIsolation = e.target.value as "uid" | "none"))}>
              <option value="uid">Separate unprivileged user (uid)</option>
              <option value="none">None</option>
            </select>
          </Field>
          <Field label="Network egress">
            <select className="input" value={draft.requirements.egress} onChange={(e) => update((p) => void (p.requirements.egress = e.target.value as "gateway-only" | "none"))}>
              <option value="gateway-only">Gateway only</option>
              <option value="none">Unrestricted</option>
            </select>
          </Field>
        </div>
        <div className="mt-5 space-y-3">
          <div className="label">Acknowledged gaps</div>
          {GAPS.map((gap) => (
            <Toggle
              key={gap.id}
              checked={draft.acknowledgedGaps.includes(gap.id)}
              onChange={(checked) =>
                update((p) => {
                  const list = p.acknowledgedGaps.filter((g) => g !== gap.id);
                  p.acknowledgedGaps = checked ? [...list, gap.id] : list;
                })
              }
              label={gap.label}
              description={gap.description}
            />
          ))}
          <p className="hint">Acknowledged gaps are recorded on every job and shown to callers. The shipped Container Apps executor enforces uid isolation but not egress.</p>
        </div>
      </Card>

      <Card title="Validation">
        <IssueList issues={issues} empty="The policy is valid." />
      </Card>
    </div>
  );
}
