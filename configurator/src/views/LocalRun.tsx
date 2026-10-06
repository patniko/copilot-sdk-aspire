import { ExternalLink, FlaskConical, Hammer, Play, RefreshCw, RotateCw, Save, Square } from "../components/icons";
import { useEffect, useState } from "react";
import type { LocalSettings } from "../../server/types";
import { api, errorMessage } from "../api";
import { FoundryPicker } from "../components/FoundryPicker";
import { DemoHostFields } from "../components/DemoHostFields";
import { Badge, Card, ChipsInput, CopyButton, Empty, Field, PageHeader, Spinner, stateTone } from "../components/ui";
import { useApp } from "../state";

export function LocalRunView() {
  const { settings, refreshSettings, environment, local, refreshLocal, runTask, tasks, toast, setView } = useApp();
  const [draft, setDraft] = useState<LocalSettings>();
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [hostCredential, setHostCredential] = useState("");
  const [savingCredential, setSavingCredential] = useState(false);

  async function saveHostCredential() {
    setSavingCredential(true);
    try {
      await api("/api/settings/demo-host-credential", { method: "PUT", body: { token: hostCredential } });
      setHostCredential("");
      toast("Saved the demo host credential to Aspire secrets", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setSavingCredential(false);
    }
  }

  useEffect(() => {
    if (settings && !draft) setDraft(structuredClone(settings.local));
  }, [settings, draft]);

  const localBusy = tasks.some((t) => t.status === "running" && t.kind.startsWith("local"));
  const checkBusy = tasks.some((t) => t.status === "running" && ["test-unit", "test-all", "build"].includes(t.kind));
  const dirty = draft && settings && JSON.stringify(draft) !== JSON.stringify(settings.local);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setFieldErrors({});
    try {
      await api("/api/settings/local", { method: "PUT", body: draft });
      await refreshSettings();
      setDraft(undefined);
      toast("Saved local parameters to the AppHost user secrets", "success");
    } catch (error) {
      const issues = (error as { issues?: Array<{ path: string; message: string }> }).issues ?? [];
      setFieldErrors(Object.fromEntries(issues.map((i) => [i.path.split(".")[0], i.message])));
      toast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Run locally"
        description="Aspire runs PostgreSQL and the executor in containers and the API, dispatcher, and gateway as Node processes. The gateway uses your Azure CLI identity for the model; agents never see it."
      />

      <Card
        title="Local stack"
        subtitle={local?.running ? "Running" : "Stopped"}
        actions={
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void refreshLocal()} aria-label="Refresh status">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            {local?.running ? (
              <>
                <button type="button" className="btn-secondary" disabled={localBusy} onClick={() => void runTask("local-restart-api")}>
                  <RotateCw className="h-4 w-4" /> Reload harnesses
                </button>
                <button type="button" className="btn-danger" disabled={localBusy} onClick={() => void runTask("local-stop")}>
                  <Square className="h-4 w-4" /> Stop
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary" disabled={localBusy || !environment?.docker.ok} onClick={() => void runTask("local-start")}>
                {localBusy ? <Spinner /> : <Play className="h-4 w-4" />} Build &amp; start
              </button>
            )}
          </>
        }
      >
        {!environment?.docker.ok && environment && <p className="mb-3 text-red-600 dark:text-red-400">Docker is not running. Start Docker Desktop first.</p>}
        {local?.running ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {local.dashboardUrl && (
                <a className="btn-secondary btn-sm" href={local.dashboardUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" /> Aspire dashboard
                </a>
              )}
              {local.apiUrl && (
                <a className="btn-secondary btn-sm" href={local.apiUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" /> Job console
                </a>
              )}
              <CopyButton label="Copy API key" text={async () => (await api<{ key: string }>("/api/try/local/key", { method: "POST" })).key} />
              <button type="button" className="btn-secondary btn-sm" onClick={() => setView("try")}>
                <FlaskConical className="h-3.5 w-3.5" /> Try a job
              </button>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="table-cell">Resource</th>
                  <th className="table-cell">Type</th>
                  <th className="table-cell">State</th>
                  <th className="table-cell">Health</th>
                  <th className="table-cell">Endpoint</th>
                </tr>
              </thead>
              <tbody>
                {local.resources.map((r) => (
                  <tr key={r.name}>
                    <td className="table-cell font-medium">{r.name}</td>
                    <td className="table-cell text-slate-500">{r.type}</td>
                    <td className="table-cell">
                      <Badge tone={stateTone(r.state)}>{r.state}</Badge>
                    </td>
                    <td className="table-cell">{r.health && <Badge tone={stateTone(r.health)}>{r.health}</Badge>}</td>
                    <td className="table-cell font-mono">{r.urls[0]?.url ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint mt-3">Harness edits reach the running API after "Reload harnesses". Changes to tools, profiles, or service code need Stop then Build &amp; start.</p>
          </>
        ) : (
          <Empty>Start the stack to run jobs against your local configuration. The first start builds the executor image (a few minutes).</Empty>
        )}
      </Card>

      <Card
        title="Build and test"
        subtitle="Runs the repository scripts. Output streams to the task panel."
        actions={
          <>
            <button type="button" className="btn-secondary" disabled={checkBusy} onClick={() => void runTask("build")}>
              <Hammer className="h-4 w-4" /> Build
            </button>
            <button type="button" className="btn-secondary" disabled={checkBusy} onClick={() => void runTask("test-unit")}>
              Unit tests
            </button>
            <button type="button" className="btn-secondary" disabled={checkBusy || !environment?.docker.ok} onClick={() => void runTask("test-all")}>
              All tests
            </button>
          </>
        }
      >
        <p className="text-slate-500 dark:text-slate-400">
          Unit tests need no services. "All tests" also starts a disposable PostgreSQL container and runs the API, dispatcher, gateway, and executor end to end
          with a fake model.
        </p>
      </Card>

      <Card
        title="Local parameters"
        subtitle={<>Stored in the AppHost's Aspire user secrets{settings?.secretsPath ? <> (<code className="text-xs">{settings.secretsPath}</code>)</> : null}, outside the repository.</>}
        actions={
          <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save
          </button>
        }
      >
        {!draft ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <DemoHostFields value={draft.demoHost} onChange={(demoHost) => setDraft({ ...draft, demoHost })} />
            </div>
            <div className="md:col-span-2 flex items-end gap-3">
              <Field label="Demo host GitHub credential" className="flex-1" hint="For Mission Control. Saved only to Aspire secrets, never returned or stored in a deployment target.">
                <input className="input" type="password" autoComplete="off" value={hostCredential}
                  onChange={(event) => setHostCredential(event.target.value)} />
              </Field>
              <button type="button" className="btn-secondary" disabled={hostCredential.length < 20 || savingCredential}
                onClick={() => void saveHostCredential()}>Save credential</button>
            </div>
            <div className="md:col-span-2">
              <FoundryPicker
                subscriptionId={environment?.azure.subscriptionId}
                onPick={(account, deployments) =>
                  setDraft({ ...draft, foundryEndpoint: account.endpoint, foundryDeployments: deployments.map((d) => d.name) })
                }
              />
            </div>
            <Field label="Foundry endpoint" help="local.foundryEndpoint" hint="OpenAI v1 endpoint, e.g. https://<account>.openai.azure.com/openai/v1" error={fieldErrors.foundryEndpoint}>
              <input className="input font-mono" value={draft.foundryEndpoint} onChange={(e) => setDraft({ ...draft, foundryEndpoint: e.target.value })} />
            </Field>
            <Field label="Model deployments" help="local.foundryDeployments" hint="Deployment names the gateway routes; jobs use the policy-approved model names." error={fieldErrors.foundryDeployments}>
              <ChipsInput values={draft.foundryDeployments} onChange={(values) => setDraft({ ...draft, foundryDeployments: values })} pattern={/^[A-Za-z0-9._-]{1,64}$/} />
            </Field>
            <Field label="npm registry for image builds" help="local.registries" hint="Leave empty for registry.npmjs.org." error={fieldErrors.npmRegistry}>
              <input className="input font-mono" value={draft.npmRegistry} onChange={(e) => setDraft({ ...draft, npmRegistry: e.target.value })} />
            </Field>
            <Field label="PyPI index for image builds" hint="Leave empty for pypi.org." error={fieldErrors.pipIndexUrl}>
              <input className="input font-mono" value={draft.pipIndexUrl} onChange={(e) => setDraft({ ...draft, pipIndexUrl: e.target.value })} />
            </Field>
            <Field
              label="NuGet service index for the Aspire CLI"
              className="md:col-span-2"
              hint="Replaces nuget.org when the configurator runs Aspire (for networks that block it). Also map packages to this feed in a local NuGet.config."
              error={fieldErrors.nugetServiceIndex}
            >
              <input className="input font-mono" value={draft.nugetServiceIndex} onChange={(e) => setDraft({ ...draft, nugetServiceIndex: e.target.value })} />
            </Field>
          </div>
        )}
      </Card>
    </div>
  );
}
