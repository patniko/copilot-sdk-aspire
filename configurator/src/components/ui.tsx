import clsx from "clsx";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Issue } from "../../server/types";

export function Card({ title, subtitle, actions, children, className }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("card card-pad", className)}>
      {(title || actions) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-slate-500 dark:text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl">{title}</h1>
        <p className="mt-1 max-w-3xl text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children, className }: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx("block", className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{error}</span> : hint && <span className="hint block">{hint}</span>}
    </label>
  );
}

type Tone = "neutral" | "brand" | "green" | "amber" | "red" | "blue";
const TONES: Record<Tone, string> = {
  neutral: "border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300",
  brand: "border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-700/20 dark:text-brand-300",
  green: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  amber: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  red: "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300",
  blue: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={clsx("badge", TONES[tone])} title={title}>
      {children}
    </span>
  );
}

export function stateTone(state: string | undefined): Tone {
  switch ((state ?? "").toLowerCase()) {
    case "running":
    case "healthy":
    case "succeeded":
      return "green";
    case "failed":
    case "failedtostart":
    case "unhealthy":
    case "needs_review":
    case "exited":
      return "red";
    case "starting":
    case "building":
    case "waiting":
    case "queued":
    case "retry_wait":
    case "cancel_requested":
    case "inprogress":
      return "amber";
    default:
      return "neutral";
  }
}

export function StatusLine({ ok, label, detail, pending }: { ok: boolean | undefined; label: ReactNode; detail?: ReactNode; pending?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">
        {pending || ok === undefined ? (
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        ) : ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
        )}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {detail && <div className="text-xs text-slate-500 dark:text-slate-400">{detail}</div>}
      </div>
    </div>
  );
}

export function IssueList({ issues, onSelect, onFix, empty = "No issues." }: {
  issues: Issue[];
  onSelect?: (issue: Issue) => void;
  onFix?: (issue: Issue) => void;
  empty?: string;
}) {
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
        <Check className="h-4 w-4" /> {empty}
      </p>
    );
  }
  const sorted = [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
  return (
    <ul className="space-y-1.5">
      {sorted.map((issue, index) => (
        <li key={index} className="flex items-start gap-2">
          {issue.level === "error" ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className={clsx("text-left", onSelect && "hover:underline")}
              onClick={() => onSelect?.(issue)}
              disabled={!onSelect}
            >
              <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{issue.path}</span>{" "}
              <span>{issue.message}</span>
            </button>
            {issue.fix && onFix && (
              <button type="button" className="btn-secondary btn-sm ml-2" onClick={() => onFix(issue)}>
                Bump version
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ChipsInput({ values, onChange, placeholder, pattern, suggestions = [] }: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  pattern?: RegExp;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || values.includes(trimmed) || (pattern && !pattern.test(trimmed))) return;
    onChange([...values, trimmed]);
    setDraft("");
  };
  const remaining = suggestions.filter((s) => !values.includes(s));
  return (
    <div>
      <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950">
        {values.map((value) => (
          <span key={value} className="badge border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-700/20 dark:text-brand-200">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((v) => v !== value))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          className="min-w-[120px] flex-1 bg-transparent py-0.5 text-sm outline-none"
          value={draft}
          placeholder={values.length === 0 ? placeholder : ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
        />
      </div>
      {remaining.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {remaining.map((s) => (
            <button key={s} type="button" className="btn-ghost btn-sm" onClick={() => onChange([...values, s])}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A JSON text editor that reports parse errors and only emits valid values. */
export function JsonEditor({ value, onChange, rows = 14, error }: {
  value: unknown;
  onChange: (value: unknown) => void;
  rows?: number;
  error?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string>();
  const serialized = JSON.stringify(value);
  useEffect(() => {
    try {
      if (JSON.stringify(JSON.parse(text)) !== serialized) {
        setText(JSON.stringify(value, null, 2));
        setParseError(undefined);
      }
    } catch {
      // Keep the user's in-progress text while it is invalid.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
  return (
    <div>
      <textarea
        className={clsx("input-mono", (parseError || error) && "border-red-400 dark:border-red-700")}
        rows={rows}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            setParseError(undefined);
            onChange(parsed);
          } catch (err) {
            setParseError((err as Error).message);
          }
        }}
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-xs text-red-600 dark:text-red-400">{parseError ? `Invalid JSON: ${parseError}` : error}</span>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => {
            try {
              setText(JSON.stringify(JSON.parse(text), null, 2));
            } catch {
              // Nothing to format.
            }
          }}
        >
          Format
        </button>
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium">{label}</span>
        {description && <span className="block text-xs text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
    </label>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1 }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      className="input"
      value={Number.isFinite(value) ? value : ""}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
    />
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string | (() => Promise<string>); label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      onClick={async () => {
        const value = typeof text === "string" ? text : await text();
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card w-full max-w-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base">{title}</h2>
          <button type="button" className="btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("h-4 w-4 animate-spin", className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-slate-700 dark:text-slate-400">{children}</p>;
}
