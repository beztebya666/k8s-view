// Pod metrics shared store. The Pods list page mounts a PodMetricsBridge
// that calls `usePodMetrics` and pushes results here via `setMetrics`.
// Individual cells (CPU/Memory columns) subscribe by cluster+namespace+name
// without each one running its own query.
//
// We also stash a short ring-buffer history per pod so the table can draw
// a Lens-style sparkline alongside the latest value. History is bounded
// per-cluster by HISTORY_MAX_PODS using insertion order (rough LRU) so
// 150k-pod clusters don't blow up the heap. Each entry is two doubles +
// timestamp = ~24 bytes × HISTORY_LEN × HISTORY_MAX_PODS ≈ 1.4 MB worst
// case per cluster — comfortable on the metrics-bridge side.

import { create } from "zustand";
import type { PodMetric } from "./podMetrics";

const HISTORY_LEN = 30;
const HISTORY_MAX_PODS = 4_000;

export interface PodMetricSample extends PodMetric {
  /** Wall-clock ms when this sample was recorded. */
  t: number;
}

type State = {
  // cluster name → "namespace/pod" → metric.
  byCluster: Map<string, Map<string, PodMetric>>;
  // cluster name → "namespace/pod" → recent samples, oldest-first.
  history: Map<string, Map<string, PodMetricSample[]>>;
  source: "prometheus" | "metrics-server" | "none";
  setMetrics: (
    cluster: string,
    map: Map<string, PodMetric>,
    source: "prometheus" | "metrics-server" | "none",
  ) => void;
};

export const usePodMetricsStore = create<State>((set) => ({
  byCluster: new Map(),
  history: new Map(),
  source: "none",
  setMetrics: (cluster, map, source) =>
    set((s) => {
      const next = new Map(s.byCluster);
      next.set(cluster, map);

      const histAll = new Map(s.history);
      const prev = histAll.get(cluster) ?? new Map<string, PodMetricSample[]>();
      const nextHist = new Map(prev);
      const now = Date.now();
      for (const [key, m] of map) {
        const arr = nextHist.get(key)?.slice() ?? [];
        arr.push({ ...m, t: now });
        if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
        nextHist.set(key, arr);
      }
      // Trim least-recently-touched pods so we don't grow unbounded across
      // namespace switches. Map iteration is insertion order; we drop from
      // the front because new keys are added at the end.
      if (nextHist.size > HISTORY_MAX_PODS) {
        const drop = nextHist.size - HISTORY_MAX_PODS;
        let i = 0;
        for (const k of nextHist.keys()) {
          if (i >= drop) break;
          nextHist.delete(k);
          i++;
        }
      }
      histAll.set(cluster, nextHist);

      return { byCluster: next, history: histAll, source };
    }),
}));

export function podMetricKey(namespace: string | undefined, name: string | undefined): string {
  return `${namespace ?? ""}/${name ?? ""}`;
}

export function readPodMetric(cluster: string, key: string): PodMetric | undefined {
  return usePodMetricsStore.getState().byCluster.get(cluster)?.get(key);
}

export function readPodMetricHistory(cluster: string, key: string): PodMetricSample[] {
  return usePodMetricsStore.getState().history.get(cluster)?.get(key) ?? [];
}
