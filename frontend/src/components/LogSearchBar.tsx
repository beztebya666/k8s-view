// LogSearchBar — search input with the same controls Lens / VS Code expose:
// case-sensitive (Aa), regex (.*), match counter ("3 of 12"), prev/next
// navigation (↑/↓), and clear (×). Also doubles as the line filter — lines
// without a match are hidden from the rendered set, same as Lens.
//
// The component is purely presentational; it doesn't touch the buffer. The
// caller decides whether to filter on the query, and feeds back the live
// match counter so we can surface "X of Y".

import clsx from "clsx";
import { CaseSensitive, ChevronDown, ChevronUp, Filter, Regex, Search, X } from "lucide-react";

export type LogSearchValue = {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  /** When true, lines that don't match `query` are hidden from the rendered
   *  set (Lens "filter mode"). When false (default), every line is kept and
   *  matches are only highlighted / navigable — useful for keeping context
   *  around the hits. */
  filter: boolean;
};

export const EMPTY_SEARCH: LogSearchValue = {
  query: "",
  caseSensitive: false,
  regex: false,
  filter: false,
};

type Props = {
  value: LogSearchValue;
  onChange: (next: LogSearchValue) => void;
  matchCount: number;
  activeIndex: number;
  onPrev: () => void;
  onNext: () => void;
  /** True when `query` was supplied as a regex but failed to compile. */
  invalid?: boolean;
  className?: string;
};

export function LogSearchBar({
  value, onChange, matchCount, activeIndex, onPrev, onNext, invalid, className,
}: Props) {
  const update = (patch: Partial<LogSearchValue>) => onChange({ ...value, ...patch });
  const has = value.query.length > 0;
  const counter = has
    ? matchCount === 0
      ? "0 / 0"
      : `${activeIndex + 1} / ${matchCount}`
    : "";

  return (
    <div className={clsx("flex items-center gap-1", className)}>
      <div
        className={clsx(
          "relative flex items-center gap-1 h-7 px-1.5 rounded-md border bg-bg-soft transition-colors",
          invalid
            ? "border-bad/50 focus-within:border-bad"
            : has
              ? "border-accent/40 focus-within:border-accent"
              : "border-line focus-within:border-accent/40",
        )}
      >
        <ToggleIcon
          active={value.filter}
          title={value.filter ? "Filter mode: hides lines without a match" : "Filter mode: disabled — all lines stay visible"}
          onClick={() => update({ filter: !value.filter })}
        >
          <Filter size={12} />
        </ToggleIcon>
        <ToggleIcon
          active={value.caseSensitive}
          title="Match case (Aa)"
          onClick={() => update({ caseSensitive: !value.caseSensitive })}
        >
          <CaseSensitive size={13} />
        </ToggleIcon>
        <ToggleIcon
          active={value.regex}
          title="Regular expression (.*)"
          onClick={() => update({ regex: !value.regex })}
        >
          <Regex size={13} />
        </ToggleIcon>
        <span className="w-px h-4 bg-line/70 mx-0.5" aria-hidden />
        <Search size={12} className="text-fg-mute shrink-0" />
        <input
          className="bg-transparent outline-none text-xs text-fg placeholder:text-fg-mute w-[220px]"
          placeholder={value.regex
            ? (value.filter ? "Filter regex…  ↵ next" : "Search regex…  ↵ next")
            : (value.filter ? "Filter…  ↵ next" : "Search…  ↵ next")}
          value={value.query}
          onChange={(e) => update({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) onPrev(); else onNext();
            }
            if (e.key === "Escape") {
              if (value.query) {
                e.preventDefault();
                update({ query: "" });
              }
            }
          }}
          spellCheck={false}
          aria-label="Search log lines"
        />
        {has && (
          <span
            className={clsx(
              "text-[10px] tabular-nums shrink-0 px-1",
              invalid ? "text-bad" : matchCount === 0 ? "text-fg-mute" : "text-fg-soft",
            )}
            aria-live="polite"
          >
            {invalid ? "invalid regex" : counter}
          </span>
        )}
        {has && (
          <button
            type="button"
            className="h-5 w-5 grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute rounded"
            title="Clear (Esc)"
            aria-label="Clear search"
            onClick={() => update({ query: "" })}
          >
            <X size={11} />
          </button>
        )}
      </div>
      <NavButton title="Previous match (Shift+Enter)" disabled={!has || matchCount === 0} onClick={onPrev}>
        <ChevronUp size={12} />
      </NavButton>
      <NavButton title="Next match (Enter)" disabled={!has || matchCount === 0} onClick={onNext}>
        <ChevronDown size={12} />
      </NavButton>
    </div>
  );
}

function ToggleIcon({
  active, title, onClick, children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "h-5 w-5 grid place-items-center rounded transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-fg-mute hover:text-fg hover:bg-bg-mute",
      )}
    >
      {children}
    </button>
  );
}

function NavButton({
  disabled, title, onClick, children,
}: {
  disabled: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="h-7 w-7 grid place-items-center rounded-md border border-line bg-bg-soft text-fg-soft hover:text-fg hover:bg-bg-mute disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
