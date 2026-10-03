import clsx from "clsx";
import { Cloud, ExternalLink, FileCode2, LogIn, Plus, RefreshCw, Rocket, Save, Trash2 } from "../components/icons";
import { useEffect, useMemo, useState } from "react";
import type { DeployTarget, Issue } from "../../server/types";
import { api, errorMessage } from "../api";
import { FoundryPicker } from "../components/FoundryPicker";
import { Badge, Card, ChipsInput, CopyButton, Empty, Field, HelpButton, Modal, PageHeader, Spinner, StatusLine, stateTone } from "../components/ui";
import { useApp } from "../state";

type Check = { ok: boolean; errors: Array<Issue & { scope: string }>; warnings: number };

function blankTarget(existing: DeployTarget[], tenantId = "", subscriptionId = "", endpoint = "", deployments: string[] = []): DeployTarget {
  let name = existing.length ? `env-${existing.length + 1}` : "staging";
  while (existing.some((t) => t.name === name)) name = `${name}-x`;
  return {
    name,
    tenantId,
    subscriptionId,
    location: "westus2",
    resourceGroup: `copilot-agent-${name}`,
    foundryAccount: "",
    foundryResourceGroup: "",
    foundryEndpoint: endpoint,
    foundryDeployments: deployments,
  };
}

export function DeployView() {
  const { settings, refreshSettings, environment, refreshEnvironment, azure, azureError, refreshAzure, runTask, tasks, toast, setView } = useApp();
  const [targets, setTargets] = useState<DeployTarget[]>();
  const [selected, setSelected] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<Check>();
  const [confirm, setConfirm] = useState(false);
  const [loadingAzure, setLoadingAzure] = useState(false);

  useEffect(() => {
    if (settings && !targets) {
      setTargets(structuredClone(settings.targets));
      setSelected(settings.selectedTarget ?? settings.targets[0]?.name);
    }
  }, [settings, targets]);

  useEffect(() => {
    api<Check>("/api/check").then(setCheck).catch(() => undefined);
  }, [tasks.length]);

  const savedTargets = settings?.targets ?? [];
  const dirty = JSON.stringify(targets) !== JSON.stringify(savedTargets) || selected !== settings?.selectedTarget;
  const target = targets?.find((t) => t.name === selected);
  const index = targets?.findIndex((t) => t.name === selected) ?? -1;

  const refresh = async () => {
    setLoadingAzure(true);
    await refreshAzure();
    setLoadingAzure(false);
  };
  useEffect(() => {
    if (settings?.selectedTarget && !dirty) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.selectedTarget]);

  const deployTask = tasks.find((t) => t.kind === "deploy" || t.kind === "publish");
  const deploying = tasks.some((t) => t.status === "running" && (t.kind === "deploy" || t.kind === "publish"));
  const loginRunning = tasks.some((t) => t.status === "running" && t.kind === "az-login");

  const preflight = useMemo(() => {
    const signedIn = !!environment?.azure.ok;
    const tenantMatches = !!target && signedIn && environment?.azure.tenantId?.toLowerCase() === target.tenantId.toLowerCase();
    return {
      config: check?.ok,
      azure: signedIn && tenantMatches,
      azureDetail: !signedIn
        ? "Not signed in."
        : tenantMatches
          ? `${environment?.azure.user} · tenant ${target?.tenantId.slice(0, 8)}…`
          : `Signed in to tenant ${environment?.azure.tenantId?.slice(0, 8)}…, but the target uses ${target?.tenantId.slice(0, 8)}…`,
      docker: environment?.docker.ok,
      saved: !dirty && !!target,
    };
  }, [environment, target, check, dirty]);
  const ready = preflight.config && preflight.azure && preflight.docker && preflight.saved;

  const update = (patch: Partial<DeployTarget>) =>
    setTargets((current) => current?.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  async function save() {
    setSaving(true);
    setFieldErrors({});
    try {
      await api("/api/settings/targets", { method: "PUT", body: { targets, selectedTarget: selected } });
      await refreshSettings();
      setTargets(undefined);
      toast("Saved deployment targets (.configurator/settings.json)", "success");
      void refresh();
    } catch (error) {
      const issues = (error as { issues?: Array<{ path: string; message: string }> }).issues ?? [];
      setFieldErrors(Object.fromEntries(issues.map((i) => [i.path.split(".").at(-1) ?? i.path, i.message])));
      toast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  }

  if (!targets) return <Spinner />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deploy to Azure"
        description="Deploys the same AppHost to Azure Container Apps in your subscription: images are built locally, pushed to a new registry, and rolled out with PostgreSQL, managed identities, and a least-privilege model role on your existing Foundry account."
      />

      <Card
        title="Deployment target"
        subtitle="Targets are saved to .configurator/settings.json (git-ignored). They contain IDs and names, never secrets."
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                const next = blankTarget(targets, environment?.azure.tenantId, environment?.azure.subscriptionId, settings?.local.foundryEndpoint, settings?.local.foundryDeployments);
                setTargets([...targets, next]);
                setSelected(next.name);
              }}
            >
              <Plus className="h-4 w-4" /> Add target
            </button>
            <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save
            </button>
          </>
        }
      >
        {targets.length === 0 ? (
          <Empty>No targets yet. Add one to describe where to deploy.</Empty>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              {targets.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setSelected(t.name)}
                  className={clsx(
                    "btn",
                    t.name === selected
                      ? "border-[var(--borderColor-accent-emphasis)] bg-[var(--bgColor-accent-muted)]"
                      : "border-slate-200 dark:border-slate-700",
                  )}
                >
                  <Cloud className="h-4 w-4" /> {t.name}
                </button>
              ))}
            </div>
            {target && (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Target name" error={fieldErrors.name}>
                  <input
                    className="input font-mono"
                    value={target.name}
                    onChange={(e) => {
                      const name = e.target.value.toLowerCase();
                      update({ name });
                      setSelected(name);
                    }}
                  />
                </Field>
                <Field label="Region" error={fieldErrors.location}>
                  <input className="input font-mono" value={target.location} onChange={(e) => update({ location: e.target.value })} />
                </Field>
                <Field label="Resource group" help="target.resourceGroup" hint="Created if it does not exist." error={fieldErrors.resourceGroup}>
                  <input className="input font-mono" value={target.resourceGroup} onChange={(e) => update({ resourceGroup: e.target.value })} />
                </Field>
                <Field label="Tenant ID" error={fieldErrors.tenantId}>
                  <input className="input font-mono" value={target.tenantId} onChange={(e) => update({ tenantId: e.target.value })} />
                </Field>
                <Field label="Subscription ID" help="target.subscription" error={fieldErrors.subscriptionId}>
                  <input className="input font-mono" value={target.subscriptionId} onChange={(e) => update({ subscriptionId: e.target.value })} />
                </Field>
                <div className="flex items-end">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={!environment?.azure.ok}
                    onClick={() => update({ tenantId: environment!.azure.tenantId!, subscriptionId: environment!.azure.subscriptionId! })}
                  >
                    Use signed-in subscription
                  </button>
                </div>
                <div className="md:col-span-2 xl:col-span-3">
                  <div className="flex items-center gap-1"><span className="label !mb-0">Model provider (existing Foundry account)</span><HelpButton topic="target.foundry" /></div>
                  <FoundryPicker
                    subscriptionId={/^[0-9a-f-]{36}$/i.test(target.subscriptionId) ? target.subscriptionId : undefined}
                    onPick={(account, deployments) =>
                      update({
                        foundryAccount: account.name,
                        foundryResourceGroup: account.resourceGroup,
                        foundryEndpoint: account.endpoint,
                        foundryDeployments: deployments.map((d) => d.name),
                      })
                    }
                  />
                </div>
                <Field label="Foundry account" error={fieldErrors.foundryAccount}>
                  <input className="input font-mono" value={target.foundryAccount} onChange={(e) => update({ foundryAccount: e.target.value })} />
                </Field>
                <Field label="Foundry resource group" error={fieldErrors.foundryResourceGroup}>
                  <input className="input font-mono" value={target.foundryResourceGroup} onChange={(e) => update({ foundryResourceGroup: e.target.value })} />
                </Field>
                <Field label="Foundry endpoint" error={fieldErrors.foundryEndpoint}>
                  <input className="input font-mono" value={target.foundryEndpoint} onChange={(e) => update({ foundryEndpoint: e.target.value })} />
                </Field>
                <Field label="Model deployments" className="md:col-span-2" error={fieldErrors.foundryDeployments}>
                  <ChipsInput values={target.foundryDeployments} onChange={(values) => update({ foundryDeployments: values })} pattern={/^[A-Za-z0-9._-]{1,64}$/} />
                </Field>
                <div className="flex items-end justify-end">
                  <button
                    type="button"
                    className="btn-danger btn-sm"
                    onClick={() => {
                      const rest = targets.filter((t) => t.name !== target.name);
                      setTargets(rest);
                      setSelected(rest[0]?.name);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove target
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title="Preflight"
        actions={
          <button type="button" className="btn-ghost btn-sm" onClick={() => void refreshEnvironment(true)} aria-label="Recheck">
            <RefreshCw className="h-3.5 w-3.5" /> Recheck
          </button>
        }
      >
        <div className="grid gap-x-8 md:grid-cols-2">
          <StatusLine
            ok={check?.ok}
            label="Configuration is valid"
            detail={check ? (check.ok ? `${check.warnings} warning(s)` : `${check.errors.length} error(s): ${check.errors[0]?.scope} ${check.errors[0]?.message}`) : undefined}
          />
          <StatusLine ok={preflight.saved} label="Target saved" detail={preflight.saved ? target?.name : "Save the target before deploying."} />
          <div>
            <StatusLine ok={environment ? preflight.azure : undefined} label="Signed in to the target tenant" detail={environment ? preflight.azureDetail : undefined} />
            {environment && !preflight.azure && (
              <button type="button" className="btn-secondary btn-sm ml-6" disabled={loginRunning || !preflight.saved} onClick={() => void runTask("az-login")}>
                {loginRunning ? <Spinner className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />} Sign in (opens a browser)
              </button>
            )}
          </div>
          <StatusLine ok={environment ? !!preflight.docker : undefined} label="Docker is running" detail="Images are built locally for linux/amd64." />
        </div>
        {!check?.ok && check && (
          <button type="button" className="btn-ghost btn-sm mt-2" onClick={() => setView("harnesses")}>
            Open harnesses to fix
          </button>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <button type="button" className="btn-secondary" disabled={!ready || deploying} onClick={() => void runTask("publish")}>
            <FileCode2 className="h-4 w-4" /> Preview infrastructure
          </button>
          <button type="button" className="btn-primary" disabled={!ready || deploying} onClick={() => setConfirm(true)}>
            {deploying ? <Spinner /> : <Rocket className="h-4 w-4" />} Deploy {target ? `to ${target.name}` : ""}
          </button>
          {deployTask && (
            <span className="text-xs text-slate-500">
              Last: {deployTask.title} · <Badge tone={stateTone(deployTask.status)}>{deployTask.status}</Badge>
            </span>
          )}
        </div>
        <p className="hint mt-2">
          "Preview infrastructure" writes the Bicep to artifacts/deployment for review. A deployment takes about 15 minutes on ARM64 machines because images are
          built for amd64 under emulation. Running jobs are interrupted when the executor is replaced; read-only jobs retry automatically.
        </p>
      </Card>

      <Card
        title={target ? `Azure status: ${target.name}` : "Azure status"}
        actions={
          <button type="button" className="btn-ghost btn-sm" disabled={loadingAzure || dirty} onClick={() => void refresh()}>
            {loadingAzure ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </button>
        }
      >
        {azureError && <p className="text-red-600 dark:text-red-400">{azureError}</p>}
        {!azure && !azureError && <Empty>Save a target to see its status.</Empty>}
        {azure && !azure.resourceGroupExists && <Empty>Not deployed yet: resource group {target?.resourceGroup} does not exist.</Empty>}
        {azure?.error && <p className="mb-2 text-red-600 dark:text-red-400">{azure.error}</p>}
        {azure && azure.resourceGroupExists && (
          <>
            {azure.apiUrl && (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <a className="btn-secondary btn-sm" href={azure.apiUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" /> Job console
                </a>
                <CopyButton label="Copy API key" text={async () => (await api<{ key: string }>("/api/try/azure/key", { method: "POST" })).key} />
                <CopyButton label="Copy API URL" text={azure.apiUrl} />
                <code className="text-xs text-slate-500">{azure.apiUrl}</code>
              </div>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="table-cell">Container app</th>
                  <th className="table-cell">Provisioning</th>
                  <th className="table-cell">Running</th>
                  <th className="table-cell">Ingress</th>
                </tr>
              </thead>
              <tbody>
                {azure.apps.map((app) => (
                  <tr key={app.name}>
                    <td className="table-cell font-medium">{app.name}</td>
                    <td className="table-cell">
                      <Badge tone={stateTone(app.provisioningState)}>{app.provisioningState}</Badge>
                    </td>
                    <td className="table-cell">
                      <Badge tone={stateTone(app.runningStatus)}>{app.runningStatus}</Badge>
                    </td>
                    <td className="table-cell text-slate-500">{app.fqdn ? (app.external ? "external" : "internal") : "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      {confirm && target && (
        <Modal
          title={`Deploy to ${target.name}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button type="button" className="btn-ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setConfirm(false);
                  void runTask("deploy");
                }}
              >
                <Rocket className="h-4 w-4" /> Deploy
              </button>
            </>
          }
        >
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Creates or updates resources in <code>{target.resourceGroup}</code> ({target.location}) in subscription <code>{target.subscriptionId}</code>.
            </li>
            <li>
              Grants the gateway identity <strong>Cognitive Services OpenAI User</strong> on <code>{target.foundryAccount}</code>; the account itself is not
              modified.
            </li>
            <li>Publishes every harness version in harnesses/ and the current policy, as they are on disk now.</li>
            <li>Fixed costs apply while deployed: PostgreSQL, the registry, Log Analytics, and one replica per app.</li>
          </ul>
        </Modal>
      )}
    </div>
  );
}
