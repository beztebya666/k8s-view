// ClusterBadge — small clickable circle that doubles as the cluster's
// visual identity (Lens shows the same: a coloured pill in the cluster
// row). Clicking opens a popover where the user can set an uploaded
// image, an emoji/initials label, and a hue. All of it persists via
// `clusterSettings` in the zustand store, so it survives reloads.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useClusterColor } from "../lib/clusterColor";
import { useApp } from "../stores/app";
import { IconEditorBody } from "./IconEditor";

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
  const tint = useClusterColor(name);
  const label = settings.iconLabel.trim();
  const image = settings.iconImage;
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
    // Keep the 284px-tall popover on-screen near the viewport edges.
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 296)),
      top: Math.min(r.bottom + 6, window.innerHeight - 300),
    });
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
          "shrink-0 inline-flex items-center justify-center rounded-full leading-none overflow-hidden",
          editable ? "cursor-pointer" : "cursor-default",
          className,
        )}
        style={{
          width: size,
          height: size,
          background: image ? "transparent" : filled ? tint.hsl : "transparent",
          border: !image && filled ? "none" : `1px solid ${tint.hsl}`,
          color: filled ? "rgb(var(--bg))" : tint.hsl,
          fontSize,
          fontWeight: 600,
        }}
      >
        {image
          ? <img src={image} alt="" className="h-full w-full object-cover" />
          : label
            ? <span>{label.slice(0, 3)}</span>
            : null}
      </button>
      {open && pos && createPortal(
        <div
          className="fixed z-[1000] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] p-3"
          style={{ left: pos.left, top: pos.top }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <IconEditorBody name={name} />
          <div className="mt-2 flex justify-end">
            <button type="button" className="btn h-6 text-[11px]" onClick={() => setOpen(false)}>
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
