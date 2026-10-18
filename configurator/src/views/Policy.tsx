import { RotateCcw, Save, ShieldCheck, Trash2 } from "../components/icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ExecutionPolicy, Issue, PolicyOverrideStatus } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, Card, ChipsInput, Field, Flash, HelpButton, IssueList, NumberInput, PageHeader, SegmentedControl, Spinner, Toggle } from "../components/ui";
import { clearDraft, readDraft, useDraftAutosave, useHistory, useRegisterEditorActions, type Draft } from "../history";
import { useApp, useDebounced } from "../state";
import { ApprovalsCard, HostingCeilingsCard, McpCatalogCard } from "./policy/cards";
import {
  countIssues,
  differencesFromBase,
  draftKey,
  GROUPS,
  isDirty,
  issueGroup,
  overriddenGroups,
  overridesFrom,
  withGroup,
  type Group,
  type PolicyDraft,
} from "./policy/model";
import { Locked, SubHeading } from "./policy/parts";

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

const BASE = "";

/** Issues for one card, and in harness scope the settings that differ from the base policy. */
function CardFooter({ issues, differences }: { issues: Issue[]; differences?: ReturnType<typeof differencesFromBase> }) {
  if (issues.length === 0 && !differences?.length) return null;
  return (
    <div className="mt-5 space-y-3 border-t border-muted pt-4">
      {differences && differences.length > 0 && (
        <div className="text-xs">
          <span className="font-semibold">Differs from the base policy</span>
          <ul className="mt-1 space-y-0.5 fg-muted">
            {differences.map((d) => (
              <li key={d.field}>
                {d.label}: <span className="line-through">{d.base}</span> → <span className="fg-default font-medium">{d.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.length > 0 && <IssueList issues={issues} />}
    </div>
  );
}

export function PolicyView() {
  const { workspace, refreshWorkspace, toast, settings } = useApp();
  const [scope, setScope] = useState(BASE);
  const [base, setBase] = useState<ExecutionPolicy>();
  const [saved, setSaved] = useState<PolicyDraft>();
  const [loadedScope, setLoadedScope] = useState<string>();
  const history = useHistory<PolicyDraft | undefined>(undefined);
  const draft = history.value;
  const [pendingDraft, setPendingDraft] = useState<Draft<PolicyDraft> & { stale: boolean }>();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const harnessScope = scope !== BASE;
  const baseline = useMemo(() => (saved ? JSON.stringify(saved) : undefined), [saved]);

  /** Shows a freshly loaded or saved document, and offers a browser draft that differs from it. */
  const show = (next: PolicyDraft, nextIssues: Issue[], forScope: string, offerDraft: boolean) => {
    setSaved(next);
    history.reset(structuredClone(next));
    setIssues(nextIssues);
    setLoadedScope(forScope);
    setPendingDraft(undefined);
    if (!offerDraft) return;
    const stored = readDraft<PolicyDraft>(draftKey(forScope));
    if (!stored) return;
    if (!isDirty(stored.value, next, forScope !== BASE)) clearDraft(draftKey(forScope));
    else setPendingDraft({ ...stored, stale: stored.baseline !== JSON.stringify(next) });
  };

  useEffect(() => {
    let cancelled = false;
    setLoadedScope(undefined);
    const basePolicy = api<{ policy?: ExecutionPolicy; issues: Issue[] }>("/api/policy");
    const load =
      scope === BASE
        ? basePolicy.then((result) => {
            if (cancelled) return;
            setBase(result.policy);
            if (result.policy) show({ policy: result.policy, groups: [] }, result.issues, BASE, true);
            else setIssues(result.issues);
          })
        : Promise.all([basePolicy, api<PolicyOverrideStatus>(`/api/policy/overrides/${scope}`)]).then(([baseResult, result]) => {
            if (cancelled) return;
            setBase(baseResult.policy);
            show({ policy: result.effective, groups: overriddenGroups(result.override?.overrides) }, result.issues, scope, true);
          });
    load.catch((error) => !cancelled && toast(errorMessage(error), "error"));
    return () => {
      cancelled = true;
    };
    // `show` only uses stable setters and the history object's stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, toast]);

  const ready = !!draft && !!saved && !!base && loadedScope === scope;
  const dirty = ready && isDirty(draft, saved, harnessScope);
  useDraftAutosave(ready ? draftKey(scope) : undefined, draft, baseline, ready && !pendingDraft);

  const overrides = useMemo(() => (harnessScope && draft ? overridesFrom(draft.policy, draft.groups) : undefined), [harnessScope, draft]);
  const debounced = useDebounced(harnessScope ? overrides : draft?.policy, 400);
  useEffect(() => {
    if (!debounced || !dirty) return;
    let cancelled = false;
    const request = harnessScope
      ? api<{ issues: Issue[] }>(`/api/policy/overrides/${scope}/validate`, { method: "POST", body: { overrides: debounced } })
      : api<{ issues: Issue[] }>("/api/policy/validate", { method: "POST", body: { policy: debounced } });
    request.then((result) => !cancelled && setIssues(result.issues)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, dirty, harnessScope, scope]);
  // Reverting or undoing back to the saved document restores its validation.
  useEffect(() => {
    if (ready && !dirty && saved) {
      const request = harnessScope
        ? api<{ issues: Issue[] }>(`/api/policy/overrides/${scope}/validate`, { method: "POST", body: { overrides: overridesFrom(saved.policy, saved.groups) } })
        : api<{ issues: Issue[] }>("/api/policy/validate", { method: "POST", body: { policy: saved.policy } });
      let cancelled = false;
      request.then((result) => !cancelled && setIssues(result.issues)).catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    return undefined;
    // Only when the document returns to its saved state; the load already set the saved issues.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const { errors, warnings } = countIssues(issues);
  const issuesByGroup = useMemo(() => {
    const grouped = new Map<Group | undefined, Issue[]>();
    for (const found of issues) {
      const group = issueGroup(found);
      grouped.set(group, [...(grouped.get(group) ?? []), found]);
    }
    return grouped;
  }, [issues]);

  async function save() {
    if (!draft || !base) return;
    if (errors > 0) {
      toast("Fix the errors on this page before saving.", "error");
      return;
    }
    setBusy(true);
    try {
      if (harnessScope) {
        if (draft.groups.length === 0) {
          await api(`/api/policy/overrides/${scope}`, { method: "DELETE" });
          show({ policy: structuredClone(base), groups: [] }, [], scope, false);
          toast(`Removed policy/harnesses/${scope}.json; ${scope} uses the base policy`, "success");
        } else {
          const result = await api<PolicyOverrideStatus>(`/api/policy/overrides/${scope}`, { method: "PUT", body: { overrides } });
          show({ policy: result.effective, groups: overriddenGroups(result.override?.overrides) }, result.issues, scope, false);
          toast(`Saved policy/harnesses/${scope}.json`, "success");
        }
      } else {
        const result = await api<{ policy: ExecutionPolicy; issues: Issue[] }>("/api/policy", { method: "PUT", body: { policy: draft.policy } });
        setBase(result.policy);
        show({ policy: result.policy, groups: [] }, result.issues, BASE, false);
        toast("Saved policy/execution-policy.json", "success");
      }
      clearDraft(draftKey(scope));
      await refreshWorkspace();
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  useRegisterEditorActions(
    ready
      ? {
          label: harnessScope ? `Policy for ${scope}` : "Execution policy",
          canUndo: history.canUndo && !busy && !pendingDraft,
          canRedo: history.canRedo && !busy && !pendingDraft,
          undo: history.undo,
          redo: history.redo,
          dirty,
          saving: busy,
          save: () => void save(),
        }
      : undefined,
  );

  const harnessNames = useMemo(() => [...new Set((workspace?.harnesses ?? []).map((h) => h.name))].sort(), [workspace]);
  const overridden = new Map((workspace?.policyOverrides ?? []).map((o) => [o.harness, o]));

  if (!ready || !workspace) {
    return <Spinner />;
  }
  const policy = draft.policy;
  const groups = draft.groups;
  /** Records an edit. Edits with the same key coalesce while typing, so undo steps back a whole value. */
  const update = (mutate: (p: ExecutionPolicy) => void, key?: string) =>
    history.set((current) => {
      const next = structuredClone(current!);
      mutate(next.policy);
      return next;
    }, key);
  const setOverride = (group: Group, on: boolean) =>
    history.set((current) => {
      const next = structuredClone(current!);
      next.groups = withGroup(next.groups, group, on);
      if (!on) {
        for (const field of GROUPS[group]) {
          const value = base[field];
          if (value === undefined) delete (next.policy as Partial<ExecutionPolicy>)[field];
          else (next.policy as Record<string, unknown>)[field] = structuredClone(value);
        }
      }
      return next;
    });
  const locked = (group: Group) => harnessScope && !groups.includes(group);
  const cardTitle = (title: string, group: Group) => (
    <span className="flex flex-wrap items-center gap-2">
      {title}
      {harnessScope && (groups.includes(group) ? <Badge tone="brand">overridden</Badge> : <Badge>inherited</Badge>)}
    </span>
  );
  const overrideToggle = (group: Group) =>
    harnessScope ? <Toggle checked={groups.includes(group)} onChange={(on) => setOverride(group, on)} label="Override for this harness" /> : undefined;
  const footer = (group: Group) => (
    <CardFooter
      issues={issuesByGroup.get(group) ?? []}
      differences={harnessScope && groups.includes(group) ? differencesFromBase(group, policy, base) : undefined}
    />
  );
  const otherIssues = issuesByGroup.get(undefined) ?? [];
  const globalLocked = harnessScope;
  const globalHint = harnessScope ? "Global; set in the base policy." : undefined;
  const yolo = (policy.permissionModes ?? []).includes("allow");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Execution policy"
        leading={<ShieldCheck size={24} className="fg-muted" />}
        description="Operator-enforced ceilings. Harnesses and callers can only narrow these. Changes apply to new jobs after the service restarts or redeploys."
        actions={
          <>
            <button type="button" className="btn-secondary" disabled={!dirty || busy} onClick={() => history.set(structuredClone(saved))}>
              <RotateCcw className="h-4 w-4" /> Revert
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!dirty || errors > 0 || busy}
              title={errors > 0 ? "Fix the errors on this page before saving." : undefined}
              onClick={() => void save()}
            >
              {busy ? <Spinner /> : groups.length === 0 && harnessScope ? <Trash2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}{" "}
              {harnessScope ? (groups.length === 0 ? "Remove override" : "Save override") : "Save policy"}
            </button>
          </>
        }
      />

      {pendingDraft && (
        <Flash
          tone="warn"
          actions={
            <>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  clearDraft(draftKey(scope));
                  setPendingDraft(undefined);
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  history.set(structuredClone(pendingDraft.value));
                  setPendingDraft(undefined);
                }}
              >
                Restore draft
              </button>
            </>
          }
        >
          <strong>Unsaved policy changes from {new Date(pendingDraft.savedAt).toLocaleString()}.</strong>{" "}
          {pendingDraft.stale
            ? "The policy file changed after this draft was saved; restoring replaces those changes when you save."
            : "Restore them to keep editing, or discard them."}
        </Flash>
      )}

      <Card
        title={
          <span className="flex items-center gap-1">
            Applies to <HelpButton topic="policy.scope" />
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <select className="input max-w-sm" value={scope} disabled={dirty || busy} onChange={(e) => setScope(e.target.value)} aria-label="Policy scope">
            <option value={BASE}>All harnesses (base policy)</option>
            {harnessNames.map((name) => (
              <option key={name} value={name}>
                {name}
                {overridden.has(name) ? " (override)" : ""}
              </option>
            ))}
          </select>
          {dirty && <span className="hint">Save or revert to switch.</span>}
          {[...overridden.values()].filter((o) => !harnessNames.includes(o.harness)).map((o) => (
            <Badge key={o.harness} tone="red">
              policy/harnesses/{o.harness}.json names no harness
            </Badge>
          ))}
        </div>
        {harnessScope && (
          <p className="hint mt-3">
            Showing the effective policy for <strong>{scope}</strong>. Turn on <em>Override for this harness</em> on a card to replace those settings in{" "}
            <code>policy/harnesses/{scope}.json</code>; other cards inherit the base policy. Lease timing and per-caller limits are always global.
          </p>
        )}
        <div className="mt-4 border-t border-muted pt-3" aria-live="polite">
          {errors === 0 && warnings === 0 ? (
            <IssueList issues={[]} empty={harnessScope ? `The effective policy for ${scope} is valid.` : "The policy is valid."} />
          ) : (
            <p className="text-sm">
              {errors > 0 && <Badge tone="red">{errors === 1 ? "1 error" : `${errors} errors`}</Badge>}{" "}
              {warnings > 0 && <Badge tone="amber">{warnings === 1 ? "1 warning" : `${warnings} warnings`}</Badge>}{" "}
              <span className="fg-muted">
                {errors > 0 ? "Errors block saving. " : ""}Each issue is shown on the section it affects.
              </span>
            </p>
          )}
          {otherIssues.length > 0 && (
            <div className="mt-3">
              <IssueList issues={otherIssues} />
            </div>
          )}
        </div>
      </Card>

      <Card title={cardTitle("Approved agents and models", "agents")} actions={overrideToggle("agents")}>
        <Locked locked={locked("agents")}>
          <div className="space-y-2">
            {workspace.profiles.map((profile) => (
              <Toggle
                key={profile.id}
                checked={policy.allowedProfiles.includes(profile.id)}
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
          <Field label="Approved models" help="policy.allowedModels" className="mt-5" hint="Model names served by the inference gateway. Each environment maps them to Foundry deployments; GitHub Copilot models use github/<id> names (for example github/claude-sonnet-5.5).">
            <ChipsInput
              values={policy.allowedModels}
              onChange={(values) => update((p) => void (p.allowedModels = values))}
              placeholder="Add a model and press Enter"
              suggestions={settings?.local.githubInferenceModels?.map((id) => `github/${id}`)}
            />
          </Field>
        </Locked>
        {footer("agents")}
      </Card>

      <Card title={cardTitle("Limits", "limits")} actions={overrideToggle("limits")}>
        <SubHeading hint={harnessScope ? "Overridable for this harness." : "Harnesses can lower these; none can raise them."}>Per job</SubHeading>
        <Locked locked={locked("limits")} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Max duration per attempt" help="policy.maxDurationSeconds">
            <NumberInput unit="seconds" value={policy.maxDurationSeconds} min={10} max={3600} onChange={(v) => update((p) => void (p.maxDurationSeconds = v), "maxDurationSeconds")} />
          </Field>
          <Field label="Max inference tokens per job" help="policy.maxInferenceTokensPerJob">
            <NumberInput unit="tokens" value={policy.maxInferenceTokensPerJob} min={1000} step={1000} onChange={(v) => update((p) => void (p.maxInferenceTokensPerJob = v), "maxInferenceTokensPerJob")} />
          </Field>
          <Field label="Max attempts" help="policy.retry" hint="Including the first attempt.">
            <NumberInput value={policy.retry.maxAttempts} min={1} max={5} onChange={(v) => update((p) => void (p.retry.maxAttempts = v), "retry.maxAttempts")} />
          </Field>
          <Field label="Retry backoff" hint="Doubles after each attempt.">
            <NumberInput unit="seconds" value={policy.retry.backoffSeconds} min={1} max={3600} onChange={(v) => update((p) => void (p.retry.backoffSeconds = v), "retry.backoffSeconds")} />
          </Field>
        </Locked>
        <div className="mt-6">
          <SubHeading hint={harnessScope ? "These apply to every harness and are set in the base policy." : "These apply to every harness and cannot be overridden."}>
            Global
          </SubHeading>
          <Locked locked={globalLocked} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Lease" help="policy.leaseSeconds" hint={globalHint ?? "Executors heartbeat every third of this."}>
              <NumberInput unit="seconds" value={policy.leaseSeconds} min={10} max={600} onChange={(v) => update((p) => void (p.leaseSeconds = v), "leaseSeconds")} />
            </Field>
            <Field label="Concurrent attempts per caller" help="policy.maxConcurrentAttemptsPerPrincipal" hint={globalHint}>
              <NumberInput value={policy.maxConcurrentAttemptsPerPrincipal} min={1} max={1000} onChange={(v) => update((p) => void (p.maxConcurrentAttemptsPerPrincipal = v), "maxConcurrentAttemptsPerPrincipal")} />
            </Field>
            <Field label="Open jobs per caller" help="policy.maxQueuedJobsPerPrincipal" hint={globalHint}>
              <NumberInput value={policy.maxQueuedJobsPerPrincipal} min={1} max={100000} onChange={(v) => update((p) => void (p.maxQueuedJobsPerPrincipal = v), "maxQueuedJobsPerPrincipal")} />
            </Field>
          </Locked>
        </div>
        {footer("limits")}
      </Card>

      <Card
        title={cardTitle("Built-in tools and permissions", "tools")}
        subtitle="Which built-in Copilot tool groups harnesses may enable, and how their actions may be approved."
        actions={overrideToggle("tools")}
      >
        <Locked locked={locked("tools")}>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="label !mb-0">Allowed tool groups</span>
                <HelpButton topic="policy.builtinTools" />
              </div>
              {(
                [
                  ["files", "Files", "view, glob, grep, create, edit"],
                  ["shell", "Shell", "bash commands in the runner container"],
                  ["web", "Web", "web_fetch"],
                  ["agents", "Built-in agents", "explore, general-purpose and the task tools"],
                ] as const
              ).map(([id, label, detail]) => (
                <Toggle
                  key={id}
                  checked={(policy.builtinTools ?? []).includes(id)}
                  onChange={(checked) =>
                    update((p) => {
                      const order = ["files", "shell", "web", "agents"] as const;
                      const next = order.filter((g) => (g === id ? checked : (p.builtinTools ?? []).includes(g)));
                      if (next.length) p.builtinTools = [...next];
                      else delete p.builtinTools;
                    })
                  }
                  label={label}
                  description={detail}
                />
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="label !mb-0">Allowed permission modes</span>
                <HelpButton topic="policy.permissionModes" />
              </div>
              <Toggle checked disabled label="Deny" description="Always available; the default for every harness." onChange={() => undefined} />
              {(
                [
                  ["ask", "Ask", "Copilot CLI defaults: workspace reads and read-only commands run; other actions and questions go to the person who submitted the job."],
                  ["allow", "Allow (yolo)", "Let harnesses approve actions automatically."],
                ] as const
              ).map(([id, label, detail]) => (
                <Toggle
                  key={id}
                  checked={(policy.permissionModes ?? []).includes(id)}
                  onChange={(checked) =>
                    update((p) => {
                      const next = (["ask", "allow"] as const).filter((m) => (m === id ? checked : (p.permissionModes ?? []).includes(m)));
                      if (next.length) p.permissionModes = [...next];
                      else delete p.permissionModes;
                    })
                  }
                  label={label}
                  description={detail}
                />
              ))}
            </div>
          </div>
          {yolo && (
            <div className="mt-4">
              <Flash tone="warn">
                <strong>Allow</strong> lets harnesses approve shell commands, file writes and web access without review, and egress is not enforced.
                Keep it out of shared deployments; prefer <strong>Ask</strong>.
              </Flash>
            </div>
          )}
        </Locked>
        {footer("tools")}
      </Card>

      <ApprovalsCard
        policy={policy}
        update={update}
        locked={locked("approvals")}
        title={cardTitle("Approval modes", "approvals")}
        actions={overrideToggle("approvals")}
        footer={footer("approvals")}
        profiles={workspace.profiles}
      />

      <McpCatalogCard
        policy={policy}
        update={update}
        locked={locked("mcp")}
        title={cardTitle("Remote MCP servers", "mcp")}
        actions={overrideToggle("mcp")}
        footer={footer("mcp")}
      />

      <Card title={cardTitle("Model options", "model")} subtitle="Ceilings for the model settings harnesses and sub-agents can request." actions={overrideToggle("model")}>
        <Locked locked={locked("model")}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Maximum reasoning effort" help="policy.maxReasoningEffort" hint="Jobs from harnesses above the cap are rejected at admission.">
              <div>
                <SegmentedControl
                  label="Maximum reasoning effort"
                  value={policy.maxReasoningEffort ?? ""}
                  onChange={(value) =>
                    update((p) => {
                      if (value) p.maxReasoningEffort = value as NonNullable<ExecutionPolicy["maxReasoningEffort"]>;
                      else delete p.maxReasoningEffort;
                    })
                  }
                  options={[
                    { value: "", label: "No cap" },
                    { value: "low", label: "low" },
                    { value: "medium", label: "medium" },
                    { value: "high", label: "high" },
                    { value: "xhigh", label: "xhigh" },
                  ]}
                />
              </div>
            </Field>
            <div className="pt-6">
              <Toggle
                checked={!!policy.allowLongContext}
                help="policy.allowLongContext"
                onChange={(checked) =>
                  update((p) => {
                    if (checked) p.allowLongContext = true;
                    else delete p.allowLongContext;
                  })
                }
                label="Allow the long-context tier"
                description="Harnesses may request long_context; it usually costs more per token."
              />
            </div>
          </div>
        </Locked>
        {footer("model")}
      </Card>

      <HostingCeilingsCard
        policy={policy}
        update={update}
        locked={locked("hosting")}
        title={cardTitle("Hosting", "hosting")}
        actions={overrideToggle("hosting")}
        footer={footer("hosting")}
        defaults={workspace.policyDefaults.hosting}
        bindings={workspace.bindings}
      />

      <Card
        title={cardTitle("Required controls", "controls")}
        subtitle="Executors report what they enforce; each job is only handed to executors that meet its policy's requirements or whose gaps that policy acknowledges."
        actions={overrideToggle("controls")}
      >
        <Locked locked={locked("controls")}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Runner process isolation" help="policy.processIsolation">
              <div>
                <SegmentedControl
                  label="Runner process isolation"
                  value={policy.requirements.processIsolation}
                  onChange={(value) => update((p) => void (p.requirements.processIsolation = value))}
                  options={[
                    { value: "uid", label: "Separate unprivileged user (uid)" },
                    { value: "none", label: "None" },
                  ]}
                />
              </div>
            </Field>
            <Field label="Network egress" help="policy.egress">
              <div>
                <SegmentedControl
                  label="Network egress"
                  value={policy.requirements.egress}
                  onChange={(value) => update((p) => void (p.requirements.egress = value))}
                  options={[
                    { value: "gateway-only", label: "Gateway only" },
                    { value: "none", label: "Unrestricted" },
                  ]}
                />
              </div>
            </Field>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex items-center gap-1"><span className="label !mb-0">Acknowledged gaps</span><HelpButton topic="policy.acknowledgedGaps" /></div>
            {GAPS.map((gap) => (
              <Toggle
                key={gap.id}
                checked={policy.acknowledgedGaps.includes(gap.id)}
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
            <p className="hint">
              Acknowledged gaps are recorded on every job and shown to callers. The shipped executors (local and Container Apps) enforce uid
              isolation but not egress, so a policy that requires gateway-only egress without acknowledging the gap leaves its jobs queued.
            </p>
          </div>
        </Locked>
        {footer("controls")}
      </Card>
    </div>
  );
}
