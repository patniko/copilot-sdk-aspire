import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Issue } from "../../server/types";
import { help as helpContent, type HelpTopic } from "../help";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, Loader2, X, XCircle } from "./icons";
import { QuestionIcon, InfoIcon } from "@primer/octicons-react";

/** Primer Box: optional muted header row with title, subtitle and actions. */
export function Card({ title, subtitle, actions, children, className, flush }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Render children edge to edge (lists, tables). */
  flush?: boolean;
}) {
  return (
    <section className={clsx("card", className)}>
      {(title || actions) && (
        <div className="box-header">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold leading-6">{title}</h2>}
            {subtitle && <p className="text-xs fg-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : "card-pad"}>{children}</div>
    </section>
  );
}

/** Primer PageHeader: 24px title, muted description, trailing actions, divider. */
export function PageHeader({ title, description, actions, leading }: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-muted pb-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-normal">
          {leading}
          {title}
        </h1>
        <p className="mt-1 max-w-3xl fg-muted">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Primer FormControl: label (with optional help), input, caption or validation message. */
export function Field({ label, hint, error, children, className, help }: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  /** Key into the help registry; renders a ? button next to the label. */
  help?: string;
}) {
  return (
    <div className={clsx("block", className)}>
      <div className="flex items-center gap-1">
        <label className="label">{label}</label>
        {help && <HelpButton topic={help} />}
      </div>
      {children}
      {error ? (
        <span className="mt-1 flex items-center gap-1 text-xs fg-danger">
          <AlertCircle className="h-3 w-3" /> {error}
        </span>
      ) : (
        hint && <span className="hint block">{hint}</span>
      )}
    </div>
  );
}

export type Tone = "neutral" | "brand" | "green" | "amber" | "red" | "blue" | "done";
const TONES: Record<Tone, string> = {
  neutral: "",
  brand: "badge-accent",
  blue: "badge-accent",
  green: "badge-success",
  amber: "badge-attention",
  red: "badge-danger",
  done: "badge-done",
};

/** Primer Label. */
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={clsx("badge", TONES[tone])} title={title}>
      {children}
    </span>
  );
}

export function Counter({ children }: { children: ReactNode }) {
  return <span className="counter">{children}</span>;
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

/** Primer Flash banner. */
export function Flash({ tone = "info", children, actions, icon }: {
  tone?: "info" | "warn" | "error" | "success";
  children: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  const defaultIcon =
    tone === "error" ? <AlertCircle /> : tone === "warn" ? <AlertTriangle /> : tone === "success" ? <CheckCircle2 /> : <InfoIcon size={16} />;
  return (
    <div className={clsx("flash flex items-start gap-2", tone !== "info" && `flash-${tone}`)} role={tone === "error" ? "alert" : "status"}>
      <span className="mt-0.5 shrink-0">{icon ?? defaultIcon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusLine({ ok, label, detail, pending }: { ok: boolean | undefined; label: ReactNode; detail?: ReactNode; pending?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">
        {pending || ok === undefined ? (
          <Loader2 className="fg-muted" />
        ) : ok ? (
          <CheckCircle2 className="fg-success" />
        ) : (
          <XCircle className="fg-danger" />
        )}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {detail && <div className="text-xs fg-muted">{detail}</div>}
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
      <p className="flex items-center gap-2 fg-success">
        <Check /> {empty}
      </p>
    );
  }
  const sorted = [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
  return (
    <ul className="space-y-1.5">
      {sorted.map((issue, index) => (
        <li key={index} className="flex items-start gap-2">
          {issue.level === "error" ? (
            <AlertCircle className="mt-0.5 shrink-0 fg-danger" />
          ) : (
            <AlertTriangle className="mt-0.5 shrink-0 fg-attention" />
          )}
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className={clsx("text-left", onSelect && "hover:underline")}
              onClick={() => onSelect?.(issue)}
              disabled={!onSelect}
            >
              <code className="text-[11px]">{issue.path}</code> <span>{issue.message}</span>
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
      <div className="input flex flex-wrap items-center gap-1.5 !py-1">
        {values.map((value) => (
          <span key={value} className="badge badge-accent">
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
        className={clsx("input-mono", (parseError || error) && "!border-[var(--borderColor-danger-emphasis)]")}
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
        <span className="text-xs fg-danger">{parseError ? `Invalid JSON: ${parseError}` : error}</span>
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

/** Primer checkbox with label and caption. */
export function Toggle({ checked, onChange, label, description, help }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  help?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-[3px] h-4 w-4 accent-[var(--bgColor-accent-emphasis)]"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <span className="font-semibold">{label}</span>
          {description && <span className="block text-xs fg-muted">{description}</span>}
        </span>
      </label>
      {help && <HelpButton topic={help} />}
    </div>
  );
}

/** Primer SegmentedControl. */
export function SegmentedControl<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md bg-[var(--controlTrack-bgColor-rest)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={clsx(
            "h-7 rounded-md px-3 text-sm",
            value === option.value
              ? "border border-[var(--controlKnob-borderColor-rest)] bg-[var(--controlKnob-bgColor-rest)] font-semibold"
              : "border border-transparent fg-muted hover:text-[var(--fgColor-default)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
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
      {copied ? <Check className="fg-success" /> : <Copy />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Primer Dialog. */
export function Modal({ title, subtitle, children, onClose, footer, wide }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay-backdrop-bgColor)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={clsx("overlay flex max-h-[90vh] w-full flex-col", wide ? "max-w-5xl" : "max-w-lg")}>
        <div className="flex items-start justify-between gap-2 border-b border-muted px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold leading-8">{title}</h2>
            {subtitle && <p className="-mt-1 text-xs fg-muted">{subtitle}</p>}
          </div>
          <button type="button" className="btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-muted px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={className} />;
}

/** Primer Blankslate. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-default p-6 text-center fg-muted">{children}</p>;
}

/**
 * A "?" button that opens a popover explaining a setting: what it does, its scope, what each choice
 * changes, an example, and where the platform draws the line.
 */
export function HelpButton({ topic }: { topic: string }) {
  const entry: HelpTopic | undefined = helpContent[topic];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!entry) return null;
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full fg-muted hover:bg-[var(--bgColor-neutral-muted)] hover:text-[var(--fgColor-accent)]"
        aria-label={`About ${entry.title}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <QuestionIcon size={14} />
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={entry.title} className="popover absolute left-0 top-6 z-40 w-[360px] p-4 text-left text-sm font-normal">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-semibold">{entry.title}</span>
            {entry.scope && <Badge tone="done">{entry.scope}</Badge>}
          </div>
          {entry.option && <code className="text-[11px]">{entry.option}</code>}
          <p className="mt-2">{entry.summary}</p>
          {entry.effects && entry.effects.length > 0 && (
            <dl className="mt-3 space-y-1.5">
              {entry.effects.map((effect) => (
                <div key={effect.when}>
                  <dt className="text-xs font-semibold">{effect.when}</dt>
                  <dd className="text-xs fg-muted">{effect.then}</dd>
                </div>
              ))}
            </dl>
          )}
          {entry.example && (
            <div className="mt-3">
              <div className="section-label">Example</div>
              <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px]">{entry.example}</pre>
            </div>
          )}
          {entry.boundary && (
            <p className="mt-3 border-t border-muted pt-2 text-xs fg-muted">
              <span className="font-semibold text-[var(--fgColor-default)]">Platform boundary: </span>
              {entry.boundary}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
