// ClusterBadge — small clickable circle that doubles as the cluster's
// visual identity (Lens shows the same: a coloured pill in the cluster
// row). Clicking opens a tiny popover where the user can swap the icon
// label (single emoji or 1-3 letter initials) and pick a hue from a
// preset palette. Both customisations persist via `clusterSettings`,
// which is already part of the zustand store and so survives reloads.
//
// Why not Lens-style image upload: a web-deployed dashboard can't write
// arbitrary blobs to per-user storage cheaply, and emoji+colour cover
// 95% of the "I want to tell my prod cluster apart from staging" use
// cases without a server-side asset bucket.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { clusterColor, useClusterColor } from "../lib/clusterColor";
import { useApp } from "../stores/app";

const HUE_PRESETS = [
  -1, // "auto" (deterministic from name)
  0, 18, 36, 54,
  78, 120, 150,
  180, 200, 220, 240,
  270, 300, 330,
];

interface Props {
  name: string;
  /** Pixel diameter; default 14 to match the existing sidebar dot. */
  size?: number;
  /** When true, clicking opens the customisation popover; when false the
   *  badge is a passive visual only. Defaults to true. */
  editable?: boolean;
  className?: string;
  /** Border vs filled. Filled when the cluster is connected; bordered
   *  outline matches the existing offline state. */
  filled?: boolean;
  title?: string;
}

export function ClusterBadge({ name, size = 14, editable = true, className, filled = true, title }: Props) {
  const settings = useApp((s) => s.getClusterSettings(name));
  const setClusterSettings = useApp((s) => s.setClusterSettings);
  const tint = useClusterColor(name);
  const label = settings.iconLabel.trim();
  const fontSize = Math.max(8, Math.floor(size * 0.55));

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismiss(open, () => setOpen(false));

  const onClick = (e: React.MouseEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const r = (ref.current as HTMLElement).getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 6 });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        title={title ?? (editable ? "Customise icon" : name)}
        aria-label={editable ? `Customise ${name} icon` : name}
        className={clsx(
          "shrink-0 inline-flex items-center justify-center rounded-full leading-none",
          editable ? "cursor-pointer" : "cursor-default",
          className,
        )}
        style={{
          width: size,
          height: size,
          background: filled ? tint.hsl : "transparent",
          border: filled ? "none" : `1px solid ${tint.hsl}`,
          color: filled ? "rgb(var(--bg))" : tint.hsl,
          fontSize,
          fontWeight: 600,
        }}
      >
        {label && <span>{label.slice(0, 3)}</span>}
      </button>
      {open && pos && createPortal(
        <div
          className="fixed z-[1000] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] p-3 w-[260px]"
          style={{ left: pos.left, top: pos.top }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] uppercase tracking-wider text-fg-mute mb-1.5">Icon label</div>
          <input
            className="input h-7 w-full text-xs font-mono"
            placeholder="emoji or initials (max 3)"
            value={settings.iconLabel}
            maxLength={6}
            onChange={(e) => setClusterSettings(name, { iconLabel: e.target.value })}
          />
          <div className="mt-3 text-[10px] uppercase tracking-wider text-fg-mute mb-1.5">Hue</div>
          <div className="grid grid-cols-8 gap-1">
            {HUE_PRESETS.map((hue) => {
              const swatch = clusterColor(name, hue >= 0 ? hue : undefined);
              const active = settings.iconHue === hue;
              return (
                <button
                  key={hue}
                  type="button"
                  className={clsx(
                    "h-6 rounded-sm border",
                    active ? "border-fg" : "border-line/60 hover:border-fg-soft",
                  )}
                  style={{ background: hue < 0 ? "transparent" : swatch.hsl }}
                  onClick={() => setClusterSettings(name, { iconHue: hue })}
                  title={hue < 0 ? "Auto (from name)" : `hue ${hue}°`}
                >
                  {hue < 0 && <span className="text-[10px] text-fg-soft font-mono">auto</span>}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex justify-between">
            <button
              type="button"
              className="text-[11px] text-fg-mute hover:text-fg"
              onClick={() => setClusterSettings(name, { iconLabel: "", iconHue: -1 })}
            >
              Reset
            </button>
            <button
              type="button"
              className="btn h-6 text-[11px]"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function useDismiss(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
}
