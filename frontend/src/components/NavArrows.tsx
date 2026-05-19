// NavArrows — browser-style ← → plus a Home jump, wired to the in-app
// navStack. Lives at the far left of the Topbar. The arrows are disabled
// at the ends of the history so the user gets the same affordance Lens
// gives: obvious, reversible movement that never escapes the app.

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, Home } from "lucide-react";
import clsx from "clsx";
import { useApp } from "../stores/app";
import {
  canBack, canForward, markBack, markForward, record, snapshot, subscribe,
} from "../lib/navStack";

// Mounted once near the top of the app tree: records every committed
// location so the arrows know where they can go.
export function NavStackRecorder() {
  const loc = useLocation();
  useEffect(() => {
    record(loc.pathname + loc.search);
  }, [loc.pathname, loc.search]);
  return null;
}

export function NavArrows() {
  const navigate = useNavigate();
  const cluster = useApp((s) => s.cluster);
  useSyncExternalStore(subscribe, snapshot);
  const back = canBack();
  const forward = canForward();

  const goHome = () => {
    navigate(cluster ? `/${encodeURIComponent(cluster)}/overview` : "/");
  };

  return (
    <div className="flex items-center gap-0.5">
      <NavBtn onClick={goHome} title="Home (cluster overview)" enabled>
        <Home size={14} />
      </NavBtn>
      <NavBtn
        onClick={() => { markBack(); navigate(-1); }}
        title="Back"
        enabled={back}
      >
        <ArrowLeft size={14} />
      </NavBtn>
      <NavBtn
        onClick={() => { markForward(); navigate(1); }}
        title="Forward"
        enabled={forward}
      >
        <ArrowRight size={14} />
      </NavBtn>
    </div>
  );
}

function NavBtn({
  onClick, title, enabled, children,
}: {
  onClick: () => void;
  title: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      title={title}
      aria-label={title}
      className={clsx(
        "h-7 w-7 grid place-items-center rounded-md transition-colors",
        enabled
          ? "text-fg-soft hover:text-fg hover:bg-bg-mute"
          : "text-fg-mute/40 cursor-default",
      )}
    >
      {children}
    </button>
  );
}
