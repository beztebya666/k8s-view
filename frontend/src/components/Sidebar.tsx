import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, ChevronRight, FileUp, Folder, Plus, Search, Star, Terminal, X } from "lucide-react";
import { api, type ClusterInfo } from "../lib/api";
import { useApp } from "../stores/app";
import { useTabs } from "../stores/tabs";
import { SECTIONS, type NavItem, type NavSection } from "../nav/sections";
import { clusterColor, useClusterColor } from "../lib/clusterColor";
import { AddClusterModal } from "./AddClusterModal";
import { ClusterBadge } from "./ClusterBadge";
import { getSnapshot as favSnapshot, listFor, remove as removeFav, reorder as reorderFav, subscribe as subscribeFav } from "../lib/favourites";
import { refToQuery } from "./DetailPanel";
import { useResourceList, type Item } from "../lib/useResourceList";
import { useDismiss } from "../lib/useDismiss";

export function Sidebar({ onNavigate }: { onNavigate: (to: string) => void }) {
  const appCluster = useApp((s) => s.cluster);
  const setCluster = useApp((s) => s.setCluster);
  const navigate = useNavigate();
  const location = useLocation();
  const route = parseRoute(location.pathname, appCluster);
  const queryClient = useQueryClient();
  const { data: clusters = [] } = useQuery({ queryKey: ["clusters"], queryFn: api.clusters });
  const [filter, setFilter] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const quickWrapRef = useRef<HTMLDivElement | null>(null);
  const [addClusterOpen, setAddClusterOpen] = useState(false);
  // Outside-click + Esc dismiss for the quick-actions popover. Same pattern
  // as Topbar's cluster/namespace pickers.
  useDismiss(quickWrapRef, quickOpen, () => setQuickOpen(false));
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(() => new Set([route.cluster]));
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(activeSectionLabels(route.page).map((label) => sectionKey(route.cluster, label))),
  );

  useEffect(() => {
    setExpandedClusters((prev) => new Set(prev).add(route.cluster));
    setExpandedSections((prev) => {
      const next = new Set(prev);
      for (const label of activeSectionLabels(route.page)) next.add(sectionKey(route.cluster, label));
      return next;
    });
  }, [route.cluster, route.page]);

  const visibleSections = useMemo(() => filterSections(SECTIONS, filter), [filter]);

  const toggleCluster = (cluster: string) => {
    setExpandedClusters((prev) => toggleSet(prev, cluster));
  };

  const toggleSection = (cluster: string, label: string) => {
    setExpandedSections((prev) => toggleSet(prev, sectionKey(cluster, label)));
  };

  // Sidebar clicks open a *preview* tab — VSCode/Lens behaviour. The
  // preview tab is replaced in place by the next sidebar click instead of
  // stacking another pill in the strip. The user commits a preview tab to
  // a permanent one by double-clicking the pill, by opening a logs/exec
  // session from it, or by hitting "+ New tab" in the strip.
  const openRoute = (clusterName: string, to: string) => {
    api.selectCluster(clusterName).catch(() => {});
    const path = to.replace(/^\/+/, "");
    useTabs.getState().openPreview({ cluster: clusterName, pathname: path, search: "" });
    navigate(`/${encodeURIComponent(clusterName)}/${path}`);
  };

  const clustersToRender = clusters.length > 0
    ? clusters
    : [{ name: appCluster, current: true, connected: false, version: "" } as ClusterInfo];

  return (
    <nav className="h-full select-none flex flex-col bg-bg-soft">
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          <Logo />
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">k8s-view</div>
            <div className="text-[10px] uppercase tracking-wide text-fg-mute">Navigator</div>
          </div>
        </div>

        <div className="px-2 pb-2">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
            <input
              className="input h-7 w-full pl-7 text-xs"
              placeholder="Find cluster or resource..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>

        <FavouritesSection cluster={appCluster} />

        <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-fg-mute">
          Kubernetes clusters
        </div>

        <div className="pb-3">
          {clustersToRender.map((cluster) => (
            <ClusterSidebarItem
              key={cluster.name}
              cluster={cluster}
              isOpen={expandedClusters.has(cluster.name)}
              isActive={cluster.name === route.cluster}
              onToggleCluster={() => toggleCluster(cluster.name)}
              visibleSections={visibleSections}
              expandedSections={expandedSections}
              filter={filter}
              route={route}
              onToggleSection={(label) => toggleSection(cluster.name, label)}
              onOpenRoute={openRoute}
            />
          ))}
        </div>
      </div>

      <div ref={quickWrapRef} className="relative border-t border-line px-3 pt-2 pb-2">
        {quickOpen && (
          <div className="absolute left-3 bottom-11 z-30 min-w-[200px] rounded-md border border-line bg-bg-soft shadow-xl py-1 whitespace-nowrap">
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg-soft hover:text-fg hover:bg-bg-mute"
              onClick={() => { setQuickOpen(false); onNavigate("terminal"); }}
            >
              <Terminal size={13} className="text-fg-mute" />
              <span>Terminal session</span>
            </button>
            <div className="my-1 border-t border-line/70" />
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg-soft hover:text-fg hover:bg-bg-mute"
              onClick={() => { setQuickOpen(false); setAddClusterOpen(true); }}
            >
              <FileUp size={13} className="text-fg-mute" />
              <span>Add cluster…</span>
            </button>
          </div>
        )}
        <button
          className={clsx(
            "h-8 w-8 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute",
            quickOpen && "bg-bg-mute text-fg",
          )}
          title="Quick actions"
          onClick={() => setQuickOpen(!quickOpen)}
        >
          <Plus size={18} />
        </button>
      </div>
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
              navigate(`/${encodeURIComponent(first)}/overview`);
            }
          }}
        />
      )}
    </nav>
  );
}

// One row for a single cluster in the sidebar. Lives in its own component
// so we can call `useClusterColor(name)` without violating the rules-of-
// hooks in the parent's `.map()` callback. The hook subscribes to the
// cluster's `iconHue` setting, so flipping the colour in the badge
// popover repaints both the rail border and every accent below — without
// it the swatch only painted the badge dot.
function ClusterSidebarItem({
  cluster, isOpen, isActive, onToggleCluster,
  visibleSections, expandedSections, filter, route,
  onToggleSection, onOpenRoute,
}: {
  cluster: ClusterInfo;
  isOpen: boolean;
  isActive: boolean;
  onToggleCluster: () => void;
  visibleSections: NavSection[];
  expandedSections: Set<string>;
  filter: string;
  route: { cluster: string; page: string };
  onToggleSection: (label: string) => void;
  onOpenRoute: (cluster: string, to: string) => void;
}) {
  const tint = useClusterColor(cluster.name);
  return (
    <div className="pb-1">
      <button
        className={clsx(
          "w-full h-8 flex items-center gap-2 px-3 text-sm hover:bg-bg-mute transition-colors",
          isActive ? "text-fg" : "text-fg-soft",
        )}
        onClick={onToggleCluster}
      >
        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ClusterBadge
          name={cluster.name}
          size={14}
          filled={cluster.connected}
          title={cluster.connected ? "connected — click to customise icon" : "offline — click to customise icon"}
        />
        <span className="min-w-0 flex-1 text-left truncate">{cluster.name}</span>
        {cluster.version && (
          <span className="max-w-[68px] truncate text-[10px] text-fg-mute">{cluster.version}</span>
        )}
      </button>

      {isOpen && (
        <div
          className="ml-4"
          style={{ borderLeft: `1px solid ${tint.bg}` }}
        >
          {visibleSections.map((section, sectionIdx) => {
            const sectionId = section.label ?? `__headerless_${sectionIdx}`;
            const key = sectionKey(cluster.name, sectionId);
            // Headerless sections (label undefined) are always expanded —
            // the user has nothing to collapse, and Lens surfaces these
            // rows directly without the toggle.
            const sectionOpen = !section.label
              || expandedSections.has(key)
              || filter.trim().length > 0;
            return (
              <ClusterSection
                key={sectionId}
                cluster={cluster}
                section={section}
                activeCluster={route.cluster}
                activePage={route.page}
                accent={tint.hsl}
                open={sectionOpen}
                onToggle={() => section.label && onToggleSection(section.label)}
                onOpen={onOpenRoute}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClusterSection({
  cluster,
  section,
  activeCluster,
  activePage,
  accent,
  open,
  onToggle,
  onOpen,
}: {
  cluster: ClusterInfo;
  section: NavSection;
  activeCluster: string;
  activePage: string;
  accent: string;
  open: boolean;
  onToggle: () => void;
  onOpen: (cluster: string, to: string) => void;
}) {
  const sectionActive = cluster.name === activeCluster && section.items.some((it) => it.to === activePage);
  // Headerless sections render the items as a flat row group (Lens-style:
  // Overview/Applications/Nodes at the top, Namespaces/Events between
  // Storage and Access Control). The collapsible header is omitted
  // entirely — there's nothing to fold.
  if (!section.label) {
    return (
      <ul className="py-0.5">
        {section.items.map((item) => (
          <ClusterItem
            key={item.to}
            cluster={cluster.name}
            item={item}
            accent={accent}
            active={cluster.name === activeCluster && item.to === activePage}
            onOpen={onOpen}
            indent={false}
          />
        ))}
      </ul>
    );
  }
  return (
    <div>
      <button
        className={clsx(
          "w-full h-8 flex items-center gap-2 pl-3 pr-3 text-sm hover:bg-bg-mute transition-colors",
          sectionActive ? "text-fg" : "text-fg-soft",
        )}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="min-w-0 flex-1 text-left truncate">{section.label}</span>
        <span className="text-[10px] text-fg-mute">{section.items.length}</span>
      </button>
      {open && (
        <ul className="py-0.5">
          {section.items.map((item) => (
            <ClusterItem
              key={item.to}
              cluster={cluster.name}
              item={item}
              accent={accent}
              active={cluster.name === activeCluster && item.to === activePage}
              onOpen={onOpen}
            />
          ))}
          {section.label === "Custom Resources" && (
            <CustomResourceGroups
              cluster={cluster.name}
              accent={accent}
              onOpen={onOpen}
            />
          )}
        </ul>
      )}
    </div>
  );
}

function ClusterItem({
  cluster,
  item,
  accent,
  active,
  onOpen,
  indent = true,
}: {
  cluster: string;
  item: NavItem;
  accent: string;
  active: boolean;
  onOpen: (cluster: string, to: string) => void;
  /** Whether to indent under a section header. Headerless sections set
   *  this to false so rows align with the section label column. */
  indent?: boolean;
}) {
  const Icon = item.icon;
  return (
    <li>
      <button
        onClick={() => onOpen(cluster, item.to)}
        className={clsx(
          "w-full h-7 flex items-center gap-2 pr-3 text-sm transition-colors border-l-2",
          indent ? "pl-7" : "pl-3",
          active
            ? "bg-bg-mute text-fg"
            : "border-transparent text-fg-soft hover:text-fg hover:bg-bg-mute",
        )}
        style={active ? { borderLeftColor: accent, color: accent } : undefined}
      >
        <Icon size={13} strokeWidth={1.7} className="shrink-0" />
        <span className="min-w-0 truncate text-left">{item.label}</span>
      </button>
    </li>
  );
}

function parseRoute(pathname: string, fallbackCluster: string): { cluster: string; page: string } {
  const parts = pathname.split("/").filter(Boolean);
  return {
    cluster: decodeURIComponent(parts[0] ?? fallbackCluster),
    page: parts[1] ?? "overview",
  };
}

function activeSectionLabels(page: string): string[] {
  return SECTIONS
    .filter((section) => section.items.some((item) => item.to === page))
    .map((s) => s.label)
    .filter((label): label is string => !!label);
}

function sectionKey(cluster: string, label: string): string {
  return `${cluster}:${label}`;
}

function toggleSet(source: Set<string>, value: string): Set<string> {
  const next = new Set(source);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function filterSections(sections: NavSection[], filter: string): NavSection[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => (
        (section.label?.toLowerCase().includes(needle) ?? false)
        || item.label.toLowerCase().includes(needle)
        || item.gvr?.toLowerCase().includes(needle)
      )),
    }))
    .filter((section) => section.items.length > 0);
}

// CustomResourceGroups — Lens-style live tree of CRDs grouped by API
// group. Mounts a CRD watch only for the selected cluster (so the cost
// is one stream per active cluster, not per render). Each group folds
// independently; clicking a CRD jumps to the generic Custom Resources
// page filtered to that GVR.
function CustomResourceGroups({
  cluster,
  accent,
  onOpen,
}: {
  cluster: string;
  accent: string;
  onOpen: (cluster: string, to: string) => void;
}) {
  const { items, ready } = useResourceList(
    cluster,
    "apiextensions.k8s.io/v1/CustomResourceDefinition",
    undefined,
    { enabled: !!cluster },
  );
  const groups = useMemo(() => groupCRDs(items as Item[]), [items]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const toggle = (g: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    return next;
  });
  if (!ready) return null;
  if (groups.length === 0) {
    return (
      <li className="pl-7 pr-3 py-1 text-[10px] text-fg-mute italic">no CRDs</li>
    );
  }
  return (
    <>
      {groups.map((g) => {
        const expanded = openGroups.has(g.name);
        return (
          <li key={g.name}>
            <button
              onClick={() => toggle(g.name)}
              className="w-full h-6 flex items-center gap-1.5 pl-5 pr-3 text-[12px] text-fg-soft hover:text-fg hover:bg-bg-mute"
            >
              {expanded
                ? <ChevronDown size={11} className="text-fg-mute shrink-0" />
                : <ChevronRight size={11} className="text-fg-mute shrink-0" />}
              <Folder size={11} className="text-fg-mute shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{g.name}</span>
              <span className="text-[9px] text-fg-mute">{g.kinds.length}</span>
            </button>
            {expanded && (
              <ul>
                {g.kinds.map((k) => (
                  <li key={`${g.name}/${k.kind}/${k.version}`}>
                    <button
                      onClick={() => onOpen(cluster, customResourceTo(g.name, k.version, k.kind, k.namespaced))}
                      className="w-full h-6 flex items-center gap-1.5 pl-12 pr-3 text-[12px] text-fg-soft hover:text-fg hover:bg-bg-mute"
                      title={`${g.name}/${k.version}/${k.kind}`}
                      style={{ /* leave hover tint alone but stash accent for future highlight if needed */ }}
                    >
                      <span className="min-w-0 truncate text-left">{k.kind}</span>
                      <span className="ml-auto text-[9px] text-fg-mute">{k.version}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
      <li className="sr-only" aria-hidden style={{ borderLeftColor: accent }} />
    </>
  );
}

interface CRDKind {
  kind: string;
  version: string;
  namespaced: boolean;
}

interface CRDGroup {
  name: string;
  kinds: CRDKind[];
}

function groupCRDs(items: Item[]): CRDGroup[] {
  const map = new Map<string, Map<string, CRDKind>>();
  for (const it of items) {
    const spec = (it as any).spec ?? {};
    const groupName = String(spec.group ?? "").trim();
    const kindName = String(spec.names?.kind ?? "").trim();
    if (!groupName || !kindName) continue;
    const versions = (spec.versions ?? []) as any[];
    // Pick the storage version, or fall back to the first served one.
    const storage = versions.find((v) => v?.storage) ?? versions.find((v) => v?.served) ?? versions[0];
    if (!storage?.name) continue;
    const namespaced = spec.scope === "Namespaced";
    let kinds = map.get(groupName);
    if (!kinds) {
      kinds = new Map();
      map.set(groupName, kinds);
    }
    // De-dup if multiple CRDs declare the same kind/version (shouldn't
    // happen but be defensive).
    kinds.set(`${kindName}/${storage.name}`, { kind: kindName, version: String(storage.name), namespaced });
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, kinds]) => ({
      name,
      kinds: [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
    }));
}

function customResourceTo(group: string, version: string, kind: string, namespaced: boolean): string {
  const params = new URLSearchParams();
  params.set("gvr", `${group}/${version}/${kind}`);
  params.set("namespaced", namespaced ? "true" : "false");
  return `custom?${params.toString()}`;
}

function FavouritesSection({ cluster }: { cluster: string }) {
  // useSyncExternalStore picks up additions from anywhere in the app and
  // (via the storage event in `lib/favourites`) cross-tab edits too.
  useSyncExternalStore(subscribeFav, favSnapshot);
  const items = useMemo(() => listFor(cluster), [cluster]);
  const [, setSearchParams] = useSearchParams();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  if (items.length === 0) return null;
  const open = (f: ReturnType<typeof listFor>[number]) => {
    const q = refToQuery({
      group: f.group, version: f.version, resource: f.resource,
      namespace: f.namespace, name: f.name,
    });
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", q);
      next.delete("tab");
      return next;
    });
  };
  return (
    <div className="pb-2">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-fg-mute flex items-center gap-1">
        <Star size={10} className="opacity-70" />
        <span>Favourites</span>
        <span className="ml-auto text-fg-mute/70 normal-case tracking-normal">⌘+1…9</span>
      </div>
      <ul className="px-1">
        {items.map((f, i) => {
          const slotShortcut = i < 9 ? String(i + 1) : "";
          const dragging = dragIdx === i;
          const dropAfter = overIdx === i && dragIdx !== null && dragIdx !== i;
          return (
            <li
              key={`${f.group}/${f.version}/${f.resource}/${f.namespace ?? ""}/${f.name}`}
              className={clsx(
                "group flex items-center",
                dragging && "opacity-40",
                dropAfter && "border-t border-accent/60",
              )}
              draggable
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = "move";
                // Firefox needs a payload to actually start the drag.
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragEnter={() => setOverIdx(i)}
              onDragOver={(e) => { e.preventDefault(); }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null && dragIdx !== i) {
                  reorderFav(cluster, dragIdx, i);
                }
                setDragIdx(null);
                setOverIdx(null);
              }}
            >
              <span
                className={clsx(
                  "shrink-0 w-4 text-center font-mono text-[9px]",
                  i < 9 ? "text-fg-mute/80" : "text-fg-mute/40",
                )}
                aria-hidden
                title={slotShortcut ? `Cmd/Ctrl+${slotShortcut}` : undefined}
              >
                {slotShortcut || "·"}
              </span>
              <button
                className="flex-1 min-w-0 h-7 px-1.5 text-left text-xs text-fg-soft hover:text-fg hover:bg-bg-mute rounded-sm flex items-center gap-2"
                onClick={() => open(f)}
                title={`${f.kind} · ${f.namespace ? `${f.namespace}/` : ""}${f.name}`}
              >
                <span className="chip shrink-0 !h-4 !text-[9px] !px-1">{f.kind}</span>
                <span className="truncate">{f.name}</span>
                {f.namespace && (
                  <span className="text-fg-mute truncate text-[10px] ml-auto pr-1">{f.namespace}</span>
                )}
              </button>
              <button
                className="opacity-0 group-hover:opacity-70 hover:opacity-100 hover:text-bad px-1 text-fg-mute"
                title="Unpin"
                onClick={() => removeFav(f)}
              >
                <X size={11} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <path d="M32 8 L52 20 L52 44 L32 56 L12 44 L12 20 Z"
        fill="none" stroke="url(#lg)" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="32" cy="32" r="6" fill="url(#lg)" />
    </svg>
  );
}
