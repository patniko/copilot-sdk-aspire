import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { hasToken } from "./api";
import {
  Boxes,
  Copilot,
  Download,
  FlaskConical,
  GitHubMark,
  Laptop,
  LayoutDashboard,
  Moon,
  Redo,
  Rocket,
  Save,
  ShieldCheck,
  Sun,
  Undo,
} from "./components/icons";
import { LivePlan } from "./components/LivePlan";
import { TaskDrawer } from "./components/TaskDrawer";
import { Badge, Counter, Spinner } from "./components/ui";
import { useEditorActions, useEditorShortcuts } from "./history";
import { useApp, type View } from "./state";
import { DeployView } from "./views/Deploy";
import { HarnessesView } from "./views/Harnesses";
import { LocalRunView } from "./views/LocalRun";
import { OverviewView } from "./views/Overview";
import { PolicyView } from "./views/Policy";
import { TryView } from "./views/Try";

const NAV: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard /> },
  { id: "harnesses", label: "Harnesses", icon: <Boxes /> },
  { id: "policy", label: "Policy", icon: <ShieldCheck /> },
  { id: "local", label: "Local run", icon: <Laptop /> },
  { id: "deploy", label: "Deploy", icon: <Rocket /> },
  { id: "try", label: "Try it", icon: <FlaskConical /> },
];

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("configurator-theme");
    return stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.dataset.colorMode = dark ? "dark" : "light";
    root.dataset.lightTheme = "light";
    root.dataset.darkTheme = "dark";
    localStorage.setItem("configurator-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

function EditorToolbar() {
  const actions = useEditorActions();
  useEditorShortcuts(actions);
  if (!actions) return null;
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
  return (
    <div className="flex items-center gap-1 border-r border-muted pr-3" aria-label={`Editing ${actions.label}`}>
      <span className="mr-1 hidden max-w-[180px] truncate text-xs fg-muted xl:inline" title={actions.label}>
        {actions.label}
        {actions.dirty && <span className="ml-1 fg-attention">• unsaved</span>}
      </span>
      <button type="button" className="btn-ghost btn-sm btn-icon" aria-label="Undo" title={`Undo (${mod}Z)`} disabled={!actions.canUndo} onClick={actions.undo}>
        <Undo />
      </button>
      <button type="button" className="btn-ghost btn-sm btn-icon" aria-label="Redo" title={`Redo (${mod}Shift+Z)`} disabled={!actions.canRedo} onClick={actions.redo}>
        <Redo />
      </button>
      {actions.exportJson && (
        <button type="button" className="btn-ghost btn-sm btn-icon" aria-label="Export resolved JSON" title="Export resolved harness JSON" onClick={actions.exportJson}>
          <Download />
        </button>
      )}
      <button type="button" className="btn-primary btn-sm" title={`Save (${mod}S)`} disabled={!actions.dirty || actions.saving} onClick={actions.save}>
        {actions.saving ? <Spinner /> : <Save />} Save
      </button>
    </div>
  );
}

export function App() {
  const { view, setView, workspace, environment, local, toasts, loadError, tasks } = useApp();
  const [dark, toggleTheme] = useTheme();

  if (!hasToken()) {
    return (
      <div className="mx-auto mt-24 max-w-lg card card-pad">
        <h1 className="text-xl">Session token missing</h1>
        <p className="mt-2 fg-muted">
          Open the configurator with the URL printed by <code>pnpm configure</code>. It contains a one-time session token that
          protects the local server.
        </p>
      </div>
    );
  }

  const harnessErrors = workspace ? workspace.harnesses.reduce((n, h) => n + h.errors, 0) : 0;
  const policyErrors = workspace ? workspace.policyIssues.filter((i) => i.level === "error").length : 0;

  return (
    <div className={clsx("min-h-screen", tasks.length > 0 && "pb-12")}>
      <header className="sticky top-0 z-30 border-b border-default bg-gh-header">
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          <GitHubMark size={32} aria-label="GitHub" />
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="flex items-center gap-1.5 font-semibold">
              <Copilot className="fg-done" /> GitHub Copilot SDK
            </span>
            <span className="fg-muted">/</span>
            <span className="truncate font-semibold">Agent Service Configurator</span>
            <Badge tone="done">Aspire</Badge>
          </nav>
          {workspace && (
            <div className="ml-2 hidden items-center gap-2 text-xs md:flex">
              <span className="flex items-center gap-1 fg-muted">
                <Boxes /> <span className="font-semibold text-[var(--fgColor-default)]">customer workspace</span>
              </span>
              {workspace.changes.items.length > 0 && <Badge tone="amber">{workspace.changes.items.length} workspace changes</Badge>}
            </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            <EditorToolbar />
            <div className="hidden items-center gap-1.5 lg:flex">
              <Badge tone={environment?.docker.ok ? "green" : environment ? "red" : "neutral"}>Docker</Badge>
              <Badge
                tone={environment?.azure.ok ? "green" : environment ? "red" : "neutral"}
                title={environment?.azure.ok ? `${environment.azure.user} · ${environment.azure.subscriptionName}` : environment?.azure.detail}
              >
                Azure
              </Badge>
              <Badge tone={local?.running ? "green" : "neutral"}>Local {local?.running ? "running" : "stopped"}</Badge>
            </div>
            <button type="button" className="btn-secondary btn-sm btn-icon" aria-label="Toggle theme" onClick={toggleTheme}>
              {dark ? <Sun /> : <Moon />}
            </button>
          </div>
        </div>
        <nav aria-label="Configure" className="flex gap-2 overflow-x-auto px-4 lg:px-6">
          {NAV.map((item) => {
            const count =
              item.id === "harnesses" ? workspace?.harnesses.length : item.id === "policy" && policyErrors > 0 ? policyErrors : undefined;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
                className={clsx("tab mb-2 mt-0", view === item.id && "tab-active")}
              >
                {item.icon}
                {item.label}
                {count !== undefined && <Counter>{count}</Counter>}
                {item.id === "harnesses" && harnessErrors > 0 && <Badge tone="red">{harnessErrors}</Badge>}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-6 px-4 py-6 lg:px-6 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-w-0">
          {loadError && <div className="flash flash-error mb-4">{loadError}</div>}
          {view === "overview" && <OverviewView />}
          {view === "harnesses" && <HarnessesView />}
          {view === "policy" && <PolicyView />}
          {view === "local" && <LocalRunView />}
          {view === "deploy" && <DeployView />}
          {view === "try" && <TryView />}
        </main>

        <aside className="hidden 2xl:block 2xl:sticky 2xl:top-[120px] 2xl:self-start">
          <LivePlan />
        </aside>
      </div>

      <TaskDrawer />

      <div className="fixed right-4 top-28 z-50 space-y-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              "overlay flash max-w-sm text-sm",
              t.tone === "error" && "flash-error",
              t.tone === "success" && "flash-success",
              t.tone === "info" && "!border-[var(--borderColor-default)] !bg-[var(--overlay-bgColor)]",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
