import clsx from "clsx";
import type { ReactNode } from "react";
import type { Decision } from "../../server/types";
import { useApp, type View } from "../state";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Circle, CircleDot, ShieldCheck, Wrench, XCircle } from "./icons";
import { Counter } from "./ui";
import { InfoIcon } from "@primer/octicons-react";

type StepState = "done" | "attention" | "pending" | "blocked";

function Step({ state, title, detail, action }: { state: StepState; title: string; detail: ReactNode; action?: ReactNode }) {
  const badge = {
    done: { icon: <Check />, className: "bg-[var(--bgColor-success-emphasis)] text-[var(--fgColor-onEmphasis)]" },
    attention: { icon: <CircleDot />, className: "bg-[var(--bgColor-attention-emphasis)] text-[var(--fgColor-onEmphasis)]" },
    pending: { icon: <Circle />, className: "" },
    blocked: { icon: <XCircle />, className: "bg-[var(--bgColor-danger-emphasis)] text-[var(--fgColor-onEmphasis)]" },
  }[state];
  return (
    <li className="timeline-item">
      <span className={clsx("timeline-badge", badge.className)}>{badge.icon}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="font-semibold">{title}</div>
        <div className="text-xs fg-muted">{detail}</div>
        {action && <div className="mt-1">{action}</div>}
      </div>
    </li>
  );
}

const DECISION_STYLE: Record<Decision["kind"], { icon: ReactNode; label: string }> = {
  host: { icon: <ShieldCheck className="fg-success" />, label: "Platform" },
  review: { icon: <AlertTriangle className="fg-attention" />, label: "Review" },
  gap: { icon: <XCircle className="fg-danger" />, label: "Gap" },
  info: { icon: <InfoIcon size={16} className="fg-accent" />, label: "Info" },
};

/** Decisions for the harness being edited, grouped by kind. */
export function DecisionList({ decisions, compact }: { decisions: Decision[]; compact?: boolean }) {
  const order: Decision["kind"][] = ["gap", "review", "host", "info"];
  const sorted = [...decisions].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <ul className="space-y-2">
      {sorted.map((d, i) => (
        <li key={i} className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0" title={DECISION_STYLE[d.kind].label}>
            {DECISION_STYLE[d.kind].icon}
          </span>
          <div className="min-w-0">
            <div className={clsx("font-medium", compact && "text-xs")}>{d.title}</div>
            <div className="text-xs fg-muted">{d.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Right-hand summary of where the configuration stands in the configure → run → deploy pipeline. */
export function LivePlan() {
  const { workspace, local, azure, settings, environment, tasks, setView, editorDetail, view } = useApp();
  const errors = workspace ? workspace.harnesses.reduce((n, h) => n + h.errors, 0) + workspace.policyIssues.filter((i) => i.level === "error").length : 0;
  const warnings = workspace ? workspace.harnesses.reduce((n, h) => n + h.warnings, 0) + workspace.policyIssues.filter((i) => i.level === "warning").length : 0;
  const lastBuild = tasks.find((t) => ["build", "test-unit", "test-all", "local-start"].includes(t.kind));
  const lastDeploy = tasks.find((t) => t.kind === "deploy");
  const target = settings?.targets.find((t) => t.name === settings.selectedTarget);
  const go = (next: View, label: string) => (
    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium fg-accent hover:underline" onClick={() => setView(next)}>
      {label} <ArrowRight className="h-3 w-3" />
    </button>
  );
  const runningApps = azure?.apps.filter((a) => a.runningStatus === "Running").length ?? 0;
  const decisions = view === "harnesses" ? editorDetail?.decisions : undefined;

  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-1 text-base font-semibold">Live plan</h2>
        <p className="mb-2 text-xs fg-muted">Configure, validate, run, deploy.</p>
        <ol>
          <Step
            state={!workspace ? "pending" : errors ? "blocked" : warnings ? "attention" : "done"}
            title="Configuration"
            detail={workspace ? `${workspace.harnesses.length} harness version(s) · ${errors} error(s) · ${warnings} warning(s)` : "Loading…"}
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
      </section>

      {decisions && editorDetail && (
        <section className="card">
          <div className="box-header">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold leading-6">
                <Wrench /> Decisions <Counter>{decisions.length}</Counter>
              </h2>
              <p className="text-xs fg-muted">
                {editorDetail.document.manifest.name} {editorDetail.document.manifest.version}
              </p>
            </div>
          </div>
          <div className="card-pad">
            <DecisionList decisions={decisions} compact />
            {editorDetail.requiredCapabilities.length > 0 && (
              <p className="mt-3 border-t border-muted pt-2 text-xs fg-muted">
                <CheckCircle2 className="mr-1 inline h-3 w-3 fg-success" />
                Runners must support: {editorDetail.requiredCapabilities.join(", ")}
              </p>
            )}
          </div>
        </section>
      )}

      {workspace && workspace.git.changedConfig.length > 0 && (
        <section className="card">
          <div className="box-header">
            <h2 className="text-sm font-semibold leading-6">Uncommitted configuration</h2>
            <Counter>{workspace.git.changedConfig.length}</Counter>
          </div>
          <ul className="space-y-0.5 p-3 font-mono text-[11px] fg-muted">
            {workspace.git.changedConfig.slice(0, 8).map((c) => (
              <li key={c} className="truncate" title={c}>
                {c}
              </li>
            ))}
          </ul>
          <p className="hint border-t border-muted px-3 py-2">Commit configuration with the code you deploy so environments stay reproducible.</p>
        </section>
      )}
    </div>
  );
}
