// PortForwardsPage — list every active port-forward session, with stop +
// reconnect + copy-url + open-in-tab affordances. Backed by the module-
// scoped pool in `lib/portForwards.ts` so navigation away doesn't tear
// down the WebSockets — Lens parity for "I left the page open and want
// my forwards still alive".

import { useSyncExternalStore } from "react";
import { Copy, ExternalLink, RefreshCcw, Square, Trash2 } from "lucide-react";
import clsx from "clsx";
import {
  close as closePF,
  getSnapshot,
  reconnect as reconnectPF,
  remove as removePF,
  subscribe as subscribePF,
  type PortForwardSession,
} from "../lib/portForwards";
import { age } from "../lib/format";
import { copyToClipboard } from "../lib/clipboard";

export function PortForwardsPage() {
  const sessions = useSyncExternalStore(subscribePF, getSnapshot);
  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Port forwards</h1>
        <span className="chip">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
      </header>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
        {sessions.length === 0 ? (
          <Empty />
        ) : (
          <ul className="space-y-2 max-w-[920px]">
            {sessions.map((s) => (
              <Row key={s.id} s={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="text-fg-mute text-sm max-w-md leading-relaxed">
      No active port-forwards. Open a Pod or Service and pick "Forward port"
      from the kebab menu — sessions opened that way show up here while they
      stay alive.
    </div>
  );
}

function Row({ s }: { s: PortForwardSession }) {
  const url = s.localPort > 0 ? buildUrl(s.localPort) : null;
  return (
    <li className="rounded-md border border-line bg-bg-soft px-3 py-2.5">
      <div className="flex items-center gap-3">
        <StateDot state={s.state} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm truncate">
            {s.ns}/{s.pod} <span className="text-fg-mute">:</span>{s.remotePort}
            <span className="text-fg-mute mx-1.5">→</span>
            <span className="text-accent">localhost:{s.localPort || "—"}</span>
          </div>
          <div className="text-xs text-fg-mute mt-0.5 truncate">
            cluster: {s.cluster}
            {" · "}
            {s.endedAt ? `ended ${age(new Date(s.endedAt).toISOString())}` : `running for ${age(new Date(s.startedAt).toISOString())}`}
            {s.err && <span className="text-bad ml-2">· {s.err}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {url && s.state === "running" && (
            <button
              className="btn h-7"
              title="Open in browser tab"
              onClick={() => window.open(url, "_blank", "noopener")}
            >
              <ExternalLink size={12} />
              Open
            </button>
          )}
          {url && (
            <button
              className="btn h-7"
              title="Copy URL"
              onClick={() => { void copyToClipboard(url); }}
            >
              <Copy size={12} />
            </button>
          )}
          {(s.state === "ended" || s.state === "error") ? (
            <button
              className="btn h-7"
              title="Reconnect"
              onClick={() => reconnectPF(s.id)}
            >
              <RefreshCcw size={12} />
              Reconnect
            </button>
          ) : (
            <button
              className="btn h-7"
              title="Stop forwarding"
              onClick={() => closePF(s.id)}
            >
              <Square size={12} />
              Stop
            </button>
          )}
          <button
            className="btn h-7 btn-bad"
            title="Remove from list"
            onClick={() => removePF(s.id)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </li>
  );
}

function StateDot({ state }: { state: PortForwardSession["state"] }) {
  const cls =
    state === "running" ? "bg-ok" :
    state === "connecting" ? "bg-warn animate-pulse" :
    state === "ended" ? "bg-fg-mute" :
    "bg-bad";
  return <span className={clsx("h-2 w-2 rounded-full shrink-0", cls)} title={state} />;
}

function buildUrl(localPort: number): string {
  // The forward listener lives on the BACKEND HOST (i.e. wherever the Go
  // server is running). Same-origin host resolves correctly when the user
  // opened the UI directly; for remote backends the user needs network
  // access to that host:port the same way they'd connect via kubectl.
  return `http://${window.location.hostname}:${localPort}/`;
}
