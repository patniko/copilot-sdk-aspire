import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Issue } from "../../server/types";
import { help as helpContent, type HelpTopic } from "../help";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, Loader2, X, XCircle } from "./icons";
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

export function ChipsInput({ values, onChange, placeholder, pattern, suggestions = [], details = {} }: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  pattern?: RegExp;
  suggestions?: string[];
  /** Extra text per value (for example the model behind a deployment), shown on chips and suggestions. */
  details?: Record<string, string>;
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
          <span key={value} className="badge badge-accent" title={details[value]}>
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
            <button key={s} type="button" className="btn-ghost btn-sm" title={details[s]} onClick={() => onChange([...values, s])}>
              + {s}
              {details[s] && <span className="fg-muted">({details[s]})</span>}
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
export function Toggle({ checked, onChange, label, description, help, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  help?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <label className={clsx("flex items-start gap-2", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer")}>
        <input
          type="checkbox"
          className="mt-[3px] h-4 w-4 accent-[var(--bgColor-accent-emphasis)]"
          checked={checked}
          disabled={disabled}
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
export function SegmentedControl<T extends string>({ value, options, onChange, label, size = "md" }: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md bg-[var(--controlTrack-bgColor-rest)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={clsx(
            "rounded-md",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
            value === option.value
              ? "border border-[var(--controlKnob-borderColor-rest)] bg-[var(--controlKnob-bgColor-rest)] font-semibold"
              : "border border-transparent fg-muted hover:text-[var(--fgColor-default)]",
            option.disabled && "cursor-not-allowed line-through opacity-50 hover:!text-[var(--fgColor-muted)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Radio group rendered as selectable cards, for choices that need a sentence of explanation each. */
export function RadioCards<T extends string>({ value, options, onChange, label, columns = 2 }: {
  value: T;
  options: Array<{ value: T; label: string; description?: ReactNode; badge?: ReactNode; disabled?: boolean }>;
  onChange: (value: T) => void;
  label: string;
  columns?: 2 | 3 | 4;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx("grid gap-2", columns === 2 ? "sm:grid-cols-2" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-4")}
    >
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={clsx(
              "rounded-md border p-3 text-left",
              checked
                ? "border-[var(--borderColor-accent-emphasis)] bg-[var(--bgColor-accent-muted)]"
                : "border-default hover:bg-[var(--bgColor-neutral-muted)]",
              option.disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={clsx(
                  "inline-block h-3.5 w-3.5 shrink-0 rounded-full border",
                  checked ? "border-[4px] border-[var(--bgColor-accent-emphasis)]" : "border-[var(--borderColor-emphasis)]",
                )}
              />
              <span className="font-semibold">{option.label}</span>
              {option.badge && <span className="ml-auto">{option.badge}</span>}
            </span>
            {option.description && <span className="mt-1 block pl-[22px] text-xs fg-muted">{option.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Human-readable reading of a number in a unit, e.g. 5400 seconds → "1 h 30 min", 200000 tokens → "200k". */
export function formatUnit(value: number, unit: "seconds" | "tokens"): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (unit === "tokens") {
    if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(2)}M tokens`;
    if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}k tokens`;
    return `${value} tokens`;
  }
  if (value < 60) return `${value} s`;
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(" ");
}

export function NumberInput({ value, onChange, min, max, step = 1, unit }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  /** Shows a suffix and a human-readable reading next to the input. */
  unit?: "seconds" | "tokens";
}) {
  const outOfRange = Number.isFinite(value) && ((min !== undefined && value < min) || (max !== undefined && value > max));
  const input = (
    <input
      type="number"
      className={clsx("input", unit && "!pr-16", outOfRange && "!border-[var(--borderColor-danger-emphasis)]")}
      value={Number.isFinite(value) ? value : ""}
      min={min}
      max={max}
      step={step}
      aria-invalid={outOfRange || undefined}
      onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
    />
  );
  if (!unit) return input;
  const reading = formatUnit(value, unit);
  const range = [min !== undefined && `min ${formatUnit(min, unit)}`, max !== undefined && `max ${formatUnit(max, unit)}`].filter(Boolean).join(" · ");
  return (
    <div>
      <div className="relative">
        {input}
        <span className="pointer-events-none absolute inset-y-0 right-7 flex items-center text-xs fg-muted">{unit === "seconds" ? "sec" : "tokens"}</span>
      </div>
      <span className={clsx("mt-0.5 block text-xs", outOfRange ? "fg-danger" : "fg-muted")}>
        {reading && <span className="font-medium">{reading}</span>}
        {reading && range && " · "}
        {range}
      </span>
    </div>
  );
}

/** A password input with a show/hide toggle. */
export function SecretInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        className="input !pr-16 font-mono"
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      <button
        type="button"
        className="btn-ghost btn-sm absolute inset-y-0 right-1 my-auto h-6"
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/** An ordered list of values with move up/down, remove, and an "add" picker limited to known options. */
export function OrderedList({ values, onChange, options, label, describe, empty }: {
  values: string[];
  onChange: (values: string[]) => void;
  /** Values that may be added. Existing values outside this list stay visible and are flagged by `describe`. */
  options: string[];
  label: string;
  describe?: (value: string, index: number) => ReactNode;
  empty?: ReactNode;
}) {
  const move = (from: number, to: number) => {
    const next = [...values];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  const remaining = options.filter((o) => !values.includes(o));
  return (
    <div>
      {values.length === 0 ? (
        empty && <p className="text-xs fg-muted">{empty}</p>
      ) : (
        <ol className="card divide-y divide-[var(--borderColor-muted)]" aria-label={label}>
          {values.map((value, index) => (
            <li key={value} className="flex items-center gap-2 px-2 py-1.5">
              <span className="w-5 text-right font-mono text-xs fg-muted">{index + 1}.</span>
              <code className="!bg-transparent text-xs">{value}</code>
              <span className="min-w-0 flex-1 text-xs">{describe?.(value, index)}</span>
              <button type="button" className="btn-ghost btn-sm btn-icon" aria-label={`Move ${value} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                              <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm btn-icon"
                aria-label={`Move ${value} down`}
                disabled={index === values.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button type="button" className="btn-ghost btn-sm btn-icon" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((v) => v !== value))}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {remaining.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {remaining.map((option) => (
            <button key={option} type="button" className="btn-ghost btn-sm" onClick={() => onChange([...values, option])}>
              + {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type SemverPart = "major" | "minor" | "patch";

/** Increments one part of a semantic version and resets the parts after it. Invalid input becomes 1.0.0. */
export function bumpSemver(version: string, part: SemverPart = "patch"): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return "1.0.0";
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Semantic version input with one-click patch/minor/major bumps relative to `base`. */
export function VersionInput({ value, onChange, base, autoFocus }: { value: string; onChange: (value: string) => void; base?: string; autoFocus?: boolean }) {
  const from = base ?? value;
  const valid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={clsx("input font-mono !w-36", !valid && "!border-[var(--borderColor-danger-emphasis)]")}
          value={value}
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label="Version"
          aria-invalid={!valid || undefined}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <div className="flex gap-1" role="group" aria-label="Bump version">
          {(["patch", "minor", "major"] as const).map((part) => {
            const next = bumpSemver(from, part);
            return (
              <button
                key={part}
                type="button"
                className={clsx("btn-sm", value === next ? "btn-secondary !border-[var(--borderColor-accent-emphasis)]" : "btn-ghost")}
                title={`${from} → ${next}`}
                onClick={() => onChange(next)}
              >
                {part} <span className="font-mono fg-muted">{next}</span>
              </button>
            );
          })}
        </div>
      </div>
      {!valid && <span className="mt-1 block text-xs fg-danger">Use MAJOR.MINOR.PATCH, e.g. 1.2.0.</span>}
    </div>
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
