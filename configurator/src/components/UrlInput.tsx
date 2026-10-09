import clsx from "clsx";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Badge, Spinner } from "./ui";

type Probe = { reachable: true; status: number } | { reachable: false; detail: string };

export function urlProblem(value: string, { https = false }: { https?: boolean } = {}): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, including https://.";
  }
  if (url.protocol !== "https:" && (https || url.protocol !== "http:")) return https ? "Use an https:// URL." : "Use an http:// or https:// URL.";
  return undefined;
}

function verdict(probe: Probe): { tone: "green" | "amber" | "red"; text: string } {
  if (!probe.reachable) return { tone: "red", text: `Unreachable: ${probe.detail}` };
  if (probe.status < 300) return { tone: "green", text: `Reachable (HTTP ${probe.status})` };
  if (probe.status === 401 || probe.status === 403) return { tone: "green", text: `Reachable, needs credentials (HTTP ${probe.status})` };
  if (probe.status < 500) return { tone: "amber", text: `Reachable, but HTTP ${probe.status}. Check the path.` };
  return { tone: "red", text: `Server error (HTTP ${probe.status})` };
}

/** URL input with inline format validation and a "Test" button that checks reachability from this machine. */
export function UrlInput({ value, onChange, placeholder, https, probePath = "", label }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  https?: boolean;
  /** Appended to the URL when testing, e.g. "/models" for an OpenAI v1 endpoint. */
  probePath?: string;
  label: string;
}) {
  const [probe, setProbe] = useState<{ url: string; result: Probe } | { url: string; error: string }>();
  const [busy, setBusy] = useState(false);
  const problem = urlProblem(value, { https });
  const current = probe?.url === value ? probe : undefined;

  async function test() {
    setBusy(true);
    try {
      const target = `${value.replace(/\/+$/, "")}${probePath}`;
      setProbe({ url: value, result: await api<Probe>("/api/check-url", { method: "POST", body: { url: target } }) });
    } catch (error) {
      setProbe({ url: value, error: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const result = current && "result" in current ? verdict(current.result) : undefined;
  return (
    <div>
      <div className="flex gap-2">
        <input
          className={clsx("input font-mono", problem && "!border-[var(--borderColor-danger-emphasis)]")}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={!!problem || undefined}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <button type="button" className="btn-secondary shrink-0" disabled={!value || !!problem || busy} onClick={() => void test()}>
          {busy && <Spinner className="h-3.5 w-3.5" />} Test
        </button>
      </div>
      {problem && <span className="mt-1 block text-xs fg-danger">{problem}</span>}
      {result && (
        <span className="mt-1 block">
          <Badge tone={result.tone}>{result.text}</Badge>
        </span>
      )}
      {current && "error" in current && <span className="mt-1 block text-xs fg-danger">{current.error}</span>}
    </div>
  );
}
