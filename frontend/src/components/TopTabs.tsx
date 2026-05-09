// TopTabs — Lens-style browser tabs across the very top of the workspace.
//
// Behavioural contract (mirrors Lens / OpenLens):
//   * Every navigation that changes the (cluster, pathname) pair opens a new
//     tab — or focuses the existing tab if one already covers that route.
//   * Query-string changes (the right `?d=` detail panel, the bottom `?b=`
//     pane, `?tab=yaml` inside details) live INSIDE a tab. Switching tabs
//     restores the view-state the user had open in that tab.
//   * Right-click on a tab opens a context menu (Close / Close all / Close
//     other tabs / Close tabs to the right).
//   * Tabs auto-shrink so 20+ fit before horizontal scrolling kicks in.
//
// Performance: no transitions on width, no blurs, no shadows on the tab
// strip itself — the bar repaints on every navigation, so we keep the
// per-tab DOM cheap.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AppWindow, FileText, GaugeCircle, Plus, ScrollText, Settings2, Terminal, X,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { useTabs, type PageTab } from "../stores/tabs";
import { SECTIONS } from "../nav/sections";
import { clusterColor, useClusterColor } from "../lib/clusterColor";

const ROUTE_META: Record<string, { label: string; icon: LucideIcon }> = (() => {
  const m: Record<string, { label: string; icon: LucideIcon }> = {
    overview:     { label: "Cluster Overview", icon: GaugeCircle },
    applications: { label: "Applications",     icon: AppWindow },
    workloads:    { label: "Workloads",        icon: GaugeCircle },
    custom:       { label: "Custom Resources", icon: ScrollText },
    apis:         { label: "API Resources",    icon: Settings2 },
    settings:     { label: "Settings",         icon: Settings2 },
    terminal:     { label: "Terminal",         icon: Terminal },
  };
  for (const section of SECTIONS) {
    for (const item of section.items) {
      if (!m[item.to]) m[item.to] = { label: item.label, icon: item.icon };
    }
  }
  return m;
})();

type TabDescriptor = {
  label: string;
  detail?: string;
  icon: LucideIcon;
};

function describe(tab: PageTab): TabDescriptor {
  const segments = tab.pathname.split("/").filter(Boolean);
  const head = segments[0] ?? "overview";
  if (head === "resource") {
    const resource = segments[3] ?? "";
    const last = decodeURIComponent(segments[segments.length - 1] ?? "");
    const ns = segments[4] === "ns" ? decodeURIComponent(segments[5] ?? "") : undefined;
    return {
      label: last || resource,
      detail: ns ? `${resource} · ${ns}` : resource,
      icon: ROUTE_META[resource]?.icon ?? FileText,
    };
  }
  if (head === "pods" && segments[1] === "ns") {
    const podName = decodeURIComponent(segments[3] ?? "");
    const sub = segments[4];
    return {
      label: podName,
      detail: sub === "logs" ? "logs" : sub === "exec" ? "shell" : sub === "attach" ? "attach" : "pod",
      icon: sub === "logs" ? ScrollText : Terminal,
    };
  }
  if (head === "settings") {
    const section = segments[1];
    return { label: "Settings", detail: section, icon: Settings2 };
  }
  const meta = ROUTE_META[head];
  return {
    label: meta?.label ?? head,
    icon: meta?.icon ?? FileText,
  };
}

function buildPath(tab: PageTab): string {
  return `/${encodeURIComponent(tab.cluster)}/${tab.pathname}${tab.search}`;
}

function parseLocation(pathname: string, searchString: string, fallbackCluster: string): {
  cluster: string;
  pathname: string;
  search: string;
} | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const cluster = decodeURIComponent(parts[0]);
  if (!cluster && !fallbackCluster) return null;
  const sub = parts.slice(1).join("/") || "overview";
  return {
    cluster: cluster || fallbackCluster,
    pathname: sub,
    search: searchString,
  };
}

export function useTabsRouterSync() {
  const location = useLocation();
  const fallbackCluster = useApp((s) => s.cluster);
  const initialized = useRef(false);

  useEffect(() => {
    const current = parseLocation(location.pathname, location.search, fallbackCluster);
    if (!current) return;

    const { tabs, activeId, openTab, openPreview, patchActive, patchTab, selectTab } = useTabs.getState();

    // First sync after mount: deep-link / restore. Don't clobber persisted
    // tabs — focus the matching one if it exists, else fork a new one.
    if (!initialized.current) {
      initialized.current = true;
      const match = tabs.find((t) => t.cluster === current.cluster && t.pathname === current.pathname);
      if (match) {
        if (match.id !== activeId) selectTab(match.id);
        if (match.search !== current.search) patchTab(match.id, { search: current.search });
      } else {
        openTab(current);
      }
      return;
    }

    // Subsequent navigation. Three cases:
    //   1. Same (cluster, pathname) as the active tab — only the query
    //      changed (a detail panel opened, etc.). Patch in place; preview
    //      status is preserved.
    //   2. Different route AND the active tab is a preview — replace the
    //      preview's content in place (Lens / VSCode behaviour). Without
    //      this, clicking a row in a Pods list (which navigates to the
    //      pod's detail route) would commit the preview and stack new
    //      pills as the user clicked around.
    //   3. Otherwise — open or focus a permanent tab, mirroring Lens
    //      behaviour where every cross-cluster nav lands in its own tab.
    const active = tabs.find((t) => t.id === activeId);
    if (active && active.cluster === current.cluster && active.pathname === current.pathname) {
      if (active.search !== current.search) {
        patchActive({ search: current.search });
      }
      return;
    }
    if (active && active.preview) {
      openPreview(current);
      return;
    }
    openTab(current);
  }, [location.pathname, location.search, fallbackCluster]);
}

export function TopTabs() {
  const navigate = useNavigate();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const selectTab = useTabs((s) => s.selectTab);
  const closeTab = useTabs((s) => s.closeTab);
  const closeOthers = useTabs((s) => s.closeOthers);
  const closeToTheRight = useTabs((s) => s.closeToTheRight);
  const closeAll = useTabs((s) => s.closeAll);
  const openTab = useTabs((s) => s.openTab);
  const createTab = useTabs((s) => s.createTab);
  const fallbackCluster = useApp((s) => s.cluster);

  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.clusters });

  const [menu, setMenu] = useState<{ tab: PageTab; index: number; x: number; y: number } | null>(null);

  const createNewTab = useCallback(() => {
    const target = fallbackCluster || clusters?.find((c) => c.current)?.name || clusters?.[0]?.name || "";
    if (!target) return;
    const id = createTab({ cluster: target, pathname: "overview", search: "" });
    const t = useTabs.getState().tabs.find((x) => x.id === id);
    navigate(t ? buildPath(t) : `/${encodeURIComponent(target)}/overview`);
  }, [createTab, navigate, fallbackCluster, clusters]);

  const onSelect = useCallback((tab: PageTab) => {
    if (tab.id === activeId) return;
    selectTab(tab.id);
    navigate(buildPath(tab));
  }, [activeId, selectTab, navigate]);

  const navigateAfterClose = useCallback((nextId: string | null) => {
    if (nextId) {
      const t = useTabs.getState().tabs.find((x) => x.id === nextId);
      if (t) navigate(buildPath(t));
      return;
    }
    // Closed the very last tab — Lens-style behaviour: drop to the home
    // shell instead of conjuring a fresh Overview pill out of thin air.
    // We also wipe the active cluster pointer so RootRedirect goes
    // straight to HomeShell without a one-frame bounce through the
    // remembered cluster's Overview route.
    useApp.getState().setCluster("");
    navigate("/", { replace: true });
  }, [navigate]);

  const onClose = useCallback((tab: PageTab) => {
    const newActive = closeTab(tab.id);
    navigateAfterClose(newActive);
  }, [closeTab, navigateAfterClose]);

  const onAdd = useCallback(() => {
    createNewTab();
  }, [createNewTab]);

  const onMiddleClick = useCallback((e: React.MouseEvent, tab: PageTab) => {
    if (e.button !== 1) return;
    e.preventDefault();
    onClose(tab);
  }, [onClose]);

  const onContextMenu = useCallback((e: React.MouseEvent, tab: PageTab, index: number) => {
    e.preventDefault();
    setMenu({ tab, index, x: e.clientX, y: e.clientY });
  }, []);

  if (tabs.length === 0) return null;

  // Auto-shrink: tabs share the row's width via flex-1 with a sane min/max,
  // and fall back to horizontal scroll once min-width × count exceeds the
  // strip. No JS measurements needed.
  return (
    <div className="h-9 shrink-0 flex items-stretch bg-bg border-b border-line select-none">
      <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto top-tabs-scroll">
        {tabs.map((tab, idx) => (
          <TabPill
            key={tab.id}
            tab={tab}
            idx={idx}
            active={tab.id === activeId}
            onSelect={onSelect}
            onClose={onClose}
            onMiddleClick={onMiddleClick}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
      <button
        type="button"
        className="h-9 w-9 grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute border-l border-line shrink-0"
        onClick={onAdd}
        title="New tab"
        aria-label="New tab"
      >
        <Plus size={14} />
      </button>

      {menu && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          tabCount={tabs.length}
          isLast={menu.index === tabs.length - 1}
          onClose={() => setMenu(null)}
          onAction={(kind) => {
            const target = menu.tab;
            setMenu(null);
            if (kind === "close") {
              onClose(target);
            } else if (kind === "closeOthers") {
              closeOthers(target.id);
              navigate(buildPath(target));
            } else if (kind === "closeRight") {
              closeToTheRight(target.id);
              const nextActive = useTabs.getState().activeId;
              if (nextActive) {
                const t = useTabs.getState().tabs.find((x) => x.id === nextActive);
                if (t) navigate(buildPath(t));
              }
            } else if (kind === "closeAll") {
              closeAll();
              // Same Lens behaviour as closing the last tab via the X —
              // drop to the home shell instead of replacing the strip
              // with a fresh Overview pill the user didn't ask for.
              useApp.getState().setCluster("");
              navigate("/", { replace: true });
            }
          }}
        />
      )}
    </div>
  );
}

// One pill in the top tab strip. Lives in its own component so we can call
// `useClusterColor(tab.cluster)` per pill without breaking the rules-of-
// hooks in the parent's `.map(...)` callback. The hook subscribes to the
// cluster's persisted hue, so flipping the colour in the badge popover
// repaints every tab top-border + icon for that cluster instantly.
function TabPill({
  tab, idx, active, onSelect, onClose, onMiddleClick, onContextMenu,
}: {
  tab: PageTab;
  idx: number;
  active: boolean;
  onSelect: (t: PageTab) => void;
  onClose: (t: PageTab) => void;
  onMiddleClick: (e: React.MouseEvent, t: PageTab) => void;
  onContextMenu: (e: React.MouseEvent, t: PageTab, i: number) => void;
}) {
  const desc = describe(tab);
  const Icon = desc.icon;
  const tint = useClusterColor(tab.cluster);
  const commitTab = useTabs((s) => s.commitTab);
  return (
    <div
      role="tab"
      aria-selected={active}
      className={clsx(
        "group relative flex items-center gap-1.5 pl-2.5 pr-1 cursor-pointer text-xs",
        "border-r border-line",
        "flex-1 basis-0 min-w-[110px] max-w-[200px]",
        active
          ? "bg-bg-soft text-fg"
          : "bg-bg text-fg-soft hover:bg-bg-mute hover:text-fg",
      )}
      onClick={() => onSelect(tab)}
      onDoubleClick={() => commitTab(tab.id)}
      onMouseDown={(e) => onMiddleClick(e, tab)}
      onAuxClick={(e) => onMiddleClick(e, tab)}
      onContextMenu={(e) => onContextMenu(e, tab, idx)}
      title={
        `${desc.label} · ${tab.cluster}${desc.detail ? ` · ${desc.detail}` : ""}`
        + (tab.preview ? " · preview tab (double-click to keep)" : "")
      }
    >
      {active && (
        <span
          className="absolute left-0 right-0 top-0 h-[2px]"
          style={{ background: tint.hsl }}
          aria-hidden
        />
      )}
      <Icon
        size={12}
        strokeWidth={1.7}
        className="shrink-0"
        style={{ color: tint.hsl, opacity: active ? 1 : 0.85 }}
      />
      <span className="min-w-0 flex flex-col leading-tight overflow-hidden">
        <span className={clsx("truncate", tab.preview && "italic")}>{desc.label}</span>
        <span className={clsx("truncate text-[10px] text-fg-mute", tab.preview && "italic")}>
          {tab.cluster}{desc.detail ? ` · ${desc.detail}` : ""}
        </span>
      </span>
      <button
        type="button"
        className={clsx(
          "ml-auto h-5 w-5 rounded grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute shrink-0",
          active ? "opacity-90" : "opacity-0 group-hover:opacity-90",
        )}
        onClick={(e) => { e.stopPropagation(); onClose(tab); }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Close tab"
        aria-label="Close tab"
      >
        <X size={11} />
      </button>
    </div>
  );
}

type ContextAction = "close" | "closeOthers" | "closeRight" | "closeAll";

function TabContextMenu({
  x, y, tabCount, isLast, onClose, onAction,
}: {
  x: number; y: number; tabCount: number; isLast: boolean;
  onClose: () => void;
  onAction: (kind: ContextAction) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({ left: x, top: y }));

  // Keep the menu inside the viewport — Lens does this and it avoids the
  // jitter you'd otherwise see on right-click near the edge.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 6);
    const top  = Math.min(y, window.innerHeight - rect.height - 6);
    setPos({ left: Math.max(4, left), top: Math.max(4, top) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onViewportChange = () => onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[1500] min-w-[180px] rounded-md border border-line bg-bg-soft py-1 text-xs shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ContextItem label="Close"                      onClick={() => onAction("close")} />
      <ContextItem label="Close All"                  onClick={() => onAction("closeAll")} />
      <ContextItem label="Close other tabs"           disabled={tabCount <= 1} onClick={() => onAction("closeOthers")} />
      <ContextItem label="Close tabs to the right"    disabled={tabCount <= 1 || isLast} onClick={() => onAction("closeRight")} />
    </div>,
    document.body,
  );
}

function ContextItem({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "w-full text-left px-3 py-1.5",
        disabled
          ? "text-fg-mute cursor-not-allowed"
          : "text-fg-soft hover:text-fg hover:bg-bg-mute",
      )}
    >
      {label}
    </button>
  );
}
