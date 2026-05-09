// CommandPalette — Cmd-K / Ctrl-K fuzzy nav across pages, resources, and
// actions. Three sources mixed into one ranked list:
//
//   1. Pages — every sidebar item plus the special pages (Overview,
//      Settings, Terminal, Port forwards). Available offline.
//   2. Actions — short verbs ("Switch cluster", "Toggle theme",
//      "Reload data"). Always present.
//   3. Resources — Namespaces / Nodes / Deployments / StatefulSets /
//      DaemonSets / Services / Pods, only when the palette is open
//      AND the user has typed at least one character. Subscriptions are
//      shared with the rest of the app via `useResourceList`, so the
//      cost is one watch per kind even with 150k pods.
//
// Ranking: prefix-of-name > word-start > substring > namespace match.
// Higher tiers always sort above lower; within a tier, alphabetical.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity, Box, ChevronRight, Container, FileCog, Group, Hash, Layers, Network,
  Search as SearchIcon, Server, Sun, Workflow,
} from "lucide-react";
import clsx from "clsx";
import { useApp } from "../stores/app";
import { SECTIONS } from "../nav/sections";
import { useResourceList, type Item } from "../lib/useResourceList";
import { refToQuery, type DetailRef } from "./DetailPanel";

type Tier = 1 | 2 | 3 | 4;

interface Entry {
  id: string;
  title: string;
  subtitle?: string;
  /** Smaller right-aligned tag — usually a kind. */
  badge?: string;
  icon: React.ComponentType<any>;
  /** Stable category for grouping in the list. */
  group: "Resources" | "Pages" | "Actions";
  /** Lower runs first. Used to show Pages before Resources when both match. */
  groupOrder: 0 | 1 | 2;
  onPick: () => void;
  /** Lowercased haystack used by the matcher. */
  haystack: string;
}

interface Match {
  entry: Entry;
  tier: Tier;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const cluster = useApp((s) => s.cluster);
  const setTheme = useApp((s) => s.setTheme);
  const theme = useApp((s) => s.theme);

  // Global hotkey. Cmd-K on macOS, Ctrl-K elsewhere. Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent | globalThis.KeyboardEvent) => {
      const k = e as globalThis.KeyboardEvent;
      const isMod = k.metaKey || k.ctrlKey;
      if (isMod && k.key.toLowerCase() === "k") {
        k.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (k.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Resource subscriptions only when (a) the palette is open, and
  // (b) the user has typed something — opening alone shouldn't fan out
  // multiple cluster-wide watches if the user just brushed Cmd-K.
  const wantsResources = open && query.trim().length > 0 && !!cluster;
  const namespaces = useResourceList(cluster, "/v1/Namespace", undefined, { enabled: wantsResources });
  const nodes = useResourceList(cluster, "/v1/Node", undefined, { enabled: wantsResources });
  const services = useResourceList(cluster, "/v1/Service", undefined, { enabled: wantsResources });
  const deployments = useResourceList(cluster, "apps/v1/Deployment", undefined, { enabled: wantsResources });
  const statefulsets = useResourceList(cluster, "apps/v1/StatefulSet", undefined, { enabled: wantsResources });
  const daemonsets = useResourceList(cluster, "apps/v1/DaemonSet", undefined, { enabled: wantsResources });
  const pods = useResourceList(cluster, "/v1/Pod", undefined, { enabled: wantsResources });

  const close = useCallback(() => setOpen(false), []);

  const openInPanel = useCallback((target: DetailRef) => {
    const q = refToQuery(target);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", q);
      next.delete("tab");
      return next;
    });
  }, [setSearchParams]);

  const goPage = useCallback((to: string) => {
    if (cluster) navigate(`/${encodeURIComponent(cluster)}/${to}`);
  }, [cluster, navigate]);

  const pageEntries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const flat = SECTIONS.flatMap((s) => s.items.map((it) => ({ ...it, section: s.label })));
    for (const it of flat) {
      out.push({
        id: `page:${it.to}`,
        title: it.label,
        subtitle: it.section,
        icon: it.icon,
        group: "Pages",
        groupOrder: 0,
        onPick: () => goPage(it.to),
        haystack: `${it.label} ${it.section}`.toLowerCase(),
      });
    }
    const specials: Array<{ to: string; label: string; icon: any }> = [
      { to: "overview", label: "Overview", icon: Activity },
      { to: "applications", label: "Applications", icon: Box },
      { to: "workloads", label: "Workloads Overview", icon: Layers },
      { to: "events", label: "Events", icon: Activity },
      { to: "terminal", label: "Terminal Launcher", icon: Container },
      { to: "portforwards", label: "Port Forwards", icon: Network },
      { to: "settings", label: "Settings", icon: FileCog },
    ];
    for (const s of specials) {
      if (out.some((e) => e.id === `page:${s.to}`)) continue;
      out.push({
        id: `page:${s.to}`,
        title: s.label,
        icon: s.icon,
        group: "Pages",
        groupOrder: 0,
        onPick: () => goPage(s.to),
        haystack: s.label.toLowerCase(),
      });
    }
    return out;
  }, [goPage]);

  const actionEntries = useMemo<Entry[]>(() => [
    {
      id: "action:theme",
      title: theme === "light" ? "Switch to dark theme" : "Switch to light theme",
      icon: Sun,
      group: "Actions",
      groupOrder: 1,
      onPick: () => setTheme(theme === "light" ? "dark" : "light"),
      haystack: "toggle theme dark light",
    },
  ], [theme, setTheme]);

  const resourceEntries = useMemo<Entry[]>(() => {
    if (!wantsResources) return [];
    const out: Entry[] = [];
    const push = (kind: string, gvr: string, resource: string, group: string, version: string, items: Item[], icon: any, options: { namespaced: boolean; cap?: number }) => {
      const cap = options.cap ?? 200;
      let n = 0;
      for (const it of items) {
        if (n >= cap) break;
        const name = it.metadata?.name;
        if (!name) continue;
        const ns = options.namespaced ? it.metadata?.namespace : undefined;
        const target: DetailRef = { group, version, resource, namespace: ns, name };
        out.push({
          id: `${gvr}:${ns ?? ""}/${name}`,
          title: name,
          subtitle: ns ? `${ns}` : undefined,
          badge: kind,
          icon,
          group: "Resources",
          groupOrder: 2,
          onPick: () => openInPanel(target),
          haystack: `${name} ${ns ?? ""} ${kind}`.toLowerCase(),
        });
        n++;
      }
    };
    push("Namespace", "/v1/Namespace", "namespaces", "core", "v1", namespaces.items as Item[], Hash, { namespaced: false });
    push("Node", "/v1/Node", "nodes", "core", "v1", nodes.items as Item[], Server, { namespaced: false });
    push("Service", "/v1/Service", "services", "core", "v1", services.items as Item[], Network, { namespaced: true });
    push("Deployment", "apps/v1/Deployment", "deployments", "apps", "v1", deployments.items as Item[], Box, { namespaced: true });
    push("StatefulSet", "apps/v1/StatefulSet", "statefulsets", "apps", "v1", statefulsets.items as Item[], Layers, { namespaced: true });
    push("DaemonSet", "apps/v1/DaemonSet", "daemonsets", "apps", "v1", daemonsets.items as Item[], Group, { namespaced: true });
    push("Pod", "/v1/Pod", "pods", "core", "v1", pods.items as Item[], Container, { namespaced: true, cap: 500 });
    return out;
  }, [wantsResources, namespaces.items, nodes.items, services.items, deployments.items, statefulsets.items, daemonsets.items, pods.items, openInPanel]);

  const allEntries = useMemo(() => [...pageEntries, ...actionEntries, ...resourceEntries], [pageEntries, actionEntries, resourceEntries]);

  const matches = useMemo<Match[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Show pages + actions when nothing is typed.
      return allEntries.filter((e) => e.group !== "Resources").map((entry) => ({ entry, tier: 4 as Tier }));
    }
    const out: Match[] = [];
    for (const e of allEntries) {
      const tier = matchTier(q, e.title.toLowerCase(), e.haystack);
      if (tier > 0) out.push({ entry: e, tier: tier as Tier });
    }
    out.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.entry.groupOrder !== b.entry.groupOrder) return a.entry.groupOrder - b.entry.groupOrder;
      return a.entry.title.localeCompare(b.entry.title);
    });
    return out.slice(0, 200);
  }, [query, allEntries]);

  // Reset the highlight whenever the result set shrinks past it.
  useEffect(() => {
    if (highlight >= matches.length) setHighlight(0);
  }, [matches.length, highlight]);

  // Keep the highlighted row visible inside the scrolling list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  if (!open) return null;
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(matches.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[highlight];
      if (m) {
        m.entry.onPick();
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] bg-black/40 backdrop-blur-[1px] flex items-start justify-center pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="w-[min(620px,92vw)] max-h-[70vh] flex flex-col rounded-lg border border-line bg-bg-soft shadow-[0_24px_60px_rgb(0_0_0/0.6)] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line/60 px-3 h-11">
          <SearchIcon size={14} className="text-fg-mute shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            onKeyDown={onInputKey}
            placeholder="Type a page, action, or resource…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-fg-mute"
          />
          <span className="text-[10px] text-fg-mute font-mono">ESC</span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {matches.length === 0 && (
            <div className="px-3 py-6 text-fg-mute text-sm text-center">
              {query ? "No matches" : "Start typing…"}
            </div>
          )}
          {renderGrouped(matches, highlight, (i) => setHighlight(i), () => setOpen(false))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function renderGrouped(matches: Match[], highlight: number, onHover: (i: number) => void, onPicked: () => void) {
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let lastGroup: Entry["group"] | null = null;
  for (const m of matches) {
    if (m.entry.group !== lastGroup) {
      blocks.push(
        <div key={`h:${m.entry.group}:${i}`} className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-fg-mute">
          {m.entry.group}
        </div>,
      );
      lastGroup = m.entry.group;
    }
    const Icon = m.entry.icon;
    const idx = i;
    blocks.push(
      <button
        key={m.entry.id}
        data-idx={idx}
        type="button"
        onMouseMove={() => onHover(idx)}
        onClick={() => { m.entry.onPick(); onPicked(); }}
        className={clsx(
          "w-full px-3 py-1.5 text-sm flex items-center gap-2 text-left",
          highlight === idx ? "bg-bg-mute" : "hover:bg-bg-mute/60",
        )}
      >
        <Icon size={14} className="text-fg-mute shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate">{m.entry.title}</div>
          {m.entry.subtitle && (
            <div className="truncate text-[11px] text-fg-mute">{m.entry.subtitle}</div>
          )}
        </div>
        {m.entry.badge && <span className="chip shrink-0">{m.entry.badge}</span>}
        <ChevronRight size={12} className="text-fg-mute shrink-0" />
      </button>,
    );
    i++;
  }
  return blocks;
}

// matchTier — return the best ranking tier the entry hits, or 0 for no match.
// Tier 1: query is a prefix of the title.
// Tier 2: query is a word-start match in the title.
// Tier 3: query appears anywhere in the title.
// Tier 4: query appears in the broader haystack (subtitle/badge).
function matchTier(q: string, title: string, haystack: string): Tier | 0 {
  if (title.startsWith(q)) return 1;
  if (titleHasWordStart(title, q)) return 2;
  if (title.includes(q)) return 3;
  if (haystack.includes(q)) return 4;
  return 0;
}

function titleHasWordStart(title: string, q: string): boolean {
  // Treat hyphens, slashes, dots, and digits-after-letters as word boundaries
  // so "co" matches "kube-system/coredns" (after "/") and "v1" matches
  // "apps/v1/Deployment" (after "/").
  const re = /(^|[\s\-_/.])([a-z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title)) !== null) {
    const start = m.index + m[1].length;
    if (title.startsWith(q, start)) return true;
  }
  return false;
}
