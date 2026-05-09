// LogRow — single virtualized log line, rendered as colored spans rather
// than concatenated strings. Decomposes into:
//
//   [timestamp]?  [source]?  body
//
// Timestamp dims to fg-mute. Source name (`[container]` / `[init-cni]` /
// `[main · prev]`) gets a stable hash-coloured bracket so multi-container
// streams are scannable at a glance — same idea as the per-cluster colour
// identity.
//
// The body is split around search hits; active hit gets a brighter
// background ring so the user sees where the cursor is in a 5 000-row
// buffer.

import { memo } from "react";

export type LogChunk = {
  /** Per-line ordinal so React-virtual keys are stable across re-renders. */
  key: string;
  timestamp: string | null;
  source: string | null;
  /** Two complementary forms — the structured body and the rendered body
   *  with search hits already split into ranges. The renderer never has to
   *  re-scan the body for matches. */
  body: string;
  /** Sorted, non-overlapping match ranges within `body`. */
  matches: ReadonlyArray<MatchRange>;
};

export type MatchRange = {
  start: number;
  end: number;
  /** Absolute match index across the full filtered set — used to highlight
   *  the currently active hit. */
  index: number;
};

export const SOURCE_PALETTE = [
  "#7dd3fc", // sky-300
  "#86efac", // green-300
  "#fda4af", // rose-300
  "#fcd34d", // amber-300
  "#c4b5fd", // violet-300
  "#5eead4", // teal-300
  "#fdba74", // orange-300
  "#f0abfc", // fuchsia-300
];

export function sourceColor(name: string | null | undefined): string {
  if (!name) return "#94a3b8"; // slate-400
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return SOURCE_PALETTE[h % SOURCE_PALETTE.length];
}

type Props = {
  chunk: LogChunk;
  showTimestamp: boolean;
  showSource: boolean;
  activeMatchIndex: number;
};

export const LogRow = memo(function LogRow({
  chunk, showTimestamp, showSource, activeMatchIndex,
}: Props) {
  const tsColor = "rgb(160, 165, 175)"; // independent of theme — bg is hard black
  const srcColor = sourceColor(chunk.source);
  return (
    <>
      {showTimestamp && chunk.timestamp && (
        <span style={{ color: tsColor }}>{chunk.timestamp}{" "}</span>
      )}
      {showSource && chunk.source && (
        <span style={{ color: srcColor }}>[{chunk.source}]{" "}</span>
      )}
      <BodyWithMatches
        body={chunk.body}
        matches={chunk.matches}
        activeMatchIndex={activeMatchIndex}
      />
    </>
  );
});

function BodyWithMatches({
  body, matches, activeMatchIndex,
}: {
  body: string;
  matches: ReadonlyArray<MatchRange>;
  activeMatchIndex: number;
}) {
  if (matches.length === 0) return <span>{body}</span>;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) out.push(<span key={`t${cursor}`}>{body.slice(cursor, m.start)}</span>);
    const isActive = m.index === activeMatchIndex;
    out.push(
      <mark
        key={`m${m.start}`}
        data-match-index={m.index}
        className={isActive ? "log-hit log-hit-active" : "log-hit"}
      >
        {body.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  }
  if (cursor < body.length) out.push(<span key={`t${cursor}`}>{body.slice(cursor)}</span>);
  return <>{out}</>;
}
