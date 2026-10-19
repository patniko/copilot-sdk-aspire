import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  HarnessDefinition, InputRequestView, InputResponseSubmission, SharedSessionView, WorkerInputRequestView, WorkerView,
} from "@copilot-agent/contracts";
import type { DemoCheck, DemoLaunch, DemoModeInfo, DemosInfo } from "../../server/types";
import { api, errorMessage } from "../api";
import { InputRequestCard } from "../components/InputRequestCard";
import { AlertTriangle, ArrowRight, Check, Play, RefreshCw, Rocket, ShieldCheck, TerminalSquare, X } from "../components/icons";
import { Badge, CopyButton, Spinner } from "../components/ui";
import { useApp } from "../state";
import "../components/demos.css";

type Mode = DemoModeInfo["mode"];
type Stage = "defined" | "admitted" | "cli" | "live";
const STAGES: Array<{ id: Stage; label: string; detail: string }> = [
  { id: "defined", label: "Defined in code", detail: "defineAgent() validates it locally" },
  { id: "admitted", label: "Admitted by policy", detail: "POST /v1/sessions with the definition" },
  { id: "cli", label: "CLI attached", detail: "AHP through the connection broker" },
  { id: "live", label: "Live", detail: "Placement, budget, and workers update here" },
];

interface Active {
  mode: Mode;
  title: string;
  sessionId: string;
  definition: HarnessDefinition;
  prompts: string[];
  terminal: DemoLaunch["terminal"];
}

interface Live {
  session: SharedSessionView;
  workers?: WorkerView[];
}

/**
 * Launch the code-defined demo agents, one per hosting offering, on the local stack and watch them run. Each launch
 * submits the same definition `pnpm agent:demo` would, opens the Copilot CLI on the session in a new terminal window,
 * and follows the session here: where it runs, its budget, its workers, and the approvals they need.
 */
export function DemosView() {
  const { runTask, toast, setView } = useApp();
  const [info, setInfo] = useState<DemosInfo>();
  const [model, setModel] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [launching, setLaunching] = useState<Mode>();
  const [stage, setStage] = useState<Stage | undefined>(() => (restoreActive() ? "live" : undefined));
  const [active, setActiveState] = useState<Active | undefined>(restoreActive);
  const [launchError, setLaunchError] = useState<string>();
  const setActive = useCallback((next: Active | undefined) => {
    setActiveState(next);
    if (next) sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(ACTIVE_KEY);
  }, []);

  const load = useCallback(async (selected?: string) => {
    setLoading(true);
    try {
      const next = await api<DemosInfo>(`/api/demos${selected ? `?model=${encodeURIComponent(selected)}` : ""}`);
      setInfo(next);
      setModel(next.model || undefined);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const prepare = async () => {
    setPreparing(true);
    try {
      const { changed } = await api<{ changed: string[] }>("/api/demos/prepare", { method: "POST" });
      if (changed.length) {
        toast(`Policy updated (${changed.join(", ")}). Restarting agent-api to load it.`, "success");
        await runTask("local-restart-api");
      } else {
        toast("The policy already allows every demo.", "info");
      }
      await load(model);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setPreparing(false);
    }
  };

  const launch = async (demo: DemoModeInfo) => {
    if (!model) return;
    setLaunching(demo.mode);
    setLaunchError(undefined);
    setActive(undefined);
    setStage("defined");
    try {
      const result = await api<DemoLaunch>("/api/demos/launch", { method: "POST", body: { mode: demo.mode, model } });
      const session = result.session as SharedSessionView;
      setStage("admitted");
      setActive({ mode: demo.mode, title: demo.title, sessionId: session.id, definition: result.definition, prompts: demo.prompts, terminal: result.terminal });
      await pause(700);
      setStage(result.terminal.opened ? "cli" : "admitted");
      if (!result.terminal.opened) toast(`Could not open a terminal: ${result.terminal.error ?? "unknown error"}. Copy the command instead.`, "error");
    } catch (error) {
      setStage(undefined);
      setLaunchError(errorMessage(error));
    } finally {
      setLaunching(undefined);
    }
  };

  const blocking = info?.checks.filter((check) => !check.ok) ?? [];
  const canPrepare = blocking.some((check) => check.fix === "prepare");
  const markLive = useCallback(() => setStage("live"), []);
  const closed = useCallback(() => { setActive(undefined); setStage(undefined); }, [setActive]);

  return (
    <div className="demos">
      <section className="demo-hero" aria-labelledby="demos-title">
        <div className="demo-hero-orbit" aria-hidden="true">
          {Array.from({ length: 14 }, (_, index) => <span key={index} className={`demo-orbit-dot demo-orbit-dot-${index % 7}`} />)}
        </div>
        <div className="demo-hero-copy">
          <p className="demo-eyebrow"><Rocket /> Managed agents</p>
          <h2 id="demos-title">Define an agent in code. Run it four ways.</h2>
          <p>
            Each demo submits a harness definition from code, the platform admits it under operator policy and places it,
            and the Copilot CLI opens on it in a new terminal. Follow it live below.
          </p>
        </div>
        <div className="demo-hero-controls">
          <label className="demo-model">
            <span>Model</span>
            <select value={model ?? ""} onChange={(event) => { setModel(event.target.value); void load(event.target.value); }} disabled={!info?.models.length}>
              {(info?.models ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <ReadinessPill loading={loading} blocking={blocking.length} />
        </div>
      </section>

      {info && blocking.length > 0 && (
        <section className="demo-checks" aria-label="Readiness">
          {info.checks.map((check) => <CheckChip key={check.id} check={check} />)}
          <div className="demo-check-actions">
            {canPrepare && (
              <button type="button" className="btn btn-primary" onClick={() => void prepare()} disabled={preparing}>
                {preparing ? <Spinner /> : <ShieldCheck />} Prepare policy and reload API
              </button>
            )}
            {blocking.some((check) => check.fix === "start") && (
              <button type="button" className="btn btn-secondary" onClick={() => setView("local")}><Play /> Start the local stack</button>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => void load(model)} disabled={loading}><RefreshCw /> Recheck</button>
          </div>
        </section>
      )}

      <section className="demo-grid" aria-label="Hosting modes">
        {(info?.modes ?? []).map((demo) => (
          <ModeCard key={demo.mode} demo={demo} busy={launching === demo.mode} disabled={Boolean(launching) || !model}
            selected={active?.mode === demo.mode} onLaunch={() => void launch(demo)} />
        ))}
        {!info && loading && <div className="demo-loading" role="status"><Spinner /> Checking the local stack...</div>}
      </section>

      {launchError && (
        <div className="demo-error" role="alert"><AlertTriangle /> <span>{launchError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setLaunchError(undefined)} aria-label="Dismiss"><X /></button>
        </div>
      )}

      {(stage || active) && (
        <section className="demo-run" aria-label="Running demo">
          <Stepper stage={stage} />
          {active && <LiveSession key={active.sessionId} active={active} onLive={markLive} onClosed={closed} />}
        </section>
      )}
    </div>
  );
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACTIVE_KEY = "configurator-demo-active";

/** The demo this tab was following, so a reload or a configurator restart keeps the live view. */
function restoreActive(): Active | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) ?? "null") as Active | null;
    return stored?.sessionId && stored.definition ? stored : undefined;
  } catch {
    return undefined;
  }
}

function ReadinessPill({ loading, blocking }: { loading: boolean; blocking: number }) {
  if (loading) return <span className="demo-pill"><Spinner /> Checking</span>;
  return blocking
    ? <span className="demo-pill demo-pill-warn"><AlertTriangle /> {blocking} {blocking === 1 ? "check needs" : "checks need"} attention</span>
    : <span className="demo-pill demo-pill-ready"><span className="demo-pulse" /> Ready to demo</span>;
}

function CheckChip({ check }: { check: DemoCheck }) {
  return (
    <div className={clsx("demo-check", check.ok ? "demo-check-ok" : "demo-check-bad")} title={check.detail}>
      {check.ok ? <Check /> : <AlertTriangle />}
      <div><strong>{check.label}</strong><span>{check.detail}</span></div>
    </div>
  );
}

export function ModeCard({ demo, busy, disabled, selected, onLaunch }: {
  demo: DemoModeInfo; busy: boolean; disabled: boolean; selected: boolean; onLaunch: () => void;
}) {
  const blocked = demo.problems.length > 0;
  return (
    <article className={clsx("demo-card", `demo-card-${demo.mode}`, selected && "demo-card-selected")}>
      <ModeArt mode={demo.mode} />
      <div className="demo-card-body">
        <h3>{demo.title}</h3>
        <p className="demo-tagline">{demo.tagline}</p>
        <p className="demo-story">{demo.story}</p>
        <div className="demo-card-meta">
          <code>{demo.definition.name}</code>
          {(demo.definition.builtinTools ?? []).map((tool) => <Badge key={tool}>{tool}</Badge>)}
        </div>
        {blocked && <ul className="demo-problems">{demo.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      </div>
      <button type="button" className="demo-launch" onClick={onLaunch} disabled={disabled || blocked}>
        {busy ? <Spinner /> : <Rocket />} {busy ? "Launching..." : `Launch ${demo.title.toLowerCase()}`}
      </button>
    </article>
  );
}

/** A small animated picture of where the mode runs: the shared worker on the left, containers on the right. */
function ModeArt({ mode }: { mode: Mode }) {
  return (
    <div className={clsx("demo-art", `demo-art-${mode}`)} aria-hidden="true">
      <div className="demo-art-shared">
        {mode !== "isolated" && Array.from({ length: mode === "shared" ? 6 : 4 }, (_, index) => (
          <span key={index} className={clsx("demo-art-dot", index === 0 && "demo-art-dot-me")} />
        ))}
      </div>
      {mode !== "shared" && (
        <div className="demo-art-containers">
          {(mode === "orchestrator" ? ["s", "m"] : mode === "isolated" ? ["a", "me", "b"] : ["me"]).map((box) => (
            <span key={box} className={clsx("demo-art-box", `demo-art-box-${box}`)}><span className="demo-art-dot" /></span>
          ))}
        </div>
      )}
      {mode === "promotable" && <span className="demo-art-traveller" />}
      {mode === "orchestrator" && <span className="demo-art-beam" />}
    </div>
  );
}

export function Stepper({ stage }: { stage?: Stage }) {
  const reached = stage ? STAGES.findIndex((step) => step.id === stage) : -1;
  return (
    <ol className="demo-stepper">
      {STAGES.map((step, index) => (
        <li key={step.id} className={clsx(index < reached && "done", index === reached && "current")}>
          <span className="demo-step-mark">{index < reached || (index === reached && step.id === "live") ? <Check /> : index + 1}</span>
          <span><strong>{step.label}</strong><small>{step.detail}</small></span>
        </li>
      ))}
    </ol>
  );
}

function LiveSession({ active, onLive, onClosed }: { active: Active; onLive: () => void; onClosed: () => void }) {
  const { toast } = useApp();
  const [live, setLive] = useState<Live>();
  const [requests, setRequests] = useState<WorkerInputRequestView[]>([]);
  const [busy, setBusy] = useState<string>();
  const announced = useRef(false);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api<Live>(`/api/demos/sessions/${active.sessionId}`);
        if (stopped) return;
        setLive(next);
        if (next.session.online && !announced.current) {
          announced.current = true;
          onLive();
        }
        if (active.mode === "orchestrator") {
          const pending = await api<{ requests: WorkerInputRequestView[] }>("/api/demos/worker-requests");
          if (!stopped) setRequests(pending.requests.filter((request) => request.sessionId === active.sessionId));
        }
      } catch {
        // A transient failure keeps the last view; the next poll retries.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [active.sessionId, active.mode, onLive]);

  const act = async (label: string, path: string, success: string) => {
    setBusy(label);
    try {
      await api(path, { method: "POST" });
      toast(success, "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(undefined);
    }
  };
  const respond = async (request: WorkerInputRequestView, submission: InputResponseSubmission) => {
    await api(`/api/demos/sessions/${request.sessionId}/input-requests/${request.id}/respond`, { method: "POST", body: submission });
    setRequests((current) => current.filter((entry) => entry.id !== request.id));
  };

  const session = live?.session;
  const promoting = session?.promotion && !["committed", "failed"].includes(session.promotion.state);
  return (
    <div className="demo-live">
      <div className="demo-live-main">
        <header className="demo-live-header">
          <div>
            <h3>{active.title}: <code>{active.definition.name}</code></h3>
            <p>Session <code>{active.sessionId}</code>{session && <> · <span className={clsx("demo-online", session.online && "on")} /> {session.online ? "CLI attached" : "waiting for the CLI"}</>}</p>
          </div>
          <div className="demo-live-actions">
            <button type="button" className="btn btn-secondary" disabled={Boolean(busy)}
              onClick={() => void act("cli", `/api/demos/sessions/${active.sessionId}/cli`, "Opened the CLI in a new terminal.")}><TerminalSquare /> Open CLI</button>
            {active.mode === "promotable" && session?.placement === "shared" && !promoting && (
              <button type="button" className="btn btn-primary" disabled={Boolean(busy)}
                onClick={() => void act("promote", `/api/demos/sessions/${active.sessionId}/promote`, "Promotion requested.")}><ArrowRight /> Promote now</button>
            )}
            <button type="button" className="btn btn-danger" disabled={Boolean(busy)}
              onClick={() => void act("close", `/api/demos/sessions/${active.sessionId}/close`, "Session closed.").then(onClosed)}><X /> Close</button>
          </div>
        </header>

        {!active.terminal.opened && (
          <div className="demo-error" role="alert"><AlertTriangle /> <span>Run this in a terminal: <code>{active.terminal.command}</code></span><CopyButton text={active.terminal.command} /></div>
        )}

        <Topology mode={active.mode} live={live} />
        {session && <Facts session={session} />}

        {active.mode === "orchestrator" && (
          <div className="demo-approvals">
            <h4>Worker approvals <Badge tone={requests.length ? "amber" : "neutral"}>{requests.length}</Badge></h4>
            {requests.length === 0
              ? <p className="demo-muted">Workers ask a person here. The coordinator cannot approve them.</p>
              : requests.map((request) => (
                <div key={request.id} className="demo-approval">
                  <p className="demo-muted"><strong>{request.worker}</strong> · {request.harness.name}</p>
                  <InputRequestCard request={{ ...request, jobId: request.sessionId, attempt: 1 } as unknown as InputRequestView}
                    onRespond={(submission) => respond(request, submission)} />
                </div>
              ))}
          </div>
        )}
      </div>

      <aside className="demo-live-side">
        <div className="demo-panel">
          <h4>Try in the CLI</h4>
          <ul className="demo-prompts">
            {active.prompts.map((prompt) => {
              const text = prompt.replaceAll("<id>", active.sessionId).split("   (")[0]!;
              return <li key={prompt}><span>{prompt.replaceAll("<id>", active.sessionId)}</span><CopyButton text={text} label="Copy" /></li>;
            })}
          </ul>
        </div>
        <div className="demo-panel">
          <h4>The agent, in code</h4>
          <CodeBlock definition={active.definition} />
        </div>
      </aside>
    </div>
  );
}

/** Where the session runs now: the shared worker lane, the container lane, and the move between them. */
export function Topology({ mode, live }: { mode: Mode; live?: Live }) {
  const session = live?.session;
  const inContainer = session?.placement === "container";
  const moving = Boolean(session?.promotion && !["committed", "failed"].includes(session.promotion.state));
  const workers = live?.workers ?? [];
  return (
    <div className={clsx("demo-topology", moving && "moving")} aria-label="Where the session runs">
      <div className="demo-lane demo-lane-shared">
        <span className="demo-lane-label">Shared worker · one runtime, many sessions</span>
        <div className="demo-lane-body">
          {Array.from({ length: 5 }, (_, index) => <span key={index} className="demo-ghost" />)}
          {session && !inContainer && <SessionToken key="shared" label={mode === "orchestrator" ? "coordinator" : "this session"} />}
        </div>
      </div>
      <div className="demo-lane-link" aria-hidden="true"><span className="demo-beam" /></div>
      <div className="demo-lane demo-lane-containers">
        <span className="demo-lane-label">Session containers · one per session or worker</span>
        <div className="demo-lane-body">
          {session && inContainer && (
            <div className="demo-container">
              <small>{session.container?.size ?? "container"} · {session.container?.state ?? "starting"}</small>
              <SessionToken key="container" label={mode === "promotable" ? `generation ${session.segment.generation}` : "this session"} />
            </div>
          )}
          {workers.map((worker) => (
            <div key={worker.id} className={clsx("demo-container", "demo-worker", `demo-worker-${worker.state}`, worker.capacityReleased && "released")}>
              <small>{worker.size} · {worker.approvalMode}</small>
              <strong>{worker.name}</strong>
              <span className="demo-worker-state">{worker.state === "needs_input" ? "needs you" : worker.state}{worker.stopReason ? ` (${worker.stopReason})` : ""}</span>
              <span className="demo-worker-tokens">{worker.usage.tokensUsed.toLocaleString()} tokens</span>
            </div>
          ))}
          {session && !inContainer && moving && (
            <div className="demo-container demo-container-pending">
              <small>{session.promotion?.size ?? "small"} · {session.promotion?.state}</small>
              <strong>Moving here...</strong>
            </div>
          )}
          {!inContainer && !moving && workers.length === 0 && (
            <span className="demo-muted demo-empty-lane">
              {mode === "shared" ? "Nothing here: shared sessions never start a container." : mode === "promotable" ? "Ask for a shell; the session moves here." : mode === "orchestrator" ? "Workers appear here when the coordinator starts them." : "Starts when the CLI connects."}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionToken({ label }: { label: string }) {
  return <span className="demo-token"><span className="demo-token-core" />{label}</span>;
}

function Facts({ session }: { session: SharedSessionView }) {
  const total = session.budget.usedTokens + session.budget.reservedTokens + session.budget.remainingTokens;
  const used = total ? Math.min(100, (session.budget.usedTokens / total) * 100) : 0;
  const reserved = total ? Math.min(100 - used, (session.budget.reservedTokens / total) * 100) : 0;
  const facts: Array<[string, ReactNode]> = [
    ["Mode", session.mode],
    ["Placement", session.placement],
    ["Generation", session.segment.generation],
    ["Promotion", session.promotion?.state ?? "none"],
    ["Model", session.model],
  ];
  return (
    <div className="demo-facts">
      {facts.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
      <div className="demo-budget">
        <small>Budget · {session.budget.usedTokens.toLocaleString()} used of {total.toLocaleString()}</small>
        <div className="demo-budget-bar">
          <span className="used" style={{ width: `${used}%` }} />
          <span className="reserved" style={{ width: `${reserved}%` }} />
        </div>
      </div>
    </div>
  );
}

/** The definition as the `defineAgent` call that produced it, with light syntax colouring (text only, no HTML). */
export function CodeBlock({ definition }: { definition: HarnessDefinition }) {
  const source = useMemo(() => {
    const shown: Record<string, unknown> = {
      name: definition.name, model: definition.model.preferred, hosting: definition.hosting,
      ...(definition.builtinTools?.length ? { builtinTools: definition.builtinTools } : {}),
      ...(definition.permissions ? { permissions: definition.permissions } : {}),
      ...(definition.limits.maxInferenceTokens !== 200_000 ? { limits: { maxInferenceTokens: definition.limits.maxInferenceTokens } } : {}),
      instructions: definition.instructions.length > 160 ? `${definition.instructions.slice(0, 160)}...` : definition.instructions,
    };
    return `const agent = defineAgent(${JSON.stringify(shown, null, 2).replace(/"([A-Za-z]+)":/g, "$1:")});\nconst session = await platform.createSession(agent);\nawait session.openCli();`;
  }, [definition]);
  return (
    <div className="demo-code">
      <div className="demo-code-actions"><CopyButton text={source} label="Copy" /></div>
      <pre><code>{source.split("\n").map((line, index) => <span key={index} className="demo-code-line">{colour(line)}{"\n"}</span>)}</code></pre>
    </div>
  );
}

function colour(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /("(?:[^"\\]|\\.)*")|\b(const|await|true|false)\b|\b(defineAgent|createSession|openCli)\b|(\d[\d_]*)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index! > last) parts.push(line.slice(last, match.index));
    const kind = match[1] ? "str" : match[2] ? "kw" : match[3] ? "fn" : "num";
    parts.push(<span key={match.index} className={`tok-${kind}`}>{match[0]}</span>);
    last = match.index! + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}
