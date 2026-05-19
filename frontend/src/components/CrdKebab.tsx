// CrdKebab — the "⋮" row menu for a CRD-backed kind in the API Resources
// and Custom Resources lists. Those lists only let you drill *into* a
// kind's instances; this adds the affordance the user asked for — reach
// the backing CustomResourceDefinition's YAML (and its definition view)
// without leaving the list. Built-in kinds have no CRD, so callers only
// render this for custom groups.
//
// The menu is portaled to <body> with a fixed position computed from the
// trigger rect, so a row near the viewport bottom never clips it.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { MoreVertical, FileCode2, FileSearch } from "lucide-react";
import { useBottomPane } from "./BottomPane";

const CRD_GVR = "apiextensions.k8s.io/v1/customresourcedefinitions";
const MENU_W = 200;

export function CrdKebab({ cluster, crdName }: { cluster: string; crdName: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const bottom = useBottomPane();
  const [, setParams] = useSearchParams();

  // Close on any outside click / Escape / scroll — same lifecycle as the
  // table's RowActions menu.
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos]);

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setPos({
      top: Math.min(r.bottom + 4, window.innerHeight - 92),
      left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
    });
  };

  const editYaml = () => {
    bottom.push({ action: "yaml", cluster, name: crdName, gvr: CRD_GVR });
  };
  const viewDef = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", `${CRD_GVR}/${encodeURIComponent(crdName)}`);
      next.delete("tab");
      return next;
    });
  };

  return (
    <div className="flex justify-center">
      <button
        type="button"
        // data-detail-trigger: clicking the kebab is an action, not a
        // "click away" — without this the detail panel's outside-click
        // handler closed the panel out from under the user.
        data-detail-trigger
        // hover:bg-line (not bg-mute) so the kebab stays visually
        // distinct even when the row underneath is already hover-tinted.
        className="h-7 w-7 grid place-items-center rounded-md text-fg-mute hover:text-fg hover:bg-line"
        title="CRD actions"
        aria-label={`Actions for ${crdName}`}
        onClick={toggle}
      >
        <MoreVertical size={15} />
      </button>
      {pos && createPortal(
        <div
          className="fixed z-[1000] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] py-1"
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem icon={<FileCode2 size={14} />} label="Edit YAML"
            onClick={() => { editYaml(); setPos(null); }} />
          <MenuItem icon={<FileSearch size={14} />} label="View definition"
            onClick={() => { viewDef(); setPos(null); }} />
        </div>,
        document.body,
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="w-full h-9 flex items-center gap-2 px-3 text-sm text-left text-fg hover:bg-bg-mute"
      onClick={onClick}
    >
      <span className="shrink-0 text-fg-mute">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
