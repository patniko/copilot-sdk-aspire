import { useEffect, useState } from "react";
import type { HostingPageInfo, TryTarget } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, CopyButton, Flash, Spinner } from "../components/ui";
import { harnessHostRow } from "../hosting";
import { describeProblem, MODE_INFO, STATUS_BADGES, TRANSPORT_INFO } from "../hostingText";
import { useApp } from "../state";

/**
 * Per-harness hosting for one configuration target: the running agent-api's view when it reports one, otherwise the
 * saved workspace evaluated against the target's settings with the same contract functions.
 */
export function HarnessHostingRows({ target }: { target: TryTarget }) {
  const { settings, local, workspace, setView } = useApp();
  const [state, setState] = useState<{ info?: HostingPageInfo; loading: boolean; error?: string }>({ loading: true });
  const service = target === "local" && !!local?.running;
  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    api<HostingPageInfo>(`/api/hosting?target=${target}${service ? "&service=1" : ""}`)
      .then((info) => !cancelled && setState({ info, loading: false }))
      .catch((error) => !cancelled && setState({ loading: false, error: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [target, service, workspace]);
  const deployment = settings?.targets.find((entry) => entry.name === settings.selectedTarget);
  const demoHost = target === "local" ? settings?.local.demoHost : deployment?.demoHost;
  const info = state.info?.target === target ? state.info : undefined;
  return (
    <section className="card" aria-label="Harness hosting">
      <div className="box-header">
        <div>
          <h2 className="text-sm font-semibold leading-6">Harness hosting</h2>
          <p className="text-xs fg-muted">Each harness's mode, host, client transports and connection, for the selected configuration target.</p>
        </div>
        {info && (
          <Badge tone={info.source === "service" ? "green" : "neutral"}>
            {info.source === "service" ? "Reported by the running agent-api" : "Evaluated from your configuration"}
          </Badge>
        )}
      </div>
      <div className="card-pad space-y-3">
        {state.loading && !info && <Spinner />}
        {state.error && <p className="text-sm fg-danger" role="alert">{state.error}</p>}
        {info?.note && <Flash>{info.note}</Flash>}
        {info?.source === "configuration" && (
          <p className="hint">
            Saved harnesses and policy, evaluated against the hosts this target's settings describe: the batch executor and the demo agent host. The
            running service decides at connection time.
          </p>
        )}
        {info && info.overview.harnesses.length === 0 && info.invalid.length === 0 && <p className="text-sm fg-muted">No harnesses yet.</p>}
        {info?.overview.harnesses.map((view) => {
          const row = harnessHostRow(view, info.overview.hosts, target, demoHost);
          const status = STATUS_BADGES[view.status];
          return (
            <div key={view.harness} className="space-y-2 border-b border-muted pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{view.harness}</span>
                <span className="font-mono text-xs fg-muted">v{view.version}</span>
                <Badge tone="done">{view.interaction === "batch" ? "Batch jobs" : MODE_INFO[view.mode].label}</Badge>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <p className="text-sm">
                <span className="font-medium">{row.host}.</span> <span className="fg-muted">{row.hostDetail}</span>
              </p>
              {row.costNote && <p className="text-xs fg-attention">{row.costNote}</p>}
              {view.problems[0] && <p className="text-sm">{describeProblem(view.problems[0])}</p>}
              {view.transports.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {view.transports.map((transport) => (
                    <Badge key={transport.transport} tone={transport.available ? "green" : "neutral"} title={transport.problem?.message}>
                      {TRANSPORT_INFO[transport.transport].label}: {transport.available ? "available" : transport.allowed ? "unavailable" : "not allowed"}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-start gap-3">
                {view.interaction === "batch" ? (
                  <button type="button" className="btn-secondary btn-sm" disabled={view.status !== "ready"} onClick={() => setView("try")}>
                    Run a job in Try it
                  </button>
                ) : (
                  row.connections.map((connection) =>
                    connection.command ? (
                      <CopyButton key={connection.transport} label={`Copy ${connection.label} launcher`} text={connection.command} />
                    ) : (
                      <div key={connection.transport} className="max-w-md">
                        <button type="button" className="btn-secondary btn-sm" disabled>
                          Connect over {connection.label}
                        </button>
                        <p className="mt-1 text-xs fg-muted">{connection.disabledReason}</p>
                      </div>
                    ),
                  )
                )}
              </div>
            </div>
          );
        })}
        {info && info.invalid.length > 0 && (
          <p className="text-sm fg-muted">
            Not evaluated until they validate: {info.invalid.map((entry) => `${entry.harness} ${entry.version}`).join(", ")}.{" "}
            <button type="button" className="font-semibold text-[var(--fgColor-accent)] underline" onClick={() => setView("harnesses")}>
              Open Harnesses
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
