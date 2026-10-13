import { useId, useState } from "react";
import type { TryTarget } from "../../server/types";
import { HostingDiagram, HostingNodeIcon } from "../components/HostingDiagram";
import { CircleDot, GitBranch, ShieldCheck, TerminalSquare } from "../components/icons";
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
    <div className="space-y-6 hosting-page">
      <PageHeader
        title="Your hosting architecture"
        leading={<GitBranch size={24} />}
        description="See where every responsibility runs, how requests and state move through the platform, and which hybrid components are still proposals."
      />
      <section className="hosting-control-bar" aria-label="Topology controls">
        <div>
          <span className="hosting-control-label">Architecture</span>
          <div className="hosting-segmented" role="group" aria-label="Architecture view">
            <button type="button" data-active={architecture === "current"} aria-pressed={architecture === "current"} onClick={() => setArchitecture("current")}>
              Current stack
            </button>
            <button type="button" data-active={architecture === "hybrid"} aria-pressed={architecture === "hybrid"} onClick={() => setArchitecture("hybrid")}>
              Hybrid proposal
            </button>
          </div>
        </div>
        <label>
          <span className="hosting-control-label">Configuration target</span>
          <select className="input" value={target} onChange={(event) => setTarget(event.target.value === "azure" ? "azure" : "local")}>
            <option value="local">Local workstation</option>
            <option value="azure" disabled={!deployment}>{deployment ? `Azure · ${deployment.name}` : "Azure · no target selected"}</option>
          </select>
        </label>
        <div className="hosting-control-summary">
          <Badge tone={architecture === "hybrid" ? "amber" : "green"}>
            {architecture === "hybrid" ? "Proposal · not deployed" : "Configured architecture"}
          </Badge>
          <span>{architecture === "hybrid" ? "Planned components and routes are dashed." : "Resource state is observational, not live telemetry."}</span>
        </div>
      </section>
      <section className="hosting-architecture-shell" aria-label="Hosting architecture">
        <div className="hosting-architecture-heading">
          <div>
            <h2>{architecture === "hybrid" ? "Shared coordinator with on-demand execution" : "Current container-backed service"}</h2>
            <p>{architecture === "hybrid"
              ? "A low-cost shared main loop delegates privileged or long-running work into isolated container capacity."
              : "The API admits work into durable orchestration, container execution, and gateway-managed model access."}</p>
          </div>
          <span className="hosting-readonly"><ShieldCheck size={14} /> Read-only architecture view</span>
        </div>
        <HostingDiagram topology={topology} selected={node.id} onSelect={setSelected} detailId={detailId} />
        <p className="hosting-boundary-note">
          Diagram zones describe placement and responsibility. They do not claim enforced network egress or cross-customer isolation beyond the controls documented by this repository.
        </p>
      </section>
      <section className="hosting-inspector" id={detailId} aria-live="polite" aria-label="Component details">
        <div className="hosting-inspector-heading">
          <span className="hosting-inspector-icon"><HostingNodeIcon node={node.id} size={27} /></span>
          <div>
            <span className="hosting-inspector-kicker">Selected component</span>
            <h2>{node.title}</h2>
          </div>
          <Badge tone={node.proposed ? "amber" : "neutral"}>{hostingObservation(node, target, local, observedAzure)}</Badge>
        </div>
        <div className="hosting-inspector-grid">
          <div>
            <h3>Responsibility</h3>
            <p>{node.purpose}</p>
          </div>
          <div>
            <h3>Placement</h3>
            <p>{hostingPlacement(node, target)}</p>
          </div>
          <div className="hosting-inspector-boundary">
            <h3><CircleDot size={14} /> Boundary to keep explicit</h3>
            <p>{node.limitation}</p>
          </div>
        </div>
        {target === "azure" && azureError && <p className="mt-3 fg-danger" role="alert">Azure observation unavailable: {azureError}</p>}
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
