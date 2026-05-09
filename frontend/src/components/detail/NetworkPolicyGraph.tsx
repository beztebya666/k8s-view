// NetworkPolicyGraph — Lens-style three-column diagram for a single
// NetworkPolicy: ingress sources on the left, the policy's pod selector
// in the middle, egress destinations on the right. Arrows carry the
// allowed ports as labels. We never try to lay out the underlying pods
// (that needs a force-directed graph and the topology data) — the
// audience for this view is the security engineer reading the policy
// spec, and "who can talk to whom" is the question they ask.
//
// All math is plain SVG, no third-party graph library — keeps the
// bundle size low and the render cheap. Edges fan out vertically from
// each center anchor to the matching column nodes.

import { useMemo } from "react";

const COL_W = 200;
const NODE_H = 56;
const NODE_GAP = 14;
const TOP = 28;
const SIDE_PAD = 12;

interface NodeBox {
  side: "ingress" | "egress" | "center";
  label: string;
  sub?: string;
  ports?: string[];
}

interface Layout {
  width: number;
  height: number;
  ingress: NodeBox[];
  egress: NodeBox[];
  centerLabel: string;
  centerSub: string;
  policyTypes: string[];
}

export function NetworkPolicyGraph({ obj }: { obj: any }) {
  const layout = useMemo<Layout>(() => buildLayout(obj), [obj]);
  if (!layout.ingress.length && !layout.egress.length) {
    return (
      <div className="rounded-md border border-line bg-bg-soft px-3 py-2 text-[11px] text-fg-mute">
        Policy has no ingress or egress rules.
      </div>
    );
  }

  const { width, height, ingress, egress, centerLabel, centerSub, policyTypes } = layout;
  const cx = width / 2;
  const centerY = height / 2 - NODE_H / 2;
  const centerNodeX = cx - COL_W / 2;
  const ingressX = SIDE_PAD;
  const egressX = width - SIDE_PAD - COL_W;

  return (
    <div className="rounded-md border border-line bg-bg-soft overflow-hidden">
      <div className="px-3 py-1.5 border-b border-line/60 flex items-center text-[11px] text-fg-mute gap-2">
        <span>NetworkPolicy graph</span>
        <span className="ml-auto flex items-center gap-1">
          {policyTypes.map((t) => (
            <span key={t} className={t === "Egress" ? "chip chip-warn" : "chip chip-info"}>{t}</span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} aria-label="NetworkPolicy graph" className="block">
        <defs>
          <marker id="np-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 Z" fill="rgb(var(--fg-mute))" />
          </marker>
        </defs>

        {/* Ingress nodes + arrows */}
        {ingress.map((n, i) => {
          const y = TOP + i * (NODE_H + NODE_GAP);
          const fromX = ingressX + COL_W;
          const toX = centerNodeX;
          const yMid = y + NODE_H / 2;
          const targetY = centerY + NODE_H / 2;
          const path = curveBetween(fromX, yMid, toX, targetY);
          return (
            <g key={`in-${i}`}>
              <path d={path} fill="none" stroke="rgb(var(--fg-mute))" strokeWidth={1} markerEnd="url(#np-arrow)" />
              <PortLabel ports={n.ports} x={(fromX + toX) / 2} y={(yMid + targetY) / 2} />
              <Box x={ingressX} y={y} width={COL_W} height={NODE_H} accent="info" label={n.label} sub={n.sub} />
            </g>
          );
        })}

        {/* Egress nodes + arrows */}
        {egress.map((n, i) => {
          const y = TOP + i * (NODE_H + NODE_GAP);
          const fromX = centerNodeX + COL_W;
          const toX = egressX;
          const yMid = centerY + NODE_H / 2;
          const targetY = y + NODE_H / 2;
          const path = curveBetween(fromX, yMid, toX, targetY);
          return (
            <g key={`out-${i}`}>
              <path d={path} fill="none" stroke="rgb(var(--fg-mute))" strokeWidth={1} markerEnd="url(#np-arrow)" />
              <PortLabel ports={n.ports} x={(fromX + toX) / 2} y={(yMid + targetY) / 2} />
              <Box x={egressX} y={y} width={COL_W} height={NODE_H} accent="warn" label={n.label} sub={n.sub} />
            </g>
          );
        })}

        <Box x={centerNodeX} y={centerY} width={COL_W} height={NODE_H} accent="ok" label={centerLabel} sub={centerSub} bold />
      </svg>
    </div>
  );
}

function PortLabel({ ports, x, y }: { ports?: string[]; x: number; y: number }) {
  if (!ports || ports.length === 0) {
    return <text x={x} y={y - 4} textAnchor="middle" className="fill-fg-mute" fontSize={10}>any</text>;
  }
  // Inline up to 2 ports, "+N" the rest, so a hub policy with 12 backends
  // doesn't wrap into the next arrow's label.
  const head = ports.slice(0, 2).join(", ");
  const overflow = ports.length - 2;
  const text = overflow > 0 ? `${head} +${overflow}` : head;
  return (
    <text x={x} y={y - 4} textAnchor="middle" className="fill-fg-soft" fontSize={10}>
      {text}
    </text>
  );
}

function Box({
  x, y, width, height, label, sub, accent, bold,
}: {
  x: number; y: number; width: number; height: number;
  label: string; sub?: string;
  accent: "ok" | "warn" | "info";
  bold?: boolean;
}) {
  const stroke =
    accent === "ok" ? "rgb(var(--ok) / 0.55)" :
    accent === "warn" ? "rgb(var(--warn) / 0.55)" :
    "rgb(var(--info) / 0.55)";
  const fill =
    accent === "ok" ? "rgb(var(--ok) / 0.06)" :
    accent === "warn" ? "rgb(var(--warn) / 0.06)" :
    "rgb(var(--info) / 0.06)";
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={6} fill={fill} stroke={stroke} />
      <text
        x={x + width / 2}
        y={y + (sub ? height / 2 - 4 : height / 2 + 4)}
        textAnchor="middle"
        className="fill-fg"
        fontSize={12}
        fontWeight={bold ? 600 : 500}
      >
        {clip(label, 28)}
      </text>
      {sub && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 12}
          textAnchor="middle"
          className="fill-fg-mute"
          fontSize={10}
        >
          {clip(sub, 36)}
        </text>
      )}
    </g>
  );
}

function curveBetween(x1: number, y1: number, x2: number, y2: number): string {
  // Cubic Bezier with control points pulled out horizontally — gives the
  // "river-flowing" look Lens uses for similar diagrams.
  const cx = (x1 + x2) / 2;
  return `M${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
}

function clip(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function buildLayout(obj: any): Layout {
  const policyTypes: string[] = (obj?.spec?.policyTypes ?? []) as string[];
  const podSelector = obj?.spec?.podSelector ?? {};
  const centerLabel = describeSelector(podSelector) || "All pods in namespace";
  const centerSub = obj?.metadata?.namespace ?? "";

  const ingress: NodeBox[] = [];
  for (const rule of (obj?.spec?.ingress ?? []) as any[]) {
    const ports = formatPorts(rule?.ports);
    if (!rule?.from || rule.from.length === 0) {
      ingress.push({ side: "ingress", label: "Anywhere", sub: "no `from` selectors", ports });
      continue;
    }
    for (const peer of rule.from as any[]) {
      ingress.push(peerToNode(peer, "ingress", ports));
    }
  }

  const egress: NodeBox[] = [];
  for (const rule of (obj?.spec?.egress ?? []) as any[]) {
    const ports = formatPorts(rule?.ports);
    if (!rule?.to || rule.to.length === 0) {
      egress.push({ side: "egress", label: "Anywhere", sub: "no `to` selectors", ports });
      continue;
    }
    for (const peer of rule.to as any[]) {
      egress.push(peerToNode(peer, "egress", ports));
    }
  }

  const rows = Math.max(ingress.length, egress.length, 1);
  const height = TOP + rows * (NODE_H + NODE_GAP) + 12;
  const width = COL_W * 3 + SIDE_PAD * 2 + 80;
  return { width, height, ingress, egress, centerLabel, centerSub, policyTypes };
}

function peerToNode(peer: any, side: "ingress" | "egress", ports: string[]): NodeBox {
  if (peer?.ipBlock) {
    const except = (peer.ipBlock.except ?? []) as string[];
    return {
      side,
      label: peer.ipBlock.cidr ?? "0.0.0.0/0",
      sub: except.length > 0 ? `except ${except.join(", ")}` : "ipBlock",
      ports,
    };
  }
  const podSel = describeSelector(peer?.podSelector);
  const nsSel = describeSelector(peer?.namespaceSelector);
  if (podSel && nsSel) return { side, label: `pods: ${podSel}`, sub: `namespaces: ${nsSel}`, ports };
  if (podSel) return { side, label: `pods: ${podSel}`, sub: "same namespace", ports };
  if (nsSel) return { side, label: `namespaces: ${nsSel}`, sub: "any pod", ports };
  return { side, label: "All peers", sub: "empty selector", ports };
}

function describeSelector(sel?: any): string {
  if (!sel) return "";
  const matchLabels = sel.matchLabels ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(matchLabels)) parts.push(`${k}=${v}`);
  for (const expr of (sel.matchExpressions ?? []) as any[]) {
    const op = String(expr?.operator ?? "");
    const vals = (expr?.values ?? []) as string[];
    if (op === "In" || op === "NotIn") parts.push(`${expr.key} ${op.toLowerCase()} (${vals.join(",")})`);
    else parts.push(`${expr.key} ${op.toLowerCase()}`);
  }
  return parts.join(", ");
}

function formatPorts(ports?: any[]): string[] {
  if (!ports || ports.length === 0) return [];
  return ports.map((p) => {
    const proto = p?.protocol ?? "TCP";
    const port = p?.port;
    return `${proto}/${port ?? "*"}`;
  });
}
