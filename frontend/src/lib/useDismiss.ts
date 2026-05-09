// useDismiss — close a popup on outside-click or Escape.
//
// Originally lived inline in Topbar; lifted out so menus elsewhere
// (Sidebar quick-actions, kebabs, namespace pickers) all share one
// implementation rather than re-rolling the same useEffect.
//
// We listen on `mousedown` (not `click`) so the menu closes BEFORE the
// click target gets its turn — which is what every native menu does and
// avoids "click on item, menu fires its own onClick AND the dismiss
// closes" double-fire ordering issues.

import { useEffect, type RefObject } from "react";

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}
