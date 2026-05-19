// TopologyGraph — three-column node-graph for the focused workload.
//
//   left column   middle column   right column
//   ──────────    ─────────────   ────────────
//   owner(s)      this object     children
//
// For Deployment we overload the middle to ReplicaSets and put the
// Deployment itself on the left, the Pods on the right. Same idea for
// CronJob (Jobs in the middle) and Pod (Services on the right). The
// columns are dropped silently when there's nothing to put in them, so
// a service with zero matched pods just renders a single centered card.
//
// Implementation is plain SVG sized to fit the largest column; we never
// pull in a force-directed layout because k8s ownership is a tree and
// fixed columns read better than springs at 100% zoom.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApp } from "../../stores/app";
import { useResourceList, type Item } from "../../lib/useResourceList";
import { refToQuery, type DetailRef } from "../DetailPanel";
import { clusterNow, useNowTick } from "../../lib/clock";
import { age } from "../../lib/format";

// Layout constants. COL_W is now dynamic — computed each render from the
// container's available width — but we keep min/max so a very narrow panel
// stays readable and a 4K monitor doesn't stretch a 3-card row across the
// whole screen. The previous hardcoded 240px was the bug the user spotted:
// no matter how wide the detail pane got, names were still clipped to ~30
// chars because that's all the column made room for.
const NODE_H = 44;
const NODE_GAP = 10;
const TOP = 18;
const COL_GAP = 60;
const SIDE_PAD = 12;
const COL_W_MIN = 200;
// 360px ≈ ~45 monospace chars at 12px — covers virtually all real pod
// names (`<deployment>-<rs>-<id>` typically ≤ 45 chars). Past that the
// card looks like an empty banner; rare 50+ char names still get a tooltip
// via the SVG <title>. Picked over the previous 520 because a single-card
// row at full pane width was visually noisy.
const COL_W_MAX = 360;
// Approx pixel width of one JetBrains Mono character at 12px — used to map
// available column pixels to a name char-clip threshold. Empirical: monaco
// 12px averages ~7.2px / char including padding margins.
const CHAR_PX = 7.2;

interface Node {
  ref: DetailRef;
  kind: string;
  label: string;
  /** ISO creation timestamp; rendered as a live "Xm" age in the card's
   *  top-right corner. Owner-reference nodes don't carry one (the owner
   *  ref only includes kind/name/uid) so the corner stays empty there. */
  creationTimestamp?: string;
  sub?: string;
  tone: "ok" | "warn" | "bad" | "info" | "mute";
}

interface Layout {
  width: number;
  height: number;
  left: Node[];
  middle: Node[];
  right: Node[];
  centerKind?: "left" | "middle"; // which column hosts the focused obj
  centerIndex?: number;
}

export function TopologyGraph({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const kind: string = obj?.kind ?? "";
  const ns: string = obj?.metadata?.namespace ?? "";
  const uid: string = obj?.metadata?.uid ?? "";

  const wantsPods = ["Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Node"].includes(kind);
  const wantsRS = kind === "Deployment";
  const wantsJobs = kind === "CronJob";
  const wantsServices = kind === "Pod";

  const wantsSlices = kind === "Service";

  const pods = useResourceList(cluster, "/v1/Pod", ns || undefined, { enabled: wantsPods && !!ns });
  const rss = useResourceList(cluster, "apps/v1/ReplicaSet", ns || undefined, { enabled: wantsRS && !!ns });
  const jobs = useResourceList(cluster, "batch/v1/Job", ns || undefined, { enabled: wantsJobs && !!ns });
  const services = useResourceList(cluster, "/v1/Service", ns || undefined, { enabled: wantsServices && !!ns });
  // EndpointSlices are the authoritative answer to "what does this Service
  // actually route to" — selector equality alone misses set-based
  // selectors and manually-managed endpoints, which is why the Service
  // topology came up empty before.
  const slices = useResourceList(cluster, "discovery.k8s.io/v1/EndpointSlice", ns || undefined, { enabled: wantsSlices && !!ns });

  const layout = useMemo<Layout | null>(
    () => buildTopology(obj, kind, uid, ns, {
      pods: pods.items as any[],
      rss: rss.items as any[],
      jobs: jobs.items as any[],
      services: services.items as any[],
      slices: slices.items as any[],
    }),
    [obj, kind, uid, ns, pods.items, rss.items, jobs.items, services.items, slices.items],
  );

  if (!layout) return null;
  if (layout.left.length === 0 && layout.middle.length === 1 && layout.right.length === 0) {
    // Nothing to show besides the focused object — render no card.
    return null;
  }

  return <Diagram layout={layout} />;
}

function Diagram({ layout }: { layout: Layout }) {
  const [, setSearchParams] = useSearchParams();
  const open = (ref: DetailRef) => {
    const q = refToQuery(ref);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", q);
      next.delete("tab");
      return next;
    });
  };

  const { left, middle, right, height } = layout;
  // Only populated columns get a slot — see the layout note below.
  const present = [left, middle, right].filter((c) => c.length > 0);
  const cols = present.length;

  // Measure the wrapper to size COL_W against the actual available width.
  // ResizeObserver fires on detail-pane resize so the topology re-flows to
  // use the full pane — when the pane is wide, the cards grow with it
  // rather than capping at a hardcoded 240px and clipping pod names.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
  }, []);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const colW = useMemo(() => {
    if (containerWidth <= 0 || cols === 0) return COL_W_MIN;
    const available = containerWidth - SIDE_PAD * 2 - Math.max(0, cols - 1) * COL_GAP;
    const per = Math.floor(available / cols);
    return Math.max(COL_W_MIN, Math.min(COL_W_MAX, per));
  }, [containerWidth, cols]);

  const width = SIDE_PAD * 2 + cols * colW + Math.max(0, cols - 1) * COL_GAP;
  const colX = (i: number) => SIDE_PAD + i * (colW + COL_GAP);
  // Pack only the non-empty columns left-to-right. Placing middle/right
  // at fixed indices 1/2 pushed them past the SVG width whenever `left`
  // was empty (StatefulSet, DaemonSet, Job, Service, Node) — the pod
  // column was rendered off-canvas and clipped.
  const columns: { nodes: Node[]; x: number }[] =
    present.map((nodes, i) => ({ nodes, x: colX(i) }));

  return (
    <div className="rounded-md border border-line bg-bg-soft overflow-hidden">
      <div className="px-3 py-1.5 border-b border-line/60 text-[11px] text-fg-mute">Topology</div>
      <div ref={wrapRef} className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-label="Resource topology" className="block">
          <defs>
            <marker id="topo-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 Z" fill="rgb(var(--fg-mute))" />
            </marker>
          </defs>

          {/* Edges between each adjacent pair of populated columns. */}
          {columns.slice(0, -1).map((col, i) => (
            <g key={`edge-${i}`}>
              {drawEdges(col.x + colW, col.nodes, columns[i + 1].x, columns[i + 1].nodes)}
            </g>
          ))}

          {columns.map((col, ci) => col.nodes.map((n, i) => {
            const y = TOP + i * (NODE_H + NODE_GAP);
            return (
              <NodeBox
                key={`c${ci}n${i}`}
                node={n}
                x={col.x}
                y={y}
                colW={colW}
                onClick={() => open(n.ref)}
              />
            );
          }))}
        </svg>
      </div>
    </div>
  );
}

function drawEdges(x1: number, fromCol: Node[], x2: number, toCol: Node[]): React.ReactNode {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < fromCol.length; i++) {
    for (let j = 0; j < toCol.length; j++) {
      const y1 = TOP + i * (NODE_H + NODE_GAP) + NODE_H / 2;
      const y2 = TOP + j * (NODE_H + NODE_GAP) + NODE_H / 2;
      const cx = (x1 + x2) / 2;
      out.push(
        <path
          key={`e${i}-${j}`}
          d={`M${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`}
          fill="none"
          stroke="rgb(var(--fg-mute) / 0.55)"
          strokeWidth={1}
          markerEnd="url(#topo-arrow)"
        />,
      );
    }
  }
  return out;
}

function NodeBox({ node, x, y, colW, onClick }: { node: Node; x: number; y: number; colW: number; onClick: () => void }) {
  // Subscribe to the 1Hz tick so the age in the top-right corner stays
  // live without re-rendering the whole topology — only the cards update.
  // Owner-ref nodes have no creationTimestamp; we silently skip the age
  // text for those (and also skip the subscription effect cost is moot
  // since useNowTick is just a Set add/remove).
  useNowTick();
  const stroke =
    node.tone === "ok" ? "rgb(var(--ok) / 0.55)" :
    node.tone === "warn" ? "rgb(var(--warn) / 0.55)" :
    node.tone === "bad" ? "rgb(var(--bad) / 0.55)" :
    node.tone === "info" ? "rgb(var(--info) / 0.55)" :
    "rgb(var(--line))";
  const fill =
    node.tone === "ok" ? "rgb(var(--ok) / 0.06)" :
    node.tone === "warn" ? "rgb(var(--warn) / 0.06)" :
    node.tone === "bad" ? "rgb(var(--bad) / 0.06)" :
    node.tone === "info" ? "rgb(var(--info) / 0.06)" :
    "rgb(var(--bg))";
  // Reserve room for the right-hand sub label (status / replica count) so
  // the main name has a sub-aware width budget. Char clip is computed from
  // the *actual* column width — when the panel is wide, we let long names
  // breathe instead of capping at a hardcoded 30 chars.
  const subWidth = node.sub ? Math.min(node.sub.length, 14) * CHAR_PX + 14 : 0;
  const nameClip = Math.max(12, Math.floor((colW - 20 - subWidth) / CHAR_PX));
  const ageStr = node.creationTimestamp ? age(node.creationTimestamp, clusterNow()) : "";
  return (
    <g style={{ cursor: "pointer" }} onClick={onClick}>
      <title>{node.kind}: {node.label}{node.sub ? ` (${node.sub})` : ""}{ageStr ? ` · age ${ageStr}` : ""}</title>
      <rect x={x} y={y} width={colW} height={NODE_H} rx={6} fill={fill} stroke={stroke} />
      <text x={x + 10} y={y + 18} className="fill-fg-mute" fontSize={10} fontFamily="JetBrains Mono, monospace">
        {node.kind}
      </text>
      {ageStr && (
        <text x={x + colW - 8} y={y + 18} textAnchor="end" className="fill-fg-mute" fontSize={10} fontFamily="JetBrains Mono, monospace">
          {ageStr}
        </text>
      )}
      <text x={x + 10} y={y + 33} className="fill-fg" fontSize={12} fontFamily="JetBrains Mono, monospace">
        {clip(node.label, nameClip)}
      </text>
      {node.sub && (
        <text x={x + colW - 8} y={y + 33} textAnchor="end" className="fill-fg-mute" fontSize={10} fontFamily="JetBrains Mono, monospace">
          {clip(node.sub, 14)}
        </text>
      )}
    </g>
  );
}

function clip(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function buildTopology(
  obj: any,
  kind: string,
  uid: string,
  ns: string,
  data: { pods: any[]; rss: any[]; jobs: any[]; services: any[]; slices?: any[] },
): Layout | null {
  if (!obj || !kind) return null;

  const ownedBy = (uidSet: Set<string>) => (it: any) =>
    (it.metadata?.ownerReferences ?? []).some((o: any) => uidSet.has(o.uid));

  const me: Node = nodeFor(obj);

  let left: Node[] = [];
  let middle: Node[] = [];
  let right: Node[] = [];

  if (kind === "Deployment") {
    left = [me];
    const ownedRS = data.rss.filter(ownedBy(new Set([uid])));
    middle = ownedRS.map(nodeFor);
    const rsUids = new Set(ownedRS.map((r) => r.metadata?.uid).filter(Boolean));
    right = data.pods.filter(ownedBy(rsUids)).map(nodeFor);
  } else if (kind === "ReplicaSet") {
    const dep = (obj?.metadata?.ownerReferences ?? []).find((o: any) => o.controller && o.kind === "Deployment");
    if (dep) {
      left = [{
        ref: { group: "apps", version: "v1", resource: "deployments", namespace: ns, name: dep.name },
        kind: "Deployment", label: dep.name, tone: "info",
      }];
    }
    middle = [me];
    right = data.pods.filter(ownedBy(new Set([uid]))).map(nodeFor);
  } else if (kind === "StatefulSet" || kind === "DaemonSet" || kind === "Job") {
    // Surface the controlling owner — frequently a custom resource
    // (a Prometheus / VMAgent / a CronJob / any operator CRD). ownerNode
    // resolves an arbitrary Kind via its apiVersion + plural heuristic.
    const owner = (obj?.metadata?.ownerReferences ?? []).find((o: any) => o.controller)
      ?? (obj?.metadata?.ownerReferences ?? [])[0];
    if (owner) left = [ownerNode(owner, ns)];
    middle = [me];
    right = data.pods.filter(ownedBy(new Set([uid]))).map(nodeFor);
  } else if (kind === "CronJob") {
    left = [me];
    const ownedJobs = data.jobs.filter(ownedBy(new Set([uid])));
    middle = ownedJobs.map(nodeFor);
    const jobUids = new Set(ownedJobs.map((j) => j.metadata?.uid).filter(Boolean));
    right = data.pods.filter(ownedBy(jobUids)).map(nodeFor);
  } else if (kind === "Service") {
    middle = [me];
    // Authoritative membership: pods named by this Service's
    // EndpointSlices. Union with a plain selector match so pods that
    // exist but aren't Ready (hence not in a slice yet) still show —
    // that union is what makes the graph actually populate.
    const svcName = obj?.metadata?.name ?? "";
    const epPodNames = new Set<string>();
    for (const sl of data.slices ?? []) {
      const owns = (sl?.metadata?.labels ?? {})["kubernetes.io/service-name"] === svcName;
      if (!owns) continue;
      for (const ep of (sl?.endpoints ?? [])) {
        const tr = ep?.targetRef;
        if (tr?.kind === "Pod" && tr?.name) epPodNames.add(tr.name);
      }
    }
    const sel = obj?.spec?.selector;
    const selPods = sel && Object.keys(sel).length > 0
      ? data.pods.filter((p) => labelMatches(p?.metadata?.labels ?? {}, sel))
      : [];
    const seen = new Set<string>();
    const backing: any[] = [];
    for (const p of data.pods) {
      const nm = p?.metadata?.name;
      if (!nm || seen.has(nm)) continue;
      if (epPodNames.has(nm)) { seen.add(nm); backing.push(p); }
    }
    for (const p of selPods) {
      const nm = p?.metadata?.name;
      if (!nm || seen.has(nm)) continue;
      seen.add(nm); backing.push(p);
    }
    right = backing.map(nodeFor);
    // Left column = the distinct controllers behind those pods, so the
    // Service isn't a context-free island ("…и т.д").
    const ownerSeen = new Set<string>();
    for (const p of backing) {
      const o = (p?.metadata?.ownerReferences ?? []).find((r: any) => r.controller)
        ?? (p?.metadata?.ownerReferences ?? [])[0];
      if (!o?.kind || !o?.name) continue;
      const k = `${o.kind}/${o.name}`;
      if (ownerSeen.has(k)) continue;
      ownerSeen.add(k);
      left.push(ownerNode(o, ns));
    }
  } else if (kind === "Pod") {
    const owner = (obj?.metadata?.ownerReferences ?? []).find((o: any) => o.controller)
              ?? (obj?.metadata?.ownerReferences ?? [])[0];
    if (owner) {
      left = [ownerNode(owner, ns)];
    }
    middle = [me];
    const labels = obj?.metadata?.labels ?? {};
    const matched = data.services.filter((s) => {
      const sel = s?.spec?.selector;
      if (!sel || Object.keys(sel).length === 0) return false;
      return labelMatches(labels, sel);
    });
    right = matched.map(nodeFor);
  } else if (kind === "Node") {
    middle = [me];
    right = data.pods.filter((p) => p?.spec?.nodeName === obj?.metadata?.name).map(nodeFor);
  } else {
    return null;
  }

  // Cap each column so 200 pods don't render an unscrollable wall.
  left = left.slice(0, 30);
  middle = middle.slice(0, 30);
  right = right.slice(0, 60);

  // `width` is recomputed at render-time from the live container width;
  // we only return `height` here, which depends on row count.
  const rows = Math.max(left.length, middle.length, right.length, 1);
  const height = TOP + rows * (NODE_H + NODE_GAP) + 12;
  return { width: 0, height, left, middle, right };
}

function nodeFor(it: any): Node {
  const kind = String(it?.kind ?? guessKind(it));
  const meta = it?.metadata ?? {};
  let tone: Node["tone"] = "info";
  let sub: string | undefined;

  if (kind === "Pod") {
    const phase = it?.status?.phase;
    tone =
      phase === "Running" || phase === "Succeeded" ? "ok" :
      phase === "Pending" ? "warn" :
      phase === "Failed" || phase === "Unknown" ? "bad" :
      "mute";
    sub = phase;
  } else if (kind === "ReplicaSet") {
    const desired = Number(it?.spec?.replicas ?? 0);
    const ready = Number(it?.status?.readyReplicas ?? 0);
    tone = ready === desired && desired > 0 ? "ok" : ready === 0 ? "mute" : "warn";
    sub = `${ready}/${desired}`;
  } else if (kind === "Job") {
    const succeeded = Number(it?.status?.succeeded ?? 0);
    const failed = Number(it?.status?.failed ?? 0);
    const completions = Number(it?.spec?.completions ?? 1);
    tone = failed > 0 ? "bad" : succeeded === completions ? "ok" : "warn";
    sub = `${succeeded}/${completions}`;
  } else if (kind === "Deployment") {
    const ready = Number(it?.status?.readyReplicas ?? 0);
    const desired = Number(it?.status?.replicas ?? it?.spec?.replicas ?? 0);
    tone = ready === desired && desired > 0 ? "ok" : "warn";
    sub = `${ready}/${desired}`;
  } else if (kind === "Service") {
    sub = String(it?.spec?.type ?? "");
    tone = "ok";
  } else if (kind === "Node") {
    tone = "info";
  }

  const apiVersion: string = String(it?.apiVersion ?? guessApiVersion(kind));
  const slash = apiVersion.indexOf("/");
  const group = slash >= 0 ? apiVersion.slice(0, slash) : "core";
  const version = slash >= 0 ? apiVersion.slice(slash + 1) : apiVersion;
  const resource = pluraliseLocal(kind);
  const ref: DetailRef = {
    group,
    version,
    resource,
    namespace: kind === "Node" ? undefined : meta.namespace,
    name: meta.name ?? "",
  };
  return { ref, kind, label: meta.name ?? "?", sub, tone, creationTimestamp: meta.creationTimestamp };
}

function ownerNode(owner: any, namespace?: string): Node {
  const apiVersion: string = String(owner.apiVersion ?? "v1");
  const slash = apiVersion.indexOf("/");
  const group = slash >= 0 ? apiVersion.slice(0, slash) : "core";
  const version = slash >= 0 ? apiVersion.slice(slash + 1) : apiVersion;
  const resource = pluraliseLocal(owner.kind);
  return {
    ref: {
      group, version, resource,
      namespace: owner.kind === "Node" ? undefined : namespace,
      name: owner.name,
    },
    kind: owner.kind,
    label: owner.name,
    tone: "info",
  };
}

function labelMatches(labels: Record<string, string>, selector: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

function pluraliseLocal(kind: string): string {
  const k = kind.toLowerCase();
  if (k.endsWith("s")) return k + "es";
  if (k.endsWith("y")) return k.slice(0, -1) + "ies";
  return k + "s";
}

function guessKind(it: any): string {
  // Items pulled from useResourceList should already carry .kind from the
  // backend. This is defensive for the rare missed case.
  return String(it?.kind ?? "Resource");
}

function guessApiVersion(kind: string): string {
  if (kind === "Pod" || kind === "Service" || kind === "Node") return "v1";
  if (kind === "Job" || kind === "CronJob") return "batch/v1";
  return "apps/v1";
}
