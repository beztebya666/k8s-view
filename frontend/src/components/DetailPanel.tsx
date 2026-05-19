// DetailPanel — Lens-style right-side resizable detail pane.
//
// Click a row in any ResourceTable: instead of taking over the page,
// the selected resource is encoded into the `?d=` query parameter and
// this component renders <ResourceDetailPage> in a panel on the right.
// The list stays mounted and interactive in the centre.
//
// URL shape (no leading "resource/"):
//   `?d=apps/v1/deployments/ns/kube-system/local-path-provisioner`
//   `?d=core/v1/nodes/k8s-worker`

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { X } from "lucide-react";
import { ResourceDetailPage } from "../pages/ResourceDetailPage";
import { useMediaQuery, NARROW_QUERY } from "../lib/ui";

const STORAGE_KEY = "k8s-view:detail-panel-width";
const MIN_WIDTH = 420;
// 960 fits a 3-column topology (Deployment → ReplicaSet → Pods) at the new
// COL_W=240 without horizontal scroll on common viewports.
const DEFAULT_WIDTH = 960;

export type DetailRef = {
  group: string;
  version: string;
  resource: string;
  namespace?: string;
  name: string;
};

export function parseDetailRef(s: string | null): DetailRef | null {
  if (!s) return null;
  const parts = s.split("/");
  if (parts.length === 4) {
    return {
      group: parts[0], version: parts[1], resource: parts[2],
      name: safeDecode(parts[3]),
    };
  }
  if (parts.length === 6 && parts[3] === "ns") {
    return {
      group: parts[0], version: parts[1], resource: parts[2],
      namespace: safeDecode(parts[4]),
      name: safeDecode(parts[5]),
    };
  }
  return null;
}

export function refToQuery(ref: DetailRef): string {
  if (ref.namespace) {
    return `${ref.group}/${ref.version}/${ref.resource}/ns/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`;
  }
  return `${ref.group}/${ref.version}/${ref.resource}/${encodeURIComponent(ref.name)}`;
}

// hrefToQuery — translate a "resource/..." rowHref (the legacy navigation
// target produced by columns/list pages) into the panel's `?d=` value.
export function hrefToQuery(href: string): string {
  return href.replace(/^\/+/, "").replace(/^resource\//, "");
}

// Lightweight Kind→plural rule. Matches the same heuristic ResourceListPage
// uses, which the backend's discovery routes accept. Edge cases that don't
// follow English plural rules (e.g. "Endpoints" → "endpoints") aren't a
// concern here — owner refs only ever point at apps/batch/core kinds.
export function pluralise(kind: string): string {
  const k = kind.toLowerCase();
  if (k.endsWith("s")) return k + "es";
  if (k.endsWith("y")) return k.slice(0, -1) + "ies";
  return k + "s";
}

// Convert an `ownerReferences` entry into a panel ref. The owning object lives
// in the same namespace as the child (k8s constraint), so the caller passes
// the child's namespace.
export function ownerToRef(owner: { apiVersion?: string; kind?: string; name?: string } | null | undefined, namespace?: string): DetailRef | null {
  if (!owner?.kind || !owner?.name) return null;
  const apiVersion = owner.apiVersion ?? "v1";
  const slash = apiVersion.indexOf("/");
  const group = slash >= 0 ? apiVersion.slice(0, slash) : "core";
  const version = slash >= 0 ? apiVersion.slice(slash + 1) : apiVersion;
  // Cluster-scoped kinds we encounter through owner refs: Node. Anything else
  // is namespaced and inherits the child's namespace.
  const ns = owner.kind === "Node" ? undefined : namespace;
  return { group, version, resource: pluralise(owner.kind), namespace: ns, name: owner.name };
}

// LinkCell — a clickable cell that opens its target in the right detail
// panel. Used for namespace / node / controlled-by / etc. columns. Stops
// propagation so the row's own click handler doesn't fight it. No underline
// (intentional — we keep the accent colour for affordance, but the row is
// already a link target so the underline noise isn't worth it).
export function LinkCell({
  target,
  children,
  className,
  title,
}: {
  target: DetailRef | null;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const [, setParams] = useSearchParams();
  if (!target) {
    return <span className={clsx("text-fg-mute", className)}>{children}</span>;
  }
  return (
    <button
      type="button"
      data-detail-trigger
      className={clsx("text-accent text-left truncate hover:text-accent/75 outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-sm", className)}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        const q = refToQuery(target);
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          if (next.get("d") === q) {
            next.delete("d");
            next.delete("tab");
          } else {
            next.set("d", q);
            next.delete("tab");
          }
          return next;
        });
      }}
    >
      {children}
    </button>
  );
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function DetailPanelHost() {
  const [params, setParams] = useSearchParams();
  const refStr = params.get("d");
  const ref = parseDetailRef(refStr);

  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("d");
    next.delete("tab");
    setParams(next);
  }, [params, setParams]);

  // Esc closes the panel — but only when no input/textarea/Monaco has focus,
  // so the YAML editor's own Esc handling still works.
  useEffect(() => {
    if (!ref) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isInteractive(e.target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref, close]);

  // Click-away: a mousedown anywhere in the central content region that
  // ISN'T a row / link that opens another resource dismisses the panel.
  // Scoped to [data-content-region] on purpose — portaled menus that the
  // detail page itself spawns (Select dropdowns, kebab) live on
  // document.body, NOT inside the content column, so clicking them never
  // collapses the panel out from under the user. Clicking a row or
  // <LinkCell> ([data-detail-trigger]) switches the target instead of
  // closing, so there's no close→reopen flicker.
  useEffect(() => {
    if (!ref) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.isConnected) return;
      if (t.closest("[data-detail-panel]")) return;
      if (t.closest("[data-detail-trigger]")) return;
      if (!t.closest("[data-content-region]")) return;
      close();
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [ref, close]);

  if (!ref) return null;
  // key forces a remount when switching to a different resource so any
  // local detail-page state (selected tab content, log buffers) resets.
  return <DetailPanel key={refStr ?? ""} target={ref} onClose={close} />;
}

function isInteractive(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (t.isContentEditable) return true;
  // Monaco editor textarea sits inside .monaco-editor — let it handle its own Esc.
  if (t.closest(".monaco-editor")) return true;
  return false;
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const n = stored ? Number(stored) : DEFAULT_WIDTH;
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return clampWidth(n);
}

function clampWidth(w: number): number {
  if (typeof window === "undefined") return Math.max(MIN_WIDTH, w);
  const max = Math.max(MIN_WIDTH, window.innerWidth - 360);
  return Math.max(MIN_WIDTH, Math.min(max, w));
}

function DetailPanel({ target, onClose }: { target: DetailRef; onClose: () => void }) {
  const [width, setWidth] = useState<number>(readStoredWidth);
  // On phones / narrow windows the resizable side-pane is unusable —
  // it'd either crush the list to nothing or overflow the screen. There
  // it becomes a full-screen sheet (close via X / Esc) instead.
  const narrow = useMediaQuery(NARROW_QUERY);

  // Re-clamp when the viewport shrinks below the saved width.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const draggingRef = useRef(false);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = startX - ev.clientX;
      const next = clampWidth(startW + dx);
      setWidth(next);
      try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [width]);

  return (
    <aside
      data-detail-panel
      className={clsx(
        "detail-panel-in border-l border-line bg-bg flex flex-col",
        narrow
          ? "fixed inset-0 z-40 w-full h-full"
          : "relative shrink-0 h-full",
      )}
      style={narrow ? undefined : { width }}
      role="complementary"
      aria-label="Resource detail"
    >
      {/* Resize handle: 6px hit area straddling the left edge with a 1px
          accent line on hover. -ml-[3px] makes it overlap the border.
          Pointless on a full-screen sheet, so it's dropped when narrow. */}
      {!narrow && (
      <div
        className="group absolute left-0 top-0 bottom-0 z-30 -ml-[3px] w-[6px] cursor-col-resize"
        onMouseDown={onResizeStart}
        title="Drag to resize"
      >
        <div className="absolute inset-y-0 left-[3px] w-px bg-line group-hover:bg-accent transition-colors" />
      </div>
      )}

      <ResourceDetailPage
        group={target.group}
        version={target.version}
        resource={target.resource}
        namespace={target.namespace}
        name={target.name}
        onClose={onClose}
        closeIcon={<X size={13} />}
      />
    </aside>
  );
}
