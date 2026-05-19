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
  /** Uploaded avatar as a downscaled data-URL (≤96px, persisted in
   *  localStorage). Empty ⇒ fall back to iconLabel / initials. */
  iconImage: string;
  /** Free-text environment tag ("PROD", "staging", …). Empty ⇒ no badge.
   *  Shown anywhere the cluster surfaces — picker, tabs — so a prod
   *  cluster is impossible to mistake for a sandbox. */
  tag: string;
  /** Visual weight of the tag badge. Defaults to the loud red so the
   *  common "this is PROD" case screams without extra config. */
  tagTone: "bad" | "warn" | "ok" | "info" | "accent";
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
  iconImage: "",
  tag: "",
  tagTone: "bad",
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
  /** API-group filter for the CRD/API-kind pages (Definitions, Browse,
   *  API Resources) where a namespace selector is meaningless. "" means
   *  all groups; "core" is the sentinel for the empty (core/v1) group. */
  apiGroup: string;
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
  setApiGroup: (g: string) => void;
  setTheme: (t: Theme) => void;
  setSearch: (s: string) => void;
  setLastPage: (cluster: string, page: string) => void;
  getClusterSettings: (cluster: string) => ClusterSettings;
  setClusterSettings: (cluster: string, patch: Partial<ClusterSettings>) => void;
  /** Drop every piece of per-cluster state we keep on the device — settings,
   *  last-page memory, and the active cluster pointer if it matches. Called
   *  from the Topbar after `api.removeCluster` so a re-imported cluster of
   *  the same name comes up with default settings rather than inheriting
   *  the previous incarnation's hue / icon / preferences. */
  forgetCluster: (cluster: string) => void;
};

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      cluster: "",
      namespace: "",
      namespaces: [],
      apiGroup: "",
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
      setApiGroup: (apiGroup) => set({ apiGroup }),
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
      forgetCluster: (cluster) => set((state) => {
        const nextSettings = { ...state.clusterSettings };
        delete nextSettings[cluster];
        const nextLastPage = { ...state.lastPage };
        delete nextLastPage[cluster];
        return {
          clusterSettings: nextSettings,
          lastPage: nextLastPage,
          // Wipe the active cluster pointer when it matches — caller will
          // navigate to "/" after this and a stale name in `cluster` would
          // make every `useResourceList(cluster, …)` keep firing against a
          // dead WebSocket pool entry.
          cluster: state.cluster === cluster ? "" : state.cluster,
        };
      }),
    }),
    { name: "k8s-view:app" },
  ),
);

// useClusterLabel — the name to *display* for a cluster. `displayName`
// (the "Cluster name" field in Settings) is a cosmetic override; the
// registry name stays the routing identity. Everywhere a cluster name is
// shown to the user — sidebar, picker, tabs, status bar — should go
// through this so a rename actually sticks everywhere, not just on the
// Settings page.
export function useClusterLabel(name: string): string {
  return useApp((s) => {
    const d = s.clusterSettings[name]?.displayName;
    return d && d.trim() ? d.trim() : name;
  });
}
