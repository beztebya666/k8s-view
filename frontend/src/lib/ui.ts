// ui — cross-component layout state that isn't worth a context.
//
// Holds the sidebar open/closed flag (the Topbar hamburger toggles it,
// ClusterShell reads it) and a tiny media-query hook so the shell can
// turn the fixed sidebar into an off-canvas drawer on phones / narrow
// windows without every page re-implementing breakpoints.

import { useEffect, useState } from "react";
import { create } from "zustand";

// Below this the sidebar stops being a permanent column and becomes a
// drawer; the detail panel goes full-width. 860 keeps the 3-pane desktop
// layout on real laptops and tablets in landscape, drawer on phones and
// split-screen windows.
export const NARROW_QUERY = "(max-width: 860px)";

function matches(q: string): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(q).matches;
}

type UIState = {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

export const useUI = create<UIState>((set) => ({
  // Start closed on a narrow first paint so a phone doesn't flash the
  // full sidebar over the content before the effect runs.
  sidebarOpen: !matches(NARROW_QUERY),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));

// Reactive media query. Re-renders the caller when the match flips.
export function useMediaQuery(query: string): boolean {
  const [hit, setHit] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const on = () => setHit(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return hit;
}
