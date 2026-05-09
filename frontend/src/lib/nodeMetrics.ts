// Hook returning aggregated node CPU/memory usage. Prefers Prometheus when
// detected; falls back to the Kubernetes metrics-server (`metrics.k8s.io`).

import { useQuery } from "@tanstack/react-query";
import { api, type PromResponse } from "./api";
import { cpuToMillicores, memToBytes } from "./format";
import { useEffectiveMetricsSource } from "./podMetrics";

export type NodeMetrics = {
  cpu: number;     // millicores in use
  memory: number;  // bytes in use
  samples: number;
};

export type NodeMetricsResult = {
  data: NodeMetrics | null;
  source: "prometheus" | "metrics-server" | "none";
  error: unknown;
  loading: boolean;
};

const PROM_NODE_CPU_QUERY =
  "sum(rate(node_cpu_seconds_total{mode!~\"idle|iowait|steal\"}[2m])) * 1000";
const PROM_NODE_MEMORY_QUERY =
  "sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)";
const PROM_NODE_COUNT_QUERY = "count(node_uname_info)";

export function useNodeMetrics(cluster: string): NodeMetricsResult {
  const source = useEffectiveMetricsSource(cluster);

  const promQuery = useQuery({
    enabled: !!cluster && source === "prometheus",
    queryKey: ["nodeMetrics:prom", cluster],
    queryFn: () => fetchPromNodeMetrics(cluster),
    refetchInterval: 30_000,
    retry: false,
  });

  const fallback = useQuery({
    enabled: !!cluster && source === "metrics-server",
    queryKey: ["nodeMetrics:ms", cluster],
    queryFn: () => api.nodeMetrics(cluster).then(parseMetricsServerNodes),
    refetchInterval: 30_000,
    retry: false,
  });

  return {
    data: (source === "prometheus" ? promQuery.data : source === "metrics-server" ? fallback.data : null) ?? null,
    source,
    error: source === "prometheus" ? promQuery.error : source === "metrics-server" ? fallback.error : null,
    loading: source === "prometheus" ? promQuery.isLoading : source === "metrics-server" ? fallback.isLoading : false,
  };
}

async function fetchPromNodeMetrics(cluster: string): Promise<NodeMetrics> {
  const [cpu, mem, count] = await Promise.all([
    api.promQuery(cluster, PROM_NODE_CPU_QUERY).catch(() => null),
    api.promQuery(cluster, PROM_NODE_MEMORY_QUERY).catch(() => null),
    api.promQuery(cluster, PROM_NODE_COUNT_QUERY).catch(() => null),
  ]);
  return {
    cpu: scalarFromVector(cpu),
    memory: scalarFromVector(mem),
    samples: Math.round(scalarFromVector(count)),
  };
}

function scalarFromVector(resp: PromResponse | null): number {
  if (!resp || resp.status !== "success" || !resp.data) return 0;
  if (resp.data.resultType === "vector" && resp.data.result.length > 0) {
    const v = resp.data.result[0]?.value?.[1];
    return v ? parseFloat(v) || 0 : 0;
  }
  if (resp.data.resultType === "scalar") {
    const v = (resp.data as any).result?.[1];
    return v ? parseFloat(v) || 0 : 0;
  }
  return 0;
}

function parseMetricsServerNodes(payload: any): NodeMetrics {
  let cpu = 0;
  let memory = 0;
  let samples = 0;
  for (const item of payload?.items ?? []) {
    cpu += cpuToMillicores(item.usage?.cpu);
    memory += memToBytes(item.usage?.memory);
    samples += 1;
  }
  return { cpu, memory, samples };
}
