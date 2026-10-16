import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Cloud,
  Copilot,
  FlaskConical,
  Laptop,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Wrench,
} from "../components/icons";
import type { ReactNode } from "react";
import { Badge, Card, Flash, StatusLine, stateTone, type Tone } from "../components/ui";
import { useApp, type View } from "../state";

interface ReadinessItem {
  title: string;
  detail: string;
  tone: Tone;
  label: string;
  view: View;
  action: string;
}

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

function ReadinessCard({ item }: { item: ReadinessItem }) {
  const { setView } = useApp();
  const icon = item.tone === "green"
    ? <CheckCircle2 className="fg-success" />
    : item.tone === "amber" || item.tone === "red"
      ? <AlertTriangle className={item.tone === "red" ? "fg-danger" : "fg-attention"} />
      : <Wrench className="fg-muted" />;
  return (
    <button
      type="button"
      className="card flex min-h-28 w-full items-start gap-3 p-4 text-left transition-colors hover:bg-[var(--bgColor-muted)]"
      onClick={() => setView(item.view)}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <strong>{item.title}</strong>
          <Badge tone={item.tone}>{item.label}</Badge>
        </span>
        <span className="mt-1 block text-sm fg-muted">{item.detail}</span>
        <span className="mt-2 flex items-center gap-1 text-xs font-semibold fg-accent">
          {item.action} <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </span>
    </button>
  );
}

export function OverviewView() {
  const { workspace, environment, refreshEnvironment, local, settings, azure, tasks, setView } = useApp();
  const harnessErrors = workspace ? workspace.harnesses.reduce((n, h) => n + h.errors, 0) : 0;
  const policyErrors = workspace?.policyIssues.filter((issue) => issue.level === "error").length ?? 0;
  const errors = harnessErrors + policyErrors;
  const names = workspace ? new Set(workspace.harnesses.map((h) => h.name)).size : 0;
  const target = settings?.targets.find((t) => t.name === settings.selectedTarget);
  const localToolsReady = environment
    ? environment.node.ok && environment.pnpm.ok && environment.aspire.ok && environment.docker.ok
    : undefined;
  const readiness: ReadinessItem[] = [
    {
      title: "Configuration",
      detail: !workspace
        ? "Loading harnesses and policy."
        : errors
          ? `${harnessErrors} harness and ${policyErrors} policy error(s) must be fixed.`
          : `${workspace.harnesses.length} version(s) across ${names} harness(es) pass validation.`,
      tone: !workspace ? "neutral" : errors ? "red" : "green",
      label: !workspace ? "Checking" : errors ? "Blocked" : "Ready",
      view: errors && policyErrors > 0 ? "policy" : "harnesses",
      action: errors ? "Review errors" : "Review configuration",
    },
    {
      title: "Local execution",
      detail: !environment
        ? "Checking the required local tools."
        : !localToolsReady
          ? "Node.js, pnpm, Aspire, or Docker needs attention."
          : local?.running
            ? `${local.resources.length} Aspire resource(s) observed.`
            : "Prerequisites are ready; the stack is not running.",
      tone: !environment ? "neutral" : !localToolsReady ? "red" : local?.running ? "green" : "amber",
      label: !environment ? "Checking" : !localToolsReady ? "Blocked" : local?.running ? "Running" : "Ready to start",
      view: "local",
      action: local?.running ? "Inspect local stack" : "Open local run",
    },
    {
      title: "Azure deployment",
      detail: !target
        ? "No deployment target is selected."
        : !environment?.azure.ok
          ? `Target ${target.name} is configured; Azure CLI needs attention.`
          : azure?.resourceGroupExists
            ? `${target.name} is deployed to ${target.resourceGroup}.`
            : `${target.name} is configured and has not been deployed.`,
      tone: !target ? "neutral" : !environment?.azure.ok ? "red" : azure?.resourceGroupExists ? "green" : "amber",
      label: !target ? "Not configured" : !environment?.azure.ok ? "Blocked" : azure?.resourceGroupExists ? "Deployed" : "Ready to deploy",
      view: "deploy",
      action: azure?.resourceGroupExists ? "Inspect deployment" : "Configure deployment",
    },
  ];
  const readyCount = readiness.filter((item) => item.tone === "green").length;
  const activeTask = tasks.find((task) => task.status === "running");
  const recentTasks = tasks.slice(0, 3);
  const nextAction = errors
    ? { label: "Fix configuration", view: policyErrors > 0 ? "policy" as const : "harnesses" as const }
    : localToolsReady === false
      ? { label: "Fix local prerequisites", view: "local" as const }
      : !local?.running
        ? { label: "Start locally", view: "local" as const }
        : { label: "Run a job", view: "try" as const };

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
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary" onClick={() => setView(nextAction.view)}>
                {nextAction.label} <ArrowRight />
              </button>
              <span className="text-sm fg-muted">
                {readyCount} of {readiness.length} readiness areas are active
                {activeTask ? <> · <strong>{activeTask.title}</strong> is running</> : null}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="readiness-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="readiness-heading" className="text-lg font-semibold">Readiness</h2>
            <p className="text-sm fg-muted">What is usable now, what is blocked, and where to act.</p>
          </div>
          <Badge tone={errors ? "red" : readyCount === readiness.length ? "green" : "amber"}>
            {errors ? `${errors} configuration error(s)` : `${readyCount}/${readiness.length} active`}
          </Badge>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {readiness.map((item) => <ReadinessCard key={item.title} item={item} />)}
        </div>
      </section>

      {workspace && workspace.policy.acknowledgedGaps.length > 0 && (
        <Flash
          tone="warn"
          actions={<button type="button" className="btn-secondary btn-sm" onClick={() => setView("policy")}>Review policy</button>}
        >
          <strong>Accepted execution gaps:</strong>{" "}
          {workspace.policy.acknowledgedGaps.join(", ")}. These acknowledgements allow eligible jobs to run; they do not enforce the missing control.
        </Flash>
      )}

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

      <div className="grid gap-6 xl:grid-cols-3">
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

        <Card title="Recent activity" subtitle="Latest configurator commands and outcomes." actions={<Rocket className="fg-muted" />}>
          {recentTasks.length > 0 ? (
            <ul className="divide-y divide-[var(--borderColor-muted)]">
              {recentTasks.map((task) => (
                <li key={task.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{task.title}</div>
                    <div className="truncate text-xs fg-muted">{task.command}</div>
                  </div>
                  <Badge tone={stateTone(task.status)}>{task.status}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fg-muted">No commands have run in this configurator session.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
