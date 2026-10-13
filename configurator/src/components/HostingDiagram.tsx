import { useId } from "react";
import { HOSTING_HEIGHT, HOSTING_NODE_HEIGHT, HOSTING_NODE_WIDTH, HOSTING_WIDTH, type HostingNodeId, type HostingTopology } from "../hosting";
import "./hosting.css";

const boundaries = [
  { label: "Clients & transport", x: 20, y: 35, width: 225, height: 505 },
  { label: "Platform services", x: 250, y: 35, width: 695, height: 220 },
  { label: "Job execution", x: 950, y: 35, width: 225, height: 220 },
  { label: "Interactive container", x: 250, y: 325, width: 220, height: 175 },
  { label: "Durable state", x: 490, y: 325, width: 455, height: 175 },
  { label: "Managed inference path", x: 950, y: 325, width: 225, height: 420 },
];

export function HostingDiagram({ topology, selected, onSelect, detailId }: {
  topology: HostingTopology;
  selected: HostingNodeId;
  onSelect: (id: HostingNodeId) => void;
  detailId: string;
}) {
  const id = useId();
  const title = (node: HostingNodeId) => topology.nodes.find((entry) => entry.id === node)?.title ?? node;
  return (
    <div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 text-xs fg-muted" aria-label="Topology legend">
        <span>Select a component to inspect it.</span>
        <span>Solid: request path</span>
        <span>Dashed: state/control</span>
        <span>Dotted boxes: proposed components</span>
      </div>
      <p className="px-4 pb-2 text-xs fg-muted md:hidden">Scroll horizontally to explore the map, or open the text connection map below.</p>
      <div className="hosting-viewport" role="region" aria-label="Hosting topology; scroll horizontally on narrow screens" tabIndex={0}>
        <div className="hosting-map" style={{ aspectRatio: `${HOSTING_WIDTH} / ${HOSTING_HEIGHT}` }}>
          <svg className="hosting-drawing" viewBox={`0 0 ${HOSTING_WIDTH} ${HOSTING_HEIGHT}`} aria-hidden="true">
            <defs>
              <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </marker>
            </defs>
            {boundaries.map((zone) => <g key={zone.label} className="hosting-boundary">
              <rect x={zone.x} y={zone.y} width={zone.width} height={zone.height} rx="10" />
              <text x={zone.x + 14} y={zone.y + 28}>{zone.label}</text>
            </g>)}
            {topology.edges.map((edge) => <g key={`${edge.from}-${edge.to}`} className="hosting-edge"
              data-active={edge.from === selected || edge.to === selected} data-support={edge.support}>
              <polyline points={edge.points.map((point) => point.join(",")).join(" ")} markerEnd={`url(#${id}-arrow)`} />
              <text x={edge.labelAt[0]} y={edge.labelAt[1]} textAnchor="middle">{edge.label}{edge.proposed ? " *" : ""}</text>
            </g>)}
          </svg>
          {topology.nodes.map((node) => <button key={node.id} type="button" className="hosting-node"
            data-proposed={node.proposed} aria-pressed={selected === node.id} aria-controls={detailId}
            onClick={() => onSelect(node.id)}
            style={{ left: `${node.x / HOSTING_WIDTH * 100}%`, top: `${node.y / HOSTING_HEIGHT * 100}%`, width: `${HOSTING_NODE_WIDTH / HOSTING_WIDTH * 100}%`, height: `${HOSTING_NODE_HEIGHT / HOSTING_HEIGHT * 100}%` }}>
            <strong>{node.title}</strong>
            <span>{node.caption}</span>
          </button>)}
        </div>
      </div>
      <details className="border-t border-muted px-4 py-3">
        <summary className="cursor-pointer text-sm">Text connection map</summary>
        <ul className="mt-3 space-y-1 text-sm fg-muted">
          {topology.edges.map((edge) => <li key={`${edge.from}-${edge.to}`}>{title(edge.from)} to {title(edge.to)}: {edge.label}{edge.proposed ? " (proposed)" : ""}.</li>)}
        </ul>
      </details>
    </div>
  );
}
