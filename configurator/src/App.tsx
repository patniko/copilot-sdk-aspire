import clsx from "clsx";
import { Boxes, Cloud, FlaskConical, GitBranch, Laptop, LayoutDashboard, Moon, ShieldCheck, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { hasToken } from "./api";
import { LivePlan } from "./components/LivePlan";
import { TaskDrawer } from "./components/TaskDrawer";
import { Badge } from "./components/ui";
import { useApp, type View } from "./state";
import { DeployView } from "./views/Deploy";
import { HarnessesView } from "./views/Harnesses";
import { LocalRunView } from "./views/LocalRun";
import { OverviewView } from "./views/Overview";
import { PolicyView } from "./views/Policy";
import { TryView } from "./views/Try";

const NAV: Array<{ id: View; label: string; detail: string; icon: ReactNode }> = [
  { id: "overview", label: "Overview", detail: "Pipeline & environment", icon: <LayoutDashboard className="h-5 w-5" /> },
  { id: "harnesses", label: "Harnesses", detail: "Prompt, model, tools, schemas", icon: <Boxes className="h-5 w-5" /> },
  { id: "policy", label: "Policy", detail: "Operator ceilings & controls", icon: <ShieldCheck className="h-5 w-5" /> },
  { id: "local", label: "Local run", detail: "Parameters, tests, local stack", icon: <Laptop className="h-5 w-5" /> },
  { id: "deploy", label: "Deploy", detail: "Azure target & rollout", icon: <Cloud className="h-5 w-5" /> },
  { id: "try", label: "Try it", detail: "Run a job end to end", icon: <FlaskConical className="h-5 w-5" /> },
];

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("configurator-theme");
    return stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("configurator-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

export function App() {
  const { view, setView, workspace, environment, local, toasts, loadError, tasks } = useApp();
  const [dark, toggleTheme] = useTheme();

  if (!hasToken()) {
    return (
      <div className="mx-auto mt-24 max-w-lg card card-pad">
        <h1 className="text-xl">Session token missing</h1>
        <p className="mt-2 text-slate-500">
          Open the configurator with the URL printed by <code>pnpm configure</code>. It contains a one-time session token that
          protects the local server.
        </p>
      </div>
    );
  }

  const configErrors = workspace ? workspace.harnesses.reduce((n, h) => n + h.errors, 0) + workspace.policyIssues.filter((i) => i.level === "error").length : 0;

  return (
    <div className={clsx("min-h-screen", tasks.length > 0 && "pb-12")}>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="flex items-center gap-4 px-6 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-200">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight">Agent Service Configurator</div>
            <div className="text-xs text-slate-500">Copilot SDK + Aspire</div>
          </div>
          {workspace && (
            <div className="ml-4 hidden items-center gap-2 border-l border-slate-200 pl-4 text-xs text-slate-500 dark:border-slate-800 md:flex">
              <GitBranch className="h-3.5 w-3.5" />
              <span className="font-medium text-slate-700 dark:text-slate-300">{workspace.git.branch}</span>
              {workspace.git.changedConfig.length > 0 && <Badge tone="amber">{workspace.git.changedConfig.length} uncommitted config change(s)</Badge>}
              {configErrors > 0 && <Badge tone="red">{configErrors} config error(s)</Badge>}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Badge tone={environment?.docker.ok ? "green" : environment ? "red" : "neutral"}>Docker</Badge>
            <Badge
              tone={environment?.azure.ok ? "green" : environment ? "red" : "neutral"}
              title={environment?.azure.ok ? `${environment.azure.user} · ${environment.azure.subscriptionName}` : environment?.azure.detail}
            >
              Azure
            </Badge>
            <Badge tone={local?.running ? "green" : "neutral"}>Local stack {local?.running ? "running" : "stopped"}</Badge>
            <button type="button" className="btn-ghost" aria-label="Toggle theme" onClick={toggleTheme}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[240px_minmax(0,1fr)] 2xl:grid-cols-[240px_minmax(0,1fr)_320px]">
        <nav aria-label="Configure" className="lg:sticky lg:top-[84px] lg:self-start">
          <div className="label mb-3 px-2">Configure</div>
          <ul className="space-y-1">
            {NAV.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setView(item.id)}
                  aria-current={view === item.id ? "page" : undefined}
                  className={clsx(
                    "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    view === item.id
                      ? "border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-700/20 dark:text-brand-200"
                      : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-800",
                  )}
                >
                  <span className="mt-0.5 opacity-80">{item.icon}</span>
                  <span>
                    <span className="block font-medium">{item.label}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{item.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0">
          {loadError && (
            <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{loadError}</div>
          )}
          {view === "overview" && <OverviewView />}
          {view === "harnesses" && <HarnessesView />}
          {view === "policy" && <PolicyView />}
          {view === "local" && <LocalRunView />}
          {view === "deploy" && <DeployView />}
          {view === "try" && <TryView />}
        </main>

        <aside className="hidden 2xl:block 2xl:sticky 2xl:top-[84px] 2xl:self-start">
          <LivePlan />
        </aside>
      </div>

      <TaskDrawer />

      <div className="fixed right-4 top-20 z-50 space-y-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              "max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg",
              t.tone === "error" && "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
              t.tone === "success" && "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
              t.tone === "info" && "border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
