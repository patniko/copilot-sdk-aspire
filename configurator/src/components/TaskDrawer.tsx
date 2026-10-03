import clsx from "clsx";
import { ChevronDown, ChevronUp, Square, TerminalSquare } from "./icons";
import { useEffect, useRef, useState } from "react";
import type { TaskInfo, TaskLine } from "../../server/types";
import { api } from "../api";
import { useApp } from "../state";
import { Badge, Spinner, stateTone } from "./ui";

function elapsed(task: TaskInfo, now: number): string {
  const end = task.endedAt ? new Date(task.endedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(task.startedAt).getTime()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/** Bottom drawer that streams the output of build, test, run, and deploy tasks. */
export function TaskDrawer() {
  const { tasks, activeTask, setActiveTask, drawerOpen, setDrawerOpen } = useApp();
  const [lines, setLines] = useState<TaskLine[]>([]);
  const [now, setNow] = useState(Date.now());
  const cursor = useRef(0);
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const current = tasks.find((t) => t.id === activeTask) ?? tasks[0];

  useEffect(() => {
    setLines([]);
    cursor.current = 0;
    stick.current = true;
  }, [current?.id]);

  useEffect(() => {
    if (!current || !drawerOpen) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api<{ info: TaskInfo; lines: TaskLine[] }>(`/api/tasks/${current.id}?after=${cursor.current}`);
        if (cancelled) return;
        if (result.lines.length) {
          cursor.current = result.lines.at(-1)!.seq;
          setLines((existing) => [...existing, ...result.lines].slice(-6000));
        }
      } catch {
        // Retried on the next tick.
      }
    };
    void poll();
    const timer = setInterval(poll, current.status === "running" ? 800 : 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [current?.id, current?.status, drawerOpen]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (stick.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  if (tasks.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white shadow-[0_-4px_16px_rgba(15,23,42,0.08)] dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-5 py-2 text-left"
        onClick={() => setDrawerOpen(!drawerOpen)}
        aria-expanded={drawerOpen}
      >
        <TerminalSquare className="h-4 w-4 text-slate-500" />
        {current && (
          <>
            <span className="font-medium">{current.title}</span>
            <Badge tone={stateTone(current.status)}>
              {current.status === "running" && <Spinner className="h-3 w-3" />}
              {current.status}
            </Badge>
            <span className="text-xs text-slate-500">{elapsed(current, now)}</span>
          </>
        )}
        <span className="ml-auto">{drawerOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}</span>
      </button>
      {drawerOpen && current && (
        <div className="border-t border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 overflow-x-auto px-5 py-2">
            {tasks.slice(0, 8).map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => setActiveTask(task.id)}
                className={clsx(
                  "btn btn-sm",
                  task.id === current.id
                    ? "border-[var(--borderColor-accent-emphasis)] bg-[var(--bgColor-accent-muted)]"
                    : "border-slate-200 dark:border-slate-700",
                )}
              >
                <span className={clsx("h-2 w-2 rounded-full", {
                  "bg-[var(--bgColor-attention-emphasis)]": task.status === "running",
                  "bg-[var(--bgColor-success-emphasis)]": task.status === "succeeded",
                  "bg-[var(--bgColor-danger-emphasis)]": task.status === "failed",
                  "bg-slate-400": task.status === "cancelled",
                })} />
                {task.title}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <code className="hidden max-w-[40ch] truncate text-xs text-slate-500 lg:block" title={current.command}>
                {current.command}
              </code>
              {current.status === "running" && (
                <button type="button" className="btn-danger btn-sm" onClick={() => void api(`/api/tasks/${current.id}/cancel`, { method: "POST" })}>
                  <Square className="h-3 w-3" /> Cancel
                </button>
              )}
            </div>
          </div>
          <pre
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="h-72 overflow-auto bg-slate-950 px-5 py-3 font-mono text-[11.5px] leading-relaxed text-slate-200"
          >
            {lines.map((line) => (
              <div
                key={line.seq}
                className={clsx(
                  line.stream === "system" && "text-sky-300",
                  line.stream === "stderr" && /error|fail|✗|❌/i.test(line.text) && "text-red-300",
                  /✓|succeeded|success/i.test(line.text) && line.stream !== "stderr" && "text-emerald-300",
                )}
              >
                {line.text || " "}
              </div>
            ))}
            {lines.length === 0 && <div className="text-slate-500">Waiting for output…</div>}
          </pre>
        </div>
      )}
    </div>
  );
}
