// Browser-style page tabs across the top of the workspace. Each tab pins a
// (cluster, pathname, search) triple so the user can hop between several
// resource views — e.g. cluster overview, pods of one cluster, applications
// of another — without losing scroll/filter state in their detail panels.
//
// Persisted to localStorage so tabs survive a page reload (Lens behaviour).

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PageTab = {
  id: string;
  cluster: string;
  /** Path under /:cluster/, e.g. "overview", "pods", "resource/apps/v1/deployments/ns/foo/bar". */
  pathname: string;
  /** Raw query string ("?d=…&tab=yaml") or empty. */
  search: string;
};

export type TabsState = {
  tabs: PageTab[];
  activeId: string | null;

  /** Insert or focus the (cluster, pathname) tab. The query string is treated
   *  as in-tab view state, so an existing tab is reused with its search
   *  refreshed rather than duplicating. Returns the resulting active id. */
  openTab: (tab: Omit<PageTab, "id">) => string;
  /** Like openTab, but always creates a fresh tab (bypasses the
   *  "tab with same route already exists, reuse it" dedup). Used by the
   *  explicit "New tab" button in TopTabs — clicking + with the current
   *  Overview tab focused otherwise looked like a no-op. */
  createTab: (tab: Omit<PageTab, "id">) => string;
  /** Update a specific tab in place. */
  patchTab: (id: string, patch: { cluster?: string; pathname?: string; search?: string }) => void;
  /** Update the active tab in place. Used to mirror router navigation. */
  patchActive: (patch: { cluster?: string; pathname?: string; search?: string }) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => string | null;   // returns id of new active tab (null if none)
  closeOthers: (id: string) => void;
  closeToTheRight: (id: string) => void;
  closeAll: () => void;
  /** Bulk replace — used during hydration to rewrite ids when restoring. */
  reset: (tabs: PageTab[], activeId: string | null) => void;
};

let counter = 0;
function makeId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

function sameRoute(a: { cluster: string; pathname: string }, b: PageTab): boolean {
  return a.cluster === b.cluster && a.pathname === b.pathname;
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,

      openTab: (tab) => {
        const existing = get().tabs.find((t) => sameRoute(tab, t));
        if (existing) {
          // Reuse the tab — refresh its search to whatever the caller passed
          // so the URL the user just navigated to is what they see when they
          // come back to the tab.
          if (existing.search !== tab.search) {
            set((s) => ({
              tabs: s.tabs.map((t) => t.id === existing.id ? { ...t, search: tab.search } : t),
              activeId: existing.id,
            }));
          } else {
            set({ activeId: existing.id });
          }
          return existing.id;
        }
        const id = makeId();
        const next: PageTab = { id, ...tab };
        set((s) => ({ tabs: [...s.tabs, next], activeId: id }));
        return id;
      },

      createTab: (tab) => {
        const id = makeId();
        const next: PageTab = { id, ...tab };
        set((s) => ({ tabs: [...s.tabs, next], activeId: id }));
        return id;
      },

      patchTab: (id, patch) => {
        const { tabs } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const current = tabs[idx];
        const next: PageTab = {
          ...current,
          cluster:  patch.cluster  ?? current.cluster,
          pathname: patch.pathname ?? current.pathname,
          search:   patch.search   ?? current.search,
        };
        if (
          next.cluster === current.cluster
          && next.pathname === current.pathname
          && next.search === current.search
        ) return;
        const replaced = tabs.slice();
        replaced[idx] = next;
        set({ tabs: replaced });
      },

      patchActive: (patch) => {
        const { activeId, patchTab } = get();
        if (!activeId) return;
        patchTab(activeId, patch);
      },

      selectTab: (id) => {
        const t = get().tabs.find((x) => x.id === id);
        if (t) set({ activeId: id });
      },

      closeTab: (id) => {
        const { tabs, activeId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return activeId;
        const next = tabs.filter((_, i) => i !== idx);
        let nextActive = activeId;
        if (activeId === id) {
          const neighbour = next[idx] ?? next[idx - 1] ?? null;
          nextActive = neighbour?.id ?? null;
        }
        set({ tabs: next, activeId: nextActive });
        return nextActive;
      },

      closeOthers: (id) => {
        const tab = get().tabs.find((t) => t.id === id);
        if (!tab) return;
        set({ tabs: [tab], activeId: tab.id });
      },

      closeToTheRight: (id) => {
        const { tabs, activeId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0 || idx === tabs.length - 1) return;
        const next = tabs.slice(0, idx + 1);
        const stillActive = next.some((t) => t.id === activeId);
        set({ tabs: next, activeId: stillActive ? activeId : id });
      },

      closeAll: () => set({ tabs: [], activeId: null }),

      reset: (tabs, activeId) => set({ tabs, activeId }),
    }),
    {
      name: "k8s-view:tabs",
      version: 1,
      partialize: (s) => ({ tabs: s.tabs, activeId: s.activeId }),
    },
  ),
);
