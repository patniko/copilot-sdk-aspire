import { useId, type ComponentType } from "react";
import {
  Boxes,
  CircleDot,
  Cloud,
  Copilot,
  FileCode2,
  GitBranch,
  ShieldCheck,
  TerminalSquare,
  type IconProps,
} from "./icons";
import {
  HOSTING_HEIGHT,
  HOSTING_NODE_HEIGHT,
  HOSTING_NODE_WIDTH,
  HOSTING_WIDTH,
  type HostingNodeId,
  type HostingTopology,
} from "../hosting";
import "./hosting.css";

type BoundaryTone = "accent" | "attention" | "success" | "neutral";

const boundaries: Array<{
  id: string;
  label: string;
  caption: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: BoundaryTone;
  nested?: boolean;
}> = [
  { id: "access", label: "Clients & transport", caption: "User-owned entry points", x: 20, y: 35, width: 258, height: 590, tone: "attention" },
  { id: "control", label: "Platform control plane", caption: "Admission, policy and orchestration", x: 290, y: 35, width: 750, height: 300, tone: "accent" },
  { id: "execution", label: "Job execution", caption: "Isolated runner capacity", x: 1050, y: 35, width: 250, height: 300, tone: "success" },
  { id: "interactive", label: "Interactive container", caption: "Optional retained session", x: 290, y: 375, width: 250, height: 225, tone: "accent", nested: true },
  { id: "state", label: "Session & durable state", caption: "Principal-scoped ownership", x: 550, y: 375, width: 490, height: 225, tone: "success" },
  { id: "managed", label: "Managed inference", caption: "Gateway-held provider access", x: 1050, y: 375, width: 250, height: 445, tone: "attention" },
  { id: "native", label: "Native inference", caption: "Connected Copilot account", x: 290, y: 650, width: 250, height: 170, tone: "neutral" },
];

const nodeIcons: Record<HostingNodeId, ComponentType<IconProps>> = {
  cli: TerminalSquare,
  entry: ShieldCheck,
  shared: Copilot,
  dispatcher: GitBranch,
  scheduler: GitBranch,
  executors: Boxes,
  transport: GitBranch,
  container: Boxes,
  "session-fs": FileCode2,
  ledger: CircleDot,
  gateway: ShieldCheck,
  foundry: Cloud,
  copilot: Copilot,
};

export function HostingNodeIcon({ node, size = 25 }: { node: HostingNodeId; size?: number }) {
  const Icon = nodeIcons[node];
  return <Icon size={size} />;
}

function labelWidth(label: string): number {
  return Math.max(48, label.length * 6.5 + 16);
}

export function HostingDiagram({ topology, selected, onSelect, detailId }: {
  topology: HostingTopology;
  selected: HostingNodeId;
  onSelect: (id: HostingNodeId) => void;
  detailId: string;
}) {
  const id = useId();
  const title = (node: HostingNodeId) => topology.nodes.find((entry) => entry.id === node)?.title ?? node;
  const activeEdges = topology.edges.filter((edge) => edge.from === selected || edge.to === selected);
  const connected = new Set(activeEdges.flatMap((edge) => [edge.from, edge.to]));
  const visibleBoundaries = boundaries.filter((zone) => zone.id !== "native" || topology.nodes.some((node) => node.id === "copilot"));

  return (
    <div className="hosting-diagram">
      <div className="hosting-toolbar">
        <span className="hosting-instruction">
          <span className="hosting-cursor" aria-hidden="true">↖</span>
          Select a component to explore
        </span>
        <div className="hosting-legend" aria-label="Connection legend">
          <span><i className="hosting-legend-flow" /> Requests &amp; execution</span>
          <span><i className="hosting-legend-support" /> Control &amp; state</span>
          <span><i className="hosting-legend-proposed" /> Proposed</span>
        </div>
      </div>
      <p className="hosting-scroll-hint">Scroll horizontally to explore the map, or open the text connection map below.</p>
      <div className="hosting-viewport" role="region" aria-label="Hosting topology; scroll horizontally on narrow screens" tabIndex={0}>
        <div className="hosting-map" style={{ aspectRatio: `${HOSTING_WIDTH} / ${HOSTING_HEIGHT}` }}>
          <svg className="hosting-drawing" viewBox={`0 0 ${HOSTING_WIDTH} ${HOSTING_HEIGHT}`} aria-hidden="true">
            <defs>
              {(["flow", "support", "active", "proposed"] as const).map((kind) => (
                <marker
                  key={kind}
                  id={`${id}-arrow-${kind}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="9"
                  markerHeight="9"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path className={`hosting-arrowhead hosting-arrowhead-${kind}`} d="M 2 1 L 8 5 L 2 9" />
                </marker>
              ))}
            </defs>
            {visibleBoundaries.map((zone) => (
              <g key={zone.id} className="hosting-boundary" data-tone={zone.tone} data-nested={zone.nested}>
                <rect x={zone.x} y={zone.y} width={zone.width} height={zone.height} rx="14" />
                <circle cx={zone.x + 22} cy={zone.y + 22} r="6" />
                <text className="hosting-boundary-label" x={zone.x + 38} y={zone.y + 27}>{zone.label}</text>
                <text className="hosting-boundary-caption" x={zone.x + 16} y={zone.y + 51}>{zone.caption}</text>
              </g>
            ))}
            {topology.edges.map((edge) => {
              const active = edge.from === selected || edge.to === selected;
              const kind = active ? "active" : edge.proposed ? "proposed" : edge.support ? "support" : "flow";
              const path = edge.points.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
              return (
                <g
                  key={`${edge.from}-${edge.to}`}
                  className="hosting-edge"
                  data-active={active}
                  data-support={edge.support}
                  data-proposed={edge.proposed}
                >
                  <path className="hosting-wire-casing" d={path} />
                  <path className="hosting-wire" d={path} markerEnd={`url(#${id}-arrow-${kind})`} />
                </g>
              );
            })}
            {topology.edges.map((edge) => {
              const active = edge.from === selected || edge.to === selected;
              const width = labelWidth(edge.label);
              return (
                <g key={`${edge.from}-${edge.to}-label`} className="hosting-edge-label" data-active={active} data-proposed={edge.proposed}>
                  <rect x={edge.labelAt[0] - width / 2} y={edge.labelAt[1] - 13} width={width} height="26" rx="6" />
                  <text x={edge.labelAt[0]} y={edge.labelAt[1]} dominantBaseline="central" textAnchor="middle">
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </svg>
          {topology.nodes.map((node) => {
            return (
              <button
                key={node.id}
                type="button"
                className="hosting-node"
                data-node={node.id}
                data-proposed={node.proposed}
                data-connected={connected.has(node.id)}
                data-replicated={node.id === "executors" && !node.proposed}
                aria-pressed={selected === node.id}
                aria-controls={detailId}
                onClick={() => onSelect(node.id)}
                style={{
                  left: `${node.x / HOSTING_WIDTH * 100}%`,
                  top: `${node.y / HOSTING_HEIGHT * 100}%`,
                  width: `${HOSTING_NODE_WIDTH / HOSTING_WIDTH * 100}%`,
                  height: `${HOSTING_NODE_HEIGHT / HOSTING_HEIGHT * 100}%`,
                }}
              >
                <span className="hosting-node-icon"><HostingNodeIcon node={node.id} /></span>
                <span className="hosting-node-copy">
                  <strong>{node.title}</strong>
                  <small>{node.caption}</small>
                </span>
                {node.proposed && <span className="hosting-node-badge">Proposed</span>}
                <span className="hosting-node-port" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      <details className="hosting-text-map">
        <summary>Text connection map</summary>
        <ul>
          {topology.edges.map((edge) => (
            <li key={`${edge.from}-${edge.to}`}>
              {title(edge.from)} to {title(edge.to)}: {edge.label}{edge.proposed ? " (proposed)" : ""}.
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
