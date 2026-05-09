// Stable, deterministic color per cluster name. Used everywhere we need to
// signal "which cluster does this UI element belong to" — sidebar dot, top-tab
// active border, Create-resource pencil icon, etc. The user expects Lens-style
// per-cluster color identity: the same cluster always paints the same hue.
//
// Implementation: FNV-1a 32-bit over the name → hue ∈ [0,360). Saturation and
// lightness are clamped to the small bands that work in both light and dark
// themes (no neon, no muddy browns).
//
// Two callsite shapes:
//
//   * `clusterColor(name, hueOverride?)` — pure helper. Use from non-React
//     code (event handlers, render utilities, anything outside a component).
//     When the user has set a custom hue in Settings the caller is
//     responsible for passing it as `hueOverride`.
//   * `useClusterColor(name)` — React hook. Reads the per-device override
//     (`clusterSettings[name].iconHue`) from the global store and re-renders
//     the consumer when it changes. **Prefer this in components** — it's
//     what makes "pick a hue in the badge popover and watch every chip /
//     button / tab in the UI repaint instantly" actually work.

import { useSyncExternalStore } from "react";
import { useApp } from "../stores/app";

const SATURATION = 70;
const LIGHTNESS_DARK  = 60; // for dark theme — colors stay readable on bg
const LIGHTNESS_LIGHT = 45; // for light theme — colors stay readable on bg

export type ClusterColor = {
  /** HSL color suitable for `color`/`background-color`/`border-color`. */
  hsl: string;
  /** A muted version (10% alpha) for backgrounds/halos. */
  bg: string;
  /** Inline CSS custom property bag. */
  vars: { [k: string]: string };
};

export function clusterColor(name: string, hueOverride?: number): ClusterColor {
  const hue = (hueOverride !== undefined && hueOverride >= 0 && hueOverride < 360)
    ? Math.floor(hueOverride)
    : hueFor(name);
  // We render the same hue in both themes; only the lightness shifts. The
  // browser-side theme switch already toggles a `light` class on <html>, so we
  // hand back two values and let the consumer pick (or use the var).
  const dark  = `hsl(${hue}, ${SATURATION}%, ${LIGHTNESS_DARK}%)`;
  const light = `hsl(${hue}, ${SATURATION}%, ${LIGHTNESS_LIGHT}%)`;
  return {
    hsl: dark,
    bg:  `hsl(${hue}, ${SATURATION}%, ${LIGHTNESS_DARK}%, 0.14)`,
    vars: {
      "--cluster-color":       dark,
      "--cluster-color-light": light,
      "--cluster-color-bg":    `hsl(${hue}, ${SATURATION}%, ${LIGHTNESS_DARK}%, 0.14)`,
    },
  };
}

function hueFor(name: string): number {
  // FNV-1a 32-bit. Picked over Math.random / hash() because it's tiny and
  // produces well-distributed buckets across short kubectl-style context names.
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

// useClusterColor — selector hook that pulls the cluster's persisted hue
// override from the app store. We subscribe through useSyncExternalStore so
// only the iconHue field gates re-renders (a flat `useApp((s) => …)` would
// re-fire the consumer on every unrelated store mutation — selectedNamespace,
// search input keystrokes, …, which is what made the per-cluster theming
// "pick a colour" workflow look broken).
export function useClusterColor(name: string): ClusterColor {
  const hue = useSyncExternalStore(
    (cb) => useApp.subscribe(cb),
    () => {
      if (!name) return -1;
      const settings = useApp.getState().clusterSettings[name];
      const value = settings?.iconHue;
      return typeof value === "number" ? value : -1;
    },
    () => -1, // SSR / initial — fall back to deterministic hue.
  );
  return clusterColor(name, hue >= 0 ? hue : undefined);
}
