import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light" | "auto";

// Metrics-source override. "auto" tries Prometheus first then falls back to
// the Kubernetes metrics-server. The remaining options are explicit overrides
// the user can pick from the Settings page when auto-detection is wrong.
export type MetricsProvider =
  | "auto"
  | "prometheus"
  | "metrics-server"
  | "none";

export type ClusterSettings = {
  displayName: string;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  terminalWorkingDirectory: string;
  terminalDefaultNamespace: string;
  terminalDefaultShell: string;
  accessibleNamespaces: string[];
  metricsProvider: MetricsProvider;
  hiddenMetrics: string[];
  nodeShellImage: string;
  nodeShellPullSecret: string;
  persistColumnWidths: boolean;
  /** Render the inline CPU/memory sparkline columns on the Pods list.
   *  Off by default — these columns are noisy when no metrics provider is
   *  available, and on huge clusters (~150K pods) the per-row metrics
   *  subscription is best opt-in. */
  showPodMetricsColumns: boolean;
  /** Custom icon override — single emoji or 1-3 character initials. Empty
   *  string ⇒ fall back to the deterministic colour-only badge. */
  iconLabel: string;
  /** Custom HSL hue 0-359, or -1 to use the deterministic hash colour. */
  iconHue: number;
  lensMetrics: {
    prometheus: boolean;
    kubeStateMetrics: boolean;
    nodeExporter: boolean;
  };
};

export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = {
  displayName: "",
  httpProxy: "",
  httpsProxy: "",
  noProxy: "",
  terminalWorkingDirectory: "$USERPROFILE",
  terminalDefaultNamespace: "default",
  terminalDefaultShell: "/bin/sh",
  accessibleNamespaces: [],
  metricsProvider: "auto",
  hiddenMetrics: [],
  nodeShellImage: "docker.io/alpine:3.19",
  nodeShellPullSecret: "",
  persistColumnWidths: false,
  showPodMetricsColumns: false,
  iconLabel: "",
  iconHue: -1,
  lensMetrics: {
    prometheus: false,
    kubeStateMetrics: false,
    nodeExporter: false,
  },
};

export type AppState = {
  cluster: string;
  namespace: string;             // "" means all namespaces
  namespaces: string[];           // [] means all namespaces; otherwise explicit multi-selection
  theme: Theme;
  search: string;
  clusterSettings: Record<string, Partial<ClusterSettings>>;
  /** Last route segment visited per cluster — used so switching clusters
   *  brings the user back to where they were instead of always landing
   *  on Overview. Keyed by cluster name. */
  lastPage: Record<string, string>;
  setCluster: (c: string) => void;
  setNamespace: (n: string) => void;
  setNamespaces: (namespaces: string[]) => void;
  setTheme: (t: Theme) => void;
  setSearch: (s: string) => void;
  setLastPage: (cluster: string, page: string) => void;
  getClusterSettings: (cluster: string) => ClusterSettings;
  setClusterSettings: (cluster: string, patch: Partial<ClusterSettings>) => void;
};

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      cluster: "",
      namespace: "",
      namespaces: [],
      theme: "dark",
      search: "",
      clusterSettings: {},
      lastPage: {},
      setCluster: (cluster) => set({ cluster }),
      setNamespace: (namespace) => set({ namespace, namespaces: namespace ? [namespace] : [] }),
      setNamespaces: (namespaces) => {
        const unique = [...new Set(namespaces.filter(Boolean))].sort();
        set({ namespaces: unique, namespace: unique.length === 1 ? unique[0] : "" });
      },
      setTheme: (theme) => {
        document.documentElement.classList.toggle("light", theme === "light");
        document.documentElement.classList.toggle("dark", theme !== "light");
        set({ theme });
      },
      setSearch: (search) => set({ search }),
      setLastPage: (cluster, page) => set((s) => ({
        lastPage: { ...s.lastPage, [cluster]: page },
      })),
      getClusterSettings: (cluster) => ({
        ...DEFAULT_CLUSTER_SETTINGS,
        ...(get().clusterSettings[cluster] ?? {}),
        lensMetrics: {
          ...DEFAULT_CLUSTER_SETTINGS.lensMetrics,
          ...(get().clusterSettings[cluster]?.lensMetrics ?? {}),
        },
      }),
      setClusterSettings: (cluster, patch) => set((state) => {
        const prev = state.clusterSettings[cluster] ?? {};
        return {
          clusterSettings: {
            ...state.clusterSettings,
            [cluster]: {
              ...prev,
              ...patch,
              lensMetrics: patch.lensMetrics
                ? { ...(prev.lensMetrics ?? {}), ...patch.lensMetrics }
                : prev.lensMetrics,
            },
          },
        };
      }),
    }),
    { name: "k8s-view:app" },
  ),
);
