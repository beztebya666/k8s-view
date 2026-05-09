// CreateFab — Lens-style floating "+" anchored to the bottom-right of a
// resource page. Clicking it opens the bottom-pane "Create resource" tab,
// pre-loaded with a template that matches the page's GVR. Hovering reveals
// a small chip telling the user which cluster will receive the apply.
//
// Theming notes:
//   * The hover chip uses the same surface tokens as the rest of the UI
//     (`bg-bg-soft` + `border-line` + `text-fg-soft`) so it reads well in
//     both dark and light themes. Cluster identity is conveyed by a small
//     dot, not a bright background.
//   * The button uses the `accent` token (already theme-aware) instead of a
//     hard-coded blue, so it tones down in light mode automatically.

import { useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "../stores/app";
import { useBottomPane } from "./BottomPane";
import { useClusterColor } from "../lib/clusterColor";

export function CreateFab({ templateGvr }: { templateGvr?: string }) {
  const cluster = useApp((s) => s.cluster);
  const bottom = useBottomPane();
  const [hover, setHover] = useState(false);
  const tint = useClusterColor(cluster);

  if (!cluster) return null;

  return (
    <div
      className="absolute right-5 bottom-5 z-20 flex items-center gap-2"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {hover && (
        <div className="flex items-center gap-1.5 px-2 h-7 rounded-md text-[11px] border border-line bg-bg-soft text-fg-soft shadow-[0_4px_12px_rgb(0_0_0/0.25)] whitespace-nowrap">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ background: tint.hsl }}
            aria-hidden
          />
          <span>Create in <span className="text-fg font-medium">{cluster}</span></span>
        </div>
      )}
      <button
        type="button"
        className="h-11 w-11 rounded-full grid place-items-center bg-accent/95 text-white shadow-[0_6px_16px_rgb(0_0_0/0.32)] hover:bg-accent active:scale-95 transition-transform"
        title={`Create resource in ${cluster}`}
        aria-label={`Create resource in ${cluster}`}
        onClick={() => bottom.push({ action: "create", cluster, gvr: templateGvr })}
      >
        <Plus size={20} strokeWidth={2.4} />
      </button>
    </div>
  );
}
