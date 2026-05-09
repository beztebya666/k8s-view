// Cluster Overview — Lens-style. Toolbar with scope (Worker/Master) +
// time-range + chart-metric (CPU/Memory) toggles, big time-series area
// chart on the left, three concentric Usage/Requests/Limits/Allocatable/
// Capacity donuts on the right (CPU, Memory, Pods), warnings table at the
// bottom. Prometheus is preferred for usage; metrics-server is the
// fallback when not detected.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { AlertTriangle, Cpu, HardDrive, Info } from "lucide-react";
import { useApp } from "../stores/app";
import { useResourceList } from "../lib/useResourceList";
import { bytes, formatMillicores } from "../lib/format";
import { usePrometheusInfo } from "../lib/podMetrics";
import {
  RANGE_OPTIONS,
  filterNodesByScope,
  useClusterTotals,
  useFallbackUsageSeries,
  useUsageSeries,
  type RangeId,
  type Scope,
  type SeriesKind,
} from "../lib/clusterMetrics";
import { Donut, type DonutRing } from "../components/charts/Donut";
import { AreaChart, type Series } from "../components/charts/AreaChart";
import { hrefToQuery } from "../components/DetailPanel";
import { Select as KvSelect } from "../components/Select";
import { useSearchParams } from "react-router-dom";

const SCOPE_OPTIONS: Array<{ id: Scope; label: string }> = [
  { id: "worker", label: "Worker Nodes" },
  { id: "master", label: "Master Nodes" },
];

export function OverviewPage() {
  const cluster = useApp((s) => s.cluster);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [scope, setScope] = useState<Scope>("master");
  const [range, setRange] = useState<RangeId>("1h");
  const [chartMetric, setChartMetric] = useState<SeriesKind>("cpu");

  const promInfo = usePrometheusInfo(cluster);
  const promDetected = promInfo.data?.detected === true;
  const promReason = promInfo.data?.detected === false ? promInfo.data.reason : null;

  const nodes = useResourceList(cluster, "/v1/Node", undefined);
  const pods = useResourceList(cluster, "/v1/Pod", undefined);
  const events = useResourceList(cluster, "/v1/Event", undefined);

  const scopedNodes = useMemo(() => filterNodesByScope(nodes.items, scope), [nodes.items, scope]);
  const scopedNodeNames = useMemo(
    () => scopedNodes.map((n) => n.metadata?.name).filter(Boolean) as string[],
    [scopedNodes],
  );

  const { totals, source } = useClusterTotals(cluster, nodes.items, pods.items, scope);
  const series = useUsageSeries(cluster, scope, scopedNodeNames, chartMetric, range);
  // Mirror the Prom range-series with a metrics-server fallback that
  // accumulates live samples in memory. The chart shows whichever series
  // matches the active source so the panel is never empty when a metrics
  // source exists. We also fall through Prom → fallback when Prom is
  // detected but the range query returned no data (e.g. cAdvisor labels
  // don't match our scoped queries) — that's the same regression the
  // donuts have, just on the chart side.
  const scopedNodeSet = useMemo(() => new Set(scopedNodeNames), [scopedNodeNames]);
  const promPoints = series.data ?? [];
  const usingPromChart = source === "prometheus" && promPoints.length > 0;
  // Only enable the live-sample fallback on a Prom cluster when Prom's
  // range query has actually returned empty — otherwise we'd double-poll
  // metrics-server while Prom is doing its job.
  const promEmpty = source === "prometheus" && series.isFetched && promPoints.length === 0;
  const fallbackSeries = useFallbackUsageSeries(cluster, scope, scopedNodeSet, chartMetric, promEmpty);
  const chartPoints = usingPromChart ? promPoints : fallbackSeries.data;
  // For the metrics-server fallback we never enter the AreaChart "loading"
  // branch — there is no terminal "done" state, samples just trickle in.
  // Keep the loading flag tied to React Query only for the Prometheus path
  // so the fallback's emptyText ("Collecting live samples…") shows while
  // the buffer is empty instead of a forever-spinner.
  const chartLoading = usingPromChart ? series.isLoading : false;

  const warnings = useMemo(
    () => events.items.filter((e: any) => e.type === "Warning")
      .sort((a: any, b: any) => eventTime(b) - eventTime(a))
      .slice(0, 60),
    [events.items],
  );
  const warningTotal = useMemo(
    () => events.items.reduce((n, e: any) => n + (e.type === "Warning" ? 1 : 0), 0),
    [events.items],
  );

  const openInPanel = (href: string) => {
    const ref = hrefToQuery(href);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", ref);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3 shrink-0">
        <h1 className="text-lg font-medium tracking-tight shrink-0">Cluster overview</h1>
        <span className="chip normal-case">{cluster}</span>
        <div className="ml-2 flex items-center gap-2">
          <Select<Scope> value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
          <Select<RangeId>
            value={range}
            onChange={setRange}
            options={RANGE_OPTIONS.map((r) => ({ id: r.id, label: r.label }))}
          />
          <SegmentedToggle
            value={chartMetric}
            onChange={setChartMetric}
            options={[
              { id: "cpu", label: "CPU", icon: Cpu },
              { id: "memory", label: "Memory", icon: HardDrive },
            ]}
          />
          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-line text-fg-mute hover:text-fg hover:bg-bg-mute"
            title={
              promDetected
                ? `Currently used metrics source: Prometheus (${promInfo.data?.detected && (promInfo.data as any).namespace}/${promInfo.data?.detected && (promInfo.data as any).service})`
                : `Currently used metrics source: metrics-server. ${promReason ?? "Prometheus not detected"}`
            }
            aria-label="Metrics source"
          >
            <Info size={14} />
          </button>
        </div>
        <div className="ml-auto">
          <SourceBadge source={source} promDetected={promDetected} />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_640px] gap-4 p-4">
          <section className="border border-line bg-bg-soft rounded p-4">
            <div className="mb-2 flex items-center text-xs text-fg-mute">
              <span className="font-medium text-fg-soft">{chartMetric === "cpu" ? "CPU usage" : "Memory usage"}</span>
              <span className="ml-2">·</span>
              <span className="ml-2">{rangeLabel(range)}</span>
              <span className="ml-2">·</span>
              <span className="ml-2">{scope === "worker" ? "Worker nodes" : "Master nodes"}</span>
            </div>
            <AreaChart
              points={chartPoints}
              loading={chartLoading}
              formatY={chartMetric === "cpu" ? formatMillicores : (v) => bytes(v)}
              emptyText={
                source === "none"
                  ? "Configure a metrics source in cluster Settings"
                  : usingPromChart
                    ? "No samples in the selected range"
                    : promDetected
                      ? "Prometheus returned no scoped samples — collecting live metrics-server fallback…"
                      : "Collecting live samples from metrics-server… first points appear in ~30 s"
              }
            />
          </section>

          <section className="grid grid-cols-3 gap-3">
            <DonutCard
              title="CPU"
              format={formatMillicores}
              totals={totals.cpu}
              kind="cpu"
            />
            <DonutCard
              title="Memory"
              format={bytes}
              totals={totals.memory}
              kind="memory"
            />
            <DonutCard
              title="Pods"
              format={(n) => n.toLocaleString()}
              totals={{
                usage: totals.pods.usage,
                requests: 0,
                limits: 0,
                allocatable: totals.pods.allocatable,
                capacity: totals.pods.capacity,
              }}
              kind="pods"
            />
          </section>
        </div>

        <section className="px-4 pb-4">
          <CountsOverTimeCard
            cluster={cluster}
            scope={scope}
            podsCount={pods.items.length}
            nodesCount={scopedNodes.length}
          />
        </section>

        <section className="px-4 pb-4">
          <div className="border border-line bg-bg-soft rounded">
            <div className="h-12 px-4 flex items-center gap-2 border-b border-line">
              <AlertTriangle size={14} className={warningTotal > 0 ? "text-warn" : "text-fg-mute"} />
              <span className="text-sm font-medium text-fg">Warnings</span>
              <span className="text-xs text-fg-mute">
                ({warnings.length.toLocaleString()} of {warningTotal.toLocaleString()})
              </span>
              {events.error && <span className="text-xs text-bad">{events.error}</span>}
              <button
                type="button"
                className="ml-auto text-xs text-accent hover:underline"
                onClick={() => navigate(clusterHref(cluster, "events"))}
              >
                View all events →
              </button>
            </div>
            <WarningsTable
              cluster={cluster}
              events={warnings}
              onOpen={openInPanel}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

// --- Counts-over-time chart ------------------------------------------

// Module-scoped sample buffer per (cluster, scope). Survives navigation
// across routes within one session — return to Overview and the chart is
// already populated. Caps per-key at COUNTS_HISTORY_LEN samples (~3 hours
// at the 60-second sample rate).
const COUNTS_HISTORY_LEN = 180;
const COUNTS_INTERVAL_MS = 60_000;
type CountsSample = { t: number; pods: number; nodes: number };
const countsHistory = new Map<string, CountsSample[]>();

function countsKey(cluster: string, scope: Scope): string {
  return `${cluster}|${scope}`;
}

function useCountsHistory(cluster: string, scope: Scope, pods: number, nodes: number): CountsSample[] {
  const key = countsKey(cluster, scope);
  const [, force] = useState(0);
  useEffect(() => {
    if (!cluster) return;
    const tick = () => {
      const arr = (countsHistory.get(key) ?? []).slice();
      const t = Math.floor(Date.now() / 1000);
      arr.push({ t, pods, nodes });
      if (arr.length > COUNTS_HISTORY_LEN) arr.splice(0, arr.length - COUNTS_HISTORY_LEN);
      countsHistory.set(key, arr);
      force((n) => n + 1);
    };
    tick(); // immediate first sample so the chart isn't empty for a minute
    const id = window.setInterval(tick, COUNTS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [cluster, key, pods, nodes]);
  return countsHistory.get(key) ?? [];
}

function CountsOverTimeCard({
  cluster, scope, podsCount, nodesCount,
}: { cluster: string; scope: Scope; podsCount: number; nodesCount: number }) {
  const samples = useCountsHistory(cluster, scope, podsCount, nodesCount);
  const podsColor = "rgb(var(--accent))";
  const nodesColor = "rgb(var(--ok))";
  const series = useMemo<Series[]>(() => [
    { label: "Pods", color: podsColor, points: samples.map((s) => ({ t: s.t, v: s.pods })) },
    { label: "Nodes", color: nodesColor, points: samples.map((s) => ({ t: s.t, v: s.nodes })) },
  ], [samples]);
  return (
    <div className="border border-line bg-bg-soft rounded p-4">
      <div className="mb-2 flex items-center text-xs text-fg-mute">
        <span className="font-medium text-fg-soft">Pods &amp; Nodes over time</span>
        <span className="ml-2">·</span>
        <span className="ml-2">live</span>
        <span className="ml-2">·</span>
        <span className="ml-2">{scope === "worker" ? "Worker scope" : "Master scope"}</span>
      </div>
      <AreaChart
        height={140}
        series={series}
        formatY={(v) => Math.round(v).toLocaleString()}
        emptyText="Sampling… first point appears immediately, history grows by the minute"
      />
      <div className="flex items-center justify-center gap-3 mt-1.5 text-[10px] text-fg-mute">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded-sm" style={{ background: podsColor }} />
          Pods ({podsCount.toLocaleString()})
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded-sm" style={{ background: nodesColor }} />
          Nodes ({nodesCount.toLocaleString()})
        </span>
      </div>
    </div>
  );
}

function DonutCard({
  title,
  totals,
  format,
  kind,
}: {
  title: string;
  totals: { usage: number; requests: number; limits: number; allocatable: number; capacity: number };
  format: (n: number) => string;
  kind: "cpu" | "memory" | "pods";
}) {
  const isPods = kind === "pods";
  const max = Math.max(totals.capacity, totals.allocatable, totals.limits, totals.requests, totals.usage, 1);
  const pct = totals.capacity > 0 ? (totals.usage / totals.capacity) * 100 : 0;

  // Colour-code each metric so the legend matches Lens.
  const usageColor   = "rgb(var(--accent))";
  const limitsColor  = "rgb(var(--info))";
  const requestsColor = "rgb(var(--ok))";
  const allocColor   = "rgb(var(--warn))";
  const capColor     = "rgb(var(--fg-mute))";

  const rings: DonutRing[] = isPods
    ? [
        { key: "capacity", label: "Capacity", value: totals.capacity, max, color: capColor },
        { key: "allocatable", label: "Allocatable", value: totals.allocatable, max, color: allocColor },
        { key: "usage", label: "Usage", value: totals.usage, max, color: usageColor },
      ]
    : [
        { key: "capacity", label: "Capacity", value: totals.capacity, max, color: capColor },
        { key: "allocatable", label: "Allocatable", value: totals.allocatable, max, color: allocColor },
        { key: "limits", label: "Limits", value: totals.limits, max, color: limitsColor },
        { key: "requests", label: "Requests", value: totals.requests, max, color: requestsColor },
        { key: "usage", label: "Usage", value: totals.usage, max, color: usageColor },
      ];

  return (
    <div className="border border-line bg-bg-soft rounded p-3 flex flex-col">
      <div className="text-center text-xs uppercase tracking-wide text-fg-mute">{title}</div>
      <div className="flex justify-center my-2">
        <Donut rings={rings} centerLabel={totals.capacity > 0 ? `${pct.toFixed(1)}%` : "—"} />
      </div>
      <div className="space-y-1 text-[11px]">
        {rings.slice().reverse().map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
            <span className="text-fg-soft">{r.label}:</span>
            <span className="ml-auto font-mono text-fg tabular-nums">{format(r.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ id: T; label: string }>;
}) {
  return (
    <KvSelect<T>
      value={value}
      onChange={onChange}
      buttonHeight={8}
      options={options.map((o) => ({ value: o.id, label: o.label }))}
    />
  );
}

function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ id: T; label: string; icon: any }>;
}) {
  return (
    <div className="h-8 inline-flex items-center rounded-md border border-line overflow-hidden">
      {options.map((o) => {
        const Icon = o.icon;
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            title={o.label}
            aria-pressed={active}
            className={clsx(
              "h-full px-2.5 inline-flex items-center gap-1.5 text-xs",
              active ? "bg-bg-mute text-fg" : "text-fg-mute hover:text-fg",
            )}
          >
            <Icon size={13} />
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SourceBadge({
  source,
  promDetected,
}: {
  source: "prometheus" | "metrics-server" | "none";
  promDetected: boolean;
}) {
  if (source === "prometheus") {
    return (
      <span className="chip normal-case border-ok/40 bg-ok/10 text-ok">
        Prometheus
      </span>
    );
  }
  if (source === "metrics-server") {
    return (
      <span className="chip normal-case border-warn/40 bg-warn/10 text-warn">
        metrics-server fallback
      </span>
    );
  }
  return (
    <span className="chip normal-case text-fg-mute">
      {promDetected ? "Loading metrics…" : "No metrics source"}
    </span>
  );
}

function WarningsTable({
  cluster,
  events,
  onOpen,
}: {
  cluster: string;
  events: any[];
  onOpen: (href: string) => void;
}) {
  if (events.length === 0) {
    return <div className="px-4 py-6 text-sm text-fg-mute text-center">No warnings</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="h-9 text-left text-[11px] uppercase tracking-wide text-fg-mute border-b border-line">
            <th className="px-4 font-medium">Message</th>
            <th className="px-3 font-medium w-[200px]">Object</th>
            <th className="px-3 font-medium w-[120px]">Type</th>
            <th className="px-3 font-medium text-right w-[90px]">Age</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const obj = e.involvedObject ?? {};
            const href = involvedHref(e);
            return (
              <tr key={e.metadata?.uid ?? `${obj.kind}/${obj.name}/${e.metadata?.creationTimestamp}`}
                  className="h-9 border-b border-line/60 hover:bg-bg-mute/60">
                <td className="px-4 max-w-[760px] truncate text-fg-soft" title={e.message ?? ""}>
                  {e.message ?? e.reason ?? "-"}
                </td>
                <td className="px-3 truncate text-fg-soft">
                  {href ? (
                    <button className="text-accent hover:underline truncate" onClick={() => onOpen(href)}>
                      {obj.name ?? "-"}
                    </button>
                  ) : (
                    obj.name ?? "-"
                  )}
                </td>
                <td className="px-3 text-fg-soft">{e.reason ?? "Event"}</td>
                <td className="px-3 text-right font-mono text-xs text-fg-mute">
                  {ageString(lastEventTime(e) ?? e.metadata?.creationTimestamp)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <span className="hidden">{cluster}</span>
    </div>
  );
}

function rangeLabel(id: RangeId): string {
  return RANGE_OPTIONS.find((r) => r.id === id)?.label ?? id;
}

function clusterHref(cluster: string, href: string): string {
  return `/${encodeURIComponent(cluster)}/${href.replace(/^\/+/, "")}`;
}

function eventTime(e: any): number {
  const stamp = lastEventTime(e) ?? e.metadata?.creationTimestamp;
  return stamp ? new Date(stamp).getTime() : 0;
}

function lastEventTime(e: any): string | undefined {
  return e.lastTimestamp ?? e.eventTime ?? e.series?.lastObservedTime ?? e.metadata?.creationTimestamp;
}

function ageString(stamp?: string): string {
  if (!stamp) return "—";
  const t = new Date(stamp).getTime();
  if (!Number.isFinite(t)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function involvedHref(e: any): string | null {
  const obj = e.involvedObject;
  if (!obj?.kind || !obj?.name) return null;
  const map: Record<string, { group: string; version: string; resource: string; namespaced: boolean }> = {
    Pod: { group: "core", version: "v1", resource: "pods", namespaced: true },
    Node: { group: "core", version: "v1", resource: "nodes", namespaced: false },
    Deployment: { group: "apps", version: "v1", resource: "deployments", namespaced: true },
    DaemonSet: { group: "apps", version: "v1", resource: "daemonsets", namespaced: true },
    StatefulSet: { group: "apps", version: "v1", resource: "statefulsets", namespaced: true },
    ReplicaSet: { group: "apps", version: "v1", resource: "replicasets", namespaced: true },
    Job: { group: "batch", version: "v1", resource: "jobs", namespaced: true },
    CronJob: { group: "batch", version: "v1", resource: "cronjobs", namespaced: true },
    HorizontalPodAutoscaler: { group: "autoscaling", version: "v2", resource: "horizontalpodautoscalers", namespaced: true },
  };
  const found = map[obj.kind];
  if (!found) return null;
  const name = encodeURIComponent(obj.name);
  if (found.namespaced) {
    const ns = encodeURIComponent(obj.namespace ?? e.metadata?.namespace ?? "default");
    return `resource/${found.group}/${found.version}/${found.resource}/ns/${ns}/${name}`;
  }
  return `resource/${found.group}/${found.version}/${found.resource}/${name}`;
}
