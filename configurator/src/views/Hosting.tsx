import { useId, useState } from "react";
import type { TryTarget } from "../../server/types";
import { HostingDiagram, HostingNodeIcon } from "../components/HostingDiagram";
import { CircleDot, GitBranch, ShieldCheck, TerminalSquare } from "../components/icons";
import { Badge, Card, CopyButton, PageHeader } from "../components/ui";
import { hostingObservation, hostingPlacement, hostingTopology, type HostingArchitecture, type HostingNodeId } from "../hosting";
import { useApp } from "../state";
import { HarnessHostingRows } from "./HostingHarnesses";

export function HostingView() {
  const { settings, local, azure, azureError, setView } = useApp();
  const [architecture, setArchitecture] = useState<HostingArchitecture>("current");
  const [target, setTarget] = useState<TryTarget>("local");
  const [selected, setSelected] = useState<HostingNodeId>("cli");
  const detailId = useId();
  const deployment = settings?.targets.find((entry) => entry.name === settings.selectedTarget);
  const host = target === "local" ? settings?.local.demoHost : deployment?.demoHost;
  const transport = host?.transport ?? "disabled";
  const topology = hostingTopology(architecture, transport, target === "local");
  const node = topology.nodes.find((entry) => entry.id === selected) ?? topology.nodes[0]!;
  const observedAzure = azure?.target === deployment?.name ? azure : undefined;
  const hostEnabled = transport !== "disabled";
  const sharedObserved = target === "local" && local?.resources.some((resource) => resource.name === "session-host");
  return (
    <div className="space-y-6 hosting-page">
      <PageHeader
        title="Your hosting architecture"
        leading={<GitBranch size={24} />}
        description="See where each harness runs and how Copilot CLI connects to it, and compare the default container pool with the experimental local hybrid path, including what is implemented locally and what remains an unqualified Azure proposal."
      />
      <section className="hosting-control-bar" aria-label="Topology controls">
        <div>
          <span className="hosting-control-label">Architecture</span>
          <div className="hosting-segmented" role="group" aria-label="Architecture view">
            <button type="button" data-active={architecture === "current"} aria-pressed={architecture === "current"} onClick={() => setArchitecture("current")}>
              Current stack
            </button>
            <button type="button" data-active={architecture === "hybrid"} aria-pressed={architecture === "hybrid"} onClick={() => setArchitecture("hybrid")}>
              Hybrid architecture
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
          <Badge tone={architecture === "hybrid" ? target === "local" ? "blue" : "amber" : "green"}>
            {architecture === "hybrid"
              ? target === "local" ? "Experimental · local opt-in" : "Azure proposal · unqualified"
              : "Default pool architecture"}
          </Badge>
          <span>{architecture === "hybrid"
            ? target === "local"
              ? "Implemented routes are solid; observations are not live allocation telemetry."
              : "Unqualified Azure components and routes are dashed."
            : "Resource state is observational, not live telemetry."}</span>
        </div>
      </section>
      <HarnessHostingRows target={target} />
      <section className="hosting-architecture-shell" aria-label="Hosting architecture">
        <div className="hosting-architecture-heading">
          <div>
            <h2>{architecture === "hybrid" ? "Shared coordinator with on-demand execution" : "Current container-backed service"}</h2>
            <p>{architecture === "hybrid"
              ? target === "local"
                ? "The local shared main loop delegates privileged or long-running work into actual one-shot container capacity."
                : "The shared main loop and on-demand Azure execution adapter remain an unqualified deployment proposal."
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
        <Card title={<span className="flex items-center gap-2"><TerminalSquare /> Connect Copilot CLI</span>} subtitle="Direct container attachment is independent of the experimental shared loop.">
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold">Shared coordinator <Badge tone="amber">{sharedObserved ? "Local service observed" : "Local opt-in required"}</Badge></h3>
              <p className="mt-1 text-sm fg-muted">The hybrid-coordinator harness on the shared worker. Use the matching qualified CLI and an operator-bound GitHub account. Two-real-account and Azure qualification remain open.</p>
              {sharedObserved
                ? <CopyButton label="Copy shared CLI launcher" text="pnpm host:connect --harness hybrid-coordinator --target local --transport direct" />
                : <button type="button" className="btn-secondary mt-2" disabled>Shared CLI launcher unavailable</button>}
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
          <p className="mt-2 text-sm fg-muted">Local limits are enforced by the backend and configured through Aspire's hybrid parameters. This page does not yet display the allocation ledger or edit those settings. Warm pooling is not implemented; one-shot containers retire after work.</p>
          <p className="mt-2 text-sm fg-muted">Compare the same model/provider where possible, and report shared service costs separately from execution containers and the optional direct host.</p>
        </Card>
      </div>
    </div>
  );
}
