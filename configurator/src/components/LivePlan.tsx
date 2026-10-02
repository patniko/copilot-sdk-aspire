import clsx from "clsx";
import { ArrowRight, CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useApp, type View } from "../state";

type StepState = "done" | "attention" | "pending" | "blocked";

function Step({ state, title, detail, action }: { state: StepState; title: string; detail: ReactNode; action?: ReactNode }) {
  const icon = {
    done: <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
    attention: <CircleDot className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    pending: <Circle className="h-4 w-4 text-slate-400" />,
    blocked: <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />,
  }[state];
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      <span className="z-10 mt-0.5 bg-white dark:bg-slate-900">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">{detail}</div>
        {action && <div className="mt-1.5">{action}</div>}
      </div>
    </li>
  );
}

/** Right-hand summary of where the configuration stands in the configure → run → deploy pipeline. */
export function LivePlan() {
  const { workspace, local, azure, settings, environment, tasks, setView } = useApp();
  const errors = workspace ? workspace.harnesses.reduce((n, h) => n + h.errors, 0) + workspace.policyIssues.filter((i) => i.level === "error").length : 0;
  const warnings = workspace ? workspace.harnesses.reduce((n, h) => n + h.warnings, 0) + workspace.policyIssues.filter((i) => i.level === "warning").length : 0;
  const lastBuild = tasks.find((t) => ["build", "test-unit", "test-all", "local-start"].includes(t.kind));
  const lastDeploy = tasks.find((t) => t.kind === "deploy");
  const target = settings?.targets.find((t) => t.name === settings.selectedTarget);
  const go = (view: View, label: string) => (
    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setView(view)}>
      {label} <ArrowRight className="h-3 w-3" />
    </button>
  );
  const runningApps = azure?.apps.filter((a) => a.runningStatus === "Running").length ?? 0;

  return (
    <div className="card card-pad">
      <h2 className="text-lg">Live plan</h2>
      <p className="mb-4 text-xs text-slate-500">Configure, validate, run, deploy.</p>
      <ol className="relative before:absolute before:left-[7px] before:top-1 before:h-[calc(100%-1rem)] before:w-px before:bg-slate-200 dark:before:bg-slate-700">
        <Step
          state={!workspace ? "pending" : errors ? "blocked" : warnings ? "attention" : "done"}
          title="Configuration"
          detail={
            workspace
              ? `${workspace.harnesses.length} harness version(s) · ${errors} error(s) · ${warnings} warning(s)`
              : "Loading…"
          }
          action={errors ? go("harnesses", "Fix errors") : undefined}
        />
        <Step
          state={!lastBuild ? "pending" : lastBuild.status === "succeeded" ? "done" : lastBuild.status === "running" ? "attention" : "blocked"}
          title="Build & test"
          detail={lastBuild ? `${lastBuild.title}: ${lastBuild.status}` : "Not run in this session"}
          action={go("local", "Build or test")}
        />
        <Step
          state={local?.running ? "done" : "pending"}
          title="Local stack"
          detail={local?.running ? `Running${local.apiUrl ? ` · ${local.apiUrl}` : ""}` : "Stopped"}
          action={local?.running ? go("try", "Try a job locally") : go("local", "Start locally")}
        />
        <Step
          state={!environment ? "pending" : environment.azure.ok && environment.docker.ok ? "done" : "blocked"}
          title="Deploy prerequisites"
          detail={
            environment
              ? [environment.azure.ok ? `Azure: ${environment.azure.subscriptionName}` : "Azure: not signed in", environment.docker.ok ? "Docker running" : "Docker stopped"].join(" · ")
              : "Checking…"
          }
        />
        <Step
          state={
            lastDeploy?.status === "running"
              ? "attention"
              : lastDeploy?.status === "failed"
                ? "blocked"
                : azure?.apps.length && runningApps === azure.apps.length
                  ? "done"
                  : "pending"
          }
          title={target ? `Azure: ${target.name}` : "Azure target"}
          detail={
            lastDeploy?.status === "running"
              ? "Deploying…"
              : azure
                ? azure.resourceGroupExists
                  ? `${runningApps}/${azure.apps.length} apps running in ${target?.resourceGroup}`
                  : `Not deployed to ${target?.resourceGroup}`
                : target
                  ? target.resourceGroup
                  : "No target configured"
          }
          action={go("deploy", target ? "Open deploy" : "Add a target")}
        />
      </ol>
      {workspace && workspace.git.changedConfig.length > 0 && (
        <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
          <div className="label">Uncommitted configuration</div>
          <ul className="space-y-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-300">
            {workspace.git.changedConfig.slice(0, 8).map((c) => (
              <li key={c} className={clsx("truncate")} title={c}>
                {c}
              </li>
            ))}
          </ul>
          <p className="hint">Commit configuration with the code you deploy so environments stay reproducible.</p>
        </div>
      )}
    </div>
  );
}
