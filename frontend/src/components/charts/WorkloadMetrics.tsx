// WorkloadMetrics — Lens-style tabbed metric panel for Pods and pod-bearing
// workloads (Deployment / StatefulSet / DaemonSet / ReplicaSet / Job).
//
// Tabs:
//   CPU         · always available (Prom + metrics-server fallback)
//   Memory      · always available (Prom + metrics-server fallback)
//   Network     · Prom only (cAdvisor container_network_*_bytes_total)
//   Filesystem  · Prom only (container_fs_usage_bytes)
//
// The CPU/Memory tabs overlay dashed reference lines for the workload's
// aggregate requests/limits read from the live spec, so an operator can see
// "where am I against my budget" without leaving the page.
//
// Workload identification is regex-based on the pod-name pattern that the
// matching controller mints (`<deploy>-<rs>-<id>` etc.). It's intentionally
// approximate — getting it exact would need kube-state-metrics, which we
// don't require — but it's accurate enough for the "see the trend" use case.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, HardDrive, MemoryStick, MoreHorizontal, Network, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { api, type PromResponse } from "../../lib/api";
import { useEffectiveMetricsSource, usePrometheusInfo } from "../../lib/podMetrics";
import { cpuToMillicores, memToBytes } from "../../lib/format";
import { useApp } from "../../stores/app";
import { notify_ } from "../../lib/notifications";
import { copyToClipboard } from "../../lib/clipboard";
import { AreaChart, type Point, type RefLine, type Series } from "./AreaChart";

const SUPPORTED_KINDS = new Set([
  "Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job",
]);

const RANGE_SEC = 60 * 60;        // 1 h
const STEP_SEC = 30;
const CHART_HEIGHT = 160;

type TabId = "cpu" | "memory" | "network" | "filesystem";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "cpu",        label: "CPU",        icon: Cpu },
  { id: "memory",     label: "Memory",     icon: MemoryStick },
  { id: "network",    label: "Network",    icon: Network },
  { id: "filesystem", label: "Filesystem", icon: HardDrive },
];

export function WorkloadMetrics({ obj, container, hideTitle: _hideTitle }: { obj: any; container?: string; hideTitle?: boolean }) {
  const cluster = useApp((s) => s.cluster);
  const kind: string = obj?.kind ?? "";
  const ns: string = obj?.metadata?.namespace ?? "";
  const name: string = obj?.metadata?.name ?? "";
  const supported = SUPPORTED_KINDS.has(kind) && !!ns && !!name && !!cluster;

  const promInfo = usePrometheusInfo(cluster);
  const promReady = promInfo.data?.detected === true;
  const source = useEffectiveMetricsSource(cluster);

  const [tab, setTab] = useState<TabId>("cpu");
  // Latest rendered value of the active panel — populated by the panel
  // itself via this ref so the kebab "Copy latest value" action has
  // something to report without re-running the query.
  const latestRef = useRef<{ value: number; format: (v: number) => string } | null>(null);
  const setLatest = (value: number, format: (v: number) => string) => {
    latestRef.current = { value, format };
  };

  if (!supported) return null;

  // Disable tabs that have no data source available so the user doesn't
  // chase a dead end. Network/Filesystem only ever come from Prometheus
  // (metrics-server doesn't expose those); CPU/Memory work either way.
  const tabAvailable = (id: TabId): boolean => {
    if (id === "cpu" || id === "memory") return source !== "none";
    return promReady;
  };
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
        <div className="ml-auto flex items-center gap-2">
          <span className={clsx(
            "text-[10px] tracking-wide px-1.5 py-0.5 rounded border",
            source === "prometheus"
              ? "border-info/40 bg-info/10 text-info"
              : source === "metrics-server"
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-line text-fg-mute",
          )}>
            {source === "prometheus" ? "prometheus" : source === "metrics-server" ? "metrics-server" : "no metrics"}
          </span>
          <KebabMenu
            cluster={cluster}
            tab={tab}
            getLatest={() => latestRef.current}
          />
        </div>
      </div>

      <div className="px-3 pt-3 pb-6 min-h-[180px]">
        {!activeAvailable ? (
          <UnavailableTab tab={tab} reason={
            source === "none" ? "metrics disabled in cluster Settings" : "this metric needs Prometheus"
          } />
        ) : tab === "cpu" ? (
          <CpuPanel cluster={cluster} obj={obj} container={container} promReady={promReady} setLatest={setLatest} />
        ) : tab === "memory" ? (
          <MemoryPanel cluster={cluster} obj={obj} container={container} promReady={promReady} setLatest={setLatest} />
        ) : tab === "network" ? (
          <NetworkPanel cluster={cluster} kind={kind} ns={ns} name={name} container={container} setLatest={setLatest} />
        ) : (
          <FilesystemPanel cluster={cluster} kind={kind} ns={ns} name={name} container={container} setLatest={setLatest} />
        )}
      </div>
    </div>
  );
}

// --- Kebab menu (refresh / settings / copy latest) -------------------

function KebabMenu({
  cluster, tab, getLatest,
}: {
  cluster: string;
  tab: TabId;
  getLatest: () => { value: number; format: (v: number) => string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const close = () => setOpen(false);
  const toggle = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setPos({
      left: Math.min(window.innerWidth - 220, rect.right - 200),
      top: rect.bottom + 4,
    });
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const refresh = () => {
    // Invalidate every metric query for this cluster — the panels share a
    // common ["workload-metric", cluster, …] / ["pod-metric-fallback",
    // cluster, …] key shape, and a broad invalidate is fine because
    // refetchInterval already keeps them paced.
    queryClient.invalidateQueries({ queryKey: ["workload-metric", cluster] });
    queryClient.invalidateQueries({ queryKey: ["pod-metric-fallback", cluster] });
    queryClient.invalidateQueries({ queryKey: ["clusterUsage:ms-history", cluster] });
    notify_.info("Metrics refreshed");
    close();
  };

  const openSettings = () => {
    navigate(`/${encodeURIComponent(cluster)}/settings/metrics`);
    close();
  };

  const copyLatest = async () => {
    const latest = getLatest();
    if (!latest) {
      notify_.warn("No value to copy yet");
      close();
      return;
    }
    const formatted = latest.format(latest.value);
    if (await copyToClipboard(formatted)) notify_.ok(`Copied: ${formatted}`);
    else notify_.bad("Clipboard write failed");
    close();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={clsx(
          "h-6 w-6 inline-flex items-center justify-center rounded transition-colors",
          open ? "bg-bg-mute text-fg" : "text-fg-mute hover:text-fg hover:bg-bg-mute",
        )}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreHorizontal size={13} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[1500] min-w-[200px] rounded-md border border-line bg-bg-soft py-1 text-xs shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
          style={{ left: pos.left, top: pos.top }}
        >
          <MenuItem label="Refresh now" onClick={refresh} />
          <MenuItem label={`Copy latest ${tab} value`} onClick={copyLatest} />
          <div className="my-1 border-t border-line/60" />
          <MenuItem label="Configure metrics source…" onClick={openSettings} />
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-fg-soft hover:text-fg hover:bg-bg-mute"
    >
      {label}
    </button>
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

// --- CPU / Memory panels ----------------------------------------------

type SetLatest = (value: number, format: (v: number) => string) => void;

function CpuPanel({
  cluster, obj, container, promReady, setLatest,
}: { cluster: string; obj: any; container?: string; promReady: boolean; setLatest: SetLatest }) {
  const { requests, limits } = useMemo(() => sumResources(obj, container, "cpu"), [obj, container]);
  const refLines = useMemo<RefLine[]>(() => buildRefLines(requests, limits), [requests, limits]);
  if (promReady) {
    return <PromTimeSeries cluster={cluster} obj={obj} container={container} metric="cpu" refLines={refLines} setLatest={setLatest} />;
  }
  return <FallbackTimeSeries cluster={cluster} obj={obj} container={container} metric="cpu" refLines={refLines} setLatest={setLatest} />;
}

function MemoryPanel({
  cluster, obj, container, promReady, setLatest,
}: { cluster: string; obj: any; container?: string; promReady: boolean; setLatest: SetLatest }) {
  const { requests, limits } = useMemo(() => sumResources(obj, container, "memory"), [obj, container]);
  const refLines = useMemo<RefLine[]>(() => buildRefLines(requests, limits), [requests, limits]);
  if (promReady) {
    return <PromTimeSeries cluster={cluster} obj={obj} container={container} metric="memory" refLines={refLines} setLatest={setLatest} />;
  }
  return <FallbackTimeSeries cluster={cluster} obj={obj} container={container} metric="memory" refLines={refLines} setLatest={setLatest} />;
}

// --- Network / Filesystem panels (Prom only) -------------------------

function NetworkPanel({
  cluster, kind, ns, name, container, setLatest,
}: { cluster: string; kind: string; ns: string; name: string; container?: string; setLatest: SetLatest }) {
  const win = useWindow();
  const podSelector = useMemo(() => podSelectorFor(kind, name), [kind, name]);
  const containerSelector = container
    ? `,container="${escape(container)}"`
    : ``;
  const labels = `namespace="${escape(ns)}",${podSelector}${containerSelector}`;
  const rxQ = `sum(rate(container_network_receive_bytes_total{${labels}}[2m]))`;
  const txQ = `sum(rate(container_network_transmit_bytes_total{${labels}}[2m]))`;

  const rx = useQuery({
    queryKey: ["workload-metric", cluster, "rx", kind, ns, name, container ?? "_", win.start, win.end],
    queryFn: () => api.promQueryRange(cluster, rxQ, win.start, win.end, `${STEP_SEC}s`),
    refetchInterval: 30_000,
    retry: false,
  });
  const tx = useQuery({
    queryKey: ["workload-metric", cluster, "tx", kind, ns, name, container ?? "_", win.start, win.end],
    queryFn: () => api.promQueryRange(cluster, txQ, win.start, win.end, `${STEP_SEC}s`),
    refetchInterval: 30_000,
    retry: false,
  });

  const rxPoints = toPoints(rx.data);
  const txPoints = toPoints(tx.data);
  // Render rx and tx as separate overlaid areas so the operator can
  // distinguish ingress from egress at a glance — Lens does the same. We
  // surface the latest combined value to the kebab "Copy latest value"
  // action since "rx + tx" is the most useful single number.
  const latestCombined = useMemo(() => {
    const lastRx = rxPoints[rxPoints.length - 1]?.v ?? 0;
    const lastTx = txPoints[txPoints.length - 1]?.v ?? 0;
    const t = Math.max(rxPoints[rxPoints.length - 1]?.t ?? 0, txPoints[txPoints.length - 1]?.t ?? 0);
    return [{ t, v: lastRx + lastTx }];
  }, [rxPoints, txPoints]);
  useLatestPoint(latestCombined, formatBytes, setLatest);
  const rxColor = "rgb(var(--info))";
  const txColor = "rgb(var(--ok))";
  const series = useMemo<Series[]>(() => [
    { label: "Receive", color: rxColor, points: rxPoints },
    { label: "Transmit", color: txColor, points: txPoints },
  ], [rxPoints, txPoints]);
  const legend = useMemo(() => [
    { label: "Receive", color: rxColor },
    { label: "Transmit", color: txColor },
  ], []);
  return (
    <PanelChart
      title="Network"
      unit="bytes / s"
      series={series}
      loading={rx.isLoading || tx.isLoading}
      error={(rx.error || tx.error) as Error | null}
      formatY={formatBytes}
      window={win}
      legend={legend}
    />
  );
}

function FilesystemPanel({
  cluster, kind, ns, name, container, setLatest,
}: { cluster: string; kind: string; ns: string; name: string; container?: string; setLatest: SetLatest }) {
  const win = useWindow();
  const podSelector = useMemo(() => podSelectorFor(kind, name), [kind, name]);
  const containerSelector = container ? `,container="${escape(container)}"` : ``;
  const labels = `namespace="${escape(ns)}",${podSelector}${containerSelector}`;
  const q = `sum(container_fs_usage_bytes{${labels}})`;

  const usage = useQuery({
    queryKey: ["workload-metric", cluster, "fs", kind, ns, name, container ?? "_", win.start, win.end],
    queryFn: () => api.promQueryRange(cluster, q, win.start, win.end, `${STEP_SEC}s`),
    refetchInterval: 30_000,
    retry: false,
  });
  const points = toPoints(usage.data);
  useLatestPoint(points, formatBytes, setLatest);
  return (
    <PanelChart
      title="Filesystem"
      unit="bytes"
      points={points}
      loading={usage.isLoading}
      error={usage.error as Error | null}
      formatY={formatBytes}
      window={win}
    />
  );
}

// --- Prometheus time-series for CPU/Memory ---------------------------

function PromTimeSeries({
  cluster, obj, container, metric, refLines, setLatest,
}: {
  cluster: string;
  obj: any;
  container?: string;
  metric: "cpu" | "memory";
  refLines: RefLine[];
  setLatest: SetLatest;
}) {
  const kind: string = obj?.kind ?? "";
  const ns: string = obj?.metadata?.namespace ?? "";
  const name: string = obj?.metadata?.name ?? "";
  const win = useWindow();
  const queries = useMemo(() => buildQueries(kind, ns, name, container), [kind, ns, name, container]);
  const q = metric === "cpu" ? queries.cpu : queries.mem;

  const result = useQuery({
    queryKey: ["workload-metric", cluster, metric, kind, ns, name, container ?? "_", win.start, win.end],
    queryFn: () => api.promQueryRange(cluster, q, win.start, win.end, `${STEP_SEC}s`),
    refetchInterval: 30_000,
    retry: false,
  });
  // Prom CPU is in cores (the query already produces a rate in cores).
  // metrics-server CPU on the fallback is stored in millicores → cores
  // happens in FallbackTimeSeries, so by the time charts render both
  // panels are in the same "cores" unit.
  const points = toPoints(result.data);
  const fmt = metric === "cpu" ? formatCores : formatBytes;
  useLatestPoint(points, fmt, setLatest);
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

// --- metrics-server fallback for CPU/Memory --------------------------

const FALLBACK_HISTORY = 240;
const FALLBACK_INTERVAL = 5_000;

type FallbackSample = { t: number; cpu: number; mem: number };

function FallbackTimeSeries({
  cluster, obj, container, metric, refLines, setLatest,
}: {
  cluster: string;
  obj: any;
  container?: string;
  metric: "cpu" | "memory";
  refLines: RefLine[];
  setLatest: SetLatest;
}) {
  const ns: string = obj?.metadata?.namespace ?? "";
  const pod: string = obj?.metadata?.name ?? "";
  const source = useEffectiveMetricsSource(cluster);
  const enabled = source === "metrics-server" && !!cluster && !!ns && !!pod;
  const samplesRef = useRef<FallbackSample[]>([]);
  const [, force] = useState(0);

  const query = useQuery({
    enabled,
    queryKey: ["pod-metric-fallback", cluster, ns, pod],
    queryFn: () => api.podMetrics(cluster, ns),
    refetchInterval: FALLBACK_INTERVAL,
    retry: false,
  });

  useEffect(() => {
    samplesRef.current = [];
    force((n) => n + 1);
  }, [cluster, ns, pod, container]);

  useEffect(() => {
    if (!query.data) return;
    const sample = readPodFromMetricsServer(query.data, pod, container);
    if (!sample) return;
    const arr = samplesRef.current.slice();
    const t = Math.floor(Date.now() / 1000);
    if (arr.length === 0 || arr[arr.length - 1].t !== t) {
      arr.push({ t, cpu: sample.cpu, mem: sample.mem });
      if (arr.length > FALLBACK_HISTORY) arr.splice(0, arr.length - FALLBACK_HISTORY);
      samplesRef.current = arr;
      force((n) => n + 1);
    }
  }, [query.data, pod, container]);

  const samples = samplesRef.current;
  // Convert to chart units: cpu millicores → cores, memory stays bytes.
  const points: Point[] = samples.map((s) => ({
    t: s.t,
    v: metric === "cpu" ? s.cpu / 1000 : s.mem,
  }));
  const fmt = metric === "cpu" ? formatCores : formatBytes;
  useLatestPoint(points, fmt, setLatest);
  const win = samples.length > 0
    ? { start: samples[0].t, end: samples[samples.length - 1].t }
    : { start: Math.floor(Date.now() / 1000) - 60, end: Math.floor(Date.now() / 1000) };

  return (
    <PanelChart
      title={metric === "cpu" ? "CPU" : "Memory"}
      unit={metric === "cpu" ? "cores" : "bytes"}
      points={points}
      loading={false}                    // fallback never blocks: emptyText covers no-data
      error={query.error as Error | null}
      formatY={fmt}
      window={win}
      refLines={refLines}
      windowLabelOverride={`live · last ${Math.max(1, Math.round((win.end - win.start) / 60))} min`}
      emptyText="Collecting live samples from metrics-server… first points appear in ~5 s"
    />
  );
}

function useLatestPoint(points: Point[], format: (v: number) => string, setLatest: SetLatest) {
  useEffect(() => {
    if (points.length === 0) return;
    setLatest(points[points.length - 1].v, format);
  }, [points, format, setLatest]);
}

// --- Shared chart panel ----------------------------------------------

function PanelChart({
  title, unit, points, series, loading, error, formatY, window: w, refLines, legend, windowLabelOverride, emptyText,
}: {
  title: string;
  unit: string;
  points?: Point[];
  series?: Series[];
  loading: boolean;
  error: Error | null;
  formatY: (v: number) => string;
  window: { start: number; end: number };
  refLines?: RefLine[];
  legend?: Array<{ label: string; color: string }>;
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
            series={series}
            height={CHART_HEIGHT}
            loading={loading}
            formatY={formatY}
            xTicks={makeXTicks(w.start, w.end)}
            emptyText={emptyText ?? "No samples"}
            refLines={refLines}
          />
        )}
      </div>
      {legend && legend.length > 0 && (
        <div className="flex items-center justify-center gap-3 mt-1.5 text-[10px] text-fg-mute">
          {legend.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1">
              <span className="h-1.5 w-3 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- helpers ----------------------------------------------------------

function useWindow() {
  // Compute the step-aligned window. The previous implementation put
  // `Math.floor(Date.now() / (STEP_SEC * 1000))` in the deps array, but
  // reading Date.now() during render doesn't trigger re-renders by itself
  // — the window would only advance when the parent re-rendered for some
  // unrelated reason. We now drive it from a setInterval-backed state so
  // the chart's query key actually rolls forward every STEP_SEC.
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

function buildRefLines(requests: number, limits: number): RefLine[] {
  const out: RefLine[] = [];
  if (requests > 0) out.push({ value: requests, label: "request", tone: "info" });
  if (limits > 0) out.push({ value: limits, label: "limit", tone: "warn" });
  return out;
}

function sumResources(
  obj: any,
  container: string | undefined,
  metric: "cpu" | "memory",
): { requests: number; limits: number } {
  // For Pod we read straight from spec.containers / spec.initContainers.
  // For workloads we read from spec.template.spec.containers — k8s mints
  // pods from this template, so per-pod limits are predictable.
  const podSpec = obj?.kind === "Pod" ? obj?.spec : obj?.spec?.template?.spec;
  const containers: any[] = [
    ...((podSpec?.containers ?? []) as any[]),
    ...((podSpec?.initContainers ?? []) as any[]),
  ];
  const filtered = container ? containers.filter((c) => c?.name === container) : containers;
  let requests = 0;
  let limits = 0;
  for (const c of filtered) {
    const r = c?.resources?.requests ?? {};
    const l = c?.resources?.limits ?? {};
    if (metric === "cpu") {
      // CPU is rendered on the chart in cores; spec values are millicores.
      requests += cpuToMillicores(r.cpu) / 1000;
      limits   += cpuToMillicores(l.cpu) / 1000;
    } else {
      requests += memToBytes(r.memory);
      limits   += memToBytes(l.memory);
    }
  }
  return { requests, limits };
}

function buildQueries(kind: string, ns: string, name: string, container?: string): { cpu: string; mem: string } {
  const podSelector = podSelectorFor(kind, name);
  const containerSelector = container
    ? `,container="${escape(container)}"`
    : `,container!="",container!="POD"`;
  const labels = `namespace="${escape(ns)}",${podSelector}${containerSelector}`;
  const cpu = `sum(rate(container_cpu_usage_seconds_total{${labels}}[2m]))`;
  const mem = `sum(container_memory_working_set_bytes{${labels}})`;
  return { cpu, mem };
}

function podSelectorFor(kind: string, name: string): string {
  const escaped = escapeRegex(name);
  if (kind === "Pod") {
    return `pod="${escape(name)}"`;
  }
  if (kind === "StatefulSet") {
    return `pod=~"${escaped}-[0-9]+"`;
  }
  return `pod=~"${escaped}-[a-z0-9-]+"`;
}

function toPoints(resp?: PromResponse): Point[] {
  const series = resp?.data?.result;
  if (!series || series.length === 0) return [];
  const values = series[0]?.values ?? [];
  const points: Point[] = [];
  for (const [t, v] of values) {
    const ts = Number(t);
    const val = Number(v);
    if (Number.isFinite(ts) && Number.isFinite(val)) {
      points.push({ t: ts, v: val });
    }
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
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatCores(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  // Below 1 core → render in millicores so users don't have to count
  // decimal zeros. We never bottom out into scientific notation (`5.9e-5`
  // is hostile to read) — instead we keep ramping up the precision until
  // the smallest meaningful digit shows. Anything below 0.01 m is just
  // shown as ~0m so the y-axis labels don't fight the chart for space.
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

function escape(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPodFromMetricsServer(
  payload: any,
  pod: string,
  container?: string,
): { cpu: number; mem: number } | null {
  const items: any[] = Array.isArray(payload?.items)
    ? payload.items
    : payload?.metadata?.name
      ? [payload]
      : [];
  const item = items.find((p) => p?.metadata?.name === pod);
  if (!item) return null;
  let cpu = 0;
  let mem = 0;
  for (const c of item.containers ?? []) {
    if (container && c?.name !== container) continue;
    cpu += cpuToMillicores(c?.usage?.cpu);
    mem += memToBytes(c?.usage?.memory);
  }
  return { cpu, mem };
}
