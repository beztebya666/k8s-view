import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Sun, Moon, Wifi, WifiOff, ChevronDown, FilePen, Settings, FileUp, Trash2, PlugZap, Unplug, Menu } from "lucide-react";
import clsx from "clsx";
import { api, ClusterInfo } from "../lib/api";
import { useApp, useClusterLabel } from "../stores/app";
import { useTabs } from "../stores/tabs";
import { getClusterStream, destroyClusterStream, useClusterConnected } from "../lib/stream";
import { AddClusterModal } from "./AddClusterModal";
import { modals } from "./Modals";
import { notify_ } from "../lib/notifications";
import { clusterColor, useClusterColor } from "../lib/clusterColor";
import { useBottomPane } from "./BottomPane";
import { useDismiss } from "../lib/useDismiss";
import { NavArrows } from "./NavArrows";
import { ClusterTag } from "./ClusterTag";
import { useUI } from "../lib/ui";

type Menu = "cluster" | "ns" | "group" | null;

// Pages that browse API *kinds* rather than namespaced objects — there a
// namespace selector is meaningless, so the Topbar shows a Group picker.
const GROUP_SCOPED_PAGES = new Set(["crds", "custom", "apis"]);

export function Topbar() {
  const cluster = useApp((s) => s.cluster);
  const namespace = useApp((s) => s.namespace);
  const namespaces = useApp((s) => s.namespaces);
  const setNamespaces = useApp((s) => s.setNamespaces);
  const search = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const settings = useApp((s) => s.getClusterSettings(cluster));
  const apiGroup = useApp((s) => s.apiGroup);
  const setApiGroup = useApp((s) => s.setApiGroup);
  const navigate = useNavigate();
  const location = useLocation();
  const { cluster: routeCluster } = useParams();
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  // Second path segment: /:cluster/<page>/...
  const page = location.pathname.split("/").filter(Boolean)[1] ?? "";
  // On /custom the Group picker only fits the kind list; once you drill
  // into a kind (?gvr=…) you're browsing real objects → namespace picker.
  const browsingInstances = page === "custom" && new URLSearchParams(location.search).has("gvr");
  const groupMode = GROUP_SCOPED_PAGES.has(page) && !browsingInstances;

  // Single source of truth for which menu is open — opening one auto-closes
  // the other, so users never see two pickers stacked simultaneously.
  const [openMenu, setOpenMenu] = useState<Menu>(null);
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();
  const bottom = useBottomPane();
  const curTint = useClusterColor(cluster);

  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.clusters });
  const { data: namespaceList } = useQuery({
    enabled: !!cluster,
    queryKey: ["namespaces", cluster],
    queryFn: () => api.namespaces(cluster),
    staleTime: 60_000,
  });
  const selectedNamespaces = namespaces.length > 0 ? namespaces : (namespace ? [namespace] : []);

  // Pool-aware: re-binds across destroy/create cycles (Disconnect+Connect,
  // remove+re-import) so the live/offline badge actually reflects the
  // current stream rather than a dead listener.
  const connected = useClusterConnected(cluster);

  // Auto-cleanup of stale tabs. A tab is "stale" when its cluster either
  // doesn't exist any more (removed from another device / SSO session
  // dropped a kubeconfig) OR is currently disconnected. Disconnect is an
  // explicit "stop touching this cluster" — leaving its tabs around lets
  // a stray sidebar click, an arrow-key tab cycle, or a page restore
  // silently re-attach informers behind the user's back, which is exactly
  // the bug the user reported. So we close them every time the picker
  // refreshes.
  useEffect(() => {
    if (!clusters) return;
    const live = new Set(clusters.filter((c) => !c.paused).map((c) => c.name));
    const stale = useTabs.getState().tabs.filter((t) => !live.has(t.cluster));
    if (stale.length === 0) return;
    const staleNames = new Set(stale.map((t) => t.cluster));
    for (const name of staleNames) {
      destroyClusterStream(name);
      useTabs.getState().closeForCluster(name);
    }
    if (cluster && !live.has(cluster)) {
      useApp.getState().setCluster("");
      navigate("/");
    }
  }, [clusters, cluster, navigate]);

  return (
    <div className="h-11 flex items-center gap-3 px-3 bg-bg-soft min-w-0">
      <button
        type="button"
        className="h-7 w-7 grid place-items-center rounded-md text-fg-soft hover:text-fg hover:bg-bg-mute shrink-0"
        onClick={toggleSidebar}
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        <Menu size={15} />
      </button>
      <NavArrows />
      <ClusterPicker
        clusters={clusters ?? []}
        current={cluster}
        open={openMenu === "cluster"}
        onOpen={(o) => setOpenMenu(o ? "cluster" : null)}
        onSelect={(name) => {
          const target = `/${encodeURIComponent(name)}/${decodeURIComponent(window.location.pathname.split("/").slice(2).join("/")) || "overview"}`;
          api.selectCluster(name).catch(() => {});
          navigate(target);
        }}
        onAdd={() => {
          setOpenMenu(null);
          setAddOpen(true);
        }}
        onDisconnect={async (name) => {
          // Disconnect must FEEL instant. Three traps to avoid:
          //
          //   1) React 18 batches state updates inside event handlers
          //      and commits them only after the handler returns. With
          //      a plain setCluster("") + navigate("/"), the browser
          //      keeps painting the still-mounted ClusterShell (heavy
          //      Overview charts, live metrics) until the handler
          //      finishes. flushSync forces React to commit + paint the
          //      HomeShell synchronously, before we move on.
          //
          //   2) RootRedirect reads the cached ["clusters"] response. If
          //      we navigate("/") *before* clearing cluster=, RootRedirect
          //      sees cluster="default" + cached paused=false and
          //      bounces straight back to /default/overview, mounting
          //      ClusterShell a second time. Wiping cluster=" "" first
          //      short-circuits the inHome check on `!cluster`.
          //
          //   3) bottom.closeForCluster(name) calls setParams, which is
          //      a react-router action keyed off the *current* URL. If
          //      we already navigated to "/", the call could write
          //      params back onto the old route. So when we're leaving
          //      the cluster's own page we skip the bottom-pane URL
          //      mutation — the BottomPaneHost re-reads on remount and
          //      the new URL has no `b=` to begin with.
          if (cluster === name) {
            flushSync(() => {
              useApp.getState().setCluster("");
              navigate("/", { replace: true });
            });
          } else {
            // Different cluster's view stays mounted; just drop its
            // bottom-pane sessions in place.
            bottom.closeForCluster(name);
          }
          destroyClusterStream(name);
          useTabs.getState().closeForCluster(name);
          try {
            await api.disconnectCluster(name);
            await queryClient.removeQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes(name) });
            await queryClient.invalidateQueries({ queryKey: ["clusters"] });
            notify_.info(`Disconnected ${name}`, "Click Connect to resume.");
          } catch (e: any) {
            notify_.bad("Disconnect failed", e?.message ?? String(e));
            await queryClient.invalidateQueries({ queryKey: ["clusters"] });
          }
        }}
        onConnect={async (name) => {
          try {
            await api.connectCluster(name);
            // Wake the pool — create a fresh ClusterStream so the live
            // badge flips back as soon as the WebSocket opens, instead of
            // waiting for some other view (resource list, side panel) to
            // mount and trigger getClusterStream itself.
            getClusterStream(name);
            await queryClient.invalidateQueries({ queryKey: ["clusters"] });
            notify_.ok(`Reconnected ${name}`);
          } catch (e: any) {
            notify_.bad("Connect failed", e?.message ?? String(e));
          }
        }}
        onRemove={async (name) => {
          const ok = await modals.confirm({
            title: `Remove cluster ${name}?`,
            body: "This unregisters the cluster from k8s-view and removes its kubeconfig from this device. The cluster itself is untouched.",
            danger: true,
            okLabel: "Remove",
          });
          if (!ok) return;
          try {
            await api.removeCluster(name);
            // Local cleanup must run BEFORE we invalidate queries so the
            // cluster picker's next render doesn't briefly observe stale
            // tabs / settings pointing at the dead cluster:
            //   1. Tear down the per-cluster WebSocket pool entry. Without
            //      this any open list/detail page would keep reconnecting
            //      to /api/v1/<gone>/stream and 404'ing in the backend log.
            //   2. Drop every tab that pointed at the cluster — leaving
            //      them around would re-mount their resource hooks on the
            //      next render and rebuild the dead stream.
            //   3. Forget local state (settings, last-page, active pointer)
            //      so a re-imported cluster of the same name comes up
            //      fresh instead of inheriting the previous owner's hue.
            destroyClusterStream(name);
            useTabs.getState().closeForCluster(name);
            useApp.getState().forgetCluster(name);
            await queryClient.invalidateQueries({ queryKey: ["clusters"] });
            // Drop any cached per-cluster query (namespaces, events, …) so
            // we don't briefly render stale data on the next route.
            await queryClient.removeQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes(name) });
            notify_.ok(`Removed ${name}`);
            if (cluster === name) {
              navigate("/");
            }
          } catch (e: any) {
            notify_.bad("Remove failed", e?.message ?? String(e));
          }
        }}
      />

      {groupMode ? (
        <GroupPicker
          cluster={cluster}
          value={apiGroup}
          open={openMenu === "group"}
          onOpen={(o) => setOpenMenu(o ? "group" : null)}
          onChange={setApiGroup}
        />
      ) : (
        <NamespacePicker
          value={selectedNamespaces}
          namespaces={mergeNamespaces(namespaceList ?? [], settings.accessibleNamespaces)}
          open={openMenu === "ns"}
          onOpen={(o) => setOpenMenu(o ? "ns" : null)}
          onChange={setNamespaces}
        />
      )}

      <div className="flex-1" />

      <div className="relative shrink-0">
        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
        <input
          className="input pl-7 w-[clamp(140px,22vw,280px)]"
          placeholder="Global search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className={clsx(
        "flex items-center gap-1.5 px-2 h-7 rounded-md text-[11px]",
        connected ? "text-ok bg-ok/10" : "text-bad bg-bad/10",
      )}>
        {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
        {connected ? "live" : "offline"}
      </div>

      <button
        className="btn"
        onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        title="Toggle theme"
      >
        {theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
      </button>

      <button
        className="btn"
        onClick={() => navigate(`/${encodeURIComponent(routeCluster ?? cluster)}/settings/general`)}
        title="Cluster settings"
      >
        <Settings size={13} />
      </button>

      <button
        className="btn"
        onClick={() => {
          const target = routeCluster ?? cluster;
          if (target) bottom.push({ action: "create", cluster: target });
        }}
        title={`Create resource in ${routeCluster ?? cluster}`}
        style={{
          borderColor: curTint.bg,
          background: curTint.bg,
          color: curTint.hsl,
        }}
      >
        <FilePen size={13} style={{ color: curTint.hsl }} /> Create
      </button>

      {addOpen && (
        <AddClusterModal
          onClose={() => setAddOpen(false)}
          onImported={async (names) => {
            setAddOpen(false);
            await queryClient.invalidateQueries({ queryKey: ["clusters"] });
            const first = names[0];
            if (first) {
              api.selectCluster(first).catch(() => {});
              navigate(`/${encodeURIComponent(first)}/overview`);
            }
          }}
        />
      )}
    </div>
  );
}

function mergeNamespaces(apiNamespaces: string[], manualNamespaces: string[]) {
  return [...new Set([...apiNamespaces, ...manualNamespaces])].sort();
}

// GroupPicker — the Topbar selector shown instead of the namespace picker
// on the CRD / API-kind pages. Single-select; "" = all groups, "core" is
// the empty (core/v1) group. Group list is derived from the same
// api-resources query the pages use, so the React-Query cache is shared.
function GroupPicker({
  cluster, value, onChange, open, onOpen,
}: {
  cluster: string;
  value: string;
  onChange: (g: string) => void;
  open: boolean;
  onOpen: (o: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState("");
  useDismiss(ref, open, () => onOpen(false));
  useEffect(() => { if (!open) setFilter(""); }, [open]);

  const { data: resources } = useQuery({
    enabled: !!cluster,
    queryKey: ["apiResources", cluster],
    queryFn: () => api.apiResources(cluster),
    staleTime: 60_000,
  });
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const r of resources ?? []) set.add(r.group || "core");
    return [...set].sort((a, b) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
  }, [resources]);
  const f = filter.toLowerCase();
  const visible = groups.filter((g) => g.toLowerCase().includes(f));

  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => onOpen(!open)}>
        group: <span className="font-medium max-w-[180px] truncate">{value || "all"}</span>
        <ChevronDown size={12} className={clsx("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[320px] bg-bg-soft border border-line rounded-md shadow-xl py-1">
          <input
            autoFocus
            className="input w-[calc(100%-12px)] mx-1.5 mb-1"
            placeholder="filter groups…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className={clsx("w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-mute",
              value === "" && "bg-bg-mute text-accent")}
            onClick={() => { onChange(""); onOpen(false); }}
          >
            <input className="kv-checkbox" type="checkbox" checked={value === ""} readOnly tabIndex={-1} />
            <span className="text-left">All groups</span>
          </button>
          <div className="max-h-[300px] overflow-y-auto">
            {visible.map((g) => (
              <button
                key={g}
                className={clsx("w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-mute font-mono text-xs",
                  value === g && "bg-bg-mute text-accent")}
                onClick={() => { onChange(g); onOpen(false); }}
              >
                <input className="kv-checkbox" type="checkbox" checked={value === g} readOnly tabIndex={-1} />
                <span className="min-w-0 flex-1 text-left truncate">{g}</span>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-2 text-xs text-fg-mute">no groups</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ClusterPicker({
  clusters, current, onSelect, open, onOpen, onAdd, onRemove, onDisconnect, onConnect,
}: {
  clusters: ClusterInfo[]; current: string; onSelect: (n: string) => void;
  open: boolean; onOpen: (o: boolean) => void;
  onAdd: () => void;
  onRemove: (n: string) => void;
  onDisconnect: (n: string) => void;
  onConnect: (n: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, open, () => onOpen(false));
  const cur = clusters.find((c) => c.name === current);
  const curTint = useClusterColor(current || "");
  const currentLabel = useClusterLabel(current);
  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => onOpen(!open)}>
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            background: cur?.connected ? curTint.hsl : "transparent",
            border: cur?.connected ? "none" : `1px solid ${curTint.hsl}`,
          }}
        />
        <span className="font-medium truncate max-w-[180px]">{current ? currentLabel : "no cluster"}</span>
        {current && <ClusterTag cluster={current} />}
        <ChevronDown size={12} className={clsx("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[300px] bg-bg-soft border border-line rounded-md shadow-xl py-1">
          <div className="max-h-[60vh] overflow-y-auto">
            {clusters.length === 0 && (
              <div className="px-3 py-2 text-xs text-fg-mute">No clusters configured</div>
            )}
            {clusters.map((c) => (
              <ClusterRow
                key={c.name}
                info={c}
                isCurrent={c.name === current}
                onSelect={() => { onSelect(c.name); onOpen(false); }}
                onRemove={() => onRemove(c.name)}
                onDisconnect={() => onDisconnect(c.name)}
                onConnect={() => onConnect(c.name)}
              />
            ))}
          </div>
          <div className="mt-1 pt-1 border-t border-line">
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-accent hover:bg-bg-mute"
              onClick={onAdd}
            >
              <FileUp size={13} />
              <span>Add cluster from kubeconfig…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Per-cluster row inside the picker. Lives in its own component so we can
// call `useClusterColor(c.name)` per row without violating the rules-of-
// hooks (a hook in the parent's `.map(...)` callback would be illegal).
function ClusterRow({
  info, isCurrent, onSelect, onRemove, onDisconnect, onConnect,
}: {
  info: ClusterInfo;
  isCurrent: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDisconnect: () => void;
  onConnect: () => void;
}) {
  const tint = useClusterColor(info.name);
  const label = useClusterLabel(info.name);
  // Three visible dot states:
  //   • filled        — connected (the apiserver answered the last probe)
  //   • outlined      — unreachable (apiserver didn't answer; usually a
  //                     network blip or a bad kubeconfig)
  //   • dashed border — paused (the user pressed Disconnect; intentional,
  //                     not a failure)
  const dotStyle: React.CSSProperties = info.connected
    ? { background: tint.hsl }
    : info.paused
      ? { background: "transparent", border: `1px dashed ${tint.hsl}` }
      : { background: "transparent", border: `1px solid ${tint.hsl}` };
  return (
    <div
      className={clsx(
        "group w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-mute",
        isCurrent && "bg-bg-mute",
      )}
    >
      <button
        type="button"
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        onClick={onSelect}
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={dotStyle} />
        <span className={clsx("flex-1 text-left truncate", info.paused && "text-fg-mute")}>
          {label}
        </span>
        <ClusterTag cluster={info.name} size="xs" />
        {info.paused
          ? <span className="text-warn text-[9px] uppercase tracking-wider font-medium">disconnected</span>
          : <span className="text-fg-mute text-[10px]">{info.version || "—"}</span>}
      </button>
      {info.paused ? (
        <button
          type="button"
          className="shrink-0 h-6 w-6 grid place-items-center rounded text-fg-mute opacity-0 group-hover:opacity-100 hover:text-ok hover:bg-ok/10"
          title={`Reconnect ${info.name}`}
          aria-label={`Reconnect ${info.name}`}
          onClick={(e) => { e.stopPropagation(); onConnect(); }}
        >
          <PlugZap size={12} />
        </button>
      ) : (
        <button
          type="button"
          className="shrink-0 h-6 w-6 grid place-items-center rounded text-fg-mute opacity-0 group-hover:opacity-100 hover:text-warn hover:bg-warn/10"
          title={`Disconnect ${info.name} (keeps it in the picker, stops every informer)`}
          aria-label={`Disconnect ${info.name}`}
          onClick={(e) => { e.stopPropagation(); onDisconnect(); }}
        >
          <Unplug size={12} />
        </button>
      )}
      <button
        type="button"
        className="shrink-0 h-6 w-6 grid place-items-center rounded text-fg-mute opacity-0 group-hover:opacity-100 hover:text-bad hover:bg-bad/10"
        title={`Remove cluster ${info.name} (unregisters and deletes the kubeconfig)`}
        aria-label={`Remove cluster ${info.name}`}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function NamespacePicker({
  value, namespaces, onChange, open, onOpen,
}: {
  value: string[]; namespaces: string[]; onChange: (v: string[]) => void;
  open: boolean; onOpen: (o: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState("");
  useDismiss(ref, open, () => onOpen(false));
  useEffect(() => { if (!open) setFilter(""); }, [open]);
  const selected = new Set(value);
  const filterLower = filter.toLowerCase();
  const visible = namespaces.filter((n) => n.toLowerCase().includes(filterLower));
  const label = value.length === 0 ? "all" : value.length === 1 ? value[0] : `${value.length} selected`;
  const toggle = (namespace: string) => {
    const next = new Set(value);
    if (next.has(namespace)) next.delete(namespace);
    else next.add(namespace);
    onChange([...next].sort());
  };
  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => onOpen(!open)}>
        ns: <span className="font-medium max-w-[150px] truncate">{label}</span>
        <ChevronDown size={12} className={clsx("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[300px] bg-bg-soft border border-line rounded-md shadow-xl py-1">
          <input
            autoFocus
            className="input w-[calc(100%-12px)] mx-1.5 mb-1"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className={clsx("w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-mute",
              value.length === 0 && "bg-bg-mute text-accent")}
            onClick={() => onChange([])}
          >
            <input className="kv-checkbox" type="checkbox" checked={value.length === 0} readOnly tabIndex={-1} />
            <span className="text-left">All namespaces</span>
          </button>
          <div className="max-h-[280px] overflow-y-auto">
            {visible.map((n) => (
              <button
                key={n}
                className={clsx("w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-mute",
                  selected.has(n) && "bg-bg-mute text-accent")}
                onClick={() => toggle(n)}
              >
                <input className="kv-checkbox" type="checkbox" checked={selected.has(n)} readOnly tabIndex={-1} />
                <span className="min-w-0 flex-1 text-left truncate">{n}</span>
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-line px-2 pt-2 pb-1 flex items-center gap-2">
            <button className="btn h-7 flex-1 justify-center" onClick={() => onChange([])}>Reset</button>
            <button className="btn-primary h-7 flex-1 justify-center" onClick={() => onOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
