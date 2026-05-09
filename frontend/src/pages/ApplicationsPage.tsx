// ApplicationsPage — Lens-style "Applications" view. Without a Helm backend
// we synthesise rows from the workloads themselves, grouping by the
// `app.kubernetes.io/instance` recommended label so a single Helm release
// surfaces as one row even when it owns several Deployments / DaemonSets /
// StatefulSets. Workloads with no instance label fall back to one row each.
//
// The page is virtualised because production clusters can hit the 150K-row
// memory order; we never mount more than the ~30 visible rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { useApp } from "../stores/app";
import { useResourceList, type Item } from "../lib/useResourceList";
import { age } from "../lib/format";
import { clusterNow } from "../lib/clock";
import { hrefToQuery } from "../components/DetailPanel";

type StatusKind = "ok" | "warn" | "bad" | "info" | "mute";

type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

type WorkloadEntry = {
  kind: WorkloadKind;
  item: Item;
};

type AppRow = {
  key: string;
  instance: string;
  application: string;
  namespace: string;
  managedBy: string;
  version: string;
  oldestCreated: string | undefined;
  status: string;
  statusKind: StatusKind;
  // Used to open the detail panel — points to the first/oldest workload.
  detailHref: string;
};

type SortKey = "instance" | "application" | "namespace" | "managedBy" | "version" | "age" | "status";

const APP_NAME = "app.kubernetes.io/name";
const APP_INSTANCE = "app.kubernetes.io/instance";
const APP_MANAGED_BY = "app.kubernetes.io/managed-by";
const APP_VERSION = "app.kubernetes.io/version";

export function ApplicationsPage() {
  const cluster = useApp((s) => s.cluster);
  const namespace = useApp((s) => s.namespace);
  const namespaces = useApp((s) => s.namespaces);
  const search = useApp((s) => s.search);
  const [, setSearchParams] = useSearchParams();
  const selectedNamespaces = namespaces.length > 0 ? namespaces : (namespace ? [namespace] : []);
  const ns = selectedNamespaces.length > 0 ? selectedNamespaces : undefined;

  const deployments = useResourceList(cluster, "apps/v1/Deployment", ns);
  const statefulSets = useResourceList(cluster, "apps/v1/StatefulSet", ns);
  const daemonSets = useResourceList(cluster, "apps/v1/DaemonSet", ns);

  const [localSearch, setLocalSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "instance", dir: 1 });
  const [now, setNow] = useState(clusterNow());

  useEffect(() => {
    const t = window.setInterval(() => setNow(clusterNow()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const rows = useMemo(() => buildRows(deployments.items, statefulSets.items, daemonSets.items),
    [deployments.items, statefulSets.items, daemonSets.items]);

  const filtered = useMemo(() => {
    const needles = [search, localSearch]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (needles.length === 0) return rows;
    return rows.filter((r) => {
      const hay = `${r.instance}${r.application}${r.namespace}${r.managedBy}${r.version}`.toLowerCase();
      return needles.every((n) => hay.includes(n));
    });
  }, [rows, search, localSearch]);

  const sorted = useMemo(() => {
    const arr = filtered.slice();
    arr.sort((a, b) => compareRows(a, b, sort.key, sort.dir, now));
    return arr;
  }, [filtered, sort, now]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 36,
    overscan: 16,
  });

  const openInPanel = useCallback((href: string) => {
    const ref = hrefToQuery(href);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = next.get("d");
      if (current === ref) {
        next.delete("d");
        next.delete("tab");
      } else {
        next.set("d", ref);
        next.delete("tab");
      }
      return next;
    });
  }, [setSearchParams]);

  const error = deployments.error ?? statefulSets.error ?? daemonSets.error;
  const ready = deployments.ready && statefulSets.ready && daemonSets.ready;
  const totalLabel = `${sorted.length.toLocaleString()} ${sorted.length === 1 ? "item" : "items"}`;

  const onHeaderClick = (key: SortKey) => {
    setSort((s) => s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 });
  };

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight shrink-0">Applications</h1>
        <span className="chip">workloads grouped by app.kubernetes.io/instance</span>
        <div className="ml-auto relative w-[min(360px,40vw)]">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
          <input
            className="input h-8 w-full pl-7 pr-8"
            placeholder="Search Application Instances..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
          />
          {localSearch && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute"
              aria-label="Clear local search"
              title="Clear local search"
              onClick={() => setLocalSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </header>

      <div className="px-4 py-2 border-b border-line text-xs text-fg-mute flex items-center gap-2">
        <span>{totalLabel}</span>
        {!ready && <span className="text-fg-mute">· loading…</span>}
        {error && <span className="text-bad ml-2">{error}</span>}
      </div>

      <ColumnHeader sort={sort} onClick={onHeaderClick} />

      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto">
        {sorted.length === 0 && ready && (
          <div className="px-4 py-6 text-fg-mute text-sm">No applications match the current filter.</div>
        )}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vrow) => {
            const r = sorted[vrow.index];
            return (
              <div
                key={r.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vrow.start}px)`,
                  height: vrow.size,
                }}
              >
                <Row row={r} now={now} onOpen={() => openInPanel(r.detailHref)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ColumnHeader({
  sort, onClick,
}: { sort: { key: SortKey; dir: 1 | -1 }; onClick: (k: SortKey) => void }) {
  const cell = (key: SortKey, label: string, extraClass: string) => (
    <button
      className={clsx(
        "h-8 inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-fg-mute hover:text-fg",
        extraClass,
      )}
      onClick={() => onClick(key)}
    >
      <span>{label}</span>
      {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
  return (
    <div className="grid border-b border-line bg-bg-soft px-4" style={{ gridTemplateColumns: ROW_GRID }}>
      {cell("instance",   "Instance",   "justify-start")}
      {cell("application","Application","justify-start")}
      {cell("namespace",  "Namespace",  "justify-start")}
      {cell("managedBy",  "Managed By", "justify-start")}
      {cell("version",    "Version",    "justify-start")}
      {cell("age",        "Age",        "justify-end")}
      {cell("status",     "Status",     "justify-end")}
    </div>
  );
}

function Row({ row, now, onOpen }: { row: AppRow; now: number; onOpen: () => void }) {
  return (
    <button
      className="grid w-full text-sm items-center px-4 h-9 border-b border-line/60 hover:bg-bg-mute/60 text-left"
      style={{ gridTemplateColumns: ROW_GRID }}
      onClick={onOpen}
      title={row.instance}
    >
      <span className="truncate font-medium text-fg">{row.instance || "—"}</span>
      <span className="truncate text-fg-soft">{row.application || "—"}</span>
      <span className="truncate text-fg-soft">{row.namespace || "—"}</span>
      <span className="truncate text-fg-soft">{row.managedBy || "—"}</span>
      <span className="truncate text-fg-soft">{row.version || "—"}</span>
      <span className="text-right font-mono text-xs text-fg-mute">{age(row.oldestCreated, now)}</span>
      <span className="text-right">
        <span className={chipClass(row.statusKind)}>{row.status}</span>
      </span>
    </button>
  );
}

const ROW_GRID =
  "minmax(220px, 2fr) minmax(180px, 2fr) minmax(140px, 1fr) minmax(110px, 0.8fr) minmax(90px, 0.6fr) 80px 110px";

function chipClass(kind: StatusKind): string {
  switch (kind) {
    case "ok": return "chip-ok";
    case "warn": return "chip-warn";
    case "bad": return "chip-bad";
    case "info": return "chip-info";
    default: return "chip";
  }
}

function buildRows(deployments: Item[], statefulSets: Item[], daemonSets: Item[]): AppRow[] {
  const groups = new Map<string, { ns: string; instance: string; entries: WorkloadEntry[] }>();
  const ungrouped: WorkloadEntry[] = [];

  const push = (kind: WorkloadKind, items: Item[]) => {
    for (const item of items) {
      const labels = item.metadata.labels ?? {};
      const instance = labels[APP_INSTANCE] ?? labels[APP_NAME];
      const ns = item.metadata.namespace ?? "";
      if (instance) {
        const key = `${ns}${instance}`;
        let g = groups.get(key);
        if (!g) {
          g = { ns, instance, entries: [] };
          groups.set(key, g);
        }
        g.entries.push({ kind, item });
      } else {
        ungrouped.push({ kind, item });
      }
    }
  };

  push("Deployment", deployments);
  push("StatefulSet", statefulSets);
  push("DaemonSet", daemonSets);

  const out: AppRow[] = [];

  for (const g of groups.values()) {
    const oldest = g.entries.reduce<WorkloadEntry | null>((prev, e) => {
      if (!prev) return e;
      const a = new Date(prev.item.metadata.creationTimestamp ?? 0).getTime();
      const b = new Date(e.item.metadata.creationTimestamp ?? 0).getTime();
      return b < a ? e : prev;
    }, null);
    const labels = oldest?.item.metadata.labels ?? {};
    const status = rollupStatus(g.entries);
    out.push({
      key: `g:${g.ns}:${g.instance}`,
      instance: g.instance,
      application: labels[APP_NAME] ?? g.instance,
      namespace: g.ns,
      managedBy: labels[APP_MANAGED_BY] ?? "",
      version: labels[APP_VERSION] ?? "",
      oldestCreated: oldest?.item.metadata.creationTimestamp,
      status: status.label,
      statusKind: status.kind,
      detailHref: workloadHref(oldest!),
    });
  }

  for (const e of ungrouped) {
    const labels = e.item.metadata.labels ?? {};
    const status = rollupStatus([e]);
    out.push({
      key: `s:${e.kind}:${e.item.metadata.uid}`,
      instance: e.item.metadata.name,
      application: labels[APP_NAME] ?? e.item.metadata.name,
      namespace: e.item.metadata.namespace ?? "",
      managedBy: labels[APP_MANAGED_BY] ?? "",
      version: labels[APP_VERSION] ?? "",
      oldestCreated: e.item.metadata.creationTimestamp,
      status: status.label,
      statusKind: status.kind,
      detailHref: workloadHref(e),
    });
  }

  return out;
}

function rollupStatus(entries: WorkloadEntry[]): { label: string; kind: StatusKind } {
  // The "worst" status across all owned workloads wins. Order from worst to
  // best so a single failing Deployment doesn't get hidden behind a healthy
  // sibling DaemonSet.
  let label = "Running";
  let kind: StatusKind = "ok";
  let scaledZeroOnly = true;
  for (const e of entries) {
    const s = workloadStatus(e);
    if (severity(s.kind) > severity(kind)) {
      label = s.label;
      kind = s.kind;
    }
    if (s.label !== "Scaled: 0") scaledZeroOnly = false;
  }
  if (scaledZeroOnly) return { label: "Scaled: 0", kind: "mute" };
  return { label, kind };
}

function severity(k: StatusKind): number {
  switch (k) {
    case "bad":  return 4;
    case "warn": return 3;
    case "info": return 2;
    case "mute": return 1;
    default:     return 0;
  }
}

function workloadStatus(entry: WorkloadEntry): { label: string; kind: StatusKind } {
  const it = entry.item;
  if (entry.kind === "Deployment" || entry.kind === "StatefulSet") {
    const desired = it.spec?.replicas ?? it.status?.replicas ?? 0;
    const ready = it.status?.readyReplicas ?? it.status?.availableReplicas ?? 0;
    if (desired === 0) return { label: "Scaled: 0", kind: "mute" };
    if (ready >= desired) return { label: "Running", kind: "ok" };
    if (ready > 0) return { label: "Updating", kind: "warn" };
    return { label: "Pending", kind: "warn" };
  }
  // DaemonSet
  const desired = it.status?.desiredNumberScheduled ?? 0;
  const ready = it.status?.numberReady ?? 0;
  if (desired === 0) return { label: "Scaled: 0", kind: "mute" };
  if (ready >= desired) return { label: "Running", kind: "ok" };
  if (ready > 0) return { label: "Updating", kind: "warn" };
  return { label: "Pending", kind: "warn" };
}

function workloadHref(entry: WorkloadEntry): string {
  const ns = entry.item.metadata.namespace ?? "";
  const name = entry.item.metadata.name;
  const resource = entry.kind === "Deployment"
    ? "deployments"
    : entry.kind === "StatefulSet" ? "statefulsets" : "daemonsets";
  return `resource/apps/v1/${resource}/ns/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;
}

function compareRows(a: AppRow, b: AppRow, key: SortKey, dir: 1 | -1, now: number): number {
  const get = (r: AppRow): string | number => {
    switch (key) {
      case "instance":    return r.instance.toLowerCase();
      case "application": return r.application.toLowerCase();
      case "namespace":   return r.namespace.toLowerCase();
      case "managedBy":   return r.managedBy.toLowerCase();
      case "version":     return r.version.toLowerCase();
      case "age":         return -(r.oldestCreated ? new Date(r.oldestCreated).getTime() : 0);
      case "status":      return r.status.toLowerCase();
    }
  };
  void now;
  const av = get(a);
  const bv = get(b);
  if (av < bv) return -dir;
  if (av > bv) return  dir;
  return 0;
}
