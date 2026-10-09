import { RotateCcw, Save, ShieldCheck, Trash2 } from "../components/icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ExecutionPolicy, Issue, PolicyOverrideStatus } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, Card, ChipsInput, Field, Flash, HelpButton, IssueList, NumberInput, PageHeader, SegmentedControl, Spinner, Toggle } from "../components/ui";
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

/** Policy cards and the fields a harness override replaces when that card is overridden. */
const GROUPS = {
  agents: ["allowedProfiles", "allowedModels"],
  limits: ["maxDurationSeconds", "maxInferenceTokensPerJob", "retry"],
  tools: ["builtinTools", "permissionModes"],
  model: ["maxReasoningEffort", "allowLongContext"],
  controls: ["requirements", "acknowledgedGaps"],
} as const satisfies Record<string, ReadonlyArray<keyof ExecutionPolicy>>;
type Group = keyof typeof GROUPS;
type Overrides = Partial<ExecutionPolicy>;

const BASE = "";

function overriddenGroups(overrides: Overrides | undefined): Set<Group> {
  const keys = new Set(Object.keys(overrides ?? {}));
  return new Set((Object.keys(GROUPS) as Group[]).filter((group) => GROUPS[group].some((field) => keys.has(field))));
}

/** The override document for the overridden cards. Optional fields get explicit values so they do not inherit. */
function overridesFrom(draft: ExecutionPolicy, groups: Set<Group>): Overrides {
  const result: Record<string, unknown> = {};
  for (const group of groups) {
    for (const field of GROUPS[group]) result[field] = structuredClone(draft[field]);
  }
  if (groups.has("tools")) {
    result.builtinTools ??= [];
    result.permissionModes ??= [];
  }
  if (groups.has("model")) {
    result.maxReasoningEffort ??= "xhigh";
    result.allowLongContext ??= false;
  }
  return result as Overrides;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/** Inherited settings are shown read-only in harness scope; a native disabled fieldset locks every nested control. */
function Locked({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={locked} className={locked ? "opacity-70" : undefined}>
      {children}
    </fieldset>
  );
}

export function PolicyView() {
  const { workspace, refreshWorkspace, toast } = useApp();
  const [scope, setScope] = useState(BASE);
  const [base, setBase] = useState<ExecutionPolicy>();
  const [saved, setSaved] = useState<ExecutionPolicy>();
  const [savedOverrides, setSavedOverrides] = useState<Overrides>();
  const [draft, setDraft] = useState<ExecutionPolicy>();
  const [groups, setGroups] = useState<Set<Group>>(new Set());
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const harnessScope = scope !== BASE;

  useEffect(() => {
    api<{ policy?: ExecutionPolicy; issues: Issue[] }>("/api/policy")
      .then((result) => {
        setBase(result.policy);
        if (scope === BASE) {
          setSaved(result.policy);
          setDraft(result.policy && structuredClone(result.policy));
          setIssues(result.issues);
        }
      })
      .catch((error) => toast(errorMessage(error), "error"));
    if (scope === BASE) {
      setGroups(new Set());
      setSavedOverrides(undefined);
      return;
    }
    api<PolicyOverrideStatus>(`/api/policy/overrides/${scope}`)
      .then((result) => {
        setSaved(result.effective);
        setDraft(structuredClone(result.effective));
        setSavedOverrides(result.override?.overrides ?? {});
        setGroups(overriddenGroups(result.override?.overrides));
        setIssues(result.issues);
      })
      .catch((error) => toast(errorMessage(error), "error"));
  }, [scope, toast]);

  const overrides = useMemo(() => (harnessScope && draft ? overridesFrom(draft, groups) : undefined), [harnessScope, draft, groups]);
  const savedComputed = useMemo(
    () => (harnessScope && saved ? overridesFrom(saved, overriddenGroups(savedOverrides)) : undefined),
    [harnessScope, saved, savedOverrides],
  );
  const dirty = harnessScope ? stable(overrides) !== stable(savedComputed) : stable(saved) !== stable(draft);
  const debounced = useDebounced(harnessScope ? overrides : draft, 400);
  useEffect(() => {
    if (!debounced || !dirty) return;
    const request = harnessScope
      ? api<{ issues: Issue[] }>(`/api/policy/overrides/${scope}/validate`, { method: "POST", body: { overrides: debounced } })
      : api<{ issues: Issue[] }>("/api/policy/validate", { method: "POST", body: { policy: debounced } });
    request.then((result) => setIssues(result.issues)).catch(() => undefined);
  }, [debounced, dirty]);

  const harnessNames = useMemo(() => [...new Set((workspace?.harnesses ?? []).map((h) => h.name))].sort(), [workspace]);
  const overridden = new Map((workspace?.policyOverrides ?? []).map((o) => [o.harness, o]));

  if (!draft || !workspace || !base) {
    return <Spinner />;
  }
  const update = (mutate: (p: ExecutionPolicy) => void) =>
    setDraft((current) => {
      const next = structuredClone(current!);
      mutate(next);
      return next;
    });
  const setOverride = (group: Group, on: boolean) => {
    setGroups((current) => {
      const next = new Set(current);
      if (on) next.add(group);
      else next.delete(group);
      return next;
    });
    if (!on) {
      update((p) => {
        for (const field of GROUPS[group]) {
          const value = base[field];
          if (value === undefined) delete (p as Partial<ExecutionPolicy>)[field];
          else (p as Record<string, unknown>)[field] = structuredClone(value);
        }
      });
    }
  };
  const errors = issues.filter((i) => i.level === "error");
  const locked = (group: Group) => harnessScope && !groups.has(group);
  const overrideToggle = (group: Group) =>
    harnessScope ? (
      <Toggle checked={groups.has(group)} onChange={(on) => setOverride(group, on)} label="Override for this harness" />
    ) : undefined;

  async function save() {
    setBusy(true);
    try {
      if (harnessScope) {
        if (groups.size === 0) {
          await api(`/api/policy/overrides/${scope}`, { method: "DELETE" });
          setSavedOverrides({});
          setSaved(structuredClone(base!));
          setDraft(structuredClone(base!));
          setIssues([]);
          toast(`Removed policy/harnesses/${scope}.json; ${scope} uses the base policy`, "success");
        } else {
          const result = await api<PolicyOverrideStatus>(`/api/policy/overrides/${scope}`, { method: "PUT", body: { overrides } });
          setSaved(result.effective);
          setDraft(structuredClone(result.effective));
          setSavedOverrides(result.override?.overrides ?? {});
          setGroups(overriddenGroups(result.override?.overrides));
          setIssues(result.issues);
          toast(`Saved policy/harnesses/${scope}.json`, "success");
        }
      } else {
        const result = await api<{ policy: ExecutionPolicy; issues: Issue[] }>("/api/policy", { method: "PUT", body: { policy: draft } });
        setBase(result.policy);
        setSaved(result.policy);
        setDraft(structuredClone(result.policy));
        setIssues(result.issues);
        toast("Saved policy/execution-policy.json", "success");
      }
      await refreshWorkspace();
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
        leading={<ShieldCheck size={24} className="fg-muted" />}
        description="Operator-enforced ceilings. Harnesses and callers can only narrow these. Changes apply to new jobs after the service restarts or redeploys."
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={!dirty}
              onClick={() => {
                setDraft(structuredClone(saved!));
                setGroups(overriddenGroups(savedOverrides));
              }}
            >
              <RotateCcw className="h-4 w-4" /> Revert
            </button>
            <button type="button" className="btn-primary" disabled={!dirty || errors.length > 0 || busy} onClick={() => void save()}>
              {busy ? <Spinner /> : groups.size === 0 && harnessScope ? <Trash2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}{" "}
              {harnessScope ? (groups.size === 0 ? "Remove override" : "Save override") : "Save policy"}
            </button>
          </>
        }
      />

      <Card
        title={
          <span className="flex items-center gap-1">
            Applies to <HelpButton topic="policy.scope" />
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <select className="input max-w-sm" value={scope} disabled={dirty} onChange={(e) => setScope(e.target.value)} aria-label="Policy scope">
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
          <Flash>
            Showing the effective policy for <strong>{scope}</strong>. Turn on <em>Override for this harness</em> on a card to replace those
            settings in <code>policy/harnesses/{scope}.json</code>; other cards inherit the base policy. Lease timing and per-caller limits are
            always global.
          </Flash>
        )}
      </Card>

      <Card title="Approved agents and models" actions={overrideToggle("agents")}>
        <Locked locked={locked("agents")}>
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
          <Field label="Approved models" help="policy.allowedModels" className="mt-5" hint="Model names served by the inference gateway. Each environment maps them to Foundry deployments.">
            <ChipsInput values={draft.allowedModels} onChange={(values) => update((p) => void (p.allowedModels = values))} placeholder="Add a model and press Enter" />
          </Field>
        </Locked>
      </Card>

      <Card title="Limits" actions={overrideToggle("limits")}>
        <div className="grid gap-4 md:grid-cols-3">
          <Locked locked={locked("limits")}>
            <Field label="Max duration per attempt (s)" help="policy.maxDurationSeconds">
              <NumberInput unit="seconds" value={draft.maxDurationSeconds} min={10} max={3600} onChange={(v) => update((p) => void (p.maxDurationSeconds = v))} />
            </Field>
          </Locked>
          <Locked locked={locked("limits")}>
            <Field label="Max inference tokens per job" help="policy.maxInferenceTokensPerJob">
              <NumberInput unit="tokens" value={draft.maxInferenceTokensPerJob} min={1000} step={1000} onChange={(v) => update((p) => void (p.maxInferenceTokensPerJob = v))} />
            </Field>
          </Locked>
          <fieldset disabled={harnessScope} className={harnessScope ? "opacity-70" : undefined}>
            <Field label="Lease seconds" help="policy.leaseSeconds" hint={harnessScope ? "Global; set in the base policy." : "Executors heartbeat every third of this."}>
              <NumberInput unit="seconds" value={draft.leaseSeconds} min={10} max={600} onChange={(v) => update((p) => void (p.leaseSeconds = v))} />
            </Field>
          </fieldset>
          <fieldset disabled={harnessScope} className={harnessScope ? "opacity-70" : undefined}>
            <Field label="Concurrent attempts per caller" help="policy.maxConcurrentAttemptsPerPrincipal" hint={harnessScope ? "Global; set in the base policy." : undefined}>
              <NumberInput value={draft.maxConcurrentAttemptsPerPrincipal} min={1} onChange={(v) => update((p) => void (p.maxConcurrentAttemptsPerPrincipal = v))} />
            </Field>
          </fieldset>
          <fieldset disabled={harnessScope} className={harnessScope ? "opacity-70" : undefined}>
            <Field label="Open jobs per caller" help="policy.maxQueuedJobsPerPrincipal" hint={harnessScope ? "Global; set in the base policy." : undefined}>
              <NumberInput value={draft.maxQueuedJobsPerPrincipal} min={1} onChange={(v) => update((p) => void (p.maxQueuedJobsPerPrincipal = v))} />
            </Field>
          </fieldset>
          <div />
          <Locked locked={locked("limits")}>
            <Field label="Max attempts" help="policy.retry">
              <NumberInput value={draft.retry.maxAttempts} min={1} max={5} onChange={(v) => update((p) => void (p.retry.maxAttempts = v))} />
            </Field>
          </Locked>
          <Locked locked={locked("limits")}>
            <Field label="Retry backoff (s)" hint="Doubles after each attempt.">
              <NumberInput unit="seconds" value={draft.retry.backoffSeconds} min={1} max={3600} onChange={(v) => update((p) => void (p.retry.backoffSeconds = v))} />
            </Field>
          </Locked>
        </div>
      </Card>

      <Card
        title="Built-in tools and permissions"
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
                  checked={(draft.builtinTools ?? []).includes(id)}
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
                  checked={(draft.permissionModes ?? []).includes(id)}
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
        </Locked>
      </Card>

      <Card title="Model options" subtitle="Ceilings for the model settings harnesses and sub-agents can request." actions={overrideToggle("model")}>
        <Locked locked={locked("model")}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Maximum reasoning effort" help="policy.maxReasoningEffort" hint="Jobs from harnesses above the cap are rejected at admission.">
              <div>
                <SegmentedControl
                  label="Maximum reasoning effort"
                  value={draft.maxReasoningEffort ?? ""}
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
                checked={!!draft.allowLongContext}
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
      </Card>

      <Card
        title="Required controls"
        subtitle="Executors report what they enforce; each job is only handed to executors that meet its policy's requirements or whose gaps that policy acknowledges."
        actions={overrideToggle("controls")}
      >
        <Locked locked={locked("controls")}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Runner process isolation" help="policy.processIsolation">
              <div>
                <SegmentedControl
                  label="Runner process isolation"
                  value={draft.requirements.processIsolation}
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
                  value={draft.requirements.egress}
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
            <p className="hint">
              Acknowledged gaps are recorded on every job and shown to callers. The shipped executors (local and Container Apps) enforce uid
              isolation but not egress, so a policy that requires gateway-only egress without acknowledging the gap leaves its jobs queued.
            </p>
          </div>
        </Locked>
      </Card>

      <Card title="Validation">
        <IssueList issues={issues} empty={harnessScope ? `The effective policy for ${scope} is valid.` : "The policy is valid."} />
      </Card>
    </div>
  );
}
