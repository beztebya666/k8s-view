// Stable, deterministic color per cluster name. Used everywhere we need to
// signal "which cluster does this UI element belong to" — sidebar dot, top-tab
// active border, Create-resource pencil icon, etc. The user expects Lens-style
// per-cluster color identity: the same cluster always paints the same hue.
//
// Implementation: FNV-1a 32-bit over the name → hue ∈ [0,360). Saturation and
// lightness are clamped to the small bands that work in both light and dark
// themes (no neon, no muddy browns). Two helpers: `clusterColor()` returns the
// raw HSL string for borders/dots, `clusterColorVars()` returns inline CSS
// custom properties so callers can opt in via `style={...}`.

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
