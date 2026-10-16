import { useEffect, useState, type ReactNode } from "react";

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;

/** Inherited settings are shown read-only in harness scope; a native disabled fieldset locks every nested control. */
export function Locked({ locked, children, className }: { locked: boolean; children: ReactNode; className?: string }) {
  return (
    <fieldset disabled={locked} className={[className, locked ? "opacity-70" : undefined].filter(Boolean).join(" ") || undefined}>
      {children}
    </fieldset>
  );
}

export function SubHeading({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide fg-muted">{children}</h3>
      {hint && <p className="text-xs fg-muted">{hint}</p>}
    </div>
  );
}

/** Why a name cannot replace `current`, if it cannot. */
export function nameProblem(name: string, current: string, taken: readonly string[]): string | undefined {
  if (!SLUG.test(name)) return "Use 2-63 lowercase letters, digits and hyphens, starting with a letter.";
  if (name !== current && taken.includes(name)) return `'${name}' is already in use.`;
  return undefined;
}

/**
 * Edits the key of a named entry (an MCP server, size, or crafting template). The new name applies on blur or Enter
 * once it is a valid, unused slug, so typing never merges two entries.
 */
export function NameInput({ value, taken, onCommit, label }: {
  value: string;
  taken: readonly string[];
  onCommit: (name: string) => void;
  label: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const problem = text === value ? undefined : nameProblem(text, value, taken);
  const commit = () => {
    if (text !== value && !problem) onCommit(text);
  };
  return (
    <div>
      <input
        className="input font-mono"
        aria-label={label}
        aria-invalid={!!problem || undefined}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      {problem && <span className="mt-1 block text-xs fg-danger">{problem} The name stays '{value}'.</span>}
    </div>
  );
}
