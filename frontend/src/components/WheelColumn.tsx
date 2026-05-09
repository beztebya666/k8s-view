// WheelColumn — vertical scroll-snap "wheel" picker that replaces fiddly
// numeric inputs (hours / minutes) with a Lens-style scrollable column.
//
// Behaviour:
//   * 5 visible rows, the centre row is the selection.
//   * Scroll-snap-y mandatory + per-item snap-center keeps the picked row
//     locked to the centre line, so flicking lands on a clean integer.
//   * Click any visible row to jump to it. Wheel / touch scrolls smoothly.
//   * Keyboard: Up / Down step by 1, Page Up / Down step by 5, Home / End
//     jump to ends. The row buttons participate in the natural tab order.
//
// Why not a third-party wheel picker: every option in the npm ecosystem
// pulls in a 5–15 KB bundle and its own theming. Snap-scroll has been
// stable in every modern browser since 2018 — a 60-line component is
// enough.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

const ROW_HEIGHT = 28;
const VISIBLE_ROWS = 5;
const COLUMN_HEIGHT = ROW_HEIGHT * VISIBLE_ROWS;
const PAD = (COLUMN_HEIGHT - ROW_HEIGHT) / 2;

type Props = {
  /** Inclusive lower bound. */
  min: number;
  /** Exclusive upper bound. */
  max: number;
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
  /** Render override — defaults to two-digit zero-padded. */
  format?: (n: number) => string;
  className?: string;
};

export function WheelColumn({ min, max, value, onChange, ariaLabel, format, className }: Props) {
  const items = useMemo(() => {
    const out: number[] = [];
    for (let n = min; n < max; n++) out.push(n);
    return out;
  }, [min, max]);

  const ref = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const fmt = format ?? defaultFormat;

  // Keep the scroll position aligned with the external value. When the user
  // is mid-scroll we ignore their input until they settle (programmatic
  // scrolls flag themselves so the onScroll handler doesn't echo them).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = (value - min) * ROW_HEIGHT;
    if (Math.abs(el.scrollTop - target) < 0.5) return;
    programmaticScrollRef.current = true;
    el.scrollTop = target;
    // Flush the flag on the next frame so onScroll (queued from the
    // assignment) doesn't fire onChange in a feedback loop.
    requestAnimationFrame(() => { programmaticScrollRef.current = false; });
  }, [value, min]);

  const onScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const el = ref.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / ROW_HEIGHT);
    const next = clamp(min + idx, min, max - 1);
    if (next !== value) onChange(next);
  }, [min, max, onChange, value]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    let delta = 0;
    if (e.key === "ArrowUp") delta = -1;
    else if (e.key === "ArrowDown") delta = 1;
    else if (e.key === "PageUp") delta = -5;
    else if (e.key === "PageDown") delta = 5;
    else if (e.key === "Home") { e.preventDefault(); onChange(min); return; }
    else if (e.key === "End") { e.preventDefault(); onChange(max - 1); return; }
    if (delta === 0) return;
    e.preventDefault();
    onChange(clamp(value + delta, min, max - 1));
  }, [min, max, value, onChange]);

  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={clsx(
        "relative outline-none focus-visible:ring-2 focus-visible:ring-accent/35 rounded-md",
        className,
      )}
      style={{ height: COLUMN_HEIGHT }}
    >
      {/* Selection guides — top + bottom hairlines around the centre row. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 border-y border-line/60 bg-bg-mute/40"
        style={{ top: PAD, height: ROW_HEIGHT }}
      />
      {/* Top fade so non-selected rows tail off into the surface. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10"
        style={{
          height: PAD,
          background: "linear-gradient(180deg, rgb(var(--bg-soft)) 25%, rgb(var(--bg-soft) / 0) 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
        style={{
          height: PAD,
          background: "linear-gradient(0deg, rgb(var(--bg-soft)) 25%, rgb(var(--bg-soft) / 0) 100%)",
        }}
      />
      <div
        ref={ref}
        onScroll={onScroll}
        className="h-full overflow-y-auto wheel-column-scroll"
        style={{
          scrollSnapType: "y mandatory",
          paddingTop: PAD,
          paddingBottom: PAD,
        }}
      >
        {items.map((n) => (
          <Row key={n} value={n} active={n === value} onPick={() => onChange(n)} format={fmt} />
        ))}
      </div>
    </div>
  );
}

function Row({
  value, active, onPick, format,
}: {
  value: number;
  active: boolean;
  onPick: () => void;
  format: (n: number) => string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // When the active row scrolls *into* view via mouse-wheel, smoothly nudge
  // it so the snap doesn't hop two rows at once on fast scrolls.
  useEffect(() => {
    if (active && ref.current) {
      ref.current.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [active]);

  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onPick}
      className={clsx(
        "w-full grid place-items-center font-mono tabular-nums select-none transition-colors",
        active ? "text-accent text-sm font-semibold" : "text-fg-mute text-xs hover:text-fg",
      )}
      style={{ height: ROW_HEIGHT, scrollSnapAlign: "center" }}
    >
      {format(value)}
    </button>
  );
}

function defaultFormat(n: number): string {
  return n.toString().padStart(2, "0");
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Sticky offset / row metrics — exported for callers that want to align
 *  surrounding chrome (e.g. a colon between two columns) with the centre
 *  row of the wheels. */
export const WHEEL_METRICS = {
  rowHeight: ROW_HEIGHT,
  visibleRows: VISIBLE_ROWS,
  columnHeight: COLUMN_HEIGHT,
  centerOffset: PAD,
} as const;
