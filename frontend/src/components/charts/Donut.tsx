// Concentric donut chart used by the cluster overview. Each ring shows a
// metric (Usage / Requests / Limits / Allocatable / Capacity) as a fraction
// of the largest value. Pure SVG — no external chart lib so it stays cheap
// for a page that re-renders every metrics tick.

import { memo } from "react";

export type DonutRing = {
  key: string;
  label: string;
  value: number;
  /** When omitted the ring is sized against the donut-wide `max`. */
  max?: number;
  color: string;
};

type Props = {
  rings: DonutRing[];
  /** Outer diameter in px. */
  size?: number;
  ringWidth?: number;
  gap?: number;
  /** Centre text (eg. "21.3%"). Hidden if empty. */
  centerLabel?: string;
};

const TRACK = "rgb(var(--bg-mute))";

export const Donut = memo(function Donut({
  rings, size = 140, ringWidth = 5, gap = 1, centerLabel,
}: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const overallMax = Math.max(...rings.map((r) => r.max ?? r.value), 1);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      role="img"
    >
      {rings.map((ring, idx) => {
        const radius = (size / 2) - 2 - idx * (ringWidth + gap) - ringWidth / 2;
        if (radius <= 0) return null;
        const circumference = 2 * Math.PI * radius;
        const max = ring.max ?? overallMax;
        const fraction = max > 0 ? Math.min(Math.max(ring.value / max, 0), 1) : 0;
        const filled = fraction * circumference;
        const remaining = circumference - filled;
        return (
          <g key={ring.key}>
            <circle
              cx={cx} cy={cy} r={radius}
              fill="none" stroke={TRACK} strokeWidth={ringWidth}
              opacity={0.55}
            />
            {filled > 0.5 && (
              <circle
                cx={cx} cy={cy} r={radius}
                fill="none" stroke={ring.color} strokeWidth={ringWidth}
                strokeLinecap="round"
                strokeDasharray={`${filled} ${remaining}`}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            )}
          </g>
        );
      })}
      {centerLabel && (
        <text
          x={cx} y={cy + 4} textAnchor="middle"
          className="fill-fg"
          style={{ fontSize: 13, fontWeight: 600 }}
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
});
