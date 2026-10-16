// The harness editor's Hosting section: interaction, hosting mode and its settings, approval mode, and remote MCP
// servers, offered within the harness's effective policy (docs/HOSTING-MODES-PLAN.md, section 3).
import { useEffect, useState, type ReactNode } from "react";
import type {
  HarnessDetail,
  HarnessDocument,
  HarnessManifest,
  HostingAvailability,
  HostingAvailabilityInfo,
  HostingMode,
  Issue,
} from "../../../server/types";
import { api, errorMessage } from "../../api";
import { Plus, Trash2 } from "../../components/icons";
import { Badge, Empty, Field, Flash, HelpButton, NumberInput, RadioCards, SegmentedControl, Spinner, Toggle } from "../../components/ui";
import {
  APPROVAL_INFO,
  APPROVAL_ORDER,
  HOSTING_MODE_ORDER,
  MODE_INFO,
  PLACEMENT_LABELS,
  prerequisiteLabel,
  STATUS_BADGES,
  TRANSPORT_INFO,
  type ApprovalMode,
} from "../../hostingText";
import { useApp, useDebounced } from "../../state";

type Update = (mutate: (d: HarnessDocument) => void, key?: string) => void;
type Hosting = NonNullable<HarnessManifest["hosting"]>;
type Workers = NonNullable<Hosting["workers"]>;
type Handoff = NonNullable<Hosting["handoffs"]>[number];
type Permissions = NonNullable<HarnessManifest["permissions"]>;
type McpRequest = NonNullable<HarnessManifest["mcpServers"]>[number];
type HostingDetail = NonNullable<HarnessDetail["hosting"]>;

/** Where the draft can run, re-evaluated shortly after it stops changing. */
function useAvailability(draft: HarnessDocument): { info?: HostingAvailabilityInfo; loading: boolean; error?: string } {
  const debounced = useDebounced(draft, 600);
  const [state, setState] = useState<{ info?: HostingAvailabilityInfo; loading: boolean; error?: string }>({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    api<HostingAvailabilityInfo>("/api/harnesses/availability", { method: "POST", body: { document: debounced } })
      .then((info) => !cancelled && setState({ info, loading: false }))
      .catch((error) => !cancelled && setState({ loading: false, error: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [debounced]);
  return state;
}

function Section({ title, help, description, badge, children }: {
  title: string;
  help?: string;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="box-header">
        <div>
          <h3 className="flex items-center gap-1 text-sm font-semibold leading-6">
            {title} {help && <HelpButton topic={help} />}
          </h3>
          {description && <p className="text-xs fg-muted">{description}</p>}
        </div>
        {badge}
      </div>
      <div className="card-pad space-y-4">{children}</div>
    </section>
  );
}

/** A number that may be omitted: empty means the policy ceiling applies. */
function OptionalNumber({ value, onChange, min, max }: { value: number | undefined; onChange: (value: number | undefined) => void; min: number; max: number }) {
  return <NumberInput value={value ?? Number.NaN} min={min} max={max} onChange={(next) => onChange(Number.isFinite(next) ? next : undefined)} />;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function needs(problems: HostingAvailability["problems"]): string | undefined {
  const labels = unique(problems.map(prerequisiteLabel).filter((label): label is string => !!label));
  return labels.length ? `Needs ${labels.join(", ")}.` : undefined;
}

export function HostingTab({ draft, update, issues, hosting }: {
  draft: HarnessDocument;
  update: Update;
  issues: Issue[];
  hosting?: HostingDetail;
}) {
  const { setView } = useApp();
  const availability = useAvailability(draft);
  const m = draft.manifest;
  const conversation = m.interaction === "conversation";
  const mode: HostingMode = m.hosting?.mode ?? "isolated";
  const errorAt = (prefix: string) => issues.find((i) => i.level === "error" && (i.path === prefix || i.path.startsWith(`${prefix}.`)))?.message;

  const setInteraction = (value: "batch" | "conversation") =>
    update((d) => {
      if (value === "conversation") {
        d.manifest.interaction = "conversation";
        return;
      }
      delete d.manifest.interaction;
      delete d.manifest.hosting;
      delete d.manifest.mcpServers;
      if (d.manifest.permissions) {
        delete d.manifest.permissions.approvalMode;
        delete d.manifest.permissions.judgeModel;
        delete d.manifest.permissions.handler;
      }
    });

  const setMode = (next: HostingMode) =>
    update((d) => {
      const current = d.manifest.hosting;
      const handoffs = current?.handoffs;
      if (next === "isolated" && !handoffs?.length) {
        delete d.manifest.hosting;
        return;
      }
      d.manifest.hosting = {
        mode: next,
        ...(next === "promotable" && current?.promotion ? { promotion: current.promotion } : {}),
        ...(next === "orchestrator" ? { workers: current?.workers ?? { harnesses: [] } } : {}),
        ...(handoffs?.length ? { handoffs } : {}),
      };
    });

  const local = availability.info?.availability.find((entry) => entry.target === "local");
  const modes = HOSTING_MODE_ORDER.map((value) => {
    const allowed = !hosting || hosting.ceilings.modes.includes(value);
    const missing = local?.modes.find((entry) => entry.mode === value)?.missing ?? [];
    const blocked = !conversation && value !== "isolated"
      ? "Needs a conversation harness: set Interaction to Conversations."
      : !allowed
        ? "The operator policy does not allow this mode for this harness. Allow it on the Policy page."
        : undefined;
    const info = MODE_INFO[value];
    return {
      value,
      label: info.label,
      disabled: !!blocked && value !== mode,
      badge: blocked
        ? <Badge tone={allowed ? "neutral" : "red"}>{allowed ? "needs conversation" : "not allowed by policy"}</Badge>
        : !conversation
          ? <Badge tone="green">batch jobs</Badge>
          : missing.length
            ? <Badge tone="amber">unavailable locally</Badge>
            : local
              ? <Badge tone="green">available locally</Badge>
              : value === "isolated" ? <Badge>default</Badge> : undefined,
      description: (
        <>
          {info.summary}
          <span className="mt-1 block">
            <strong className="font-semibold">Gains:</strong> {info.gains}
          </span>
          <span className="block">
            <strong className="font-semibold">Costs:</strong> {info.costs}
          </span>
          {(blocked ?? (conversation && missing.length ? needs(missing) : undefined)) && (
            <span className={blocked && !allowed ? "mt-1 block fg-danger" : "mt-1 block fg-attention"}>
              {blocked ?? needs(missing)}
            </span>
          )}
        </>
      ),
    };
  });

  return (
    <div className="space-y-5">
      <Section
        title="Interaction"
        help="interaction"
        description="Batch jobs run through the jobs API and return a structured result. Conversations are sessions that Copilot CLI attaches to; they do not run as jobs."
      >
        <SegmentedControl
          label="Interaction"
          value={conversation ? "conversation" : "batch"}
          onChange={setInteraction}
          options={[
            { value: "batch", label: "Batch jobs" },
            { value: "conversation", label: "Conversations" },
          ]}
        />
        {errorAt("interaction") && <p className="text-xs fg-danger">{errorAt("interaction")}</p>}
        <p className="hint">
          {conversation
            ? "Conversations need the node-ts-agent profile on the Runtime tab. Switching to batch jobs removes hosting, remote MCP servers and the approval mode, which batch harnesses cannot use."
            : "Hosting modes, remote MCP servers and approval modes other than manual need a conversation harness."}
        </p>
      </Section>

      <Section
        title="Hosting mode"
        help="hosting.mode"
        description="Where the agent loop runs: a deliberate cost, latency and isolation choice. Policy decides which modes are allowed; the deployment must also provide the hosts for it. There is no fallback to another mode."
      >
        <RadioCards label="Hosting mode" value={mode} onChange={setMode} options={modes} />
        {errorAt("hosting.mode") && <p className="text-xs fg-danger">{errorAt("hosting.mode")}</p>}
        {errorAt("hosting") && !errorAt("hosting.mode") && issues.some((i) => i.path === "hosting") && <p className="text-xs fg-danger">{errorAt("hosting")}</p>}
        {conversation && mode !== "isolated" && (
          <p className="hint">
            Shared placement separates sessions with application checks inside one process. It is not an operating-system or hostile-code boundary,
            and egress is not enforced in any mode.
          </p>
        )}
      </Section>

      {conversation && mode === "promotable" && <PromotionSection draft={draft} update={update} hosting={hosting} errorAt={errorAt} />}
      {conversation && mode === "orchestrator" && <WorkersSection draft={draft} update={update} hosting={hosting} errorAt={errorAt} issues={issues} />}
      {conversation && <HandoffsSection draft={draft} update={update} hosting={hosting} errorAt={errorAt} />}
      <ApprovalSection draft={draft} update={update} hosting={hosting} errorAt={errorAt} conversation={conversation} />
      <McpSection draft={draft} update={update} hosting={hosting} errorAt={errorAt} conversation={conversation} onOpenPolicy={() => setView("policy")} />

      <Section
        title="Where it can run"
        description="Evaluated from this workspace's settings for Local run and the selected Azure target, not from a running service."
        badge={
          <button type="button" className="btn-secondary btn-sm" onClick={() => setView("hosting")}>
            Open Hosting page
          </button>
        }
      >
        {availability.loading && !availability.info && <Spinner />}
        {availability.error && <p className="text-sm fg-danger">{availability.error}</p>}
        {availability.info?.note && <Flash tone="warn">{availability.info.note}</Flash>}
        {availability.info && availability.info.availability.length === 0 && (
          <p className="text-sm fg-muted">Fix the validation errors to see where this harness can run.</p>
        )}
        {availability.info?.availability.map((entry) => (
          <AvailabilityRow key={entry.target} entry={entry} />
        ))}
      </Section>
    </div>
  );
}

export function AvailabilityRow({ entry }: { entry: HostingAvailability }) {
  const status = STATUS_BADGES[entry.status];
  const first = entry.problems[0];
  return (
    <div className="space-y-1.5 border-b border-muted pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{entry.label}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-xs fg-muted">{PLACEMENT_LABELS[entry.placement]}</span>
      </div>
      {first && (
        <p className="text-sm">
          {first.message} {prerequisiteLabel(first) && <span className="fg-muted">Needs {prerequisiteLabel(first)}.</span>}
          {entry.problems.length > 1 && <span className="fg-muted"> ({entry.problems.length - 1} more)</span>}
        </p>
      )}
      {entry.transports.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entry.transports.map((transport) => (
            <Badge key={transport.transport} tone={transport.available ? "green" : "neutral"} title={transport.problem?.message}>
              {TRANSPORT_INFO[transport.transport].label}: {transport.available ? "available" : transport.allowed ? "unavailable" : "not allowed"}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  draft: HarnessDocument;
  update: Update;
  hosting?: HostingDetail;
  errorAt: (prefix: string) => string | undefined;
}

function editHosting(update: Update, mutate: (hosting: Hosting) => void, key?: string) {
  update((d) => {
    if (!d.manifest.hosting) return;
    mutate(d.manifest.hosting);
  }, key);
}

function PromotionSection({ draft, update, hosting, errorAt }: SectionProps) {
  const promotion = draft.manifest.hosting?.promotion;
  const sizes = hosting?.ceilings.sizes ?? {};
  const approvals = hosting?.ceilings.promotion.approval ?? ["ask"];
  const set = (mutate: (promotion: NonNullable<Hosting["promotion"]>) => void) =>
    editHosting(update, (h) => {
      const next = { ...h.promotion };
      mutate(next);
      if (Object.keys(next).length) h.promotion = next;
      else delete h.promotion;
    });
  return (
    <Section title="Promotion" help="hosting.promotion" description="When the work needs a shell, real files or more time, the session moves one way into its own container. No route leads back.">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Container size after promotion" error={errorAt("hosting.promotion.size")}>
          <select
            className="input"
            aria-label="Container size after promotion"
            value={promotion?.size ?? ""}
            onChange={(event) =>
              set((p) => {
                if (event.target.value) p.size = event.target.value;
                else delete p.size;
              })
            }
          >
            <option value="">Catalog default ({hosting?.ceilings.defaultSize ?? "smallest"})</option>
            {promotion?.size && !(promotion.size in sizes) && <option value={promotion.size}>{promotion.size} (not in the catalog)</option>}
            {Object.entries(sizes).map(([name, size]) => (
              <option key={name} value={name}>
                {name} · {size.cpus} CPU · {size.memoryMiB} MiB
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model-initiated promotion" error={errorAt("hosting.promotion.approval")} hint="A caller can also promote through the API.">
          <div>
            <SegmentedControl
              label="Promotion approval"
              value={promotion?.approval ?? "ask"}
              onChange={(value) =>
                set((p) => {
                  if (value === "ask") delete p.approval;
                  else p.approval = value;
                })
              }
              options={[
                { value: "ask", label: "Ask a person", disabled: !approvals.includes("ask"), title: approvals.includes("ask") ? undefined : "Not allowed by the operator policy" },
                { value: "allow", label: "Automatic", disabled: !approvals.includes("allow"), title: approvals.includes("allow") ? undefined : "Not allowed by the operator policy" },
              ]}
            />
          </div>
        </Field>
      </div>
    </Section>
  );
}

function WorkersSection({ draft, update, hosting, errorAt, issues }: SectionProps & { issues: Issue[] }) {
  const workers: Workers = draft.manifest.hosting?.workers ?? { harnesses: [] };
  const ceilings = hosting?.ceilings;
  const targets = hosting?.targets ?? [];
  const set = (mutate: (workers: Workers) => void, key?: string) =>
    editHosting(update, (h) => {
      const next: Workers = structuredClone(h.workers ?? { harnesses: [] });
      mutate(next);
      h.workers = next;
    }, key);
  const unknown = workers.harnesses.filter((name) => !targets.some((target) => target.name === name));
  const sizes = Object.keys(ceilings?.sizes ?? {});
  const templates = ceilings?.craftingTemplates ?? [];
  const inheritAllowed = !!ceilings?.workers.allowInheritedAuthority;
  const harnessError = issues.find((i) => i.level === "error" && i.path.startsWith("hosting.workers"))?.message;
  return (
    <Section
      title="Workers"
      help="hosting.workers"
      description="The coordinator starts these harnesses in their own containers, messages them, and archives them. Workers cannot start workers."
    >
      {harnessError && <p className="text-xs fg-danger">{harnessError}</p>}
      <div>
        <span className="label">Worker harnesses</span>
        <div className="space-y-2">
          {targets.length === 0 && unknown.length === 0 && <p className="text-xs fg-muted">No other harness exists yet.</p>}
          {targets.map((target) => {
            const listed = workers.harnesses.includes(target.name);
            const reason = target.interaction !== "conversation"
              ? "A batch harness; workers must be conversation harnesses."
              : target.mode !== "isolated"
                ? `Uses ${target.mode} hosting; workers must use isolated hosting.`
                : !target.isolatedAllowed
                  ? "Its policy does not allow isolated hosting."
                  : undefined;
            return (
              <Toggle
                key={target.name}
                checked={listed}
                disabled={!!reason && !listed}
                onChange={(on) =>
                  set((w) => {
                    w.harnesses = on ? [...w.harnesses, target.name] : w.harnesses.filter((name) => name !== target.name);
                  })
                }
                label={target.name}
                description={reason ?? target.description}
              />
            );
          })}
          {unknown.map((name) => (
            <div key={name} className="flex items-center gap-2 text-sm">
              <Badge tone="red">not found</Badge>
              <code>{name}</code>
              <button type="button" className="btn-ghost btn-sm" onClick={() => set((w) => void (w.harnesses = w.harnesses.filter((entry) => entry !== name)))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Sizes the coordinator may choose</span>
        <div className="flex flex-wrap gap-3">
          {sizes.map((size) => (
            <Toggle
              key={size}
              checked={(workers.sizes ?? []).includes(size)}
              onChange={(on) =>
                set((w) => {
                  const next = sizes.filter((entry) => (entry === size ? on : (w.sizes ?? []).includes(entry)));
                  if (next.length) w.sizes = next;
                  else delete w.sizes;
                })
              }
              label={size}
              description={`${ceilings!.sizes[size]!.cpus} CPU · ${ceilings!.sizes[size]!.memoryMiB} MiB`}
            />
          ))}
        </div>
        <span className="hint block">None selected: the catalog's default size ({ceilings?.defaultSize ?? "smallest"}) only.</span>
        {errorAt("hosting.workers.sizes") && <p className="text-xs fg-danger">{errorAt("hosting.workers.sizes")}</p>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Concurrent workers" hint={`Empty: the policy ceiling (${ceilings?.workers.maxConcurrentPerSession ?? "?"}).`} error={errorAt("hosting.workers.maxConcurrent")}>
          <OptionalNumber
            value={workers.maxConcurrent}
            min={1}
            max={32}
            onChange={(value) =>
              set((w) => {
                if (value === undefined) delete w.maxConcurrent;
                else w.maxConcurrent = value;
              }, "workers.maxConcurrent")
            }
          />
        </Field>
        <Field label="Workers per session" hint={`Empty: the policy ceiling (${ceilings?.workers.maxPerSession ?? "?"}).`} error={errorAt("hosting.workers.maxPerSession")}>
          <OptionalNumber
            value={workers.maxPerSession}
            min={1}
            max={256}
            onChange={(value) =>
              set((w) => {
                if (value === undefined) delete w.maxPerSession;
                else w.maxPerSession = value;
              }, "workers.maxPerSession")
            }
          />
        </Field>
        <Field label="Shared storage" help="hosting.workers.sharedStorage" error={errorAt("hosting.workers.sharedStorage")}>
          <div>
            <SegmentedControl
              label="Shared storage"
              value={workers.sharedStorage ?? "none"}
              onChange={(value) =>
                set((w) => {
                  if (value === "none") delete w.sharedStorage;
                  else w.sharedStorage = value;
                })
              }
              options={[
                { value: "none", label: "Private volumes only" },
                { value: "session", label: "One shared session volume" },
              ]}
            />
          </div>
        </Field>
        <Field label="Crafted workers" help="hosting.workers.crafting" error={errorAt("hosting.workers.crafting")}>
          <select
            className="input"
            aria-label="Crafting template"
            disabled={templates.length === 0 && !workers.crafting}
            value={workers.crafting?.template ?? ""}
            onChange={(event) =>
              set((w) => {
                if (event.target.value) w.crafting = { template: event.target.value };
                else delete w.crafting;
              })
            }
          >
            <option value="">{templates.length ? "Off: listed harnesses only" : "Off: the operator policy defines no crafting templates"}</option>
            {workers.crafting && !templates.includes(workers.crafting.template) && (
              <option value={workers.crafting.template}>{workers.crafting.template} (not in the policy)</option>
            )}
            {templates.map((template) => (
              <option key={template} value={template}>
                {template}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Human authority for assisted workers"
        help="hosting.workers.humanAuthority"
        error={errorAt("hosting.workers.humanAuthority")}
        hint={
          inheritAllowed
            ? "Inherit lets assisted workers' judges treat this session's recorded human messages as authority. Requests only the coordinator asked for still go to a person."
            : "The operator policy does not allow inherited authority, so workers' assisted judges use only their own session's messages."
        }
      >
        <div>
          <SegmentedControl
            label="Human authority"
            value={workers.humanAuthority ?? "none"}
            onChange={(value) =>
              set((w) => {
                if (value === "none") delete w.humanAuthority;
                else w.humanAuthority = value;
              })
            }
            options={[
              { value: "none", label: "Workers' own messages" },
              { value: "inherit", label: "Inherit the person's messages", disabled: !inheritAllowed && workers.humanAuthority !== "inherit", title: inheritAllowed ? undefined : "Not allowed by the operator policy" },
            ]}
          />
        </div>
      </Field>
    </Section>
  );
}

function HandoffsSection({ draft, update, hosting, errorAt }: SectionProps) {
  const handoffs = draft.manifest.hosting?.handoffs ?? [];
  const targets = (hosting?.targets ?? []).filter((target) => target.name !== draft.manifest.name);
  const eligible = targets.filter((target) => target.interaction === "conversation" && target.modeAllowed);
  const set = (mutate: (handoffs: Handoff[]) => Handoff[]) =>
    update((d) => {
      const current = d.manifest.hosting ?? { mode: "isolated" as const };
      const next = mutate(structuredClone(current.handoffs ?? []));
      if (next.length) d.manifest.hosting = { ...current, handoffs: next };
      else if (current.mode === "isolated" && !current.promotion && !current.workers) delete d.manifest.hosting;
      else {
        const { handoffs: _removed, ...rest } = current;
        d.manifest.hosting = rest;
      }
    });
  const add = () => {
    const target = eligible.find((entry) => !handoffs.some((handoff) => handoff.harness === entry.name));
    if (!target) return;
    set((list) => [...list, { harness: target.name, description: (target.description || `Transfer the conversation to ${target.name}.`).slice(0, 1000) }]);
  };
  return (
    <Section
      title="Handoffs"
      help="hosting.handoffs"
      description="Predefined harnesses this one may transfer the conversation to. Each becomes a transfer tool for the model; policy and availability are checked before control moves."
    >
      {handoffs.length === 0 && <p className="text-sm fg-muted">No handoff targets.</p>}
      {handoffs.map((handoff, index) => (
        <div key={index} className="card p-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Target harness" error={errorAt(`hosting.handoffs.${index}.harness`)}>
              <select
                className="input"
                aria-label={`Handoff ${index + 1} target`}
                value={handoff.harness}
                onChange={(event) => set((list) => list.map((entry, i) => (i === index ? { ...entry, harness: event.target.value } : entry)))}
              >
                {!targets.some((target) => target.name === handoff.harness) && <option value={handoff.harness}>{handoff.harness} (not found)</option>}
                {targets.map((target) => {
                  const reason = target.interaction !== "conversation" ? "batch harness" : !target.modeAllowed ? `its policy does not allow ${target.mode} hosting` : undefined;
                  return (
                    <option key={target.name} value={target.name} disabled={!!reason && target.name !== handoff.harness}>
                      {target.name}
                      {reason ? ` (${reason})` : ` (${target.mode})`}
                    </option>
                  );
                })}
              </select>
            </Field>
            <div className="flex items-end justify-end">
              <button type="button" className="btn-danger btn-sm" onClick={() => set((list) => list.filter((_, i) => i !== index))}>
                <Trash2 /> Remove
              </button>
            </div>
            <Field label="Description for the model" className="md:col-span-2" error={errorAt(`hosting.handoffs.${index}.description`)}>
              <textarea
                className="input"
                rows={2}
                value={handoff.description}
                onChange={(event) =>
                  update((d) => {
                    const entry = d.manifest.hosting?.handoffs?.[index];
                    if (entry) entry.description = event.target.value;
                  }, `hosting.handoffs.${index}.description`)
                }
              />
            </Field>
            <Field label="History the target receives" error={errorAt(`hosting.handoffs.${index}.history`)}>
              <div>
                <SegmentedControl
                  label={`Handoff ${index + 1} history`}
                  size="sm"
                  value={handoff.history ?? ""}
                  onChange={(value) =>
                    set((list) =>
                      list.map((entry, i) => {
                        if (i !== index) return entry;
                        const { history: _history, ...rest } = entry;
                        return value ? { ...rest, history: value } : rest;
                      }),
                    )
                  }
                  options={[
                    { value: "", label: "Default" },
                    { value: "full", label: "Full" },
                    { value: "summary", label: "Summary" },
                    { value: "none", label: "None" },
                  ]}
                />
              </div>
            </Field>
            <Field label="Approval" error={errorAt(`hosting.handoffs.${index}.approval`)}>
              <div>
                <SegmentedControl
                  label={`Handoff ${index + 1} approval`}
                  size="sm"
                  value={handoff.approval ?? "ask"}
                  onChange={(value) =>
                    set((list) =>
                      list.map((entry, i) => {
                        if (i !== index) return entry;
                        const { approval: _approval, ...rest } = entry;
                        return value === "ask" ? rest : { ...rest, approval: value };
                      }),
                    )
                  }
                  options={[
                    { value: "ask", label: "Ask a person" },
                    { value: "allow", label: "Automatic" },
                  ]}
                />
              </div>
            </Field>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={handoffs.length >= 8 || !eligible.some((entry) => !handoffs.some((handoff) => handoff.harness === entry.name))}
          onClick={add}
        >
          <Plus /> Add handoff
        </button>
        {eligible.length === 0 && (
          <span className="text-xs fg-muted">No other conversation harness can be a target: its policy must allow its own hosting mode.</span>
        )}
      </div>
      <p className="hint">Default history: a summary across placements, full history within one placement. Only full history keeps the person's messages as authority.</p>
    </Section>
  );
}

function ApprovalSection({ draft, update, hosting, errorAt, conversation }: SectionProps & { conversation: boolean }) {
  const permissions = draft.manifest.permissions;
  const approval: ApprovalMode = permissions?.approvalMode ?? "manual";
  const allowed = hosting?.ceilings.approvalModes ?? ["manual"];
  const policyHandlers = hosting?.ceilings.permissionHandlers ?? [];
  const profileHandlers = hosting?.profileHandlers ?? [];
  const usable = policyHandlers.filter((handler) => profileHandlers.includes(handler));
  const asks = !!permissions && (permissions.default === "ask" || Object.values(permissions.kinds ?? {}).includes("ask") || !!permissions.questions);
  const reasonFor = (mode: ApprovalMode): string | undefined => {
    if (!conversation && mode !== "manual") return "Batch harnesses use manual approval.";
    if (!allowed.includes(mode)) return "Not allowed by the operator policy.";
    if (mode === "custom" && usable.length === 0) {
      return policyHandlers.length === 0
        ? "The operator policy lists no permission handlers."
        : "No allowed handler is provided by the TypeScript conversation profile.";
    }
    return undefined;
  };
  const setApproval = (mode: ApprovalMode) =>
    update((d) => {
      if (!d.manifest.permissions && mode === "manual") return;
      const next: Permissions = structuredClone(d.manifest.permissions ?? { default: "deny" });
      if (mode === "manual") delete next.approvalMode;
      else next.approvalMode = mode;
      if (mode !== "assisted") delete next.judgeModel;
      if (mode === "custom") next.handler = next.handler && usable.includes(next.handler) ? next.handler : usable[0];
      else delete next.handler;
      d.manifest.permissions = next;
    });
  const setPermission = (mutate: (permissions: Permissions) => void) =>
    update((d) => {
      if (!d.manifest.permissions) return;
      mutate(d.manifest.permissions);
    });
  const handlers = unique([...policyHandlers, ...profileHandlers, ...(permissions?.handler ? [permissions.handler] : [])]).sort();
  return (
    <Section
      title="Approval mode"
      help="permissions.approvalMode"
      description="Who decides a permission request that the rules on the Permissions tab would send to a person. Deny rules always win."
    >
      <RadioCards
        label="Approval mode"
        value={approval}
        onChange={setApproval}
        columns={2}
        options={APPROVAL_ORDER.map((mode) => {
          const reason = reasonFor(mode);
          return {
            value: mode,
            label: APPROVAL_INFO[mode].label,
            disabled: !!reason && mode !== approval,
            badge: reason ? <Badge tone={allowed.includes(mode) ? "neutral" : "red"}>{allowed.includes(mode) ? "unavailable" : "not allowed"}</Badge> : mode === "manual" ? <Badge>default</Badge> : undefined,
            description: (
              <>
                {APPROVAL_INFO[mode].detail}
                {reason && <span className="mt-1 block fg-attention">{reason}</span>}
              </>
            ),
          };
        })}
      />
      {errorAt("permissions.approvalMode") && <p className="text-xs fg-danger">{errorAt("permissions.approvalMode")}</p>}
      {approval !== "manual" && !asks && (
        <Flash>No permission rule asks a person yet, so the approval mode has no effect. Set a rule to Ask on the Permissions tab.</Flash>
      )}
      {approval === "assisted" && (
        <Field
          label="Judge model"
          help="permissions.judgeModel"
          error={errorAt("permissions.judgeModel")}
          hint="Judge calls go through the gateway and count against the session's budget."
        >
          <select
            className="input"
            aria-label="Judge model"
            value={permissions?.judgeModel ?? ""}
            onChange={(event) =>
              setPermission((p) => {
                if (event.target.value) p.judgeModel = event.target.value;
                else delete p.judgeModel;
              })
            }
          >
            <option value="">The session's model (default)</option>
            {unique([...draft.manifest.model.allowed, ...(permissions?.judgeModel ? [permissions.judgeModel] : [])]).map((model) => {
              const approved = !hosting || hosting.allowedModels.includes(model);
              const inHarness = draft.manifest.model.allowed.includes(model);
              return (
                <option key={model} value={model} disabled={(!approved || !inHarness) && model !== permissions?.judgeModel}>
                  {model}
                  {!inHarness ? " (not an allowed model of this harness)" : !approved ? " (not approved by policy)" : ""}
                </option>
              );
            })}
          </select>
        </Field>
      )}
      {approval === "custom" && (
        <Field label="Permission handler" help="permissions.handler" error={errorAt("permissions.handler")}>
          <select
            className="input"
            aria-label="Permission handler"
            value={permissions?.handler ?? ""}
            onChange={(event) => setPermission((p) => void (p.handler = event.target.value))}
          >
            {!permissions?.handler && <option value="">Choose a handler</option>}
            {handlers.map((handler) => {
              const reason = !policyHandlers.includes(handler)
                ? "not allowed by policy"
                : !profileHandlers.includes(handler)
                  ? "not provided by the conversation profile"
                  : undefined;
              return (
                <option key={handler} value={handler} disabled={!!reason && handler !== permissions?.handler}>
                  {handler}
                  {reason ? ` (${reason})` : ""}
                </option>
              );
            })}
          </select>
        </Field>
      )}
    </Section>
  );
}

function McpSection({ draft, update, hosting, errorAt, conversation, onOpenPolicy }: SectionProps & { conversation: boolean; onOpenPolicy: () => void }) {
  const requested = draft.manifest.mcpServers ?? [];
  const catalog = hosting?.mcpCatalog ?? [];
  const set = (mutate: (servers: McpRequest[]) => McpRequest[]) =>
    update((d) => {
      const next = mutate(structuredClone(d.manifest.mcpServers ?? []));
      if (next.length) d.manifest.mcpServers = next;
      else delete d.manifest.mcpServers;
    });
  const unknown = requested.filter((entry) => !catalog.some((server) => server.server === entry.server));
  return (
    <Section
      title="Remote MCP servers"
      help="mcpServers"
      description="Servers from the operator's catalog, and the tools this harness requests from each. The host holds each server's credential; the model sees only names."
      badge={<Badge tone={requested.length ? "done" : "neutral"}>{requested.length ? `${requested.length} server(s)` : "none"}</Badge>}
    >
      {errorAt("mcpServers") && requested.length > 0 && !conversation && <p className="text-xs fg-danger">{errorAt("mcpServers")}</p>}
      {!conversation ? (
        <p className="text-sm fg-muted">Remote MCP servers need a conversation harness.</p>
      ) : catalog.length === 0 && unknown.length === 0 ? (
        <Empty>
          The operator's MCP catalog is empty.{" "}
          <button type="button" className="font-semibold text-[var(--fgColor-accent)] underline" onClick={onOpenPolicy}>
            Add servers on the Policy page.
          </button>
        </Empty>
      ) : (
        <div className="space-y-3">
          {catalog.map((server) => {
            const index = requested.findIndex((entry) => entry.server === server.server);
            const entry = index >= 0 ? requested[index] : undefined;
            const extra = entry?.tools.filter((tool) => !server.tools.includes(tool)) ?? [];
            return (
              <div key={server.server} className="card p-3">
                <Toggle
                  checked={!!entry}
                  onChange={(on) =>
                    set((list) => (on ? [...list, { server: server.server, tools: [] }] : list.filter((item) => item.server !== server.server)))
                  }
                  label={<code className="!bg-transparent">{server.server}</code>}
                  description={server.description}
                />
                {entry && (
                  <div className="mt-2 space-y-2 pl-6">
                    <div className="flex flex-wrap gap-3" role="group" aria-label={`Tools from ${server.server}`}>
                      {[...server.tools, ...extra].map((tool) => (
                        <Toggle
                          key={tool}
                          checked={entry.tools.includes(tool)}
                          onChange={(on) =>
                            set((list) =>
                              list.map((item) =>
                                item.server === server.server
                                  ? { ...item, tools: on ? [...item.tools, tool] : item.tools.filter((name) => name !== tool) }
                                  : item,
                              ),
                            )
                          }
                          label={<code className="!bg-transparent text-xs">{tool}</code>}
                          description={server.tools.includes(tool) ? undefined : "Not approved in the catalog"}
                        />
                      ))}
                    </div>
                    {entry.tools.length === 0 && <p className="text-xs fg-danger">Choose at least one tool.</p>}
                    {errorAt(`mcpServers.${index}`) && entry.tools.length > 0 && <p className="text-xs fg-danger">{errorAt(`mcpServers.${index}`)}</p>}
                  </div>
                )}
              </div>
            );
          })}
          {unknown.map((entry) => (
            <div key={entry.server} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="red">not in the catalog</Badge>
              <code>{entry.server}</code>
              <button type="button" className="btn-ghost btn-sm" onClick={() => set((list) => list.filter((item) => item.server !== entry.server))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
