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
//
// Two layers of colour beyond that:
//   * severity — the body tints red / amber / dim by detected log level
//     (error · warn · debug) so a wall of logs is triage-able at a glance;
//   * pretty JSON — when the toggle is on AND the body is a single JSON
//     object/array, it's re-indented and syntax-highlighted. Anything
//     that isn't clean JSON is left byte-for-byte as it arrived.

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

// ---- severity -------------------------------------------------------------

type Severity = "error" | "warn" | "debug" | "info";

const SEVERITY_COLOR: Record<Severity, string | undefined> = {
  error: "#fca5a5", // red-300
  warn: "#fcd34d", // amber-300
  debug: "#94a3b8", // slate-400 (dim — debug/trace is noise by default)
  info: undefined, // inherit the panel's default green
};

// Look only at the head of the line — structured loggers put the level
// up front (`level=error`, `"level":"warn"`, `[ERROR]`, `E0518 ...`) and
// scanning the whole body would mis-fire on payloads that merely contain
// the word "error".
function severityOf(body: string): Severity {
  const head = body.slice(0, 160);
  if (/\b(error|fatal|panic|emerg|crit(ical)?)\b/i.test(head)
    || /"level"\s*:\s*"(error|fatal|panic|critical)"/i.test(head)
    || /\blevel=(error|fatal|panic|critical)\b/i.test(head)
    || /(^|\s)[EF]\d{4}\b/.test(head)) {
    return "error";
  }
  if (/\b(warn|warning)\b/i.test(head)
    || /"level"\s*:\s*"warn(ing)?"/i.test(head)
    || /\blevel=warn(ing)?\b/i.test(head)
    || /(^|\s)W\d{4}\b/.test(head)) {
    return "warn";
  }
  if (/\b(debug|trace)\b/i.test(head)
    || /"level"\s*:\s*"(debug|trace)"/i.test(head)
    || /\blevel=(debug|trace)\b/i.test(head)) {
    return "debug";
  }
  return "info";
}

// ---- pretty JSON ----------------------------------------------------------

// Only treat the body as JSON when, trimmed, it's a single object/array
// literal — that's the structured-logging case. A line like
// `started server {"addr":":8080"}` is intentionally NOT reformatted:
// the user asked for non-JSON to be left exactly as-is, and partial
// reformatting would be worse than none.
function parseJsonBody(body: string): unknown | undefined {
  const t = body.trim();
  if (t.length < 2) return undefined;
  const c0 = t[0];
  if (c0 !== "{" && c0 !== "[") return undefined;
  const cN = t[t.length - 1];
  if ((c0 === "{" && cN !== "}") || (c0 === "[" && cN !== "]")) return undefined;
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

const JSON_COLOR = {
  key: "#7dd3fc", // sky-300
  string: "#86efac", // green-300
  number: "#fdba74", // orange-300
  keyword: "#c4b5fd", // violet-300 (true / false / null)
  punct: "#64748b", // slate-500
};

// Recursively emit a 2-space-indented, colour-tokenised JSON tree. Output
// is plain text + <span> colour, rendered inside the row's pre context so
// newlines/indentation render literally.
function renderJson(value: unknown, indent: number, out: React.ReactNode[], keySeq: { n: number }): void {
  const pad = "  ".repeat(indent);
  const padIn = "  ".repeat(indent + 1);
  const punct = (s: string) => <span key={`p${keySeq.n++}`} style={{ color: JSON_COLOR.punct }}>{s}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push(punct("[]")); return; }
    out.push(punct("["), "\n");
    value.forEach((v, i) => {
      out.push(padIn);
      renderJson(v, indent + 1, out, keySeq);
      out.push(i < value.length - 1 ? punct(",") : "", "\n");
    });
    out.push(pad, punct("]"));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) { out.push(punct("{}")); return; }
    out.push(punct("{"), "\n");
    entries.forEach(([k, v], i) => {
      out.push(
        padIn,
        <span key={`k${keySeq.n++}`} style={{ color: JSON_COLOR.key }}>{JSON.stringify(k)}</span>,
        punct(": "),
      );
      renderJson(v, indent + 1, out, keySeq);
      out.push(i < entries.length - 1 ? punct(",") : "", "\n");
    });
    out.push(pad, punct("}"));
    return;
  }
  out.push(<span key={`v${keySeq.n++}`} style={{ color: scalarColor(value) }}>{scalarText(value)}</span>);
}

function scalarColor(v: unknown): string {
  if (typeof v === "string") return JSON_COLOR.string;
  if (typeof v === "number") return JSON_COLOR.number;
  return JSON_COLOR.keyword; // boolean | null
}
function scalarText(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

// ---- logfmt ---------------------------------------------------------------

// logfmt — `key=value key2="quoted value" n=3` — the other structured log
// format. Same toggle as JSON: when it's on and the line isn't JSON but
// reads as logfmt, the key=value pairs get tokenised and coloured. Pure
// prose is left alone.
type LogfmtTok =
  | { t: "text"; s: string }
  | { t: "key"; s: string }
  | { t: "eq" }
  | { t: "val"; s: string; kind: "string" | "number" | "keyword" | "plain" };

const LOGFMT_PAIR = /([A-Za-z_][\w.\-]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g;

function parseLogfmt(body: string): LogfmtTok[] | null {
  const trimmed = body.trim();
  if (trimmed.length < 5) return null;
  const out: LogfmtTok[] = [];
  let cursor = 0;
  let pairs = 0;
  let matchedChars = 0;
  LOGFMT_PAIR.lastIndex = 0;
  for (let m = LOGFMT_PAIR.exec(body); m; m = LOGFMT_PAIR.exec(body)) {
    const [whole, key, rawVal] = m;
    if (m.index > cursor) out.push({ t: "text", s: body.slice(cursor, m.index) });
    out.push({ t: "key", s: key }, { t: "eq" }, { t: "val", s: rawVal, kind: logfmtValKind(rawVal) });
    cursor = m.index + whole.length;
    pairs++;
    matchedChars += whole.length;
  }
  if (cursor < body.length) out.push({ t: "text", s: body.slice(cursor) });
  // Treat as logfmt only when there are several pairs AND they make up the
  // bulk of the line — keeps a stray `id=7` inside prose from triggering.
  if (pairs < 2 || matchedChars / trimmed.length < 0.5) return null;
  return out;
}

function logfmtValKind(raw: string): "string" | "number" | "keyword" | "plain" {
  if (raw.length >= 2 && raw[0] === '"') return "string";
  if (/^-?\d+(\.\d+)?$/.test(raw)) return "number";
  if (raw === "true" || raw === "false" || raw === "null") return "keyword";
  return "plain";
}

function LogfmtBody({ toks }: { toks: LogfmtTok[] }) {
  return (
    <span>
      {toks.map((tok, i) => {
        if (tok.t === "text") return <span key={i}>{tok.s}</span>;
        if (tok.t === "key") return <span key={i} style={{ color: JSON_COLOR.key }}>{tok.s}</span>;
        if (tok.t === "eq") return <span key={i} style={{ color: JSON_COLOR.punct }}>=</span>;
        const color = tok.kind === "string" ? JSON_COLOR.string
          : tok.kind === "number" ? JSON_COLOR.number
          : tok.kind === "keyword" ? JSON_COLOR.keyword
          : undefined;
        return <span key={i} style={color ? { color } : undefined}>{tok.s}</span>;
      })}
    </span>
  );
}

// ---- row ------------------------------------------------------------------

type Props = {
  chunk: LogChunk;
  showTimestamp: boolean;
  showSource: boolean;
  activeMatchIndex: number;
  /** Pretty-print JSON bodies. Independent toggle. */
  prettyJson: boolean;
  /** Tokenise + colour logfmt (key=value) bodies. Independent toggle. */
  logfmt: boolean;
};

export const LogRow = memo(function LogRow({
  chunk, showTimestamp, showSource, activeMatchIndex, prettyJson, logfmt,
}: Props) {
  const tsColor = "rgb(160, 165, 175)"; // independent of theme — bg is hard black
  const srcColor = sourceColor(chunk.source);
  const bodyColor = SEVERITY_COLOR[severityOf(chunk.body)];

  const json = prettyJson ? parseJsonBody(chunk.body) : undefined;
  const logfmtToks = logfmt && json === undefined ? parseLogfmt(chunk.body) : null;

  return (
    <>
      {showTimestamp && chunk.timestamp && (
        <span style={{ color: tsColor }}>{chunk.timestamp}{" "}</span>
      )}
      {showSource && chunk.source && (
        <span style={{ color: srcColor }}>[{chunk.source}]{" "}</span>
      )}
      {json !== undefined
        ? <JsonBody value={json} />
        : logfmtToks
          ? (
            <span style={bodyColor ? { color: bodyColor } : undefined}>
              <LogfmtBody toks={logfmtToks} />
            </span>
          )
          : (
            <span style={bodyColor ? { color: bodyColor } : undefined}>
              <BodyWithMatches
                body={chunk.body}
                matches={chunk.matches}
                activeMatchIndex={activeMatchIndex}
              />
            </span>
          )}
    </>
  );
});

// Pretty-printed JSON drops inline search highlighting on that one line —
// the match offsets were computed against the raw body and no longer map
// onto the reflowed text. The line is still kept/filtered correctly; only
// the yellow <mark> is omitted, which is the honest trade-off for
// reformatting.
function JsonBody({ value }: { value: unknown }) {
  const out: React.ReactNode[] = [];
  renderJson(value, 0, out, { n: 0 });
  return <span>{out}</span>;
}

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
