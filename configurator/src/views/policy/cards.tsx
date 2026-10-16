// Policy cards for approval modes, the remote MCP catalog and hosting ceilings (docs/HOSTING-MODES-PLAN.md, section 3).
import { useState, type ReactNode } from "react";
import type { BindingInfo, EffectiveHostingPolicy, ExecutionPolicy, ProfileSummary } from "../../../server/types";
import { Plus, RotateCcw, Trash2 } from "../../components/icons";
import { Badge, Card, ChipsInput, Empty, Field, Flash, HelpButton, NumberInput, Toggle } from "../../components/ui";
import { UrlInput } from "../../components/UrlInput";
import { APPROVAL_INFO, APPROVAL_ORDER, HOSTING_MODE_ORDER, MODE_INFO, TRANSPORT_INFO, type ApprovalMode, type HostingTransport } from "../../hostingText";
import { effectiveHosting, freeName, renameKey, type ContainerSize, type CraftingTemplate, type HostingPolicy, type McpServerPolicy } from "./model";
import { Locked, NameInput, SubHeading } from "./parts";

type Update = (mutate: (policy: ExecutionPolicy) => void, key?: string) => void;

interface CardShell {
  title: ReactNode;
  actions?: ReactNode;
  footer: ReactNode;
  locked: boolean;
  policy: ExecutionPolicy;
  update: Update;
}

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const MCP_TOOL = /^[A-Za-z0-9_.-]{1,128}$/;
const BUILTIN_GROUPS = ["files", "shell", "web", "agents"] as const;
const PROMOTION_APPROVALS = ["ask", "allow"] as const;
const HANDOFF_HISTORIES = ["full", "summary", "none"] as const;
const HANDOFF_HISTORY_INFO: Record<(typeof HANDOFF_HISTORIES)[number], { label: string; description: string }> = {
  full: { label: "Full", description: "The target continues the same conversation; the person's messages keep their authority." },
  summary: { label: "Summary", description: "The target starts fresh from a bounded summary the source writes." },
  none: { label: "None", description: "The target starts fresh with only the source's stated reason." },
};

/** The members of `order` that are in `current`, with `value` switched on or off. */
function toggled<T extends string>(order: readonly T[], current: readonly T[], value: T, on: boolean): T[] {
  return order.filter((entry) => (entry === value ? on : current.includes(entry)));
}

/**
 * Credentials never belong in policy files or browser drafts. Secret names are short slugs; anything with other
 * characters, or a long run without hyphens, is refused before it reaches the draft.
 */
export function looksLikeCredential(value: string): boolean {
  return !/^[a-z0-9-]*$/.test(value) || (value.length >= 24 && !value.includes("-"));
}

export function ApprovalsCard({ policy, update, locked, title, actions, footer, profiles }: CardShell & { profiles: ProfileSummary[] }) {
  const modes = policy.approvalModes ?? ["manual"];
  const handlers = policy.permissionHandlers ?? [];
  const providers = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const handler of profile.permissionHandlers ?? []) providers.set(handler, [...(providers.get(handler) ?? []), profile.id]);
  }
  const toggle = (mode: ApprovalMode, on: boolean) =>
    update((p) => {
      const next = toggled(APPROVAL_ORDER, p.approvalModes ?? ["manual"], mode, on);
      if (next.length === 0) return;
      if (next.length === 1 && next[0] === "manual") delete p.approvalModes;
      else p.approvalModes = next;
    });
  return (
    <Card title={title} subtitle="Who may decide permission requests that a harness's rules would send to a person." actions={actions}>
      <Locked locked={locked}>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <span className="label !mb-0">Allowed approval modes</span>
              <HelpButton topic="policy.approvalModes" />
            </div>
            {APPROVAL_ORDER.map((mode) => (
              <Toggle
                key={mode}
                checked={modes.includes(mode)}
                disabled={modes.length === 1 && modes.includes(mode)}
                onChange={(on) => toggle(mode, on)}
                label={APPROVAL_INFO[mode].label}
                description={APPROVAL_INFO[mode].detail}
              />
            ))}
            <p className="hint">Each harness's per-kind deny, ask and allow rules still run first. Batch harnesses always use manual approval.</p>
          </div>
          <Field
            label="Permission handlers"
            help="policy.permissionHandlers"
            hint={
              providers.size
                ? "Handlers that execution profiles provide are suggested."
                : "No execution profile provides a permission handler yet. Handlers are reviewed integrator code registered in a profile's permissionHandlers."
            }
          >
            <ChipsInput
              values={handlers}
              pattern={SLUG}
              suggestions={[...providers.keys()].sort()}
              details={Object.fromEntries([...providers].map(([handler, ids]) => [handler, ids.join(", ")]))}
              placeholder="Add a handler name and press Enter"
              onChange={(values) =>
                update((p) => {
                  if (values.length) p.permissionHandlers = values;
                  else delete p.permissionHandlers;
                })
              }
            />
          </Field>
        </div>
        {modes.includes("allow-all") && (
          <div className="mt-4">
            <Flash tone="warn">
              <strong>Allow all</strong> lets harnesses approve every request that would ask a person, without review, and egress is not enforced.
            </Flash>
          </div>
        )}
      </Locked>
      {footer}
    </Card>
  );
}

/** A secret-name field that refuses anything shaped like a credential, so it never reaches the draft or a file. */
function SecretNameInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [refused, setRefused] = useState(false);
  return (
    <div>
      <input
        className="input font-mono"
        aria-label={label}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const next = event.target.value.trim();
          if (looksLikeCredential(next)) {
            setRefused(true);
            return;
          }
          setRefused(false);
          onChange(next);
        }}
      />
      {refused && (
        <span className="mt-1 block text-xs fg-danger" role="alert">
          That looks like a credential, so it was not kept. Enter the secret's name, such as docs-search-token.
        </span>
      )}
    </div>
  );
}

export function McpCatalogCard({ policy, update, locked, title, actions, footer }: CardShell) {
  const servers = Object.entries(policy.mcpServers ?? {});
  const names = servers.map(([name]) => name);
  const edit = (mutate: (servers: Record<string, McpServerPolicy>) => Record<string, McpServerPolicy> | void, key?: string) =>
    update((p) => {
      const current = structuredClone(p.mcpServers ?? {});
      const next = mutate(current) ?? current;
      if (Object.keys(next).length) p.mcpServers = next;
      else delete p.mcpServers;
    }, key);
  const editServer = (name: string, mutate: (server: McpServerPolicy) => void, key?: string) =>
    edit((all) => {
      const server = all[name];
      if (server) mutate(server);
    }, key);
  return (
    <Card
      title={title}
      subtitle="Remote MCP servers harnesses may request, and the tools each may use. Credentials stay with the operator: store secret names only."
      actions={actions}
    >
      <Locked locked={locked}>
        <div className="space-y-3">
          {servers.length === 0 && <Empty>No remote MCP servers. Harnesses cannot request one until you add it here.</Empty>}
          {servers.map(([name, server], index) => (
            <div key={index} className="card">
              <div className="box-header !py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="!bg-transparent font-semibold">{name}</code>
                  {server.auth ? <Badge tone="blue">secret: {server.auth.secret}</Badge> : <Badge>no credential</Badge>}
                  {server.allowPrivateNetwork && <Badge tone="amber">private network allowed</Badge>}
                </div>
                <button
                  type="button"
                  className="btn-danger btn-sm btn-icon"
                  aria-label={`Remove MCP server ${name}`}
                  onClick={() => edit((all) => void delete all[name])}
                >
                  <Trash2 />
                </button>
              </div>
              <div className="card-pad grid gap-3 md:grid-cols-2">
                <Field label="Name" hint="Harnesses request the server by this name.">
                  <NameInput value={name} taken={names} label={`Name of MCP server ${name}`} onCommit={(next) => edit((all) => renameKey(all, name, next))} />
                </Field>
                <Field label="URL" help="policy.mcpServers">
                  <UrlInput
                    label={`URL of MCP server ${name}`}
                    value={server.url}
                    https={!!server.auth && !server.allowPrivateNetwork}
                    placeholder="https://mcp.example.com/mcp"
                    onChange={(url) => editServer(name, (s) => void (s.url = url), `mcpServers.${index}.url`)}
                  />
                </Field>
                <Field label="Description" className="md:col-span-2" hint="Shown to harness authors when they choose servers.">
                  <input
                    className="input"
                    value={server.description ?? ""}
                    onChange={(event) =>
                      editServer(
                        name,
                        (s) => {
                          if (event.target.value) s.description = event.target.value;
                          else delete s.description;
                        },
                        `mcpServers.${index}.description`,
                      )
                    }
                  />
                </Field>
                <Field label="Approved tools" className="md:col-span-2" hint="Exact tool names on the server. Harnesses can request only these.">
                  <ChipsInput
                    values={server.tools}
                    pattern={MCP_TOOL}
                    placeholder="Add a tool name and press Enter"
                    onChange={(tools) => editServer(name, (s) => void (s.tools = tools))}
                  />
                </Field>
                <div className="space-y-3 md:col-span-2">
                  <Toggle
                    checked={!!server.auth}
                    help="policy.mcpServers.auth"
                    onChange={(on) =>
                      editServer(name, (s) => {
                        if (on) s.auth = { secret: `${name}-token`.slice(0, 63) };
                        else delete s.auth;
                      })
                    }
                    label="Sends a credential"
                    description="One service credential for every caller, which the hosting process resolves from the named secret. Per-user sign-in is a later phase."
                  />
                  {server.auth && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="Secret name" hint="The name of the operator secret that holds the credential, never the credential itself.">
                        <SecretNameInput
                          label={`Secret name for MCP server ${name}`}
                          value={server.auth.secret}
                          onChange={(secret) => editServer(name, (s) => void (s.auth!.secret = secret), `mcpServers.${index}.auth.secret`)}
                        />
                      </Field>
                      <Field label="Header" hint="Omitted: the credential is sent as a bearer token in Authorization. Otherwise it is sent as is in this header.">
                        <input
                          className="input font-mono"
                          aria-label={`Credential header for MCP server ${name}`}
                          value={server.auth.header ?? ""}
                          placeholder="Authorization"
                          spellCheck={false}
                          onChange={(event) => {
                            const header = event.target.value.trim();
                            if (!/^[A-Za-z0-9-]*$/.test(header)) return;
                            editServer(
                              name,
                              (s) => {
                                if (header) s.auth!.header = header;
                                else delete s.auth!.header;
                              },
                              `mcpServers.${index}.auth.header`,
                            );
                          }}
                        />
                      </Field>
                    </div>
                  )}
                  <Toggle
                    checked={!!server.allowPrivateNetwork}
                    onChange={(on) =>
                      editServer(name, (s) => {
                        if (on) s.allowPrivateNetwork = true;
                        else delete s.allowPrivateNetwork;
                      })
                    }
                    label="Allow a private or loopback address (development only)"
                    description="Only this server's exact origin may resolve to loopback or private addresses, and its credential may then travel over http. Link-local, metadata and internal service addresses stay refused."
                  />
                </div>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={servers.length >= 32}
            onClick={() => edit((all) => ({ ...all, [freeName("mcp-server", names)]: { url: "", tools: [] } }))}
          >
            <Plus /> Add MCP server
          </button>
          <p className="hint">
            Harness definitions and the model see only server names and approved tools. A harness can use remote MCP only on a host that supports
            it; the Hosting page shows where.
          </p>
        </div>
      </Locked>
      {footer}
    </Card>
  );
}

function TemplateEditor({ name, template, names, sizeNames, allowedModels, approvalModes, bindings, onRename, onChange, onRemove }: {
  name: string;
  template: CraftingTemplate;
  names: string[];
  sizeNames: string[];
  allowedModels: string[];
  approvalModes: ApprovalMode[];
  bindings: BindingInfo[];
  onRename: (next: string) => void;
  onChange: (mutate: (template: CraftingTemplate) => void, key?: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="card">
      <div className="box-header !py-2">
        <code className="!bg-transparent font-semibold">{name}</code>
        <button type="button" className="btn-danger btn-sm btn-icon" aria-label={`Remove crafting template ${name}`} onClick={onRemove}>
          <Trash2 />
        </button>
      </div>
      <div className="card-pad grid gap-3 md:grid-cols-2">
        <Field label="Name" hint="Orchestrator harnesses select the template by this name.">
          <NameInput value={name} taken={names} label={`Name of crafting template ${name}`} onCommit={onRename} />
        </Field>
        <Field label="Description">
          <input
            className="input"
            value={template.description ?? ""}
            onChange={(event) =>
              onChange((t) => {
                if (event.target.value) t.description = event.target.value;
                else delete t.description;
              }, `crafting.${name}.description`)
            }
          />
        </Field>
        <Field label="Models" hint="Crafted workers may use only these approved models.">
          <ChipsInput values={template.models} suggestions={allowedModels} placeholder="Add a model" onChange={(models) => onChange((t) => void (t.models = models))} />
        </Field>
        <Field label="Tool bindings" hint="Packaged tools a crafted worker may request.">
          <ChipsInput
            values={template.toolBindings}
            suggestions={bindings.map((binding) => binding.id)}
            placeholder="Add a binding"
            onChange={(toolBindings) => onChange((t) => void (t.toolBindings = toolBindings))}
          />
        </Field>
        <div className="space-y-1">
          <span className="label">Built-in tool groups</span>
          <div className="flex flex-wrap gap-3">
            {BUILTIN_GROUPS.map((group) => (
              <Toggle
                key={group}
                checked={template.builtinTools.includes(group)}
                onChange={(on) => onChange((t) => void (t.builtinTools = toggled(BUILTIN_GROUPS, t.builtinTools, group, on)))}
                label={group}
              />
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <span className="label">Approval modes</span>
          <div className="flex flex-wrap gap-3">
            {APPROVAL_ORDER.map((mode) => (
              <Toggle
                key={mode}
                checked={template.approvalModes.includes(mode)}
                disabled={template.approvalModes.length === 1 && template.approvalModes.includes(mode)}
                onChange={(on) => onChange((t) => void (t.approvalModes = toggled(APPROVAL_ORDER, t.approvalModes, mode, on)))}
                label={APPROVAL_INFO[mode].label}
                description={approvalModes.includes(mode) ? undefined : "Not allowed by this policy"}
              />
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <span className="label">Sizes</span>
          <div className="flex flex-wrap gap-3">
            {sizeNames.map((size) => (
              <Toggle
                key={size}
                checked={template.sizes.includes(size)}
                disabled={template.sizes.length === 1 && template.sizes.includes(size)}
                onChange={(on) => onChange((t) => void (t.sizes = toggled(sizeNames, t.sizes, size, on)))}
                label={size}
              />
            ))}
          </div>
        </div>
        <Field label="Max duration">
          <NumberInput
            unit="seconds"
            value={template.maxDurationSeconds}
            min={10}
            max={3600}
            onChange={(value) => onChange((t) => void (t.maxDurationSeconds = value), `crafting.${name}.duration`)}
          />
        </Field>
        <div className="space-y-2 md:col-span-2">
          <Toggle
            checked={template.maxInferenceTokens !== undefined}
            onChange={(on) =>
              onChange((t) => {
                if (on) t.maxInferenceTokens = 200_000;
                else delete t.maxInferenceTokens;
              })
            }
            label="Limit inference tokens per crafted worker"
          />
          {template.maxInferenceTokens !== undefined && (
            <NumberInput
              unit="tokens"
              value={template.maxInferenceTokens}
              min={1000}
              max={5_000_000}
              step={1000}
              onChange={(value) => onChange((t) => void (t.maxInferenceTokens = value), `crafting.${name}.tokens`)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const WORKER_LIMITS = [
  ["maxConcurrentPerSession", "Concurrent workers per session", 1, 32],
  ["maxPerSession", "Workers per session", 1, 256],
  ["maxPerPrincipal", "Concurrent workers per caller", 1, 256],
] as const;

export function HostingCeilingsCard({ policy, update, locked, title, actions, footer, defaults, bindings }: CardShell & {
  defaults: EffectiveHostingPolicy;
  bindings: BindingInfo[];
}) {
  const effective = effectiveHosting(policy.hosting, defaults);
  const sizeNames = Object.keys(effective.sizes);
  const templateNames = Object.keys(effective.crafting.templates);
  const approvalModes = policy.approvalModes ?? ["manual"];
  const edit = (mutate: (hosting: HostingPolicy) => void, key?: string) =>
    update((p) => {
      const next = structuredClone(p.hosting ?? {});
      mutate(next);
      if (Object.keys(next).length) p.hosting = next;
      else delete p.hosting;
    }, key);
  const sizes = (hosting: HostingPolicy) => (hosting.sizes ??= structuredClone(effective.sizes));
  const templates = (hosting: HostingPolicy) => (hosting.crafting ??= { templates: {} }).templates;
  const renameSize = (from: string, to: string) =>
    edit((h) => {
      h.sizes = renameKey(sizes(h), from, to);
      if (h.defaultSize === from) h.defaultSize = to;
      for (const template of Object.values(h.crafting?.templates ?? {})) template.sizes = template.sizes.map((size) => (size === from ? to : size));
    });
  const workers = effective.workers;
  return (
    <Card
      title={title}
      subtitle="Ceilings for where conversation harnesses run. Harnesses request a mode; deployments still need the hosts for it."
      actions={actions}
    >
      <Locked locked={locked}>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <span className="label !mb-0">Allowed hosting modes</span>
              <HelpButton topic="policy.hosting.modes" />
            </div>
            {HOSTING_MODE_ORDER.map((mode) => (
              <Toggle
                key={mode}
                checked={effective.modes.includes(mode)}
                disabled={effective.modes.length === 1 && effective.modes.includes(mode)}
                onChange={(on) => edit((h) => void (h.modes = toggled(HOSTING_MODE_ORDER, effective.modes, mode, on)))}
                label={MODE_INFO[mode].label}
                description={MODE_INFO[mode].summary}
              />
            ))}
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="label !mb-0">Allowed client transports</span>
                <HelpButton topic="policy.hosting.transports" />
              </div>
              {(Object.keys(TRANSPORT_INFO) as HostingTransport[]).map((transport) => (
                <Toggle
                  key={transport}
                  checked={effective.transports.includes(transport)}
                  disabled={effective.transports.length === 1 && effective.transports.includes(transport)}
                  onChange={(on) => edit((h) => void (h.transports = toggled(Object.keys(TRANSPORT_INFO) as HostingTransport[], effective.transports, transport, on)))}
                  label={TRANSPORT_INFO[transport].label}
                  description={TRANSPORT_INFO[transport].detail}
                />
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="label !mb-0">Promotion approval</span>
                <HelpButton topic="policy.hosting.promotion" />
              </div>
              {PROMOTION_APPROVALS.map((approval) => (
                <Toggle
                  key={approval}
                  checked={effective.promotion.approval.includes(approval)}
                  disabled={effective.promotion.approval.length === 1 && effective.promotion.approval.includes(approval)}
                  onChange={(on) => edit((h) => void (h.promotion = { approval: toggled(PROMOTION_APPROVALS, effective.promotion.approval, approval, on) }))}
                  label={approval === "ask" ? "Ask a person" : "Automatic"}
                  description={approval === "ask" ? "A person approves a model-initiated promotion first." : "Promotable harnesses may promote without asking."}
                />
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="label !mb-0">Handoff approval</span>
                <HelpButton topic="policy.hosting.handoffs" />
              </div>
              {PROMOTION_APPROVALS.map((approval) => (
                <Toggle
                  key={approval}
                  checked={effective.handoffs.approval.includes(approval)}
                  disabled={effective.handoffs.approval.length === 1 && effective.handoffs.approval.includes(approval)}
                  onChange={(on) => edit((h) => void (h.handoffs = { ...h.handoffs, approval: toggled(PROMOTION_APPROVALS, effective.handoffs.approval, approval, on) }))}
                  label={approval === "ask" ? "Ask a person" : "Automatic"}
                  description={approval === "ask"
                    ? "The attached person approves each handoff in their client; the safety judge and handlers cannot."
                    : "Harnesses may mark handoff targets that run without asking."}
                />
              ))}
            </div>
            <div className="space-y-2">
              <span className="label !mb-0">Handoff history</span>
              {HANDOFF_HISTORIES.map((history) => (
                <Toggle
                  key={history}
                  checked={effective.handoffs.history.includes(history)}
                  disabled={effective.handoffs.history.length === 1 && effective.handoffs.history.includes(history)}
                  onChange={(on) => edit((h) => void (h.handoffs = { ...h.handoffs, history: toggled(HANDOFF_HISTORIES, effective.handoffs.history, history, on) }))}
                  label={HANDOFF_HISTORY_INFO[history].label}
                  description={HANDOFF_HISTORY_INFO[history].description}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <SubHeading hint="Containers are sized by name; the model never chooses CPUs, memory, images or commands.">Container sizes</SubHeading>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs fg-muted">
                  <th className="pb-1 pr-3 font-semibold">Name</th>
                  <th className="pb-1 pr-3 font-semibold">CPUs</th>
                  <th className="pb-1 pr-3 font-semibold">Memory (MiB)</th>
                  <th className="pb-1" />
                </tr>
              </thead>
              <tbody>
                {Object.entries(effective.sizes).map(([name, size], index) => (
                  <tr key={index} className="align-top">
                    <td className="py-1 pr-3">
                      <NameInput value={name} taken={sizeNames} label={`Name of size ${name}`} onCommit={(next) => renameSize(name, next)} />
                    </td>
                    <td className="py-1 pr-3">
                      <NumberInput
                        value={size.cpus}
                        min={0.25}
                        max={8}
                        step={0.25}
                        onChange={(cpus) => edit((h) => void (sizes(h)[name] = { ...sizes(h)[name]!, cpus }), `sizes.${index}.cpus`)}
                      />
                    </td>
                    <td className="py-1 pr-3">
                      <NumberInput
                        value={size.memoryMiB}
                        min={256}
                        max={16_384}
                        step={256}
                        onChange={(memoryMiB) => edit((h) => void (sizes(h)[name] = { ...sizes(h)[name]!, memoryMiB }), `sizes.${index}.memory`)}
                      />
                    </td>
                    <td className="py-1">
                      <button
                        type="button"
                        className="btn-ghost btn-sm btn-icon"
                        aria-label={`Remove size ${name}`}
                        disabled={sizeNames.length <= 1}
                        onClick={() => edit((h) => void delete sizes(h)[name])}
                      >
                        <Trash2 />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={sizeNames.length >= 8}
              onClick={() => edit((h) => void (sizes(h)[freeName("size", sizeNames)] = { cpus: 1, memoryMiB: 2048 }))}
            >
              <Plus /> Add size
            </button>
            {policy.hosting?.sizes && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => edit((h) => void delete h.sizes)}>
                <RotateCcw /> Default sizes
              </button>
            )}
            <label className="flex items-center gap-2 text-sm">
              <span className="fg-muted">Default size</span>
              <select
                className="input !w-auto"
                aria-label="Default size"
                value={policy.hosting?.defaultSize ?? ""}
                onChange={(event) =>
                  edit((h) => {
                    if (event.target.value) h.defaultSize = event.target.value;
                    else delete h.defaultSize;
                  })
                }
              >
                <option value="">Smallest ({effective.defaultSize || "none"})</option>
                {policy.hosting?.defaultSize && !sizeNames.includes(policy.hosting.defaultSize) && (
                  <option value={policy.hosting.defaultSize}>{policy.hosting.defaultSize} (not in the catalog)</option>
                )}
                {sizeNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-6">
          <SubHeading hint="Ceilings for orchestrator workers; each harness can only lower them.">Worker limits</SubHeading>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {WORKER_LIMITS.map(([field, label, min, max]) => (
              <Field key={field} label={label}>
                <NumberInput
                  value={workers[field]}
                  min={min}
                  max={max}
                  onChange={(value) => edit((h) => void (h.workers = { ...h.workers, [field]: value }), `workers.${field}`)}
                />
              </Field>
            ))}
            <Field label="Idle time before a worker stops">
              <NumberInput
                unit="seconds"
                value={workers.idleSeconds}
                min={30}
                max={86_400}
                onChange={(value) => edit((h) => void (h.workers = { ...h.workers, idleSeconds: value }), "workers.idleSeconds")}
              />
            </Field>
            <Field label="Maximum worker lifetime">
              <NumberInput
                unit="seconds"
                value={workers.maxLifetimeSeconds}
                min={60}
                max={86_400}
                onChange={(value) => edit((h) => void (h.workers = { ...h.workers, maxLifetimeSeconds: value }), "workers.maxLifetimeSeconds")}
              />
            </Field>
          </div>
          <div className="mt-3 space-y-2">
            <Toggle
              checked={workers.allowInheritedAuthority}
              help="policy.hosting.allowInheritedAuthority"
              onChange={(on) => edit((h) => void (h.workers = { ...h.workers, allowInheritedAuthority: on }))}
              label="Allow inherited human authority"
              description="Coordinator harnesses may opt in to letting their assisted workers' judges treat the session's recorded human messages as authority. Off by default."
            />
            <Toggle
              checked={workers.allowCoordinatorAnswers}
              help="policy.hosting.allowCoordinatorAnswers"
              onChange={(on) => edit((h) => void (h.workers = { ...h.workers, allowCoordinatorAnswers: on }))}
              label="Let coordinators answer worker questions"
              description="A coordinator may answer its workers' questions. It never decides their permission requests, which always wait for a person. Off by default."
            />
            {policy.hosting?.workers && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => edit((h) => void delete h.workers)}>
                <RotateCcw /> Default worker limits
              </button>
            )}
          </div>
        </div>

        <div className="mt-6">
          <SubHeading hint="Ceilings for worker harnesses a coordinator composes at runtime. Without a template, crafting is off.">
            Crafting templates
          </SubHeading>
          <div className="space-y-3">
            {templateNames.length === 0 && <p className="text-sm fg-muted">No crafting templates, so orchestrators cannot craft workers.</p>}
            {Object.entries(effective.crafting.templates).map(([name, template], index) => (
              <TemplateEditor
                key={index}
                name={name}
                template={template}
                names={templateNames}
                sizeNames={sizeNames}
                allowedModels={policy.allowedModels}
                approvalModes={approvalModes}
                bindings={bindings}
                onRename={(next) => edit((h) => void ((h.crafting ??= { templates: {} }).templates = renameKey(templates(h), name, next)))}
                onChange={(mutate, key) =>
                  edit((h) => {
                    const entry = templates(h)[name];
                    if (entry) mutate(entry);
                  }, key)
                }
                onRemove={() =>
                  edit((h) => {
                    delete templates(h)[name];
                    if (Object.keys(templates(h)).length === 0) delete h.crafting;
                  })
                }
              />
            ))}
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={templateNames.length >= 16}
              onClick={() =>
                edit((h) => {
                  templates(h)[freeName("worker-template", templateNames)] = {
                    toolBindings: [],
                    builtinTools: ["files"],
                    models: policy.allowedModels.slice(0, 1),
                    approvalModes: ["manual"],
                    maxDurationSeconds: 1800,
                    sizes: [effective.defaultSize || sizeNames[0]!].filter(Boolean),
                  };
                })
              }
            >
              <Plus /> Add crafting template
            </button>
          </div>
        </div>
        <p className="hint mt-4">
          Allowing a mode lets harnesses request it. A deployment hosts it only once it has the shared worker, session containers or worker
          containers that mode needs; the Hosting page shows what each harness can use.
        </p>
      </Locked>
      {footer}
    </Card>
  );
}
