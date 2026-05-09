// Toasts — top-right tray that consumes the `lib/notifications` queue.
// Stacked vertically newest-on-top, max 5 visible, each card slides in
// from the right and fades out on dismiss. Clicking the card body
// dismisses it; the X button is there for keyboard access.

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { clearAll, dismiss, getSnapshot, subscribe, type Toast, type ToastTone } from "../lib/notifications";

const ICONS: Record<ToastTone, React.ComponentType<any>> = {
  ok: CheckCircle2,
  info: Info,
  warn: AlertTriangle,
  bad: XCircle,
};

const TONE_CLS: Record<ToastTone, string> = {
  ok:   "border-ok/40 bg-ok/10 text-ok",
  info: "border-info/40 bg-info/10 text-info",
  warn: "border-warn/40 bg-warn/10 text-warn",
  bad:  "border-bad/40 bg-bad/10 text-bad",
};

export function Toasts() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot);
  if (toasts.length === 0) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed top-3 right-3 z-[1100] flex flex-col gap-2 max-w-[min(420px,90vw)]"
      role="region"
      aria-label="Notifications"
    >
      {toasts.length > 1 && (
        <div className="self-end pointer-events-auto">
          <button
            type="button"
            className="text-[10px] uppercase tracking-wide text-fg-mute hover:text-fg bg-bg-soft/80 backdrop-blur-sm border border-line/60 rounded px-2 py-1"
            onClick={() => clearAll()}
            title="Dismiss all notifications"
          >
            Dismiss all ({toasts.length})
          </button>
        </div>
      )}
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const Icon = ICONS[toast.tone];
  return (
    <div
      role="status"
      className={clsx(
        "pointer-events-auto toast-in flex items-start gap-2 rounded-md border px-3 py-2 backdrop-blur-sm shadow-[0_18px_44px_rgb(0_0_0/0.45)]",
        TONE_CLS[toast.tone],
      )}
    >
      <Icon size={15} className="mt-[1px] shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium leading-tight text-fg">{toast.title}</div>
        {toast.body && (
          <div className="mt-0.5 text-[11px] text-fg-soft leading-snug whitespace-pre-wrap">
            {toast.body}
          </div>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 -mr-1 -mt-1 h-6 w-6 grid place-items-center rounded text-fg-mute hover:text-fg hover:bg-bg-mute/40"
        onClick={(e) => { e.stopPropagation(); dismiss(toast.id); }}
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}
