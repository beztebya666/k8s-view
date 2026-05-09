// BottomPane — Lens-style logs/shell pane that docks to the bottom of the
// content area. Lives in the `?b=` query param so the right detail panel
// (`?d=`) and the bottom pane are independent — both can be open at once,
// neither steals the whole viewport.
//
// Multi-tab: `?b=` may carry several refs separated by `|`, with `?bt=` (a
// 0-based index) selecting the active one. The `+` menu adds new tabs
// (Terminal session / Create resource); the per-tab `×` closes one tab.
//
// Per-tab ref shape:
//   logs/c/{cluster}/{namespace}/{podName}[/{container}]
//   exec/c/{cluster}/{namespace}/{podName}[/{container}]
//   attach/c/{cluster}/{namespace}/{podName}[/{container}]
//   create/c/{cluster}[/g/{group}/{version}/{Kind}]
// Old URLs without `c/{cluster}` are still accepted and use the active cluster.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { FileCode2, FilePen, FilePlus2, Plus, ScrollText, TerminalSquare, X } from "lucide-react";
import { PodLogsPage } from "../pages/PodLogsPage";
import { PodExecPage } from "../pages/PodExecPage";
import { TerminalLauncherInline } from "../pages/TerminalLauncherPage";
import { YAMLEditPane } from "./YAMLEditPane";
import { CreateResourcePane } from "./CreateResourcePane";
import { clusterColor, useClusterColor } from "../lib/clusterColor";
import { useTabs as useTabsStore } from "../stores/tabs";
import { useApp } from "../stores/app";

const STORAGE_KEY = "k8s-view:bottom-pane-height";
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 340;
const MIN_TOP_WORKSPACE_HEIGHT = 260;

export type BottomAction = "logs" | "exec" | "attach" | "terminal" | "yaml" | "create";

export type BottomRef = {
  action: BottomAction;
  cluster?: string;
  namespace?: string;
  name?: string;
  container?: string;
  /** For action === "yaml": the resource being edited, stored as
   *  `group/version/resource` (group is the literal "core" for the core API).
   *  For action === "create": optional template hint, stored as
   *  `group/version/Kind` (the same shape used by the sidebar/SECTIONS),
   *  used to pick a starter YAML template. */
  gvr?: string;
};

export function parseBottomRef(s: string | null): BottomRef | null {
  if (!s) return null;
  const parts = s.split("/");
  const action = parts[0];
  if (action === "terminal") {
    return { action: "terminal" };
  }
  // Create resource ref: create/c/{cluster}[/g/{group}/{version}/{Kind}]
  if (action === "create") {
    if (parts[1] !== "c" || parts.length < 3) return null;
    const cluster = safeDecode(parts[2]);
    if (!cluster) return null;
    let gvr: string | undefined;
    if (parts[3] === "g" && parts.length >= 7) {
      const group = safeDecode(parts[4]);
      const version = safeDecode(parts[5]);
      const kind = safeDecode(parts[6]);
      if (group !== "" && version && kind) {
        // Restore the leading-slash convention used by the sidebar for the
        // core API ("core" placeholder → empty group, with leading slash).
        gvr = `${group === "core" ? "" : group}/${version}/${kind}`;
      } else if (version && kind) {
        gvr = `/${version}/${kind}`;
      }
    }
    return { action: "create", cluster, gvr };
  }
  // YAML editor ref: yaml/c/{cluster}/{group}/{version}/{resource}/[ns/{ns}/]{name}
  if (action === "yaml") {
    if (parts[1] !== "c" || parts.length < 7) return null;
    const cluster = safeDecode(parts[2]);
    const group = safeDecode(parts[3]);
    const version = safeDecode(parts[4]);
    const resource = safeDecode(parts[5]);
    let namespace: string | undefined;
    let name: string;
    if (parts[6] === "ns") {
      if (parts.length < 9) return null;
      namespace = safeDecode(parts[7]);
      name = safeDecode(parts[8]);
    } else {
      name = safeDecode(parts[6]);
    }
    if (!cluster || !group || !version || !resource || !name) return null;
    return {
      action: "yaml",
      cluster, namespace, name,
      gvr: `${group}/${version}/${resource}`,
    };
  }
  if (action !== "logs" && action !== "exec" && action !== "attach") return null;
  let cluster: string | undefined;
  let ns: string;
  let name: string;
  let container: string | undefined;
  if (parts[1] === "c") {
    if (parts.length < 5) return null;
    cluster = safeDecode(parts[2]);
    ns = parts[3];
    name = parts[4];
    container = parts[5] ? safeDecode(parts[5]) : undefined;
  } else {
    if (parts.length < 3) return null;
    ns = parts[1];
    name = parts[2];
    container = parts[3] ? safeDecode(parts[3]) : undefined;
  }
  if (!ns || !name) return null;
  return {
    action,
    cluster,
    namespace: safeDecode(ns),
    name: safeDecode(name),
    container,
  };
}

export function bottomRefToQuery(r: BottomRef): string {
  if (r.action === "terminal") return "terminal";
  if (r.action === "create") {
    if (!r.cluster) return "";
    const head = `create/c/${encodeURIComponent(r.cluster)}`;
    if (!r.gvr) return head;
    const [group, version, kind] = r.gvr.split("/");
    if (!version || !kind) return head;
    return `${head}/g/${encodeURIComponent(group || "core")}/${encodeURIComponent(version)}/${encodeURIComponent(kind)}`;
  }
  if (r.action === "yaml") {
    if (!r.cluster || !r.gvr || !r.name) return "";
    const [group, version, resource] = r.gvr.split("/");
    const head = `yaml/c/${encodeURIComponent(r.cluster)}/${encodeURIComponent(group || "core")}/${encodeURIComponent(version)}/${encodeURIComponent(resource)}`;
    if (r.namespace) {
      return `${head}/ns/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`;
    }
    return `${head}/${encodeURIComponent(r.name)}`;
  }
  const cluster = r.cluster ? `/c/${encodeURIComponent(r.cluster)}` : "";
  const base = `${r.action}${cluster}/${encodeURIComponent(r.namespace ?? "")}/${encodeURIComponent(r.name ?? "")}`;
  if (r.container) return `${base}/${encodeURIComponent(r.container)}`;
  return base;
}

// parseBottomList — split the raw `?b=` value into individual tab refs,
// dropping any garbage segments so a stale URL never hangs the pane.
export function parseBottomList(s: string | null): BottomRef[] {
  if (!s) return [];
  return s
    .split("|")
    .map(parseBottomRef)
    .filter((x): x is BottomRef => !!x);
}

function refToQuerySegment(r: BottomRef): string {
  return bottomRefToQuery(r);
}

function refsToQuery(rs: BottomRef[]): string {
  return rs.map(refToQuerySegment).join("|");
}

function refsEqual(a: BottomRef, b: BottomRef): boolean {
  return refToQuerySegment(a) === refToQuerySegment(b);
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function tabLabel(r: BottomRef): string {
  if (r.action === "terminal") return "Terminal";
  if (r.action === "create") {
    const cluster = r.cluster ? `${r.cluster} · ` : "";
    if (r.gvr) {
      const kind = r.gvr.split("/").pop();
      return `${cluster}Create ${kind ?? "resource"}`;
    }
    return `${cluster}Create resource`;
  }
  if (r.action === "yaml") {
    const cluster = r.cluster ? `${r.cluster} · ` : "";
    const ns = r.namespace ? `${r.namespace}/` : "";
    return `${cluster}YAML ${ns}${r.name ?? "?"}`;
  }
  const podPart = r.name ?? "?";
  const action = r.action === "logs" ? "Logs" : r.action === "attach" ? "Attach" : "Shell";
  const ctr = r.container ? `:${r.container}` : "";
  const cluster = r.cluster ? `${r.cluster} · ` : "";
  return `${cluster}${action} ${podPart}${ctr}`;
}

function tabIcon(r: BottomRef) {
  if (r.action === "logs") return <ScrollText size={11} />;
  if (r.action === "yaml") return <FileCode2 size={11} />;
  if (r.action === "create") {
    // Cluster-tinted pencil — Lens-style cluster identification at a glance.
    // The hook lives in ClusterTintedIcon so tabIcon stays a plain helper
    // (it's called from .map() callbacks where rules-of-hooks would bite).
    return <ClusterTintedIcon cluster={r.cluster} />;
  }
  return <TerminalSquare size={11} />;
}

function ClusterTintedIcon({ cluster }: { cluster?: string }) {
  const tint = useClusterColor(cluster ?? "");
  const color = cluster ? tint.hsl : undefined;
  return <FilePen size={11} style={color ? { color } : undefined} />;
}

function ClusterTintedFilePlus({ cluster }: { cluster: string }) {
  const tint = useClusterColor(cluster);
  return <FilePlus2 size={12} style={{ color: tint.hsl }} />;
}

export function BottomPaneHost() {
  const [params, setParams] = useSearchParams();
  const refs = parseBottomList(params.get("b"));
  const rawIdx = Number(params.get("bt") ?? 0);
  const activeIdx = Number.isFinite(rawIdx) && rawIdx >= 0 && rawIdx < refs.length ? rawIdx : 0;

  const setRefs = useCallback((next: BottomRef[], nextIdx?: number) => {
    const np = new URLSearchParams(params);
    if (next.length === 0) {
      np.delete("b");
      np.delete("bt");
    } else {
      np.set("b", refsToQuery(next));
      const i = nextIdx === undefined
        ? Math.min(activeIdx, next.length - 1)
        : Math.max(0, Math.min(nextIdx, next.length - 1));
      if (i === 0) np.delete("bt");
      else np.set("bt", String(i));
    }
    setParams(np);
  }, [params, setParams, activeIdx]);

  const closeTab = useCallback((i: number) => {
    const next = refs.filter((_, j) => j !== i);
    const nextIdx = next.length === 0 ? 0 : Math.min(activeIdx, next.length - 1);
    setRefs(next, nextIdx);
  }, [refs, activeIdx, setRefs]);

  const closeAll = useCallback(() => setRefs([], 0), [setRefs]);

  const addTab = useCallback((r: BottomRef) => {
    // dedupe — if the tab already exists, just focus it
    const existing = refs.findIndex((x) => refsEqual(x, r));
    if (existing >= 0) {
      setRefs(refs, existing);
      return;
    }
    const next = [...refs, r];
    setRefs(next, next.length - 1);
  }, [refs, setRefs]);

  if (refs.length === 0) return null;

  const active = refs[activeIdx];
  const key = refToQuerySegment(active);
  return (
    <BottomPane
      key={key}
      tabs={refs}
      activeIdx={activeIdx}
      onSelect={(i) => setRefs(refs, i)}
      onCloseTab={closeTab}
      onCloseAll={closeAll}
      onAddTab={addTab}
    />
  );
}

function readStoredHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const n = stored ? Number(stored) : DEFAULT_HEIGHT;
  if (!Number.isFinite(n)) return DEFAULT_HEIGHT;
  return clampHeight(n);
}

function clampHeight(h: number, hostHeight?: number | null): number {
  if (typeof window === "undefined") return Math.max(MIN_HEIGHT, h);
  const usableHeight = hostHeight && Number.isFinite(hostHeight)
    ? hostHeight
    : window.innerHeight - 44;
  const max = Math.max(MIN_HEIGHT, usableHeight - MIN_TOP_WORKSPACE_HEIGHT);
  return Math.max(MIN_HEIGHT, Math.min(max, h));
}

function BottomPane({
  tabs, activeIdx, onSelect, onCloseTab, onCloseAll, onAddTab,
}: {
  tabs: BottomRef[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onCloseTab: (i: number) => void;
  onCloseAll: () => void;
  onAddTab: (r: BottomRef) => void;
}) {
  const [height, setHeight] = useState<number>(readStoredHeight);
  const paneRef = useRef<HTMLElement | null>(null);
  const hostHeightRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const clampForHost = useCallback((h: number) => clampHeight(h, hostHeightRef.current), []);

  useLayoutEffect(() => {
    const updateHostHeight = () => {
      const host = paneRef.current?.parentElement;
      hostHeightRef.current = host ? host.getBoundingClientRect().height : null;
      setHeight((h) => {
        const next = clampHeight(h, hostHeightRef.current);
        if (next !== h) {
          try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
        }
        return next;
      });
    };

    updateHostHeight();

    const host = paneRef.current?.parentElement;
    const ro = host && "ResizeObserver" in window
      ? new ResizeObserver(updateHostHeight)
      : null;
    if (host && ro) ro.observe(host);

    const onResize = () => updateHostHeight();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, []);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    const startY = e.clientY;
    const startH = height;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const dy = startY - ev.clientY;
      const next = clampForHost(startH + dy);
      setHeight(next);
      try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height, clampForHost]);

  const active = tabs[activeIdx];

  return (
    <section
      ref={paneRef}
      className="relative shrink-0 border-t border-line bg-bg flex flex-col"
      style={{ height }}
      role="complementary"
      aria-label="Bottom pane"
    >
      {/* Top resize handle */}
      <div
        className="group absolute -top-[3px] left-0 right-0 h-[6px] z-30 cursor-row-resize"
        onMouseDown={onResizeStart}
        title="Drag to resize"
      >
        <div className="absolute top-[3px] left-0 right-0 h-px bg-line group-hover:bg-accent transition-colors" />
      </div>

      <BottomTabBar
        tabs={tabs}
        activeIdx={activeIdx}
        onSelect={onSelect}
        onCloseTab={onCloseTab}
        onCloseAll={onCloseAll}
        onAddTab={onAddTab}
      />

      {/* All tabs are mounted but only the active one is visible. This keeps
          log buffers / shell sessions alive across switches. */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((t, i) => (
          <div
            key={refToQuerySegment(t)}
            className="absolute inset-0"
            style={{ visibility: i === activeIdx ? "visible" : "hidden" }}
            aria-hidden={i === activeIdx ? undefined : true}
          >
            <BottomTabBody target={t} onClose={() => onCloseTab(i)} />
          </div>
        ))}
        {!active && <div className="p-3 text-fg-mute text-sm">no tab selected</div>}
      </div>
    </section>
  );
}

function BottomTabBody({ target, onClose }: { target: BottomRef; onClose: () => void }) {
  if (target.action === "logs") {
    return (
      <PodLogsPage
        clusterOverride={target.cluster}
        ns={target.namespace!}
        podName={target.name!}
        initialContainer={target.container}
        onClose={onClose}
      />
    );
  }
  if (target.action === "exec") {
    return (
      <PodExecPage clusterOverride={target.cluster} ns={target.namespace!} podName={target.name!} onClose={onClose} />
    );
  }
  if (target.action === "attach") {
    return (
      <PodExecPage mode="attach" clusterOverride={target.cluster} ns={target.namespace!} podName={target.name!} onClose={onClose} />
    );
  }
  if (target.action === "terminal") {
    return <TerminalLauncherInline onClose={onClose} />;
  }
  if (target.action === "yaml") {
    return (
      <YAMLEditPane
        cluster={target.cluster!}
        gvr={target.gvr!}
        namespace={target.namespace}
        name={target.name!}
        onClose={onClose}
      />
    );
  }
  if (target.action === "create") {
    return (
      <CreateResourcePane
        cluster={target.cluster!}
        templateGvr={target.gvr}
        onClose={onClose}
      />
    );
  }
  return null;
}

function BottomTabBar({
  tabs, activeIdx, onSelect, onCloseTab, onCloseAll, onAddTab,
}: {
  tabs: BottomRef[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onCloseTab: (i: number) => void;
  onCloseAll: () => void;
  onAddTab: (r: BottomRef) => void;
}) {
  return (
    <div className="h-9 shrink-0 border-b border-line bg-bg-soft flex items-center gap-1 pl-2 pr-2 select-none">
      <div className="flex items-center gap-1 overflow-x-auto min-w-0">
        {tabs.map((t, i) => (
          <BottomTabHandle
            key={refToQuerySegment(t) + ":" + i}
            tab={t}
            active={i === activeIdx}
            tabCount={tabs.length}
            onSelect={() => onSelect(i)}
            onClose={() => onCloseTab(i)}
          />
        ))}
        <AddTabButton onAdd={onAddTab} />
      </div>
      <button
        className="ml-auto h-6 w-6 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
        onClick={onCloseAll}
        title="Close all tabs"
        aria-label="Close all tabs"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function BottomTabHandle({
  tab, active, tabCount, onSelect, onClose,
}: {
  tab: BottomRef; active: boolean; tabCount: number; onSelect: () => void; onClose: () => void;
}) {
  // Tab width scales with tab count: with 1–3 tabs we let them be as wide as
  // their label so a full pod-hash is visible at a glance; once the user
  // has 7+ tabs we tighten back down so the bar doesn't become a sea of
  // horizontal scroll.
  const maxW =
    tabCount <= 3 ? "max-w-[480px]" :
    tabCount <= 6 ? "max-w-[320px]" :
                    "max-w-[220px]";
  return (
    <div
      className={[
        "group inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded border text-xs cursor-pointer transition-colors",
        maxW,
        active
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-line bg-bg hover:bg-bg-mute text-fg-soft hover:text-fg",
      ].join(" ")}
      onClick={onSelect}
      title={tabLabel(tab)}
    >
      <span className="opacity-80">{tabIcon(tab)}</span>
      <span className="truncate">{tabLabel(tab)}</span>
      <button
        className="ml-1 h-4 w-4 rounded hover:bg-bg-mute flex items-center justify-center opacity-50 group-hover:opacity-100"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close tab"
        aria-label="Close tab"
      >
        <X size={10} />
      </button>
    </div>
  );
}

function AddTabButton({ onAdd }: { onAdd: (r: BottomRef) => void }) {
  const cluster = useApp((s) => s.cluster);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // The tab bar wraps the + button in an `overflow-x-auto` container, which
  // also clips overflow on the Y axis (CSS treats overflow-x:auto as
  // overflow-y:auto for layout). Without portalling, the dropdown shows up
  // as a 2-pixel sliver below the tab bar — the artefact in the
  // bug-report screenshot. Portalling to <body> with absolute coordinates
  // taken from the button's bounding rect avoids the clip entirely.
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      const menuW = 220;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8));
      const top = rect.bottom + 4;
      setPos({ left, top });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute shrink-0"
        onClick={() => setOpen((s) => !s)}
        title="New tab"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={13} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[1500] min-w-[220px] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] py-1 text-xs"
          style={{ left: pos.left, top: pos.top }}
        >
          <MenuItem
            icon={<TerminalSquare size={12} />}
            label="Terminal session"
            onClick={() => { setOpen(false); onAdd({ action: "terminal" }); }}
          />
          <MenuItem
            icon={<ClusterTintedFilePlus cluster={cluster} />}
            label={`Create resource in ${cluster || "cluster"}`}
            onClick={() => {
              setOpen(false);
              if (cluster) onAdd({ action: "create", cluster });
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-mute text-fg-soft hover:text-fg"
      onClick={onClick}
    >
      <span className="opacity-80">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// useBottomPane — small helper for callers that want to push a new tab. Used
// by the Forward button on container ports / detail header buttons / pod row
// actions.
export function useBottomPane() {
  const [params, setParams] = useSearchParams();
  return useMemo(() => ({
    push(r: BottomRef) {
      // Opening a logs / exec / yaml / port-forward / create session is
      // explicit user intent — promote the active preview tab to a
      // permanent one so the next sidebar click doesn't replace the tab
      // out from under the running session. No-op when the active tab is
      // already permanent.
      const activeId = useTabsStore.getState().activeId;
      if (activeId) useTabsStore.getState().commitTab(activeId);

      const refs = parseBottomList(params.get("b"));
      const i = refs.findIndex((x) => refsEqual(x, r));
      const activeIdx = Math.max(0, Number(params.get("bt") ?? 0));
      const np = new URLSearchParams(params);
      if (i >= 0) {
        // Re-clicking the already-active tab closes it; clicking a tab that
        // exists but isn't active just focuses it.
        if (i === activeIdx) {
          const next = refs.filter((_, j) => j !== i);
          if (next.length === 0) {
            np.delete("b"); np.delete("bt");
          } else {
            np.set("b", refsToQuery(next));
            const newIdx = Math.min(activeIdx, next.length - 1);
            if (newIdx === 0) np.delete("bt");
            else np.set("bt", String(newIdx));
          }
        } else {
          if (i === 0) np.delete("bt"); else np.set("bt", String(i));
        }
      } else {
        const next = [...refs, r];
        np.set("b", refsToQuery(next));
        if (next.length - 1 === 0) np.delete("bt");
        else np.set("bt", String(next.length - 1));
      }
      setParams(np);
    },
    toggleSingle(r: BottomRef) {
      // Replace whatever single ref is open with this one, or close it if it's
      // already the only one. Used by the existing detail-page Logs/Shell
      // toggle buttons so they don't pile up tabs on every click.
      const refs = parseBottomList(params.get("b"));
      const np = new URLSearchParams(params);
      if (refs.length === 1 && refsEqual(refs[0], r)) {
        np.delete("b"); np.delete("bt");
      } else {
        np.set("b", refsToQuery([r])); np.delete("bt");
      }
      setParams(np);
    },
    isActive(r: BottomRef) {
      const refs = parseBottomList(params.get("b"));
      const idx = Number(params.get("bt") ?? 0);
      const active = refs[Number.isFinite(idx) && idx >= 0 ? idx : 0];
      return !!active && refsEqual(active, r);
    },
    /** Drop every bottom-pane session that targets the named cluster.
     *  Called from the cluster Disconnect / Remove flows so an open shell,
     *  port-forward, or log tail doesn't keep the WebSocket alive against
     *  a cluster the user just took offline. */
    closeForCluster(cluster: string) {
      const refs = parseBottomList(params.get("b"));
      const remaining = refs.filter((r) => r.cluster !== cluster);
      if (remaining.length === refs.length) return;
      const np = new URLSearchParams(params);
      if (remaining.length === 0) {
        np.delete("b");
        np.delete("bt");
      } else {
        np.set("b", refsToQuery(remaining));
        const activeIdx = Math.max(0, Number(params.get("bt") ?? 0));
        const nextIdx = Math.min(activeIdx, remaining.length - 1);
        if (nextIdx === 0) np.delete("bt");
        else np.set("bt", String(nextIdx));
      }
      setParams(np);
    },
  }), [params, setParams]);
}
