// NodeMetrics — Lens-style tabbed metric panel for a Node. Sibling of
// WorkloadMetrics: same look, same Prometheus/metrics-server fallback
// philosophy, but node-exporter queries instead of cAdvisor ones.
//
// Tabs:
//   CPU     · always available (Prom node-exporter + metrics-server fallback)
//   Memory  · always available (Prom node-exporter + metrics-server fallback)
//   Disk    · Prom only (node_filesystem_*; metrics-server has no disk)
//
// Prometheus node-exporter series are keyed by `instance` (host:port), which
// is not the Kubernetes node name. We bridge that with `node_uname_info`,
// which carries both `instance` and `nodename`, joining on `instance`. The
// CPU/Memory tabs also overlay the node's allocatable budget as a dashed
// reference line so an operator sees headroom at a glance.

import { useEffect, useMemo, useRef, useState } from "react";
import { Cpu, HardDrive, MemoryStick, type LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api, type PromResponse } from "../../lib/api";
import { useEffectiveMetricsSource } from "../../lib/podMetrics";
import { cpuToMillicores, memToBytes } from "../../lib/format";
import { useApp } from "../../stores/app";
import { AreaChart, type Point, type RefLine } from "./AreaChart";

const RANGE_SEC = 60 * 60; // 1 h
const STEP_SEC = 30;
const CHART_HEIGHT = 160;

type TabId = "cpu" | "memory" | "disk";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "cpu", label: "CPU", icon: Cpu },
  { id: "memory", label: "Memory", icon: MemoryStick },
  { id: "disk", label: "Disk", icon: HardDrive },
];

export function NodeMetrics({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const node: string = obj?.metadata?.name ?? "";
  const source = useEffectiveMetricsSource(cluster);
  const promReady = source === "prometheus";
  const [tab, setTab] = useState<TabId>("cpu");

  if (obj?.kind !== "Node" || !node || !cluster) return null;

  // Disk has no metrics-server equivalent — it needs Prometheus. CPU/Memory
  // work from either source.
  const tabAvailable = (id: TabId): boolean =>
    id === "disk" ? promReady : source !== "none";
  const activeAvailable = tabAvailable(tab);

  return (
    <div className="rounded-md border border-line bg-bg-soft">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line">
        <div className="flex items-center gap-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const enabled = tabAvailable(t.id);
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                disabled={!enabled}
                title={enabled ? t.label : `${t.label} requires Prometheus`}
                onClick={() => setTab(t.id)}
                className={clsx(
                  "h-7 px-2 inline-flex items-center gap-1.5 rounded text-[11px] tracking-wide transition-colors",
                  active && "bg-bg text-fg border border-line",
                  !active && enabled && "text-fg-soft hover:text-fg hover:bg-bg-mute",
                  !enabled && "text-fg-mute/60 cursor-not-allowed",
                )}
              >
                <Icon size={12} />
                {t.label}
              </button>
            );
          })}
        </div>
        <span
          className={clsx(
            "ml-auto text-[10px] tracking-wide px-1.5 py-0.5 rounded border",
            source === "prometheus"
              ? "border-info/40 bg-info/10 text-info"
              : source === "metrics-server"
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-line text-fg-mute",
          )}
        >
          {source === "prometheus" ? "prometheus" : source === "metrics-server" ? "metrics-server" : "no metrics"}
        </span>
      </div>

      <div className="px-3 pt-3 pb-6 min-h-[180px]">
        {!activeAvailable ? (
          <UnavailableTab
            tab={tab}
            reason={source === "none" ? "metrics disabled in cluster Settings" : "this metric needs Prometheus"}
          />
        ) : tab === "disk" ? (
          <DiskPanel cluster={cluster} node={node} obj={obj} />
        ) : (
          <CpuMemPanel cluster={cluster} node={node} obj={obj} metric={tab} promReady={promReady} />
        )}
      </div>
    </div>
  );
}

function UnavailableTab({ tab, reason }: { tab: TabId; reason: string }) {
  return (
    <div className="grid place-items-center text-xs text-fg-mute h-[140px] border border-dashed border-line/60 rounded">
      <div className="text-center">
        <div className="text-fg-soft text-sm capitalize mb-1">{tab}</div>
        <div>{reason}</div>
      </div>
    </div>
  );
}

// --- CPU / Memory ----------------------------------------------------

function CpuMemPanel({
  cluster, node, obj, metric, promReady,
}: { cluster: string; node: string; obj: any; metric: "cpu" | "memory"; promReady: boolean }) {
  const refLines = useMemo<RefLine[]>(() => nodeRefLines(obj, metric), [obj, metric]);
  return promReady ? (
    <PromNodeSeries cluster={cluster} node={node} metric={metric} refLines={refLines} />
  ) : (
    <FallbackNodeSeries cluster={cluster} node={node} metric={metric} refLines={refLines} />
  );
}

function PromNodeSeries({
  cluster, node, metric, refLines,
}: { cluster: string; node: string; metric: "cpu" | "memory"; refLines: RefLine[] }) {
  const win = useWindow();
  const q = metric === "cpu" ? promCPUQuery(node) : promMemQuery(node);
  const result = useQuery({
    queryKey: ["node-metric", cluster, metric, node, win.start, win.end],
    queryFn: () => api.promQueryRange(cluster, q, win.start, win.end, `${STEP_SEC}s`),
    refetchInterval: 30_000,
    retry: false,
  });
  const points = toPoints(result.data);
  const fmt = metric === "cpu" ? formatCores : formatBytes;
  return (
    <PanelChart
      title={metric === "cpu" ? "CPU" : "Memory"}
      unit={metric === "cpu" ? "cores" : "bytes"}
      points={points}
      loading={result.isLoading}
      error={result.error as Error | null}
      formatY={fmt}
      window={win}
      refLines={refLines}
    />
  );
}

// metrics-server fallback: poll the node's instantaneous usage and build a
// rolling live window, mirroring WorkloadMetrics' FallbackTimeSeries.
const FALLBACK_HISTORY = 240;
const FALLBACK_INTERVAL = 5_000;

type FallbackSample = { t: number; cpu: number; mem: number };

function FallbackNodeSeries({
  cluster, node, metric, refLines,
}: { cluster: string; node: string; metric: "cpu" | "memory"; refLines: RefLine[] }) {
  const samplesRef = useRef<FallbackSample[]>([]);
  const [, force] = useState(0);

  const query = useQuery({
    queryKey: ["node-metric-fallback", cluster],
    queryFn: () => api.nodeMetrics(cluster),
    refetchInterval: FALLBACK_INTERVAL,
    retry: false,
  });

  useEffect(() => {
    samplesRef.current = [];
    force((n) => n + 1);
  }, [cluster, node]);

  useEffect(() => {
    if (!query.data) return;
    const row = (query.data.items ?? []).find((it: any) => it?.metadata?.name === node);
    if (!row) return;
    const arr = samplesRef.current.slice();
    const t = Math.floor(Date.now() / 1000);
    if (arr.length === 0 || arr[arr.length - 1].t !== t) {
      arr.push({ t, cpu: cpuToMillicores(row.usage?.cpu), mem: memToBytes(row.usage?.memory) });
      if (arr.length > FALLBACK_HISTORY) arr.splice(0, arr.length - FALLBACK_HISTORY);
      samplesRef.current = arr;
      force((n) => n + 1);
    }
  }, [query.data, node]);

  const samples = samplesRef.current;
  const points: Point[] = samples.map((s) => ({
    t: s.t,
    v: metric === "cpu" ? s.cpu / 1000 : s.mem, // cpu millicores → cores
  }));
  const win = samples.length > 0
    ? { start: samples[0].t, end: samples[samples.length - 1].t }
    : { start: Math.floor(Date.now() / 1000) - 60, end: Math.floor(Date.now() / 1000) };

  return (
    <PanelChart
      title={metric === "cpu" ? "CPU" : "Memory"}
      unit={metric === "cpu" ? "cores" : "bytes"}
      points={points}
      loading={false}
      error={query.error as Error | null}
      formatY={metric === "cpu" ? formatCores : formatBytes}
      window={win}
      refLines={refLines}
      windowLabelOverride={`live · last ${Math.max(1, Math.round((win.end - win.start) / 60))} min`}
      emptyText="Collecting live samples from metrics-server… first points appear in ~5 s"
    />
  );
}

// --- Disk (Prometheus only) ------------------------------------------

function DiskPanel({ cluster, node, obj }: { cluster: string; node: string; obj: any }) {
  const win = useWindow();
  const result = useQuery({
    queryKey: ["node-metric", cluster, "disk", node, win.start, win.end],
    queryFn: () => api.promQueryRange(cluster, promDiskQuery(node), win.start, win.end, `${STEP_SEC}s`),
    refetchInterval: 30_000,
    retry: false,
  });
  const capacity = memToBytes(obj?.status?.capacity?.["ephemeral-storage"]);
  const refLines = useMemo<RefLine[]>(
    () => (capacity > 0 ? [{ value: capacity, label: "ephemeral capacity", tone: "warn" }] : []),
    [capacity],
  );
  return (
    <PanelChart
      title="Disk"
      unit="bytes"
      points={toPoints(result.data)}
      loading={result.isLoading}
      error={result.error as Error | null}
      formatY={formatBytes}
      window={win}
      refLines={refLines}
    />
  );
}

// --- shared chart panel ----------------------------------------------

function PanelChart({
  title, unit, points, loading, error, formatY, window: w, refLines, windowLabelOverride, emptyText,
}: {
  title: string;
  unit: string;
  points: Point[];
  loading: boolean;
  error: Error | null;
  formatY: (v: number) => string;
  window: { start: number; end: number };
  refLines?: RefLine[];
  windowLabelOverride?: string;
  emptyText?: string;
}) {
  return (
    <div>
      <div className="flex items-center mb-2 text-[11px]">
        <div className="uppercase tracking-wider text-fg-mute font-semibold">{title}</div>
        <div className="ml-auto text-fg-mute">{windowLabelOverride ?? "last 1 h"} · {unit}</div>
      </div>
      <div style={{ height: CHART_HEIGHT }} className="relative">
        {error ? (
          <div className="absolute inset-0 flex items-start rounded-md border border-bad/40 bg-bad/10 text-bad text-xs px-3 py-2 overflow-auto">
            <span className="break-words">{error.message ?? "query failed"}</span>
          </div>
        ) : (
          <AreaChart
            points={points}
            height={CHART_HEIGHT}
            loading={loading}
            formatY={formatY}
            xTicks={makeXTicks(w.start, w.end)}
            emptyText={emptyText ?? "No samples"}
            refLines={refLines}
          />
        )}
      </div>
    </div>
  );
}

// --- PromQL ----------------------------------------------------------

// node_uname_info carries both `instance` and `nodename`; joining on
// `instance` rewrites node-exporter series to be addressable by node name.
function unameJoin(node: string): string {
  return `* on(instance) group_left(nodename) node_uname_info{nodename="${esc(node)}"}`;
}

function promCPUQuery(node: string): string {
  return `sum(rate(node_cpu_seconds_total{mode!="idle"}[2m]) ${unameJoin(node)})`;
}

function promMemQuery(node: string): string {
  return `sum((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) ${unameJoin(node)})`;
}

function promDiskQuery(node: string): string {
  const fs = `fstype!~"tmpfs|overlay|squashfs|ramfs"`;
  return `sum((node_filesystem_size_bytes{${fs}} - node_filesystem_avail_bytes{${fs}}) ${unameJoin(node)})`;
}

// --- helpers ---------------------------------------------------------

function nodeRefLines(obj: any, metric: "cpu" | "memory"): RefLine[] {
  const alloc = obj?.status?.allocatable ?? {};
  const value = metric === "cpu"
    ? cpuToMillicores(alloc.cpu) / 1000
    : memToBytes(alloc.memory);
  return value > 0 ? [{ value, label: "allocatable", tone: "info" }] : [];
}

function useWindow() {
  const [bucket, setBucket] = useState(() => Math.floor(Date.now() / (STEP_SEC * 1000)));
  useEffect(() => {
    const t = window.setInterval(() => {
      setBucket(Math.floor(Date.now() / (STEP_SEC * 1000)));
    }, STEP_SEC * 1000);
    return () => window.clearInterval(t);
  }, []);
  return useMemo(() => {
    const end = bucket * STEP_SEC;
    return { start: end - RANGE_SEC, end };
  }, [bucket]);
}

function toPoints(resp?: PromResponse): Point[] {
  const series = resp?.data?.result;
  if (!series || series.length === 0) return [];
  const values = series[0]?.values ?? [];
  const points: Point[] = [];
  for (const [t, v] of values) {
    const ts = Number(t);
    const val = Number(v);
    if (Number.isFinite(ts) && Number.isFinite(val)) points.push({ t: ts, v: val });
  }
  return points;
}

function makeXTicks(start: number, end: number): { x: number; label: string }[] {
  const total = end - start;
  return [0, 0.33, 0.66, 1].map((p) => {
    const t = start + Math.round(total * p);
    return { x: t, label: shortTime(t) };
  });
}

function shortTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatCores(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  const m = v * 1000;
  if (m >= 10) return `${m.toFixed(0)}m`;
  if (m >= 1) return `${m.toFixed(1)}m`;
  if (m >= 0.01) return `${m.toFixed(2)}m`;
  return "~0m";
}

function formatBytes(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GiB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KiB`;
  return `${v.toFixed(0)} B`;
}

function esc(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}
