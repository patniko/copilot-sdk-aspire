import { ArrowRight, Boxes, Cloud, FlaskConical, Laptop, RefreshCw, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, PageHeader, StatusLine } from "../components/ui";
import { useApp, type View } from "../state";

function StepCard({ step, icon, title, children, action, view }: {
  step: number;
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action: string;
  view: View;
}) {
  const { setView } = useApp();
  return (
    <div className="card flex flex-col p-5">
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-200">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Step {step}</span>
      </div>
      <h3 className="text-lg">{title}</h3>
      <div className="mt-1 flex-1 text-slate-500 dark:text-slate-400">{children}</div>
      <button type="button" className="btn-secondary mt-4 self-start" onClick={() => setView(view)}>
        {action} <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export function OverviewView() {
  const { workspace, environment, refreshEnvironment, local, settings, azure } = useApp();
  const errors = workspace ? workspace.harnesses.reduce((n, h) => n + h.errors, 0) : 0;
  const names = workspace ? new Set(workspace.harnesses.map((h) => h.name)).size : 0;
  const target = settings?.targets.find((t) => t.name === settings.selectedTarget);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configure, run, deploy."
        description="Edit the harnesses and policy in this repository, check them with the same contracts the service uses, run the full stack locally, and deploy the same application to your Azure subscription."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StepCard step={1} icon={<Boxes className="h-5 w-5" />} title="Compose" action="Edit harnesses" view="harnesses">
          {workspace ? (
            <>
              {names} harness(es), {workspace.harnesses.length} version(s).{" "}
              {errors ? <Badge tone="red">{errors} error(s)</Badge> : <Badge tone="green">valid</Badge>}
            </>
          ) : (
            "Loading…"
          )}
        </StepCard>
        <StepCard step={2} icon={<Laptop className="h-5 w-5" />} title="Run locally" action="Open Local run" view="local">
          Build, run tests, and start the stack with Aspire. {local?.running ? <Badge tone="green">running</Badge> : <Badge>stopped</Badge>}
        </StepCard>
        <StepCard step={3} icon={<FlaskConical className="h-5 w-5" />} title="Try it" action="Run a job" view="try">
          Submit a job to the local stack or Azure and watch tools, model turns, and the structured result.
        </StepCard>
        <StepCard step={4} icon={<Cloud className="h-5 w-5" />} title="Deploy" action="Open Deploy" view="deploy">
          {target ? (
            <>
              Target <strong>{target.name}</strong> · {target.resourceGroup}.{" "}
              {azure?.resourceGroupExists ? <Badge tone="green">deployed</Badge> : <Badge>not deployed</Badge>}
            </>
          ) : (
            "Add an Azure subscription, region, and Foundry account."
          )}
        </StepCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card
          title="Environment"
          subtitle="Tools the configurator drives on this machine."
          actions={
            <button type="button" className="btn-ghost btn-sm" onClick={() => void refreshEnvironment(true)}>
              <RefreshCw className="h-3.5 w-3.5" /> Recheck
            </button>
          }
        >
          <StatusLine ok={environment?.node.ok} label="Node.js" detail={environment?.node.version} />
          <StatusLine ok={environment?.pnpm.ok} label="pnpm" detail={environment?.pnpm.version ?? environment?.pnpm.detail} />
          <StatusLine ok={environment?.aspire.ok} label="Aspire CLI" detail={environment?.aspire.version ?? environment?.aspire.detail} />
          <StatusLine ok={environment?.docker.ok} label="Docker" detail={environment?.docker.version ? `Engine ${environment.docker.version}` : environment?.docker.detail} />
          <StatusLine
            ok={environment?.azure.ok}
            label="Azure CLI"
            detail={environment?.azure.ok ? `${environment.azure.user} · ${environment.azure.subscriptionName}` : environment?.azure.detail}
          />
        </Card>

        <Card title="Policy" subtitle="Operator ceilings every harness runs under." actions={<ShieldCheck className="h-5 w-5 text-slate-400" />}>
          {workspace && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
              <dt className="text-slate-500">Agents</dt>
              <dd className="flex flex-wrap gap-1">
                {workspace.policy.allowedProfiles.map((p) => (
                  <Badge key={p} tone="brand">
                    {p}
                  </Badge>
                ))}
              </dd>
              <dt className="text-slate-500">Models</dt>
              <dd className="flex flex-wrap gap-1">
                {workspace.policy.allowedModels.map((m) => (
                  <Badge key={m} tone="green">
                    {m}
                  </Badge>
                ))}
              </dd>
              <dt className="text-slate-500">Limits</dt>
              <dd>
                {workspace.policy.maxDurationSeconds}s · {workspace.policy.maxInferenceTokensPerJob.toLocaleString()} tokens · {workspace.policy.retry.maxAttempts} attempts
              </dd>
              <dt className="text-slate-500">Controls</dt>
              <dd>
                isolation: {workspace.policy.requirements.processIsolation} · egress: {workspace.policy.requirements.egress}
              </dd>
              <dt className="text-slate-500">Accepted gaps</dt>
              <dd className="flex flex-wrap gap-1">
                {workspace.policy.acknowledgedGaps.length ? workspace.policy.acknowledgedGaps.map((g) => <Badge key={g} tone="amber">{g}</Badge>) : "none"}
              </dd>
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
