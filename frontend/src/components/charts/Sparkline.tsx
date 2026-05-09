// Sparkline — fixed-size SVG mini-chart. Used inline in table cells next
// to the latest CPU/memory reading. Renders fast (no layout effects, one
// path element) so virtualised tables can afford one per visible row.
//
// Defaults match the row height: 56×14 px, single accent stroke, no axes.
// Pass `points` as plain numbers; the component handles the min/max
// scaling internally and bails out (renders an empty box) when there's
// no signal yet.

import { memo, useMemo } from "react";

type Props = {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
  /** Stroke color override; defaults to currentColor. */
  stroke?: string;
};

export const Sparkline = memo(function Sparkline({
  values, width = 56, height = 14, className, stroke,
}: Props) {
  const path = useMemo(() => buildPath(values, width, height), [values, width, height]);
  if (!path) {
    return <span className={className} style={{ width, height, display: "inline-block" }} />;
  }
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="trend"
    >
      <path d={path} fill="none" stroke={stroke ?? "currentColor"} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});

function buildPath(values: readonly number[], w: number, h: number): string | null {
  if (values.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  // Flat series — render a horizontal line in the middle so the user
  // still sees "we have data, it's stable" instead of an empty box.
  if (max === min) {
    const y = h / 2 + 0.5;
    return `M0 ${y}L${w} ${y}`;
  }
  const span = max - min;
  const stepX = w / (values.length - 1);
  const top = 1.5;
  const bottom = h - 1.5;
  const usable = bottom - top;
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const x = i * stepX;
    const y = top + (1 - (v - min) / span) * usable;
    d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
  }
  return d;
}
