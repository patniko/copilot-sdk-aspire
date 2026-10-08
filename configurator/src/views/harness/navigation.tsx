import clsx from "clsx";
import type { HarnessSummary, Issue } from "../../../server/types";
import { Badge, Counter, Empty } from "../../components/ui";
import { TABS, tabFor, type Tab } from "./tabs";

export function HarnessNavigation({ harnesses, selected, disabled, onSelect }: {
  harnesses: HarnessSummary[];
  selected?: string;
  disabled: boolean;
  onSelect: (folder: string) => void;
}) {
  const groups = new Map<string, HarnessSummary[]>();
  for (const harness of harnesses) {
    groups.set(harness.name, [...(groups.get(harness.name) ?? []), harness]);
  }

  return (
    <nav aria-label="Harnesses" className="space-y-2 xl:sticky xl:top-[120px] xl:self-start">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="section-label !mb-0">Your harnesses</span>
        <Counter>{groups.size}</Counter>
      </div>
      {groups.size === 0 && <Empty>No harnesses yet.</Empty>}
      {[...groups].map(([name, versions]) => {
        const active = versions.find((h) => h.folder === selected);
        const current = active ?? versions.find((h) => h.latest) ?? versions[0]!;
        return (
          <div key={name} className={clsx("harness-entry", active && "harness-entry-active")}>
            <button
              type="button"
              className="harness-entry-name"
              aria-current={active ? "page" : undefined}
              disabled={disabled}
              onClick={() => onSelect(current.folder)}
            >
              <span className="break-words font-semibold">{name}</span>
              <span className="mt-1 line-clamp-2 text-xs font-normal fg-muted">{current.description}</span>
            </button>
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
              {versions.length > 1 ? (
                <select
                  className="input !min-h-7 !w-auto max-w-full !px-2 !py-0.5 !text-xs font-mono"
                  aria-label={`Version of ${name}`}
                  value={current.folder}
                  disabled={disabled}
                  onChange={(event) => onSelect(event.target.value)}
                >
                  {versions.map((h) => (
                    <option key={h.folder} value={h.folder}>
                      {h.version}{h.latest ? " (latest)" : ""}{h.errors > 0 ? ` - ${h.errors} errors` : h.warnings > 0 ? ` - ${h.warnings} warnings` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-mono text-xs fg-muted">v{current.version}</span>
              )}
              {current.untracked ? <Badge tone="blue">new</Badge> : current.modified ? <Badge tone="amber">edited</Badge> : null}
              {current.errors > 0 ? <Badge tone="red">{current.errors} errors</Badge> : current.warnings > 0 ? <Badge tone="amber">{current.warnings} warnings</Badge> : null}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export function HarnessSections({ selected, issues, onSelect }: {
  selected: Tab;
  issues: Issue[];
  onSelect: (tab: Tab) => void;
}) {
  return (
    <nav aria-label="Harness sections" className="harness-sections">
      {TABS.map((tab) => {
        const tabIssues = issues.filter((issue) => tabFor(issue.path) === tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={selected === tab.id ? "page" : undefined}
            aria-controls="harness-section"
            className="harness-section"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            {tabIssues.length > 0 && (
              <span
                aria-label={`${tabIssues.length} ${tabIssues.some((issue) => issue.level === "error") ? "errors or warnings" : "warnings"}`}
                className={clsx("counter", tabIssues.some((issue) => issue.level === "error") ? "fg-danger" : "fg-attention")}
              >
                {tabIssues.length}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
