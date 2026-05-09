// Lightweight SVG area chart with Lens-style hover guide. Renders a filled
// polygon with stroke + Y-axis ticks + dashed reference lines (requests /
// limits). Hover surfaces a vertical guide, a focus dot at the nearest
// sample, and a small floating tooltip with the formatted value and
// timestamp — same affordance Lens / Grafana give the user when scrubbing
// across a time-series.

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export type Point = { t: number; v: number };

export type RefLine = {
  /** Value in the same units as the series. */
  value: number;
  /** Label rendered next to the line on the right. */
  label: string;
  /** Tone — visual differentiation between requests and limits. */
  tone?: "warn" | "bad" | "info";
};

export type Series = {
  /** Label shown in the hover tooltip and (optionally) the chart legend. */
  label: string;
  /** CSS colour string — used for both the stroke and (with opacity) the fill. */
  color: string;
  points: Point[];
};

type Props = {
  /** Single-series shorthand. Mutually exclusive with `series`. */
  points?: Point[];
  /** Multi-series form. Each series renders its own filled+stroked area; the
   *  hover tooltip lists every series at the cursor's timestamp. */
  series?: Series[];
  height?: number;
  /** Tick labels under the chart (formatted timestamps). */
  xTicks?: { x: number; label: string }[];
  /** Format the Y-axis labels. Receives the raw value. */
  formatY?: (v: number) => string;
  loading?: boolean;
  emptyText?: string;
  /** Horizontal reference lines (e.g. requests / limits). When set, the
   *  Y-axis is forced to include the highest reference value plus
   *  headroom, so the lines are always visible above the data. */
  refLines?: RefLine[];
};

const ACCENT = "rgb(var(--accent))";

export const AreaChart = memo(function AreaChart({
  points, series, height = 280, xTicks, formatY = (v) => String(Math.round(v)), loading, emptyText, refLines,
}: Props) {
  // Normalise `points` (single-series) into the multi-series internal form so
  // there's only one render path. Default colour matches the legacy single-
  // series rendering so existing call sites are pixel-identical.
  const normalisedSeries: Series[] = useMemo(() => {
    if (series && series.length > 0) return series;
    return [{ label: "value", color: ACCENT, points: points ?? [] }];
  }, [points, series]);
  const totalPoints = normalisedSeries.reduce((n, s) => n + s.points.length, 0);
  const longest = normalisedSeries.reduce(
    (acc, s) => (s.points.length > acc.points.length ? s : acc),
    normalisedSeries[0],
  );

  const { paths, max, ticks, viewWidth } = useMemo(
    () => buildPaths(normalisedSeries, height, refLines),
    [normalisedSeries, height, refLines],
  );

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ idx: number; px: number; py: number } | null>(null);

  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el || longest.points.length === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Map cursor → nearest sample index on the longest series; other series
    // share the X axis so we look up by matching timestamp later.
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const idx = Math.round(ratio * (longest.points.length - 1));
    const dxPx = longest.points.length > 1 ? rect.width / (longest.points.length - 1) : 0;
    const px = idx * dxPx;
    const py = rect.height - (longest.points[idx].v / max) * (rect.height - 24) - 14;
    setHover({ idx, px, py });
  }, [longest, max]);

  const onLeave = useCallback(() => setHover(null), []);

  // Reset hover when the underlying point set changes shape so the dot
  // doesn't briefly point at a stale index after a refetch.
  useLayoutEffect(() => {
    setHover((h) => (h && h.idx >= longest.points.length ? null : h));
  }, [longest.points.length]);

  if (loading && totalPoints === 0) {
    return (
      <div
        className="grid place-items-center text-sm text-fg-mute border border-line bg-bg-soft rounded"
        style={{ height }}
      >
        Loading metrics…
      </div>
    );
  }
  if (totalPoints === 0) {
    return (
      <div
        className="grid place-items-center text-sm text-fg-mute border border-line bg-bg-soft rounded"
        style={{ height }}
      >
        {emptyText ?? "No data"}
      </div>
    );
  }

  const hoveredAnchor = hover ? longest.points[hover.idx] : null;

  return (
    <div
      ref={wrapRef}
      className="relative w-full"
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <svg
        viewBox={`0 0 ${viewWidth} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        className="block"
      >
        {ticks.map((t) => {
          const y = height - (t / max) * (height - 24) - 14;
          return (
            <g key={t}>
              <line
                x1={0} x2={viewWidth} y1={y} y2={y}
                stroke="rgb(var(--line))" strokeOpacity={0.4} strokeDasharray="2 4"
              />
            </g>
          );
        })}
        {paths.map((p, i) => (
          <g key={`series-${i}`}>
            <path d={p.fillPath} fill={p.color} fillOpacity={0.18} />
            <path d={p.path} fill="none" stroke={p.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {refLines?.map((r, i) => {
          const y = height - (r.value / max) * (height - 24) - 14;
          const stroke = r.tone === "bad" ? "rgb(var(--bad))"
            : r.tone === "warn" ? "rgb(var(--warn))"
              : "rgb(var(--info))";
          return (
            <line
              key={`ref-${i}`}
              x1={0} x2={viewWidth} y1={y} y2={y}
              stroke={stroke} strokeOpacity={0.55} strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {/* Y labels overlay so font stays readable regardless of viewBox stretch. */}
      <div className="absolute inset-y-0 right-1 flex flex-col justify-between py-1 pointer-events-none">
        {[...ticks].reverse().map((t) => (
          <span key={`y-${t}`} className="text-[10px] text-fg-mute">{formatY(t)}</span>
        ))}
      </div>
      {xTicks && xTicks.length > 0 && (
        <div className="absolute inset-x-0 -bottom-4 flex justify-between px-1 text-[10px] text-fg-mute pointer-events-none">
          {xTicks.map((tick, i) => (
            <span key={i}>{tick.label}</span>
          ))}
        </div>
      )}
      {refLines && refLines.length > 0 && (
        <div className="absolute inset-y-0 left-1 flex flex-col py-1 pointer-events-none gap-0.5">
          {refLines.map((r, i) => {
            const y = height - (r.value / max) * (height - 24) - 14;
            const tone = r.tone === "bad" ? "text-bad"
              : r.tone === "warn" ? "text-warn"
                : "text-info";
            return (
              <span
                key={`reflbl-${i}`}
                className={`absolute text-[10px] font-medium px-1 rounded bg-bg/70 whitespace-nowrap ${tone}`}
                style={{ top: y - 7, left: 4 }}
              >
                {r.label} {formatY(r.value)}
              </span>
            );
          })}
        </div>
      )}
      {/* Hover guide + focus dots. Drawn on top in plain HTML/CSS so the
          tooltip can extend outside the SVG without clipping. */}
      {hover && hoveredAnchor && (
        <>
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: hover.px,
              width: 1,
              background: "rgb(var(--fg-mute))",
              opacity: 0.45,
            }}
          />
          {normalisedSeries.map((s, i) => {
            const sample = sampleAt(s.points, hoveredAnchor.t);
            if (!sample) return null;
            const dy = (rectHeightOr(wrapRef.current, height) - 24);
            const py = rectHeightOr(wrapRef.current, height) - (sample.v / max) * dy - 14;
            return (
              <div
                key={`dot-${i}`}
                className="absolute pointer-events-none rounded-full"
                style={{
                  left: hover.px - 4,
                  top: py - 4,
                  width: 8,
                  height: 8,
                  background: s.color,
                  boxShadow: "0 0 0 2px rgb(var(--bg))",
                }}
              />
            );
          })}
          <HoverTooltip
            t={hoveredAnchor.t}
            series={normalisedSeries}
            singleSeries={normalisedSeries.length === 1}
            formatY={formatY}
            anchorPx={hover.px}
            anchorPy={hover.py}
          />
        </>
      )}
    </div>
  );
});

function HoverTooltip({
  t, series, singleSeries, formatY, anchorPx, anchorPy,
}: {
  t: number;
  series: Series[];
  singleSeries: boolean;
  formatY: (v: number) => string;
  anchorPx: number;
  anchorPy: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; flipped: boolean }>({
    left: anchorPx + 10,
    top: Math.max(0, anchorPy - 28),
    flipped: false,
  });

  // Flip the tooltip to the other side of the cursor when it would overflow
  // the chart's right edge. Keep it inside the wrapper bounds so it never
  // gets clipped (the wrapper has `overflow: visible` by default — fine).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const tipRect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const wantsFlip = anchorPx + 10 + tipRect.width > parentRect.width - 4;
    const left = wantsFlip
      ? Math.max(4, anchorPx - 10 - tipRect.width)
      : Math.min(parentRect.width - tipRect.width - 4, anchorPx + 10);
    const top = Math.max(2, Math.min(parentRect.height - tipRect.height - 2, anchorPy - tipRect.height / 2));
    setPos({ left, top, flipped: wantsFlip });
  }, [anchorPx, anchorPy, t]);

  return (
    <div
      ref={ref}
      className="absolute z-10 pointer-events-none rounded-md border border-line bg-bg-soft/95 backdrop-blur-sm px-2 py-1 text-[11px] shadow-[0_4px_14px_rgba(0,0,0,0.35)] whitespace-nowrap"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="text-fg-mute">{formatHoverTime(t)}</div>
      {series.map((s, i) => {
        const sample = sampleAt(s.points, t);
        if (!sample) return null;
        return (
          <div key={`tip-${i}`} className="flex items-center gap-2">
            {!singleSeries && (
              <span className="h-1.5 w-1.5 rounded-sm shrink-0" style={{ background: s.color }} />
            )}
            {!singleSeries && <span className="text-fg-soft">{s.label}</span>}
            <span className="text-fg font-mono ml-auto">{formatY(sample.v)}</span>
          </div>
        );
      })}
    </div>
  );
}

function sampleAt(points: Point[], t: number): Point | null {
  if (points.length === 0) return null;
  // Series share an X axis but may have slightly different sample
  // densities (e.g. a brand-new metrics-server fallback series with fewer
  // points). Find the nearest point by timestamp.
  let best = points[0];
  let bestDist = Math.abs(points[0].t - t);
  for (let i = 1; i < points.length; i++) {
    const d = Math.abs(points[i].t - t);
    if (d < bestDist) { best = points[i]; bestDist = d; }
  }
  return best;
}

function rectHeightOr(el: HTMLElement | null, fallback: number): number {
  if (!el) return fallback;
  const h = el.getBoundingClientRect().height;
  return h > 0 ? h : fallback;
}

function formatHoverTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function buildPaths(series: Series[], height: number, refLines?: RefLine[]) {
  const viewWidth = 1000; // arbitrary; the SVG scales to its container.
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return { paths: [], max: 1, ticks: [], viewWidth };
  }
  // Y-axis must include reference lines (requests/limits) so they're always
  // visible. We DON'T floor the scale at 1 here — for sub-cores CPU a
  // 60-microcore pod would otherwise sit glued to the chart's bottom in a
  // "0..1 cores" range. Fall back to 1 only when every series is genuinely
  // zero, just to avoid divide-by-zero.
  const refMax = refLines?.length ? Math.max(...refLines.map((r) => r.value)) : 0;
  const dataMax = Math.max(...allPoints.map((p) => p.v));
  const peak = Math.max(dataMax, refMax);
  const max = peak > 0 ? peak * 1.1 : 1;
  const yOf = (v: number) => height - (v / max) * (height - 24) - 14;

  const paths = series.map((s) => {
    const pts = s.points;
    if (pts.length === 0) return { path: "", fillPath: "", color: s.color };
    // Each series is plotted on the same X axis (shared longest length) so
    // overlapping series with identical timestamps line up perfectly. A
    // series that's short (e.g. a starting fallback series) still extends
    // proportionally — we don't pad with synthetic points.
    const dx = viewWidth / Math.max(pts.length - 1, 1);
    let path = "";
    for (let i = 0; i < pts.length; i++) {
      const x = i * dx;
      const y = yOf(pts[i].v);
      path += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    const fillPath = path
      + ` L ${(pts.length - 1) * dx} ${height}`
      + ` L 0 ${height} Z`;
    return { path, fillPath, color: s.color };
  });

  // Y-axis ticks: 0, ¼, ½, ¾ of max as raw floats. We deliberately don't
  // Math.round here — for tiny scales (sub-millicore CPU, kilobytes) the
  // rounded ticks collide and the user sees three "1.00" labels stacked.
  // formatY is the right place to decide precision per metric.
  const ticks = [0.25, 0.5, 0.75].map((f) => max * f);
  return { paths, max, ticks, viewWidth };
}
