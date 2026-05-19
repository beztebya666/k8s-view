// ResourceTable — virtualized list of any kubernetes resource type.
//
// All rendering happens through TanStack Virtual; the DOM only ever holds
// the ~30 rows that actually fit on screen. Items are sorted/filtered with
// useMemo and the comparison runs on a deduplicated array, so 100k Pods
// scroll fluidly even while a hot informer fires updates.

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, ArrowUp, ArrowDown, MoreVertical, X, type LucideIcon } from "lucide-react";

/**
 * Header chip that pages render next to the title to show the warning count
 * for the current list. Click toggles "warnings first" sort, exposed to the
 * `<ResourceTable>` via the `issuesFirst` prop.
 */
export function WarningsToggle({
  count,
  active,
  onToggle,
}: {
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? "Showing warning rows first" : "Sort warning rows to the top"}
      aria-pressed={active}
      className={clsx(
        "h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs font-medium",
        "border transition-colors",
        active
          ? "border-warn/50 bg-warn/15 text-warn"
          : "border-line text-fg-soft hover:text-warn hover:border-warn/40 hover:bg-warn/5",
      )}
    >
      <AlertTriangle size={13} strokeWidth={2.25} />
      <span>{count.toLocaleString()}</span>
      <span className="text-fg-mute">{count === 1 ? "warning" : "warnings"}</span>
    </button>
  );
}
import { Item, useResourceList } from "../lib/useResourceList";
import { useApp } from "../stores/app";
import { useMediaQuery, NARROW_QUERY } from "../lib/ui";
import { age } from "../lib/format";
import { clusterNow, useNowTick } from "../lib/clock";
import { hrefToQuery } from "./DetailPanel";

/**
 * AgeCell — subscribes to the 1Hz tick *itself* via useNowTick. The tick
 * therefore re-renders only the visible age cells, NOT the whole table.
 * Sort/filter memos in the table never see `now` and stay stable across
 * ticks. With virtualisation only ~30 cells are mounted at any time.
 */
export function AgeCell({ stamp, className }: { stamp?: string; className?: string }) {
  // We don't actually need the returned value — the hook re-renders the
  // component when the tick fires, and `clusterNow()` is read fresh.
  useNowTick();
  return <span className={className ?? "text-fg font-mono text-xs"}>{age(stamp, clusterNow())}</span>;
}

export type Column = {
  key: string;
  label: string;
  width: string;            // any valid CSS grid track value (e.g. "1fr", "120px", "minmax(80px,180px)")
  /** optional columns are available from the column menu but hidden initially */
  defaultVisible?: boolean;
  /** Secondary column auto-hidden on narrow viewports so a small screen
   *  isn't forced into horizontal scrolling for low-value columns. The
   *  column menu still lists it; it just doesn't render while narrow. */
  hideOnNarrow?: boolean;
  /** value used for sorting; defaults to the rendered string */
  sortValue?: (it: Item) => string | number;
  /** how to render the cell. For age-style cells use the exported `<AgeCell>`
   *  component — it subscribes to the 1Hz tick on its own so the table's
   *  sort/filter memos never see `now`. */
  render: (it: Item) => React.ReactNode;
  align?: "left" | "right" | "center";
};

export type RowAction = {
  /** Static label — used as the React key and as the fallback when
   *  `labelFor` isn't provided. */
  label: string;
  /** Per-row label override. Returning a different string per item is how
   *  e.g. the Pod kebab shows "Restart deployment" / "Restart statefulset"
   *  depending on the owner kind. */
  labelFor?: (it: Item) => string;
  /** When provided and returns true, the action is omitted for that row.
   *  Used to hide actions that don't apply to a given owner kind (Jobs,
   *  naked pods) without leaving a dead-button in the menu. */
  hidden?: (it: Item) => boolean;
  onClick?: (it: Item) => void;
  submenu?: (it: Item) => RowAction[];
  danger?: boolean;
  icon?: LucideIcon;
};

export type BulkAction = {
  label: string;
  /** return false to keep the current selection, for example after cancelling */
  onClick: (items: Item[]) => void | boolean | Promise<void | boolean>;
  danger?: boolean;
  icon?: LucideIcon;
};

export type IssueInfo = {
  count: number;
  severity: "warn" | "bad";
  messages: string[];
};

export type ResourceTableProps = {
  cluster: string;
  gvr: string;
  namespaced: boolean;
  columns: Column[];
  /** route to navigate to when a row is clicked (relative to /:cluster/) */
  rowHref?: (it: Item) => string;
  /** extra row actions in the kebab menu */
  actions?: RowAction[];
  /** actions for checked rows */
  bulkActions?: BulkAction[];
  /** Search scoped to this table only. The top-bar search remains global. */
  localSearch?: string;
  /** Row issue metadata for warning badges and warning-first sorting. */
  issueAccessor?: (it: Item) => IssueInfo | null;
  /** Controlled "warnings first" sort. The header button (rendered by the
   * page via `<WarningsToggle>`) flips this. */
  issuesFirst?: boolean;
  /** Notified whenever the visible warning row count changes. */
  onIssueCountChange?: (count: number) => void;
  /** custom filter beyond the global search box */
  filter?: (it: Item) => boolean;
};

export function ResourceTable(props: ResourceTableProps) {
  const {
    cluster, gvr, namespaced, columns, rowHref, actions, bulkActions, localSearch,
    issueAccessor, filter, onIssueCountChange,
  } = props;
  const namespace = useApp((s) => s.namespace);
  const selectedNamespaces = useApp((s) => s.namespaces);
  const search = useApp((s) => s.search);
  const persistColumnWidths = useApp((s) => s.getClusterSettings(cluster).persistColumnWidths);
  const nsSelection = selectedNamespaces.length > 0
    ? selectedNamespaces
    : (namespace ? [namespace] : []);
  const ns = namespaced ? (nsSelection.length > 0 ? nsSelection : undefined) : undefined;
  const [openActionKey, setOpenActionKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [columnMenu, setColumnMenu] = useState<{ top: number; left: number } | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const issuesFirst = props.issuesFirst ?? false;

  const { items, ready, error, total } = useResourceList(cluster, gvr, ns);

  // Note: `now` is intentionally NOT held as table state. Age cells use
  // <AgeCell/> which subscribes to the 1Hz tick directly, so the table's
  // sort/filter memos stay stable across ticks (huge win on 100k rows).

  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => readVisibleColumns(gvr, columns));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => persistColumnWidths ? readColumnWidths(gvr) : {},
  );

  // Stable signature of the column SET. Pages like NodesPage pass
  // `columnsFor(gvr)` inline, so `columns` is a fresh array on every
  // render — and the list re-renders constantly from the live informer.
  // Depending on the array identity made the reset effect below fire on
  // every refresh tick, which slammed `openActionKey` back to null and
  // "un-pressed" the row kebab mid-click. Keying on the joined column
  // keys instead: the value only changes when the columns genuinely
  // change (e.g. the Pods metrics toggle) or the resource type switches.
  const columnsKey = useMemo(() => columns.map((c) => c.key).join("|"), [columns]);

  useEffect(() => {
    setVisibleKeys(readVisibleColumns(gvr, columns));
    setColumnWidths(persistColumnWidths ? readColumnWidths(gvr) : {});
    setSelectedKeys(new Set());
    setOpenActionKey(null);
    setColumnMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gvr, columnsKey, persistColumnWidths]);

  const setAndStoreVisibleKeys = useCallback((next: Set<string>) => {
    const normalized = normalizeVisibleColumns(columns, next);
    setVisibleKeys(normalized);
    writeVisibleColumns(gvr, normalized);
  }, [columns, gvr]);

  // On narrow viewports secondary columns drop out so the essential ones
  // fit without horizontal scrolling. A column counts as secondary when
  // it sets `hideOnNarrow`, or its key is in SECONDARY_COLUMN_KEYS — the
  // keys are semantic and reused across resource types, so one set
  // covers every table.
  const narrow = useMediaQuery(NARROW_QUERY);
  const visibleColumns = useMemo(
    () => columns.filter((c) =>
      visibleKeys.has(c.key)
      && !(narrow && (c.hideOnNarrow || SECONDARY_COLUMN_KEYS.has(c.key)))),
    [columns, visibleKeys, narrow],
  );

  // Debounce localSearch: a keystroke shouldn't kick off a 100k-row scan
  // (matchesQuery walks labels/annotations/conditions). 80ms is below the
  // perceptual threshold for a typing user but coalesces a burst of keys
  // into a single re-filter pass.
  const [debouncedLocalSearch, setDebouncedLocalSearch] = useState(localSearch);
  useEffect(() => {
    if (debouncedLocalSearch === localSearch) return;
    const t = window.setTimeout(() => setDebouncedLocalSearch(localSearch), 80);
    return () => window.clearTimeout(t);
  }, [localSearch, debouncedLocalSearch]);

  const filtered = useMemo(() => {
    let out = items;
    if (search) {
      out = out.filter((it) => matchesQuery(it, search));
    }
    if (debouncedLocalSearch) {
      out = out.filter((it) => matchesQuery(it, debouncedLocalSearch));
    }
    if (filter) out = out.filter(filter);
    return out;
  }, [items, search, debouncedLocalSearch, filter]);

  const issueByKey = useMemo(() => {
    if (!issueAccessor) return null;
    const map = new Map<string, IssueInfo>();
    for (const it of filtered) {
      const info = issueAccessor(it);
      if (info && info.count > 0) map.set(rowKey(it), info);
    }
    return map;
  }, [filtered, issueAccessor]);

  // Surface the visible-row warning count to the parent so it can render the
  // counter chip in its own header (we don't render one ourselves anymore).
  const issueCount = issueByKey?.size ?? 0;
  useEffect(() => {
    onIssueCountChange?.(issueCount);
  }, [issueCount, onIssueCountChange]);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    const get = col?.sortValue
      ?? ((it: Item) => (it.metadata?.[sort.key as "name" | "namespace"] as string) ?? "");
    const arr = filtered.slice();
    arr.sort((a, b) => {
      if (issuesFirst && issueByKey) {
        const ai = issueByKey.get(rowKey(a))?.count ?? 0;
        const bi = issueByKey.get(rowKey(b))?.count ?? 0;
        if ((ai > 0) !== (bi > 0)) return ai > 0 ? -1 : 1;
        if (ai !== bi) return bi - ai;
      }
      const av = get(a); const bv = get(b);
      if (av < bv) return -sort.dir;
      if (av > bv) return  sort.dir;
      return 0;
    });
    return arr;
  }, [filtered, sort, columns, issuesFirst, issueByKey]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 32,
    overscan: 16,
  });

  const [searchParams, setSearchParams] = useSearchParams();
  const activeDetail = searchParams.get("d");

  const rowKeys = useMemo(() => sorted.map(rowKey), [sorted]);
  const selectedItems = useMemo(
    () => sorted.filter((it) => selectedKeys.has(rowKey(it))),
    [sorted, selectedKeys],
  );
  const selectedVisibleCount = useMemo(() => rowKeys.filter((k) => selectedKeys.has(k)).length, [rowKeys, selectedKeys]);
  const allVisibleSelected = rowKeys.length > 0 && selectedVisibleCount === rowKeys.length;
  const someVisibleSelected = selectedVisibleCount > 0 && selectedVisibleCount < rowKeys.length;
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const cols = useMemo(
    () => "36px " + visibleColumns.map((c) => columnWidths[c.key] ? `${columnWidths[c.key]}px` : c.width).join(" ") + " 36px",
    [visibleColumns, columnWidths],
  );

  // Sum of every column's *minimum* width (checkbox + actions gutters
  // included). Applied as min-width on the table wrapper so the grid
  // fills the viewport when there's room, but never squeezes columns
  // below their min — instead the whole table (header AND rows) scrolls
  // horizontally together, so the rightmost columns and the Columns
  // menu stay reachable on narrow screens / inside the detail panel.
  const tableMinWidth = useMemo(
    () => 72 + visibleColumns.reduce(
      (sum, c) => sum + (columnWidths[c.key] || colMinWidth(c.width)), 0),
    [visibleColumns, columnWidths],
  );

  const onHeaderClick = useCallback((key: string) => {
    setSort((s) => s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 });
    setOpenActionKey(null);
    setColumnMenu(null);
  }, []);

  const toggleAllVisible = useCallback((checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of rowKeys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, [rowKeys]);

  const toggleSelected = useCallback((key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const resetColumnWidth = useCallback((key: string) => {
    setColumnWidths((prev) => {
      const next = { ...prev };
      delete next[key];
      if (persistColumnWidths) writeColumnWidths(gvr, next);
      return next;
    });
  }, [gvr, persistColumnWidths]);

  const resetAllColumnWidths = useCallback(() => {
    setColumnWidths({});
    writeColumnWidths(gvr, {});
  }, [gvr]);

  const startColumnResize = useCallback((e: React.PointerEvent<HTMLSpanElement>, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const cell = e.currentTarget.parentElement as HTMLElement | null;
    const startWidth = cell?.getBoundingClientRect().width ?? columnWidths[key] ?? 160;
    const startX = e.clientX;
    let latest = startWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      latest = clampWidth(startWidth + ev.clientX - startX, COLUMN_MIN, maxColumnWidth());
      setColumnWidths((prev) => ({ ...prev, [key]: Math.round(latest) }));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setColumnWidths((prev) => {
        const next = { ...prev, [key]: Math.round(latest) };
        if (persistColumnWidths) writeColumnWidths(gvr, next);
        return next;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [columnWidths, gvr, persistColumnWidths]);

  const runBulkAction = useCallback(async (action: BulkAction) => {
    if (selectedItems.length === 0 || bulkBusy) return;
    setBulkBusy(action.label);
    setOpenActionKey(null);
    setColumnMenu(null);
    try {
      const result = await action.onClick(selectedItems);
      if (result !== false) setSelectedKeys(new Set());
    } finally {
      setBulkBusy(null);
    }
  }, [bulkBusy, selectedItems]);

  // Open the row in the right-side detail panel by writing the resource
  // ref into `?d=`. Clicking the already-open row toggles the panel shut.
  // Switching to a different resource also wipes `?tab=` so the new
  // selection lands on Summary instead of inheriting (e.g.) "events" from
  // the previously inspected pod.
  const openInPanel = useCallback((href: string) => {
    const ref = hrefToQuery(href);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = next.get("d");
      if (current === ref) {
        next.delete("d");
        next.delete("tab");
      } else {
        next.set("d", ref);
        next.delete("tab");
      }
      return next;
    });
  }, [setSearchParams]);

  useEffect(() => {
    if (!openActionKey && !columnMenu) return;
    const closeAll = () => {
      setOpenActionKey(null);
      setColumnMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("click", closeAll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", closeAll);
      window.removeEventListener("keydown", onKey);
    };
  }, [openActionKey, columnMenu]);

  const openColumnMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setOpenActionKey(null);
    if (columnMenu) {
      setColumnMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const width = 300;
    const height = Math.min(window.innerHeight - 16, columns.length * 32 + 88);
    setColumnMenu({
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    });
  };

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex items-center px-3 py-2 text-xs text-fg-mute border-b border-line">
        <div className="min-w-0 flex items-center">
          <span className="text-fg font-medium">{sorted.length.toLocaleString()}</span>
          {" / "}
          <span>{total.toLocaleString()}</span>
          <span className={clsx("ml-2 truncate", error && "text-bad")}>
            {error ? `error: ${error}` : ready ? "" : "loading…"}
          </span>
        </div>
        <div className="ml-3 min-w-0 flex items-center gap-1.5">
          {search && (
            <span className="chip normal-case tracking-normal max-w-[220px] truncate">
              global: {search}
            </span>
          )}
          {localSearch && (
            <span className="chip normal-case tracking-normal max-w-[220px] truncate">
              local: {localSearch}
            </span>
          )}
        </div>
        {selectedItems.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-accent">{selectedItems.length.toLocaleString()} selected</span>
            {(bulkActions ?? []).map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.label}
                  className={clsx("btn h-6", action.danger && "btn-bad")}
                  disabled={bulkBusy !== null}
                  onClick={() => void runBulkAction(action)}
                >
                  {Icon && <Icon size={13} />}
                  {bulkBusy === action.label ? "Working..." : action.label}
                </button>
              );
            })}
            <button
              className="text-fg-mute hover:text-fg"
              onClick={() => setSelectedKeys(new Set())}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Outer = the only horizontal scroller. Header and the vertical
          rows scroller are both children of the min-width wrapper, so a
          sideways scroll moves them as one — the header never desyncs
          from the rows and the Columns menu stays reachable. */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden flex flex-col">
      <div className="flex flex-col flex-1 min-h-0" style={{ minWidth: tableMinWidth }}>
      <div
        className="table-grid sticky top-0 z-10 bg-bg-soft border-b border-line"
        style={{ ["--cols" as any]: cols }}
      >
        <div className="col-head cursor-default flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <input
            ref={headerCheckboxRef}
            type="checkbox"
            className="kv-checkbox"
            checked={allVisibleSelected}
            disabled={rowKeys.length === 0}
            title={allVisibleSelected ? "Clear visible selection" : "Select all visible rows"}
            onChange={(e) => toggleAllVisible(e.target.checked)}
          />
        </div>
        {visibleColumns.map((c) => (
          <div
            key={c.key}
            className={clsx("col-head flex items-center gap-1",
              c.align === "right" && "justify-end",
              c.align === "center" && "justify-center",
            )}
            onClick={() => onHeaderClick(c.key)}
          >
            <span className="truncate">{c.label}</span>
            {sort.key === c.key && (sort.dir === 1
              ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
            <span
              className="col-resize-handle"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize. Double-click to reset."
              onPointerDown={(e) => startColumnResize(e, c.key)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                resetColumnWidth(c.key);
              }}
            />
          </div>
        ))}
        <div className="col-head cursor-default flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <button
            className="h-6 w-6 rounded-md flex items-center justify-center text-fg-mute hover:text-fg hover:bg-line"
            title="Columns"
            aria-label="Columns"
            onClick={openColumnMenu}
          >
            <MoreVertical size={15} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{ contain: "strict" }}
        onScroll={() => {
          setOpenActionKey(null);
          setColumnMenu(null);
        }}
      >
        {error && sorted.length === 0 && (
          <div className="px-4 py-3 text-sm text-bad border-b border-line/60">
            {error}
          </div>
        )}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vrow) => {
            const it = sorted[vrow.index];
            const actionKey = it.metadata?.uid ?? `${it.metadata?.namespace ?? ""}/${it.metadata?.name ?? vrow.key}`;
            const key = rowKey(it);
            const rowRef = rowHref ? hrefToQuery(rowHref(it)) : null;
            const isActive = rowRef !== null && rowRef === activeDetail;
            return (
              <div
                key={vrow.key as string}
                data-detail-trigger
                className={clsx(
                  "row-hover absolute left-0 right-0 table-grid border-b border-line/60 cursor-pointer",
                  selectedKeys.has(key) && "bg-accent/10 hover:bg-accent/10",
                  isActive && "bg-accent/15 hover:bg-accent/15",
                )}
                style={{
                  ["--cols" as any]: cols,
                  transform: `translateY(${vrow.start}px)`,
                  height: vrow.size,
                }}
                onClick={() => {
                  setOpenActionKey(null);
                  if (rowHref) openInPanel(rowHref(it));
                }}
              >
                <div className="col-cell flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="kv-checkbox"
                    checked={selectedKeys.has(key)}
                    aria-label={`Select ${it.metadata.name}`}
                    onChange={(e) => toggleSelected(key, e.target.checked)}
                  />
                </div>
                {visibleColumns.map((c) => (
                  <div key={c.key}
                    className={clsx("col-cell",
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                    )}
                  >
                    {c.render(it)}
                  </div>
                ))}
                <RowActions
                  item={it}
                  actions={actions}
                  open={openActionKey === actionKey}
                  onOpenChange={(open) => setOpenActionKey(open ? actionKey : null)}
                />
              </div>
            );
          })}
        </div>
      </div>
      </div>
      </div>
      {columnMenu && createPortal(
        <ColumnMenu
          pos={columnMenu}
          columns={columns}
          visibleKeys={visibleKeys}
          onChange={setAndStoreVisibleKeys}
          onResetWidths={resetAllColumnWidths}
          onClose={() => setColumnMenu(null)}
        />,
        document.body,
      )}
      {selectedItems.length > 0 && (
        <div className="absolute right-4 bottom-4 z-20 flex items-center gap-2 rounded-md border border-line bg-bg-soft/95 px-2 py-2 shadow-[0_18px_48px_rgb(0_0_0/0.55)] backdrop-blur">
          <span className="px-2 text-xs text-fg-soft">{selectedItems.length.toLocaleString()} selected</span>
          {(bulkActions ?? []).map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                className={clsx("btn", action.danger && "btn-bad")}
                disabled={bulkBusy !== null}
                title={action.label}
                onClick={() => void runBulkAction(action)}
              >
                {Icon && <Icon size={14} />}
                <span>{bulkBusy === action.label ? "Working..." : action.label}</span>
              </button>
            );
          })}
          <button
            className="h-7 w-7 rounded-md grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute"
            title="Clear selection"
            aria-label="Clear selection"
            onClick={() => setSelectedKeys(new Set())}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function ColumnMenu({
  pos,
  columns,
  visibleKeys,
  onChange,
  onResetWidths,
  onClose,
}: {
  pos: { top: number; left: number };
  columns: Column[];
  visibleKeys: Set<string>;
  onChange: (next: Set<string>) => void;
  onResetWidths: () => void;
  onClose: () => void;
}) {
  const requiredKey = columns[0]?.key;
  const showAll = () => onChange(new Set(columns.map((c) => c.key)));
  const reset = () => onChange(defaultVisibleColumns(columns));

  return (
    <div
      className="fixed z-[1000] w-[300px] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] py-1 text-sm"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="h-8 px-3 flex items-center border-b border-line text-xs uppercase tracking-wide text-fg-mute">
        Columns
        <button className="ml-auto normal-case tracking-normal text-accent hover:underline" onClick={reset}>
          Reset
        </button>
      </div>
      <div className="max-h-[420px] overflow-y-auto py-1">
        {columns.map((c) => {
          const required = c.key === requiredKey;
          return (
            <label
              key={c.key}
              className={clsx(
                "h-8 px-3 flex items-center gap-2 text-fg-soft hover:bg-bg-mute hover:text-fg",
                required && "opacity-80",
              )}
            >
              <input
                type="checkbox"
                className="kv-checkbox"
                checked={visibleKeys.has(c.key)}
                disabled={required}
                onChange={(e) => {
                  const next = new Set(visibleKeys);
                  if (e.target.checked) next.add(c.key);
                  else next.delete(c.key);
                  onChange(next);
                }}
              />
              <span className="truncate">{c.label}</span>
            </label>
          );
        })}
      </div>
      <div className="h-9 px-2 pt-1 border-t border-line flex items-center gap-2">
        <button className="btn h-7 flex-1 justify-center" onClick={showAll}>Show all</button>
        <button className="btn h-7 flex-1 justify-center" onClick={onResetWidths}>Reset widths</button>
        <button className="btn h-7 flex-1 justify-center" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function rowKey(it: Item): string {
  return it.metadata?.uid
    ?? `${it.apiVersion}/${it.kind}/${it.metadata?.namespace ?? ""}/${it.metadata?.name ?? ""}`;
}

function matchesQuery(it: Item, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const meta = it.metadata ?? {};
  const haystack: string[] = [
    it.kind,
    it.apiVersion,
    meta.name,
    meta.namespace,
    it.status?.phase,
    it.status?.qosClass,
    it.spec?.nodeName,
    it.spec?.type,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  for (const field of haystack) {
    if (field.toLowerCase().includes(q)) return true;
  }
  if (mapMatches(meta.labels, q) || mapMatches(meta.annotations, q)) return true;

  const conds = it.status?.conditions;
  if (Array.isArray(conds)) {
    for (const c of conds) {
      if (String(c?.type ?? "").toLowerCase().includes(q)) return true;
      if (String(c?.status ?? "").toLowerCase().includes(q)) return true;
      if (String(c?.reason ?? "").toLowerCase().includes(q)) return true;
      if (String(c?.message ?? "").toLowerCase().includes(q)) return true;
    }
  }

  return false;
}

function mapMatches(map: Record<string, any> | undefined, query: string): boolean {
  if (!map) return false;
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase().includes(query)) return true;
    if (String(v).toLowerCase().includes(query)) return true;
  }
  return false;
}

function columnStorageKey(gvr: string): string {
  return `k8s-view:columns:v3:${gvr}`;
}

const COLUMN_MIN = 72;
const COLUMN_MAX = 760;

// Row-action (kebab) menu width. 184 clipped longer labels like
// "Renew certs (kubeadm)"; 224 fits them with the icon + padding.
const ACTION_MENU_WIDTH = 224;

// Column keys treated as secondary — dropped automatically on narrow
// viewports (the user gets the essentials without horizontal scrolling).
// Keys are semantic and reused across resource types, so this single set
// covers Pods, workloads, Services, Nodes, ConfigMaps/Secrets, etc. Only
// keys that are secondary in *every* table they appear in are listed —
// status / name / ready / restarts / ports / type stay visible.
const SECONDARY_COLUMN_KEYS = new Set<string>([
  "controlledBy", "qos", "node", "os", "internal", "selector", "nodeSelector",
  "images", "strategy", "conditions", "keys", "labels", "immutable",
  "clusterIP", "externalIP", "uptodate", "available", "updated",
  "concurrency", "lastSchedule", "lastSuccess",
]);

function columnWidthStorageKey(gvr: string): string {
  return `k8s-view:column-widths:v1:${gvr}`;
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Resolve a column track ("120px", "minmax(180px, 1.4fr)", "1fr") to the
// pixel floor it should never shrink below. Pure fr/auto tracks have no
// intrinsic floor, so we use a sane default that keeps a label legible.
function colMinWidth(track: string): number {
  const px = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(track);
  if (px) return Math.ceil(Number(px[1]));
  const mm = /minmax\(\s*(\d+(?:\.\d+)?)px/.exec(track);
  if (mm) return Math.ceil(Number(mm[1]));
  return 120;
}

function maxColumnWidth(): number {
  if (typeof window === "undefined") return COLUMN_MAX;
  return Math.max(220, Math.min(COLUMN_MAX, Math.floor(window.innerWidth * 0.72)));
}

function readColumnWidths(gvr: string): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(columnWidthStorageKey(gvr));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== "string" || typeof value !== "number") continue;
      if (!Number.isFinite(value)) continue;
      out[key] = Math.round(clampWidth(value, COLUMN_MIN, maxColumnWidth()));
    }
    return out;
  } catch {
    return {};
  }
}

function writeColumnWidths(gvr: string, widths: Record<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    const cleaned: Record<string, number> = {};
    for (const [key, value] of Object.entries(widths)) {
      if (Number.isFinite(value)) cleaned[key] = Math.round(clampWidth(value, COLUMN_MIN, maxColumnWidth()));
    }
    window.localStorage.setItem(columnWidthStorageKey(gvr), JSON.stringify(cleaned));
  } catch { /* ignore */ }
}

function defaultVisibleColumns(columns: Column[]): Set<string> {
  return normalizeVisibleColumns(columns, new Set(columns.filter((c) => c.defaultVisible !== false).map((c) => c.key)));
}

function normalizeVisibleColumns(columns: Column[], raw: Set<string>): Set<string> {
  const known = new Set(columns.map((c) => c.key));
  const next = new Set(Array.from(raw).filter((k) => known.has(k)));
  const required = columns[0]?.key;
  if (required) next.add(required);
  if (next.size === 0 && required) next.add(required);
  return next;
}

function readVisibleColumns(gvr: string, columns: Column[]): Set<string> {
  if (typeof window === "undefined") return defaultVisibleColumns(columns);
  try {
    const raw = window.localStorage.getItem(columnStorageKey(gvr));
    if (!raw) return defaultVisibleColumns(columns);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return defaultVisibleColumns(columns);
    return normalizeVisibleColumns(columns, new Set(arr.filter((x) => typeof x === "string")));
  } catch {
    return defaultVisibleColumns(columns);
  }
}

function writeVisibleColumns(gvr: string, visible: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(columnStorageKey(gvr), JSON.stringify(Array.from(visible)));
  } catch { /* ignore */ }
}

function RowActions({
  item,
  actions,
  open,
  onOpenChange,
}: {
  item: Item;
  actions?: RowAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [submenuLabel, setSubmenuLabel] = useState<string | null>(null);
  const [submenuLeft, setSubmenuLeft] = useState(true);

  useEffect(() => {
    if (!open) {
      setMenuPos(null);
      setSubmenuLabel(null);
    }
  }, [open]);

  const visibleActions = (actions ?? []).filter((a) => !a.hidden?.(item));
  if (visibleActions.length === 0) {
    return <div />;
  }
  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (open) {
      onOpenChange(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const width = ACTION_MENU_WIDTH;
    const itemHeight = 36;
    const height = visibleActions.length * itemHeight + 8;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setSubmenuLeft(left + width + 240 < window.innerWidth - 8);
    setMenuPos({
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8)),
      left,
    });
    onOpenChange(true);
  };

  return (
    <div className="relative flex justify-center">
      <button
        ref={buttonRef}
        className="h-full px-2 text-fg-mute hover:text-fg"
        title="Actions"
        aria-label={`Actions for ${item.metadata.name}`}
        onClick={openMenu}
      >
        <MoreVertical size={14} />
      </button>
      {open && menuPos && createPortal(
        <div
          className="fixed z-[1000] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] py-1"
          style={{ top: menuPos.top, left: menuPos.left, width: ACTION_MENU_WIDTH }}
          onClick={(e) => e.stopPropagation()}
        >
          {visibleActions.map((a) => {
            const Icon = a.icon;
            const sub = a.submenu?.(item) ?? [];
            const display = a.labelFor?.(item) ?? a.label;
            return (
              <div
                key={a.label}
                className="relative"
                onMouseEnter={() => setSubmenuLabel(sub.length > 0 ? a.label : null)}
              >
                <button
                  className={clsx(
                    "w-full h-9 flex items-center gap-2 px-3 text-sm text-left hover:bg-bg-mute",
                    submenuLabel === a.label && "bg-bg-mute",
                    a.danger ? "text-bad" : "text-fg",
                  )}
                  onClick={() => {
                    if (sub.length > 0) {
                      if (!a.onClick) {
                        setSubmenuLabel(a.label);
                        return;
                      }
                      a.onClick(item);
                      onOpenChange(false);
                      return;
                    }
                    a.onClick?.(item);
                    onOpenChange(false);
                  }}
                >
                  {Icon && <Icon size={15} className={clsx("shrink-0", a.danger ? "text-bad" : "text-fg-mute")} />}
                  <span className="truncate">{display}</span>
                  {sub.length > 0 && <ArrowRight size={13} className="ml-auto text-fg-mute" />}
                </button>
                {sub.length > 0 && submenuLabel === a.label && (
                  <div
                    className={clsx(
                      "absolute top-0 w-[240px] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] py-1",
                      submenuLeft ? "left-full ml-1" : "right-full mr-1",
                    )}
                  >
                    {sub.map((child) => {
                      const ChildIcon = child.icon;
                      return (
                        <button
                          key={child.label}
                          className={clsx(
                            "w-full h-8 flex items-center gap-2 px-3 text-sm text-left hover:bg-bg-mute",
                            child.danger ? "text-bad" : "text-fg",
                          )}
                          onClick={() => {
                            child.onClick?.(item);
                            onOpenChange(false);
                          }}
                        >
                          {ChildIcon && <ChildIcon size={14} className={clsx("shrink-0", child.danger ? "text-bad" : "text-fg-mute")} />}
                          <span className="truncate">{child.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
