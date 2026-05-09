// Aggregation helpers + hooks for the Cluster Overview. Splits nodes/pods by
// scope (worker vs control-plane), sums capacity/allocatable/requests/limits
// from the live informer cache, and asks Prometheus for live usage and
// time-series. Falls back to metrics-server for usage when Prometheus is
// not detected.

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Item } from "./useResourceList";
import { api, type PromResponse, type PromSample } from "./api";
import { cpuToMillicores, memToBytes } from "./format";
import { useEffectiveMetricsSource } from "./podMetrics";

export type Scope = "worker" | "master";

export type ClusterTotals = {
  cpu: { usage: number; requests: number; limits: number; allocatable: number; capacity: number };
  memory: { usage: number; requests: number; limits: number; allocatable: number; capacity: number };
  pods: { usage: number; allocatable: number; capacity: number };
};

function emptyTotals(): ClusterTotals {
  return {
    cpu: { usage: 0, requests: 0, limits: 0, allocatable: 0, capacity: 0 },
    memory: { usage: 0, requests: 0, limits: 0, allocatable: 0, capacity: 0 },
    pods: { usage: 0, allocatable: 0, capacity: 0 },
  };
}

export type RangeId = "1h" | "2h" | "4h" | "24h" | "48h" | "1w" | "1mo" | "2mo";

export const RANGE_OPTIONS: Array<{ id: RangeId; label: string; seconds: number; step: number; ticks: number }> = [
  { id: "1h",  label: "1h",       seconds: 3600,    step: 30,    ticks: 6 },
  { id: "2h",  label: "2h",       seconds: 7200,    step: 60,    ticks: 6 },
  { id: "4h",  label: "4h",       seconds: 14400,   step: 120,   ticks: 5 },
  { id: "24h", label: "24h",      seconds: 86400,   step: 300,   ticks: 6 },
  { id: "48h", label: "48h",      seconds: 172800,  step: 600,   ticks: 6 },
  { id: "1w",  label: "1 week",   seconds: 604800,  step: 1800,  ticks: 7 },
  { id: "1mo", label: "1 month",  seconds: 2592000, step: 7200,  ticks: 6 },
  { id: "2mo", label: "2 months", seconds: 5184000, step: 14400, ticks: 6 },
];

export function isMasterNode(node: Item): boolean {
  const labels = node.metadata?.labels ?? {};
  return (
    "node-role.kubernetes.io/control-plane" in labels
    || "node-role.kubernetes.io/master" in labels
  );
}

export function filterNodesByScope(nodes: Item[], scope: Scope): Item[] {
  if (scope === "master") return nodes.filter(isMasterNode);
  return nodes.filter((n) => !isMasterNode(n));
}

export function useClusterTotals(
  cluster: string,
  nodes: Item[],
  pods: Item[],
  scope: Scope,
): { totals: ClusterTotals; source: "prometheus" | "metrics-server" | "none" } {
  const source = useEffectiveMetricsSource(cluster);
  const scopedNodes = useMemo(() => filterNodesByScope(nodes, scope), [nodes, scope]);
  const scopedNodeNameSet = useMemo(() => new Set(scopedNodes.map((n) => n.metadata?.name).filter(Boolean) as string[]), [scopedNodes]);
  const scopedPods = useMemo(
    () => pods.filter((p) => p.spec?.nodeName && scopedNodeNameSet.has(p.spec.nodeName)),
    [pods, scopedNodeNameSet],
  );
  const scopedNodeNameList = useMemo(() => Array.from(scopedNodeNameSet).sort(), [scopedNodeNameSet]);
  const scopedNodeNamesKey = scopedNodeNameList.join(",");

  const promUsage = useQuery({
    enabled: !!cluster && source === "prometheus" && scopedNodeNameList.length > 0,
    queryKey: ["clusterUsage:prom", cluster, scopedNodeNamesKey],
    queryFn: () => fetchPromUsage(cluster, scopedNodeNameList),
    refetchInterval: 30_000,
    retry: false,
  });

  // metrics-server is the primary source when Prom isn't detected, and a
  // silent fallback when Prom *is* detected but returned 0 — some clusters
  // expose Prometheus without the cAdvisor labels needed for node-scoped
  // joins. We only fire the fallback after Prom has been queried and came
  // back empty, so a healthy Prom setup never pays the extra metrics-server
  // poll.
  const promEmpty = source === "prometheus"
    && promUsage.isFetched
    && (!promUsage.data || (promUsage.data.cpu === 0 && promUsage.data.memory === 0));
  const msEnabled = !!cluster && scopedNodes.length > 0
    && (source === "metrics-server" || promEmpty);
  const fallbackUsage = useQuery({
    enabled: msEnabled,
    queryKey: ["clusterUsage:ms", cluster, scope, scopedNodes.map((n) => n.metadata?.name).join(",")],
    queryFn: () => fetchMetricsServerUsage(cluster, scopedNodeNameSet),
    refetchInterval: 30_000,
    retry: false,
  });

  return useMemo(() => {
    const totals: ClusterTotals = emptyTotals();
    for (const node of scopedNodes) {
      const allocatable = node.status?.allocatable ?? {};
      const capacity = node.status?.capacity ?? {};
      totals.cpu.allocatable += cpuToMillicores(allocatable.cpu);
      totals.cpu.capacity    += cpuToMillicores(capacity.cpu);
      totals.memory.allocatable += memToBytes(allocatable.memory);
      totals.memory.capacity    += memToBytes(capacity.memory);
      totals.pods.allocatable += parseInt(allocatable.pods ?? "0", 10) || 0;
      totals.pods.capacity    += parseInt(capacity.pods ?? "0", 10) || 0;
    }
    for (const pod of scopedPods) {
      const containers = [
        ...(pod.spec?.containers ?? []),
        ...(pod.spec?.initContainers ?? []),
      ];
      for (const c of containers) {
        totals.cpu.requests += cpuToMillicores(c.resources?.requests?.cpu);
        totals.cpu.limits   += cpuToMillicores(c.resources?.limits?.cpu);
        totals.memory.requests += memToBytes(c.resources?.requests?.memory);
        totals.memory.limits   += memToBytes(c.resources?.limits?.memory);
      }
    }
    totals.pods.usage = scopedPods.length;
    let usage: { cpu: number; memory: number } | null = null;
    if (source === "prometheus") {
      // Prefer Prom; fall through to metrics-server when Prom returned all
      // zeros (typical when scoped queries can't match labels). Mixing the
      // two is fine — both are "current usage" values, just from different
      // sources.
      const prom = promUsage.data;
      if (prom && (prom.cpu > 0 || prom.memory > 0)) {
        usage = prom;
      } else if (fallbackUsage.data) {
        usage = fallbackUsage.data;
      }
    } else if (source === "metrics-server") {
      usage = fallbackUsage.data ?? null;
    }
    if (usage) {
      totals.cpu.usage = usage.cpu;
      totals.memory.usage = usage.memory;
    }
    return { totals, source };
  }, [scopedNodes, scopedPods, source, promUsage.data, fallbackUsage.data]);
}

export type SeriesKind = "cpu" | "memory";

export function useUsageSeries(
  cluster: string,
  scope: Scope,
  nodeNames: string[],
  metric: SeriesKind,
  range: RangeId,
) {
  const source = useEffectiveMetricsSource(cluster);
  const opts = RANGE_OPTIONS.find((r) => r.id === range) ?? RANGE_OPTIONS[0];
  const nodeNamesKey = nodeNames.join(",");
  // Snap end to a step boundary so the React Query key is stable across
  // sub-step intervals (no re-fetch on every render tick).
  const now = Math.floor(Date.now() / 1000);
  const end = now - (now % opts.step);
  const start = end - opts.seconds;

  return useQuery({
    enabled: !!cluster && source === "prometheus" && nodeNames.length > 0,
    queryKey: ["usageSeries", cluster, scope, metric, range, end, nodeNamesKey],
    queryFn: () => fetchUsageSeries(cluster, nodeNames, metric, opts.step, start, end),
    refetchInterval: Math.min(opts.step * 1000, 60_000),
    retry: false,
    staleTime: opts.step * 1000,
    // Keep the prior series visible while we re-query for the next window
    // boundary. Without this the chart blanks for ~RTT every STEP_SEC
    // seconds because `end` advancing into the queryKey starts a fresh
    // query whose `data` is undefined until the response arrives.
    placeholderData: keepPreviousData,
  });
}

// PromQL fallback chain. Different cluster setups expose different label
// schemas on cAdvisor metrics:
//   1. kube-prometheus-stack with kube-state-metrics → `kube_pod_info` join
//      is the canonical way to scope by node. Works on every modern setup.
//   2. cAdvisor with custom relabeling that puts `node` directly on
//      `container_*_total` — older charts.
//
// We try (1) → (2) and use the first that returns data. We deliberately
// do NOT fall through to a cluster-wide `sum(container_*)` query — on
// master scope that query sums every worker pod too and produced the
// "1092 % memory" donut. If neither scoped variant has data we'd rather
// show 0 / empty than a confidently wrong number.
const cpuRateExpr = (window: number) =>
  `rate(container_cpu_usage_seconds_total{container!="",pod!=""}[${window}s])`;
const memExpr = `container_memory_working_set_bytes{container!="",pod!=""}`;

function buildScopedQueries(metric: SeriesKind, nodes: string[], rateWindow: number): string[] {
  const safe = nodes
    .map((n) => n.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (safe.length === 0) return [];
  const nodeRe = safe.join("|");
  const base = metric === "cpu" ? cpuRateExpr(rateWindow) : memExpr;
  const tail = metric === "cpu" ? " * 1000" : "";
  return [
    // kube_pod_info join — works on kube-prometheus-stack, kube-state-metrics
    `sum(${base} * on (namespace, pod) group_left() kube_pod_info{node=~"${nodeRe}"})${tail}`,
    // direct `node` label — older cAdvisor relabelings
    `sum(${metric === "cpu"
      ? `rate(container_cpu_usage_seconds_total{container!="",node=~"${nodeRe}"}[${rateWindow}s])`
      : `container_memory_working_set_bytes{container!="",node=~"${nodeRe}"}`})${tail}`,
  ];
}

async function fetchPromUsage(cluster: string, nodes: string[]): Promise<{ cpu: number; memory: number }> {
  const cpuCandidates = buildScopedQueries("cpu", nodes, 120);
  const memCandidates = buildScopedQueries("memory", nodes, 120);
  const cpu = await firstNonZeroScalar(cluster, cpuCandidates);
  const mem = await firstNonZeroScalar(cluster, memCandidates);
  return { cpu, memory: mem };
}

async function fetchUsageSeries(
  cluster: string,
  nodes: string[],
  metric: SeriesKind,
  step: number,
  start: number,
  end: number,
): Promise<Array<{ t: number; v: number }>> {
  const window = Math.max(step, 60);
  const candidates = buildScopedQueries(metric, nodes, window);
  for (const q of candidates) {
    try {
      const resp = await api.promQueryRange(cluster, q, start, end, `${step}s`);
      const points = parseRangeMatrix(resp);
      if (points.length > 0) return points;
    } catch {
      // try next
    }
  }
  return [];
}

async function firstNonZeroScalar(cluster: string, queries: string[]): Promise<number> {
  for (const q of queries) {
    try {
      const resp = await api.promQuery(cluster, q);
      const v = scalar(resp);
      if (v > 0) return v;
    } catch {
      // try next
    }
  }
  // All queries returned 0 — return 0 (legitimately idle, or zero metrics).
  return 0;
}

async function fetchMetricsServerUsage(cluster: string, nodeFilter: Set<string>): Promise<{ cpu: number; memory: number }> {
  const list = await api.nodeMetrics(cluster);
  let cpu = 0;
  let memory = 0;
  for (const item of list?.items ?? []) {
    const name = item?.metadata?.name;
    if (!name || (nodeFilter.size > 0 && !nodeFilter.has(name))) continue;
    cpu += cpuToMillicores(item.usage?.cpu);
    memory += memToBytes(item.usage?.memory);
  }
  return { cpu, memory };
}

// --- metrics-server time-series fallback -----------------------------
// When Prometheus isn't available, the OverviewPage still wants a chart
// instead of an empty placeholder. We can't ask metrics-server for a
// historical range, so we accumulate live samples in a module-scoped
// buffer keyed by cluster+scope+metric. Buffer survives navigation
// within a session — the chart appears immediately when the user
// returns to the overview — and resets on full reload.

// Poll cadence for the metrics-server fallback. Bumped from 30 s → 5 s so
// the chart fills in within a few seconds of arriving on the page (instead
// of a half-minute blank panel). Buffer length scales accordingly so the
// total time-window covered (~20 min) is more useful than 60 min of stale
// 30 s samples we'd never look at.
const FALLBACK_HISTORY_LEN = 240;       // 240 × 5 s = 20 min
const FALLBACK_INTERVAL_MS = 5_000;
const fallbackHistory = new Map<string, Array<{ t: number; v: number }>>();

function fallbackKey(cluster: string, scope: Scope, metric: SeriesKind): string {
  return `${cluster}|${scope}|${metric}`;
}

export function useFallbackUsageSeries(
  cluster: string,
  scope: Scope,
  nodeNameSet: Set<string>,
  metric: SeriesKind,
  /** When true, run the live-sample buffer even on a Prometheus cluster.
   *  Caller passes this when its Prom range-series came back empty so the
   *  chart has *something* to show. Defaults to false so a healthy Prom
   *  cluster doesn't double-poll metrics-server. */
  enableOnProm: boolean = false,
): { data: Array<{ t: number; v: number }> } {
  const source = useEffectiveMetricsSource(cluster);
  const enabled = !!cluster && nodeNameSet.size > 0
    && (source === "metrics-server" || (source === "prometheus" && enableOnProm));
  const key = fallbackKey(cluster, scope, metric);
  const [, force] = useState(0);

  const query = useQuery({
    enabled,
    queryKey: ["clusterUsage:ms-history", cluster, scope, [...nodeNameSet].sort().join(",")],
    queryFn: () => fetchMetricsServerUsage(cluster, nodeNameSet),
    refetchInterval: FALLBACK_INTERVAL_MS,
    retry: false,
  });

  useEffect(() => {
    if (!query.data) return;
    const v = metric === "cpu" ? query.data.cpu : query.data.memory;
    const t = Math.floor(Date.now() / 1000);
    const arr = (fallbackHistory.get(key) ?? []).slice();
    // Coalesce duplicate timestamps that can happen if React re-runs
    // this effect with the same query.data reference.
    if (arr.length === 0 || arr[arr.length - 1].t !== t) {
      arr.push({ t, v });
      if (arr.length > FALLBACK_HISTORY_LEN) arr.splice(0, arr.length - FALLBACK_HISTORY_LEN);
      fallbackHistory.set(key, arr);
      force((n) => n + 1);
    }
  }, [query.data, key, metric]);

  return { data: enabled ? (fallbackHistory.get(key) ?? []) : [] };
}

function scalar(resp: PromResponse | null): number {
  if (!resp || resp.status !== "success" || !resp.data) return 0;
  if (resp.data.resultType === "vector" && resp.data.result.length > 0) {
    const v = resp.data.result[0]?.value?.[1];
    return v ? parseFloat(v) || 0 : 0;
  }
  return 0;
}

function parseRangeMatrix(resp: PromResponse): Array<{ t: number; v: number }> {
  if (resp.status !== "success" || resp.data?.resultType !== "matrix") return [];
  const series = resp.data.result.flatMap((s: PromSample) => s.values ?? []);
  // Aggregate identical timestamps if multiple series present (we asked for
  // sum() so usually one) — but be defensive.
  const byT = new Map<number, number>();
  for (const [ts, raw] of series) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    byT.set(ts, (byT.get(ts) ?? 0) + v);
  }
  return [...byT.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, v }));
}

