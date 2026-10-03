import { ArrowRight, Boxes, Cloud, Copilot, FlaskConical, Laptop, RefreshCw, ShieldCheck } from "../components/icons";
import type { ReactNode } from "react";
import { Badge, Card, StatusLine } from "../components/ui";
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
    <div className="card flex flex-col p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md border border-default bg-muted fg-muted">{icon}</span>
        <span className="text-xs font-semibold fg-muted">Step {step}</span>
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="mt-1 flex-1 fg-muted">{children}</div>
      <button type="button" className="btn-secondary btn-sm mt-3 self-start" onClick={() => setView(view)}>
        {action} <ArrowRight />
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
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-6 bg-[linear-gradient(135deg,var(--bgColor-done-muted),var(--bgColor-accent-muted))] p-6">
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-default bg-[var(--bgColor-default)]">
            <Copilot size={36} className="fg-done" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold">Your own Copilot agent service</h1>
            <p className="mt-1 max-w-3xl fg-muted">
              Agents built with the <strong className="text-[var(--fgColor-default)]">GitHub Copilot SDK</strong>, run as structured jobs by an{" "}
              <strong className="text-[var(--fgColor-default)]">Aspire</strong> application you own: configure harnesses and policy here,
              run the whole stack locally, and deploy the same app to Azure Container Apps.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {["Sub-agents", "Skills", "Prompt sections", "Reasoning effort", "Structured results", "Gateway-held model credentials"].map((f) => (
                <Badge key={f} tone="done">
                  {f}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StepCard step={1} icon={<Boxes />} title="Compose" action="Edit harnesses" view="harnesses">
          {workspace ? (
            <>
              {names} harness(es), {workspace.harnesses.length} version(s).{" "}
              {errors ? <Badge tone="red">{errors} error(s)</Badge> : <Badge tone="green">valid</Badge>}
            </>
          ) : (
            "Loading…"
          )}
        </StepCard>
        <StepCard step={2} icon={<Laptop />} title="Run locally" action="Open Local run" view="local">
          Build, run tests, and start the stack with Aspire. {local?.running ? <Badge tone="green">running</Badge> : <Badge>stopped</Badge>}
        </StepCard>
        <StepCard step={3} icon={<FlaskConical />} title="Try it" action="Run a job" view="try">
          Submit a job to the local stack or Azure and watch tools, model turns, and the structured result.
        </StepCard>
        <StepCard step={4} icon={<Cloud />} title="Deploy" action="Open Deploy" view="deploy">
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

        <Card title="Policy" subtitle="Operator ceilings every harness runs under." actions={<ShieldCheck className="fg-muted" />}>
          {workspace && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
              <dt className="fg-muted">Agents</dt>
              <dd className="flex flex-wrap gap-1">
                {workspace.policy.allowedProfiles.map((p) => (
                  <Badge key={p} tone="brand">
                    {p}
                  </Badge>
                ))}
              </dd>
              <dt className="fg-muted">Models</dt>
              <dd className="flex flex-wrap gap-1">
                {workspace.policy.allowedModels.map((m) => (
                  <Badge key={m} tone="green">
                    {m}
                  </Badge>
                ))}
              </dd>
              <dt className="fg-muted">Limits</dt>
              <dd>
                {workspace.policy.maxDurationSeconds}s · {workspace.policy.maxInferenceTokensPerJob.toLocaleString()} tokens · {workspace.policy.retry.maxAttempts} attempts
              </dd>
              <dt className="fg-muted">Controls</dt>
              <dd>
                isolation: {workspace.policy.requirements.processIsolation} · egress: {workspace.policy.requirements.egress}
              </dd>
              <dt className="fg-muted">Accepted gaps</dt>
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
