// Hook that returns a `Map<"namespace/name", { cpu, memory }>` for pods.
//
// Strategy: prefer Prometheus (auto-detected per cluster) — one round-trip
// gives every pod's instantaneous CPU rate and memory working-set. If
// Prometheus isn't available, fall back to the Kubernetes metrics-server API
// which returns the same dimensions but per-container and only for the
// current namespace selection.

import { useQuery } from "@tanstack/react-query";
import { api, type PromResponse } from "./api";
import { cpuToMillicores, memToBytes } from "./format";
import { useApp } from "../stores/app";

export type PodMetric = {
  cpu: number;     // millicores
  memory: number;  // bytes
};

export type PodMetricsMap = Map<string, PodMetric>;

const EMPTY: PodMetricsMap = new Map();

/** Raw Prometheus auto-detection — bypasses the user override so callers
 *  who only need the discovery info (eg. the SettingsPage) can show what
 *  the cluster reports independently of the override. */
export function usePrometheusInfo(cluster: string) {
  const provider = useApp((s) => s.getClusterSettings(cluster).metricsProvider);
  const probe = useQuery({
    enabled: !!cluster && provider !== "none" && provider !== "metrics-server",
    queryKey: ["prometheusInfo", cluster],
    queryFn: () => api.prometheusInfo(cluster),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  if (provider === "none") {
    return { ...probe, data: { detected: false as const, reason: "Metrics disabled in settings" }, isFetched: true };
  }
  if (provider === "metrics-server") {
    return { ...probe, data: { detected: false as const, reason: "Forced metrics-server in settings" }, isFetched: true };
  }
  return probe;
}

/** What the UI should actually display: "prometheus" if detected and the
 *  override allows it, "metrics-server" when prom is unavailable / forced
 *  off, "none" when the user disabled metrics entirely. */
export function useEffectiveMetricsSource(cluster: string): "prometheus" | "metrics-server" | "none" {
  const provider = useApp((s) => s.getClusterSettings(cluster).metricsProvider);
  const promInfo = usePrometheusInfo(cluster);
  if (provider === "none") return "none";
  if (provider === "metrics-server") return "metrics-server";
  if (provider === "prometheus") return promInfo.data?.detected ? "prometheus" : "none";
  // auto
  if (promInfo.data?.detected) return "prometheus";
  return "metrics-server";
}

export function usePodMetrics(cluster: string, namespaces: string[] | undefined) {
  const source = useEffectiveMetricsSource(cluster);
  const nsKey = (namespaces ?? []).join(",");

  const promQuery = useQuery({
    enabled: !!cluster && source === "prometheus",
    queryKey: ["podMetrics:prom", cluster, nsKey],
    queryFn: () => fetchPromPodMetrics(cluster, namespaces),
    refetchInterval: 30_000,
    retry: false,
  });

  const metricNs = (namespaces ?? []).length === 1 ? namespaces![0] : "_all";
  const fallback = useQuery({
    enabled: !!cluster && source === "metrics-server",
    queryKey: ["podMetrics:ms", cluster, metricNs],
    queryFn: () => api.podMetrics(cluster, metricNs).then(parseMetricsServerPods),
    refetchInterval: 30_000,
    retry: false,
  });

  const data = (source === "prometheus" ? promQuery.data : source === "metrics-server" ? fallback.data : EMPTY) ?? EMPTY;
  const error = source === "prometheus" ? promQuery.error : source === "metrics-server" ? fallback.error : null;
  const loading = source === "prometheus" ? promQuery.isLoading : source === "metrics-server" ? fallback.isLoading : false;

  return { data, source, error, loading };
}

async function fetchPromPodMetrics(
  cluster: string,
  namespaces: string[] | undefined,
): Promise<PodMetricsMap> {
  const nsFilter = nsRegex(namespaces);
  // `container!=""` filters out the pod-aggregate row (which would double the
  // sum) and the pause container. We multiply by 1000 to convert cores →
  // millicores and match the metrics-server fallback.
  const cpuQuery =
    `sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""${nsFilter}}[2m])) * 1000`;
  const memQuery =
    `sum by (namespace, pod) (container_memory_working_set_bytes{container!=""${nsFilter}})`;

  const [cpu, mem] = await Promise.all([
    api.promQuery(cluster, cpuQuery).catch(() => null),
    api.promQuery(cluster, memQuery).catch(() => null),
  ]);
  const out: PodMetricsMap = new Map();
  collectPromVector(cpu, (key, n) => upsert(out, key, "cpu", n));
  collectPromVector(mem, (key, n) => upsert(out, key, "memory", n));
  return out;
}

function nsRegex(namespaces: string[] | undefined): string {
  if (!namespaces || namespaces.length === 0) return "";
  // Caller-controlled list of namespace names; sanitise to keep PromQL valid.
  const safe = namespaces
    .map((n) => n.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean);
  if (safe.length === 0) return "";
  return `,namespace=~"${safe.join("|")}"`;
}

function collectPromVector(
  resp: PromResponse | null,
  visit: (key: string, value: number) => void,
) {
  if (!resp || resp.status !== "success" || resp.data?.resultType !== "vector") return;
  for (const sample of resp.data.result) {
    const ns = sample.metric.namespace;
    const pod = sample.metric.pod;
    if (!ns || !pod || !sample.value) continue;
    const n = parseFloat(sample.value[1]);
    if (!Number.isFinite(n)) continue;
    visit(`${ns}/${pod}`, n);
  }
}

function upsert(
  out: PodMetricsMap,
  key: string,
  field: keyof PodMetric,
  value: number,
) {
  const current = out.get(key) ?? { cpu: 0, memory: 0 };
  current[field] = value;
  out.set(key, current);
}

function parseMetricsServerPods(payload: any): PodMetricsMap {
  const out: PodMetricsMap = new Map();
  for (const item of payload?.items ?? []) {
    const ns = item?.metadata?.namespace;
    const pod = item?.metadata?.name;
    if (!ns || !pod) continue;
    let cpu = 0;
    let memory = 0;
    for (const container of item.containers ?? []) {
      cpu += cpuToMillicores(container.usage?.cpu);
      memory += memToBytes(container.usage?.memory);
    }
    out.set(`${ns}/${pod}`, { cpu, memory });
  }
  return out;
}
