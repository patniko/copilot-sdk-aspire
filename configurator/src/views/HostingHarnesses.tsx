import { useEffect, useState } from "react";
import type { HostingPageInfo, TryTarget } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, CopyButton, Spinner } from "../components/ui";
import { harnessHostRow } from "../hosting";
import { describeProblem, MODE_INFO, STATUS_BADGES, TRANSPORT_INFO } from "../hostingText";
import { useApp } from "../state";

/**
 * Per-harness hosting for one configuration target, as that target's running agent-api reports it in its read-only
 * `GET /v1/hosting` view: effective mode, status with prerequisites, host, transports and connection actions.
 */
export function HarnessHostingRows({ target }: { target: TryTarget }) {
  const { settings, local, workspace, setView } = useApp();
  const [state, setState] = useState<{ info?: HostingPageInfo; loading: boolean; error?: string }>({ loading: false });
  const [refresh, setRefresh] = useState(0);
  // Reading the local view needs the stack; the Azure view reads the selected target's deployed agent-api.
  const enabled = target === "azure" || !!local?.running;
  const workspaceKey = target === "local" ? workspace : undefined;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ loading: true });
    api<HostingPageInfo>(`/api/hosting?target=${target}`)
      .then((info) => !cancelled && setState({ info, loading: false }))
      .catch((error) => !cancelled && setState({ loading: false, error: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [target, enabled, workspaceKey, refresh]);
  const deployment = settings?.targets.find((entry) => entry.name === settings.selectedTarget);
  const demoHost = target === "local" ? settings?.local.demoHost : deployment?.demoHost;
  const info = enabled && state.info?.target === target ? state.info : undefined;
  const overview = info?.overview;
  return (
    <section className="card" aria-label="Harness hosting">
      <div className="box-header">
        <div>
          <h2 className="text-sm font-semibold leading-6">Harness hosting</h2>
          <p className="text-xs fg-muted">
            Each harness's mode, host, client transports and connection, as the {target === "local" ? "local" : "selected Azure"} agent-api reports
            them. Read-only: nothing here starts hosts or grants connections.
          </p>
        </div>
        {enabled && (
          <button type="button" className="btn-secondary btn-sm" disabled={state.loading} onClick={() => setRefresh((value) => value + 1)}>
            Refresh
          </button>
        )}
      </div>
      <div className="card-pad space-y-3">
        {!enabled && (
          <p className="text-sm fg-muted">
            Start the local stack to see how the service hosts each harness.{" "}
            <button type="button" className="font-semibold text-[var(--fgColor-accent)] underline" onClick={() => setView("local")}>
              Open Local run
            </button>
          </p>
        )}
        {enabled && state.loading && !info && <Spinner />}
        {enabled && state.error && <p className="text-sm fg-danger" role="alert">{state.error}</p>}
        {info?.problem && <p className="text-sm fg-muted">{info.problem}</p>}
        {info && info.stale.length > 0 && (
          <p className="text-sm fg-attention">
            Not yet loaded by this service: {info.stale.map((entry) => `${entry.harness} ${entry.version}${entry.reason === "changed" ? " (changed)" : ""}`).join(", ")}.
            {target === "local" ? " Reload harnesses from Local run to apply saved changes." : " Deploy to apply saved changes."}
          </p>
        )}
        {overview && overview.harnesses.length === 0 && <p className="text-sm fg-muted">The service has no published harnesses.</p>}
        {overview?.harnesses.map((view) => {
          const row = harnessHostRow(view, overview.hosts, target, demoHost);
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
      </div>
    </section>
  );
}
