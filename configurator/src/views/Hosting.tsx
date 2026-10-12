import { useId, useState } from "react";
import type { TryTarget } from "../../server/types";
import { HostingDiagram } from "../components/HostingDiagram";
import { GitBranch, TerminalSquare } from "../components/icons";
import { Badge, Card, CopyButton, PageHeader } from "../components/ui";
import { hostingObservation, hostingPlacement, hostingTopology, type HostingArchitecture, type HostingNodeId } from "../hosting";
import { useApp } from "../state";

export function HostingView() {
  const { settings, local, azure, azureError, setView } = useApp();
  const [architecture, setArchitecture] = useState<HostingArchitecture>("current");
  const [target, setTarget] = useState<TryTarget>("local");
  const [selected, setSelected] = useState<HostingNodeId>("cli");
  const detailId = useId();
  const deployment = settings?.targets.find((entry) => entry.name === settings.selectedTarget);
  const host = target === "local" ? settings?.local.demoHost : deployment?.demoHost;
  const transport = host?.transport ?? "disabled";
  const topology = hostingTopology(architecture, transport);
  const node = topology.nodes.find((entry) => entry.id === selected) ?? topology.nodes[0]!;
  const observedAzure = azure?.target === deployment?.name ? azure : undefined;
  const hostEnabled = transport !== "disabled";
  return (
    <div className="space-y-6">
      <PageHeader title="Hosting & topology" leading={<GitBranch size={24} />}
        description="Explore the current container stack and the proposed shared-coordinator architecture. Execution destination and connection transport are separate choices." />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex gap-2" role="group" aria-label="Architecture view">
          <button type="button" className={architecture === "current" ? "btn-primary" : "btn-secondary"} aria-pressed={architecture === "current"} onClick={() => setArchitecture("current")}>Current stack</button>
          <button type="button" className={architecture === "hybrid" ? "btn-primary" : "btn-secondary"} aria-pressed={architecture === "hybrid"} onClick={() => setArchitecture("hybrid")}>Hybrid proposal</button>
        </div>
        <label className="text-sm">
          Configuration target
          <select className="input mt-1" value={target} onChange={(event) => setTarget(event.target.value === "azure" ? "azure" : "local")}>
            <option value="local">Local</option>
            <option value="azure" disabled={!deployment}>{deployment ? `Azure: ${deployment.name}` : "Azure: no target selected"}</option>
          </select>
        </label>
      </div>
      <div className="flash">
        <Badge tone={architecture === "hybrid" ? "amber" : "neutral"}>{architecture === "hybrid" ? "Proposal / not deployed" : "Configured architecture"}</Badge>
        <p className="mt-2 text-sm">{architecture === "hybrid"
          ? "The shared CLI destination and on-demand container controller are not enabled. This preview does not deploy resources or change settings; * marks proposed connections."
          : "This is a component map, not live telemetry. Resource observations may be stale and do not establish CLI readiness."}</p>
        <p className="mt-1 text-xs fg-muted">Boxes describe responsibilities, not enforced network or cross-customer isolation.</p>
      </div>
      <section className="card overflow-hidden" aria-label="Hosting architecture">
        <HostingDiagram topology={topology} selected={node.id} onSelect={setSelected} detailId={detailId} />
      </section>
      <section className="card card-pad" id={detailId} aria-live="polite" aria-label="Component details">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg">{node.title}</h2>
          <Badge tone={node.proposed ? "amber" : "neutral"}>{hostingObservation(node, target, local, observedAzure)}</Badge>
        </div>
        <p className="mt-2 text-xs fg-muted">Configured placement: {hostingPlacement(node, target)}</p>
        <p className="mt-2">{node.purpose}</p>
        <p className="mt-2 text-sm fg-muted"><strong>Boundary:</strong> {node.limitation}</p>
        {target === "azure" && azureError && <p className="mt-2 fg-danger" role="alert">Azure observation unavailable: {azureError}</p>}
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><TerminalSquare /> Connect Copilot CLI</span>} subtitle="Keep direct container attachment independent of the proposed shared loop.">
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold">Shared coordinator <Badge tone="amber">Blocked by runtime qualification</Badge></h3>
              <p className="mt-1 text-sm fg-muted">In-process execution and session FS do not yet provide a qualified multi-account CLI host.</p>
              <button type="button" className="btn-secondary mt-2" disabled>Shared CLI launcher unavailable</button>
            </div>
            <div className="border-t border-muted pt-4">
              <h3 className="font-semibold">Container agent <Badge>{hostEnabled ? "Configured" : "Not configured"}</Badge></h3>
              <p className="mt-1 text-sm fg-muted">Launchers use existing authenticated provisioning. Copying a command does not prove the host or client is ready.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(transport === "direct" || transport === "both") && <CopyButton label="Copy direct CLI launcher" text={`pnpm host:connect --target ${target} --transport direct`} />}
                {(transport === "github" || transport === "both") && <CopyButton label="Copy GitHub CLI launcher" text={`pnpm host:connect --target ${target} --transport github`} />}
                <button type="button" className="btn-secondary" onClick={() => setView(target === "local" ? "local" : "deploy")}>Configure container host</button>
              </div>
            </div>
          </div>
        </Card>
        <Card title="Performance & allocation controls" subtitle="Measure the architecture rather than animate a claim.">
          <p>First-token latency, active-container counts, and compute cost are <strong>not measured here yet</strong>.</p>
          <p className="mt-2 text-sm fg-muted">The next integration adds real allocation events and backend-enforced concurrency, warm-capacity, retirement, and budget controls. No preview control silently changes the deployment.</p>
          <p className="mt-2 text-sm fg-muted">Compare the same model/provider where possible, and report shared service costs separately from execution containers and the optional direct host.</p>
        </Card>
      </div>
    </div>
  );
}
