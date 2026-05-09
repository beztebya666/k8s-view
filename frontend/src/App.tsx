import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, FileUp } from "lucide-react";

import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { TopTabs, useTabsRouterSync } from "./components/TopTabs";
import { DetailPanelHost } from "./components/DetailPanel";
import { BottomPaneHost } from "./components/BottomPane";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { Toasts } from "./components/Toasts";
import { AddClusterModal } from "./components/AddClusterModal";
import { ResourceListPage } from "./pages/ResourceListPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { WorkloadsOverviewPage } from "./pages/WorkloadsOverviewPage";
import { CustomResourcesPage } from "./pages/CustomResourcesPage";
import { APIResourcesPage } from "./pages/APIResourcesPage";
import { EventsPage } from "./pages/EventsPage";
import { NodesPage } from "./pages/NodesPage";
import { ResourceDetailPage } from "./pages/ResourceDetailPage";
import { PodLogsPage } from "./pages/PodLogsPage";
import { PodExecPage } from "./pages/PodExecPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TerminalLauncherPage } from "./pages/TerminalLauncherPage";
import { PortForwardsPage } from "./pages/PortForwardsPage";
import { YAMLEditorWarmup } from "./components/YAMLEditor";
import { api, type ClusterInfo } from "./lib/api";
import { useTabs } from "./stores/tabs";
import { destroyClusterStream } from "./lib/stream";
import { useApp } from "./stores/app";
import { SECTIONS } from "./nav/sections";
import { favouriteAt } from "./lib/favourites";
import { refToQuery } from "./components/DetailPanel";

export default function App() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addClusterOpen, setAddClusterOpen] = useState(false);

  const { data: clusters, isError: clustersFailed, isLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.clusters,
    refetchInterval: 30_000,
    retry: false,
  });

  const cluster = useApp((s) => s.cluster);
  const setCluster = useApp((s) => s.setCluster);
  const theme = useApp((s) => s.theme);

  // Pick the default cluster on first load. Only picks an active
  // (non-paused) cluster — otherwise after a Disconnect the App-level
  // sweep clears `cluster` to "" and this effect would immediately
  // re-elect the same disconnected cluster, racing forever and putting
  // the user back inside the very cluster they just disconnected from.
  // When every cluster is paused we leave `cluster` empty; HomeShell
  // renders the "All your clusters are disconnected" message.
  useEffect(() => {
    if (!clusters || clusters.length === 0) return;
    if (cluster && clusters.find((c) => c.name === cluster && !c.paused)) return;
    const current = clusters.find((c) => c.current && !c.paused)
                 ?? clusters.find((c) => !c.paused);
    if (!current) return;
    setCluster(current.name);
  }, [clusters, cluster, setCluster]);

  // Global stale-tab + stale-stream sweeper. A tab is "stale" when its
  // cluster is missing from the picker (removed elsewhere, SSO scope
  // changed) or currently disconnected. Disconnect is an explicit "stop
  // touching this cluster" action — leaving its tabs in the strip lets a
  // stray click silently re-attach informers, which is the bug the user
  // kept hitting. We sweep here at App level so it runs no matter which
  // shell (Cluster vs Home) is rendered, including right after a page
  // restore from localStorage where tabs are hydrated before any view
  // gets a chance to clean them up.
  useEffect(() => {
    if (!clusters) return;
    const live = new Set(clusters.filter((c) => !c.paused).map((c) => c.name));
    const tabs = useTabs.getState().tabs;
    const stale = tabs.filter((t) => !live.has(t.cluster));
    if (stale.length === 0) return;
    const staleNames = new Set(stale.map((t) => t.cluster));
    for (const name of staleNames) {
      destroyClusterStream(name);
      useTabs.getState().closeForCluster(name);
    }
    if (cluster && !live.has(cluster)) {
      useApp.getState().setCluster("");
    }
  }, [clusters, cluster]);

  // Apply theme on first paint.
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme !== "light");
  }, [theme]);

  // Cmd/Ctrl + 1..9 → open the Nth pinned favourite. Lens binds the same
  // chord to its hotbar slots; we defer to that intuition rather than
  // reinventing a different convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      const slot = Number(e.key);
      if (!Number.isInteger(slot) || slot < 1 || slot > 9) return;
      const target = (typeof document !== "undefined") ? (document.activeElement as HTMLElement | null) : null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      const c = useApp.getState().cluster;
      if (!c) return;
      const fav = favouriteAt(c, slot);
      if (!fav) return;
      e.preventDefault();
      const q = refToQuery({
        group: fav.group, version: fav.version, resource: fav.resource,
        namespace: fav.namespace, name: fav.name,
      });
      const url = new URL(window.location.href);
      url.searchParams.set("d", q);
      url.searchParams.delete("tab");
      window.history.pushState({}, "", url.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showClusterImport = !isLoading && (clustersFailed || clusters?.length === 0);
  // We deliberately DON'T gate the boot screen on `!cluster` any more —
  // an empty active cluster is the legitimate "Disconnected, sitting on
  // the home shell" state (HomeShell handles it). Treating it as "still
  // waiting" left the user staring at the loading spinner forever after
  // hitting Disconnect; we'd already wiped cluster="" but the boot
  // screen's gate kept firing.
  const waitingForCluster = isLoading || (!clusters && !clustersFailed);

  if (waitingForCluster || showClusterImport) {
    return (
      <>
        {showClusterImport ? (
          <div className="min-h-full grid place-items-center bg-bg px-6 text-fg">
            <div className="w-[min(420px,92vw)] text-center">
              <div className="mx-auto mb-6 h-2 w-2 rounded-full bg-ok shadow-[0_0_18px_rgb(34_197_94_/_0.45)]" />
              <div className="text-[34px] font-light leading-none tracking-normal">k8s-view</div>
              <div className="mt-3 text-sm text-fg-mute">No clusters connected</div>

              <button
                type="button"
                className="btn-primary mx-auto mt-6 h-9 px-3"
                onClick={() => setAddClusterOpen(true)}
              >
                <FileUp size={14} />
                Import kubeconfig
              </button>

              <div className="mt-3 flex items-center justify-center gap-3 text-xs text-fg-mute">
                <span className="inline-flex items-center gap-1.5">
                  <FileUp size={12} />
                  Upload file
                </span>
                <span className="h-3 w-px bg-line" />
                <span className="inline-flex items-center gap-1.5">
                  <ClipboardPaste size={12} />
                  Paste YAML
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="boot">
            <div className="dot" /><div className="logo">k8s-view</div>
            <div style={{ opacity: 0.5, fontSize: 13 }}>loading clusters...</div>
          </div>
        )}
        {addClusterOpen && (
          <AddClusterModal
            onClose={() => setAddClusterOpen(false)}
            onImported={async (names) => {
              setAddClusterOpen(false);
              await queryClient.invalidateQueries({ queryKey: ["clusters"] });
              const first = names[0];
              if (first) {
                setCluster(first);
                api.selectCluster(first).catch(() => {});
                navigate(`/${encodeURIComponent(first)}/overview`, { replace: true });
              }
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <YAMLEditorWarmup />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/:cluster/*" element={<ClusterShell />} />
      </Routes>
    </>
  );
}

// Top-level "/" redirect — picks the active cluster and routes to either
// the last page the user visited there (workspace persistence) or the
// Overview if they've never been before.
//
// When the user is *not* connected to any cluster (no active cluster, or
// the active cluster is currently disconnected) we render the home screen
// instead of redirecting. The home screen shows the cluster picker shell
// and an empty workspace — explicit "you're not in any cluster right now"
// state. This is the page Disconnect lands you on.
function RootRedirect() {
  const cluster = useApp((s) => s.cluster);
  const lastPage = useApp((s) => s.lastPage);
  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.clusters });
  const target = lastPage[cluster] || "overview";
  const activeInfo = clusters?.find((c) => c.name === cluster);
  const inHome = !cluster || !activeInfo || activeInfo.paused;
  if (inHome) {
    return <HomeShell clusters={clusters ?? []} />;
  }
  return <Navigate to={`/${encodeURIComponent(cluster)}/${target}`} replace />;
}

// HomeShell — what the user sees when they're not in any cluster: after
// Disconnect, after Remove, on first launch with no clusters imported, or
// on a fresh URL with no remembered selection.
//
// Lens-style: only the Sidebar is rendered. No Topbar (no cluster picker
// / namespace selector / global search / Create / live-badge — all of
// these need an active cluster), no top tabs strip (no cluster context
// to scope a tab to), no StatusBar (offline indicator + port-forwards
// counter both need an active cluster too). The workspace area is just
// a hint of what to do next. Toasts and the global command palette stay
// available because they're cluster-independent.
function HomeShell({ clusters }: { clusters: ClusterInfo[] }) {
  const navigate = useNavigate();
  const lastPage = useApp((s) => s.lastPage);
  const setCluster = useApp((s) => s.setCluster);
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());
  const liveCount = clusters.filter((c) => !c.paused).length;
  const pickedFirst = clusters.find((c) => !c.paused);

  return (
    <div className="flex flex-col h-full bg-bg text-fg">
      <div
        className="flex-1 min-h-0 grid"
        style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      >
        <div className="relative border-r border-line bg-bg-soft overflow-hidden">
          <Sidebar onNavigate={(to) => {
            // Sidebar.onNavigate is the per-cluster section path; in home
            // mode there's no active cluster, so a click is meaningless —
            // ignore it. Cluster row clicks still work because they
            // navigate to /:cluster/* directly.
            void to;
          }} />
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = sidebarWidth;
              let latest = startWidth;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
              const onMove = (ev: PointerEvent) => {
                latest = clamp(startWidth + ev.clientX - startX, SIDEBAR_MIN, maxSidebarWidth());
                setSidebarWidth(latest);
              };
              const onUp = () => {
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(latest))); } catch { /* ignore */ }
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          />
        </div>
        <main className="overflow-auto grid place-items-center p-8">
          <div className="max-w-md text-center space-y-4">
            <div className="text-fg-mute text-xs uppercase tracking-wider">k8s-view</div>
            <div className="text-2xl font-medium">Not connected to any cluster</div>
            <div className="text-fg-soft text-sm leading-relaxed">
              {clusters.length === 0
                ? "You haven't imported any kubeconfigs yet. Use the sidebar to add one."
                : liveCount === 0
                  ? "All your clusters are disconnected. Click any cluster in the sidebar to reconnect."
                  : "Pick a cluster from the sidebar to start exploring resources."}
            </div>
            {pickedFirst && (
              <button
                className="btn-primary h-9 px-4 text-sm"
                onClick={() => {
                  setCluster(pickedFirst.name);
                  api.selectCluster(pickedFirst.name).catch(() => {});
                  navigate(`/${encodeURIComponent(pickedFirst.name)}/${lastPage[pickedFirst.name] || "overview"}`);
                }}
              >
                Open {pickedFirst.name}
              </button>
            )}
          </div>
        </main>
      </div>
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function ClusterShell() {
  const { cluster: routeCluster = "" } = useParams();
  const cluster = decodeURIComponent(routeCluster);
  const setCluster = useApp((s) => s.setCluster);
  const lastPage = useApp((s) => s.lastPage);
  const setLastPage = useApp((s) => s.setLastPage);
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());

  // Hard guard against entering a disconnected cluster's route. Without
  // this, a stale tab restored from localStorage, the browser back button,
  // a copy-pasted URL, or a sidebar click that bypassed the picker would
  // mount the cluster shell and silently re-attach every informer — which
  // is exactly the "auto-connect on visit" behaviour the user complained
  // about.
  //
  // Two important detail: we redirect synchronously with <Navigate>, NOT
  // by returning null and queuing the route change in a useEffect. The
  // useEffect path makes the screen go pure black for one paint while
  // the effect dispatches navigate("/") — that's the "I disconnected and
  // landed in pure black" complaint. <Navigate replace> swaps the route
  // inside React-Router's reducer in the same render, so the user goes
  // straight to the home shell with no intermediate blank frame.
  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.clusters });
  const info = clusters?.find((c) => c.name === cluster);
  const blocked = !!cluster && (info ? info.paused : clusters !== undefined);

  useTabsRouterSync();

  useEffect(() => {
    if (cluster && !blocked) setCluster(cluster);
  }, [cluster, blocked, setCluster]);

  if (blocked) return <Navigate to="/" replace />;

  // Track current page per cluster so a later cluster-switch lands the
  // user back where they were. We deliberately ignore detail-route
  // segments (`resource/...`, `pods/.../logs`) — those are deep links the
  // user reaches *from* a list page, and overwriting the remembered list
  // page with the deep link would teleport them back to the deep link
  // every time they come back to the cluster.
  useEffect(() => {
    if (!cluster) return;
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return;
    if (decodeURIComponent(parts[0]) !== cluster) return;
    const page = parts[1];
    if (!page || page === "resource" || page === "pods") return;
    if (lastPage[cluster] === page) return;
    setLastPage(cluster, page);
  }, [location.pathname, cluster, lastPage, setLastPage]);

  const startSidebarResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let latest = startWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      latest = clamp(startWidth + ev.clientX - startX, SIDEBAR_MIN, maxSidebarWidth());
      setSidebarWidth(latest);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(latest))); } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex flex-col h-full bg-bg text-fg">
      <TopTabs />
      <div
        className="grid grid-rows-[44px_1fr] flex-1 min-h-0"
        style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      >
      <div className="row-span-2 relative border-r border-line bg-bg-soft overflow-hidden">
        <Sidebar onNavigate={(to) => navigate(`/${encodeURIComponent(cluster)}/${to}`)} />
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          title={`Resize sidebar (${SIDEBAR_MIN}-${SIDEBAR_MAX}px)`}
          onPointerDown={startSidebarResize}
        />
      </div>
      <div className="border-b border-line">
        <Topbar />
      </div>
      <div className="overflow-hidden flex flex-col min-w-0 min-h-0">
        <div className="flex-1 flex min-h-0 min-w-0">
        <main className="flex-1 min-w-0 overflow-hidden">
        <Routes>
          <Route path="overview" element={<OverviewPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="workloads" element={<WorkloadsOverviewPage />} />
          <Route path="nodes" element={<NodesPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="apis" element={<APIResourcesPage />} />
          <Route path="custom" element={<CustomResourcesPage />} />
          <Route path="terminal" element={<TerminalLauncherPage />} />
          <Route path="portforwards" element={<PortForwardsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:section" element={<SettingsPage />} />

          {/* Auto-generated routes for every resource in the sidebar */}
          {SECTIONS.flatMap((s) => s.items).filter((it) => it.gvr).map((it) => (
            <Route
              key={it.to}
              path={it.to}
              element={<ResourceListPage key={it.to} title={it.label} gvr={it.gvr!} namespaced={!!it.namespaced} />}
            />
          ))}

          <Route
            path="resource/:group/:version/:resource/:name"
            element={<ResourceDetailPage />}
          />
          <Route
            path="resource/:group/:version/:resource/ns/:namespace/:name"
            element={<ResourceDetailPage />}
          />
          <Route
            path="pods/ns/:namespace/:name/logs"
            element={<PodLogsPage />}
          />
          <Route
            path="pods/ns/:namespace/:name/exec"
            element={<PodExecPage />}
          />
          <Route
            path="pods/ns/:namespace/:name/attach"
            element={<PodExecPage mode="attach" />}
          />

          <Route path="*" element={<Navigate to={lastPage[cluster] || "overview"} replace />} />
        </Routes>
        </main>
        <DetailPanelHost />
        </div>
        <BottomPaneHost />
      </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

const SIDEBAR_WIDTH_KEY = "k8s-view:sidebar-width:v1";
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 260;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_MAX;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(window.innerWidth * 0.45)));
}

function readSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  try {
    const raw = Number.parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "", 10);
    return clamp(Number.isFinite(raw) ? raw : SIDEBAR_DEFAULT, SIDEBAR_MIN, maxSidebarWidth());
  } catch {
    return SIDEBAR_DEFAULT;
  }
}
