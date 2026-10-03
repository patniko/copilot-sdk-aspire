import clsx from "clsx";
import { ExternalLink, Laptop, Cloud, Play, RefreshCw, Square, Copilot, Wrench, CheckCircle2, XCircle, FlaskConical } from "../components/icons";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TryTarget } from "../../server/types";
import { api, errorMessage } from "../api";
import { ResultView } from "../components/ResultView";
import { Badge, Card, Empty, Field, Flash, JsonEditor, PageHeader, Spinner, stateTone } from "../components/ui";
import { useApp } from "../state";
import { BookIcon, CommentIcon, DotFillIcon, SyncIcon } from "@primer/octicons-react";

interface LiveVersion {
  version: string;
  digest: string;
  profiles: string[];
  defaultProfile: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
interface LiveHarness {
  name: string;
  description: string;
  versions: LiveVersion[];
}
interface Job {
  id: string;
  state: string;
  profile: string;
  attempts: number;
  maxAttempts: number;
  acknowledgedGaps: string[];
  usage: { inputTokens: number; outputTokens: number; requests: number };
  harness: { name: string; version: string };
  result?: unknown;
  error?: { code: string; message: string };
}
interface JobEvent {
  seq: number;
  at: string;
  body: { type: string; [key: string]: unknown };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "needs_review"]);

function skeleton(schema: any, depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "object") {
    const out: Record<string, unknown> = {};
    for (const key of schema.required ?? Object.keys(schema.properties ?? {})) out[key] = skeleton(schema.properties?.[key], depth + 1);
    return out;
  }
  if (type === "array") return schema.items ? [skeleton(schema.items, depth + 1)] : [];
  if (type === "string") return "";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  return null;
}

function describeRunnerEvent(e: Record<string, any>): string {
  switch (e.kind) {
    case "tool.started":
      return `Tool ${e.tool} started`;
    case "tool.completed":
      return `Tool ${e.tool} ${e.ok ? "completed" : "failed"}`;
    case "subagent.started":
      return `Delegated to sub-agent ${e.agent}`;
    case "subagent.completed":
      return `Sub-agent ${e.agent} ${e.ok ? "finished" : "failed"}`;
    case "skill.used":
      return `Loaded skill ${e.skill}`;
    case "agent.turn_started":
      return "Agent turn started";
    case "agent.turn_completed":
      return "Agent turn completed";
    default:
      return e.message ?? e.kind;
  }
}

function describe(event: JobEvent): string {
  const b = event.body as Record<string, any>;
  switch (b.type) {
    case "job.attempt_started":
      return `Attempt ${b.attempt} started on ${b.profile}`;
    case "job.runner_event":
      return describeRunnerEvent(b.event);
    case "job.retry_scheduled":
      return `Retry scheduled after attempt ${b.attempt} (${b.reason})`;
    case "job.failed":
      return `Failed: ${b.code} — ${b.message}`;
    default:
      return String(b.type).replace("job.", "").replaceAll("_", " ");
  }
}

function eventIcon(event: JobEvent): { icon: ReactNode; className?: string } {
  const b = event.body as Record<string, any>;
  if (b.type === "job.runner_event") {
    switch (b.event.kind) {
      case "subagent.started":
        return { icon: <Copilot />, className: "!bg-[var(--bgColor-done-muted)] fg-done" };
      case "subagent.completed":
        return { icon: <Copilot />, className: b.event.ok ? "!bg-[var(--bgColor-done-muted)] fg-done" : "!bg-[var(--bgColor-danger-muted)] fg-danger" };
      case "skill.used":
        return { icon: <BookIcon size={14} />, className: "!bg-[var(--bgColor-accent-muted)] fg-accent" };
      case "tool.started":
      case "tool.completed":
        return { icon: <Wrench />, className: b.event.ok === false ? "fg-danger" : undefined };
      default:
        return { icon: <CommentIcon size={14} /> };
    }
  }
  switch (b.type) {
    case "job.succeeded":
      return { icon: <CheckCircle2 />, className: "!bg-[var(--bgColor-success-emphasis)] text-[var(--fgColor-onEmphasis)]" };
    case "job.failed":
    case "job.needs_review":
      return { icon: <XCircle />, className: "!bg-[var(--bgColor-danger-emphasis)] text-[var(--fgColor-onEmphasis)]" };
    case "job.attempt_started":
      return { icon: <Play /> };
    case "job.retry_scheduled":
      return { icon: <SyncIcon size={14} />, className: "fg-attention" };
    default:
      return { icon: <DotFillIcon size={14} /> };
  }
}

function EventItem({ event }: { event: JobEvent }) {
  const { icon, className } = eventIcon(event);
  return (
    <li className="timeline-item !py-1">
      <span className={clsx("timeline-badge", className)}>{icon}</span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2 pt-0.5 text-xs">
        <span>{describe(event)}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] fg-muted">{new Date(event.at).toLocaleTimeString([], { hour12: false })}</span>
      </div>
    </li>
  );
}

export function TryView() {
  const { local, settings, workspace, setView } = useApp();
  const [target, setTarget] = useState<TryTarget>(local?.running ? "local" : "azure");
  const [apiUrl, setApiUrl] = useState<string>();
  const [connectError, setConnectError] = useState<string>();
  const [harnesses, setHarnesses] = useState<LiveHarness[]>();
  const [name, setName] = useState<string>();
  const [version, setVersion] = useState<string>();
  const [profile, setProfile] = useState<string>();
  const [input, setInput] = useState<unknown>({});
  const [submitError, setSubmitError] = useState<string>();
  const [job, setJob] = useState<Job>();
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);
  const connectRequest = useRef(0);

  const connect = useCallback(async () => {
    const request = ++connectRequest.current;
    setHarnesses(undefined);
    setConnectError(undefined);
    setApiUrl(undefined);
    try {
      const info = await api<{ apiUrl: string }>(`/api/try/${target}/info`);
      const result = await api<{ harnesses: LiveHarness[] }>(`/api/try/${target}/harnesses`);
      if (request !== connectRequest.current) return;
      setApiUrl(info.apiUrl);
      setHarnesses(result.harnesses);
      const first = result.harnesses[0];
      setName((current) => (result.harnesses.some((h) => h.name === current) ? current : first?.name));
    } catch (error) {
      if (request === connectRequest.current) setConnectError(errorMessage(error));
    }
  }, [target]);

  useEffect(() => {
    void connect();
  }, [connect]);

  const harness = harnesses?.find((h) => h.name === name);
  const live = harness?.versions.find((v) => v.version === version) ?? harness?.versions[0];
  useEffect(() => {
    if (!harness) return;
    const v = harness.versions[0]!;
    setVersion(v.version);
  }, [harness?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live) return;
    setProfile(live.defaultProfile);
    setInput(skeleton(live.inputSchema));
  }, [live?.digest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compare the running service's harness with the files on disk.
  const onDisk = workspace?.harnesses.find((h) => h.name === name && h.version === live?.version);
  const newerOnDisk = workspace?.harnesses.filter((h) => h.name === name && !harness?.versions.some((v) => v.version === h.version)) ?? [];
  const stale = (onDisk && onDisk.digest && live && onDisk.digest !== live.digest) || newerOnDisk.length > 0;

  // Poll the job until it finishes.
  useEffect(() => {
    if (!job || TERMINAL.has(job.state)) return;
    const timer = setInterval(async () => {
      try {
        const [next, page] = await Promise.all([
          api<Job>(`/api/try/${target}/jobs/${job.id}`),
          api<{ events: JobEvent[] }>(`/api/try/${target}/jobs/${job.id}/events?after=${cursor.current}`),
        ]);
        if (page.events.length) {
          cursor.current = page.events.at(-1)!.seq;
          setEvents((current) => [...current, ...page.events]);
        }
        setJob(next);
      } catch {
        // Retried on the next tick.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job, target]);

  async function submit() {
    setBusy(true);
    setSubmitError(undefined);
    try {
      const created = await api<Job>(`/api/try/${target}/jobs`, {
        method: "POST",
        body: { harness: { name, version: live?.version }, profile, input },
      });
      cursor.current = 0;
      setEvents([]);
      setJob(created);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const azureTarget = settings?.targets.find((t) => t.name === settings.selectedTarget);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Try it"
        leading={<FlaskConical size={24} className="fg-muted" />}
        description="Run a real job through the running service: admission, executor, agent, gateway, and model. The configurator attaches the API key; it never leaves this machine."
        actions={
          <div role="radiogroup" aria-label="Target" className="inline-flex rounded-md bg-[var(--controlTrack-bgColor-rest)] p-0.5">
            {(["local", "azure"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={target === t}
                onClick={() => {
                  setTarget(t);
                  setJob(undefined);
                }}
                className={clsx(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-3 text-sm",
                  target === t
                    ? "border-[var(--controlKnob-borderColor-rest)] bg-[var(--controlKnob-bgColor-rest)] font-semibold"
                    : "border-transparent fg-muted",
                )}
              >
                {t === "local" ? <Laptop /> : <Cloud />}
                {t === "local" ? "Local stack" : `Azure${azureTarget ? `: ${azureTarget.name}` : ""}`}
              </button>
            ))}
          </div>
        }
      />

      {connectError ? (
        <Card>
          <Flash tone="error">{connectError}</Flash>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-secondary" onClick={() => void connect()}>
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
            <button type="button" className="btn-secondary" onClick={() => setView(target === "local" ? "local" : "deploy")}>
              {target === "local" ? "Open Local run" : "Open Deploy"}
            </button>
          </div>
        </Card>
      ) : !harnesses ? (
        <Card>
          <Spinner />
        </Card>
      ) : (
        <div className="grid gap-6 2xl:grid-cols-2">
          <Card
            title="Job"
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{apiUrl}</code>
                {apiUrl && (
                  <a className="inline-flex items-center gap-1 text-xs hover:underline" href={apiUrl} target="_blank" rel="noreferrer">
                    job console <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </span>
            }
          >
            {harnesses.length === 0 ? (
              <Empty>The service has no harnesses loaded.</Empty>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Harness">
                    <select className="input" value={name} onChange={(e) => setName(e.target.value)}>
                      {harnesses.map((h) => (
                        <option key={h.name} value={h.name}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Version (running)">
                    <select className="input" value={live?.version} onChange={(e) => setVersion(e.target.value)}>
                      {harness?.versions.map((v) => (
                        <option key={v.version} value={v.version}>
                          {v.version}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Agent profile">
                    <select className="input" value={profile} onChange={(e) => setProfile(e.target.value)}>
                      {live?.profiles.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {stale && (
                  <Flash tone="warn">
                    Your files differ from what this service is running
                    {newerOnDisk.length > 0 ? ` (not yet loaded: ${newerOnDisk.map((h) => h.version).join(", ")})` : ""}.{" "}
                    {target === "local" ? "Use Reload harnesses on Local run." : "Deploy to publish them."}
                  </Flash>
                )}
                <Field label="Input">
                  <JsonEditor rows={16} value={input} onChange={setInput} />
                </Field>
                {submitError && <pre className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">{submitError}</pre>}
                <div className="flex gap-2">
                  <button type="button" className="btn-primary" disabled={busy || !name} onClick={() => void submit()}>
                    {busy ? <Spinner /> : <Play className="h-4 w-4" />} Run job
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => live && setInput(skeleton(live.inputSchema))}>
                    Reset input
                  </button>
                </div>
              </div>
            )}
          </Card>

          <Card
            title={
              job ? (
                <span className="flex items-center gap-2">
                  Result <Badge tone={stateTone(job.state)}>{job.state.replaceAll("_", " ")}</Badge>
                </span>
              ) : (
                "Result"
              )
            }
            actions={
              job &&
              !TERMINAL.has(job.state) && (
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => void api<Job>(`/api/try/${target}/jobs/${job.id}/cancel`, { method: "POST" }).then(setJob).catch(() => undefined)}
                >
                  <Square className="h-3.5 w-3.5" /> Cancel
                </button>
              )
            }
          >
            {!job ? (
              <Empty>Run a job to see live events and the structured result.</Empty>
            ) : (
              <div className="space-y-4">
                <div className="card grid grid-cols-2 gap-px overflow-hidden bg-[var(--borderColor-muted)] text-xs md:grid-cols-4">
                  <div className="bg-[var(--bgColor-default)] p-2">
                    <div className="section-label">Job</div>
                    <code className="break-all !bg-transparent !p-0">{job.id}</code>
                  </div>
                  <div className="bg-[var(--bgColor-default)] p-2">
                    <div className="section-label">Runner</div>
                    {job.profile}
                  </div>
                  <div className="bg-[var(--bgColor-default)] p-2">
                    <div className="section-label">Attempts</div>
                    {job.attempts} of {job.maxAttempts}
                  </div>
                  <div className="bg-[var(--bgColor-default)] p-2">
                    <div className="section-label">Tokens</div>
                    {job.usage.inputTokens} in · {job.usage.outputTokens} out
                  </div>
                </div>
                {job.acknowledgedGaps.length > 0 && <Badge tone="amber">gaps: {job.acknowledgedGaps.join(", ")}</Badge>}
                {job.error && (
                  <Flash tone="error">
                    <code>{job.error.code}</code> {job.error.message}
                  </Flash>
                )}
                {job.state === "succeeded" && (
                  <div className="card card-pad">
                    <ResultView value={job.result} schema={live?.outputSchema} />
                  </div>
                )}
                <div>
                  <div className="section-label flex items-center gap-2">
                    Activity {!TERMINAL.has(job.state) && <Spinner className="h-3 w-3" />}
                  </div>
                  <ol className="max-h-80 overflow-auto">
                    {events.map((e) => (
                      <EventItem key={e.seq} event={e} />
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
