// portForwards — module-scoped pool of pod port-forward sessions.
//
// Architecture mirror of logStreams.ts: each session is one WebSocket to
// `/api/v1/{cluster}/pods/{ns}/{name}/portforward?port=N&local=L` that the
// Go backend opens via client-go's `portforward.New`. The forward listener
// lives on the BACKEND HOST — not in the browser — so the user reaches the
// forwarded service at `http://<backend-host>:<localPort>/`. Closing the
// WebSocket terminates the forward; navigating away in the UI does NOT
// stop the session by design (the user expects port-forwards to persist
// while they're paying attention to other tabs).
//
// We talk to the WS protocol the backend defined:
//   • `ready <local>:<remote>`  — first message after the listener binds
//   • `error: <msg>`            — fatal error (next we get a close)
//   • `port-forward ended: ...` — graceful shutdown
//   • everything else           — informational log lines (we ignore them)

const SESSIONS = new Map<string, Session>();
const LISTENERS = new Set<() => void>();

let cachedSnapshot: readonly PortForwardSession[] = [];
let snapshotDirty = false;

export type PortForwardState =
  | "connecting"
  | "running"
  | "ended"
  | "error";

export interface PortForwardSession {
  id: string;
  cluster: string;
  ns: string;
  pod: string;
  /** Container/service port we're forwarding to. */
  remotePort: number;
  /** Port the backend host is listening on. 0 until the WS sends `ready`. */
  localPort: number;
  state: PortForwardState;
  err: string | null;
  /** Wall-clock ms when we opened the WS. */
  startedAt: number;
  /** Wall-clock ms when the session ended (state = ended/error). */
  endedAt: number | null;
  /** Last log line surfaced by the backend (truncated). */
  lastLine: string | null;
}

interface Session extends PortForwardSession {
  ws: WebSocket | null;
  closed: boolean;
}

interface OpenOpts {
  cluster: string;
  ns: string;
  pod: string;
  /** Container port to forward to. */
  port: number;
  /** Preferred local port; 0 = backend picks an ephemeral one. */
  localPort?: number;
}

export function open(opts: OpenOpts): string {
  const id = makeId();
  const now = Date.now();
  const s: Session = {
    id,
    cluster: opts.cluster,
    ns: opts.ns,
    pod: opts.pod,
    remotePort: opts.port,
    localPort: 0,
    state: "connecting",
    err: null,
    startedAt: now,
    endedAt: null,
    lastLine: null,
    ws: null,
    closed: false,
  };
  SESSIONS.set(id, s);
  notify();
  connect(s, opts.localPort ?? 0);
  return id;
}

export function close(id: string): void {
  const s = SESSIONS.get(id);
  if (!s) return;
  s.closed = true;
  if (s.ws) {
    try { s.ws.close(); } catch { /* ignore */ }
    s.ws = null;
  }
  s.state = s.state === "running" ? "ended" : s.state;
  if (!s.endedAt) s.endedAt = Date.now();
  notify();
}

export function remove(id: string): void {
  close(id);
  SESSIONS.delete(id);
  notify();
}

export function reconnect(id: string): void {
  const s = SESSIONS.get(id);
  if (!s) return;
  if (s.ws) {
    try { s.ws.close(); } catch { /* ignore */ }
    s.ws = null;
  }
  s.closed = false;
  s.state = "connecting";
  s.err = null;
  s.endedAt = null;
  s.lastLine = null;
  s.startedAt = Date.now();
  notify();
  connect(s, s.localPort);
}

export function list(): readonly PortForwardSession[] {
  return getSnapshot();
}

export function activeCount(): number {
  let n = 0;
  for (const s of SESSIONS.values()) {
    if (s.state === "running" || s.state === "connecting") n++;
  }
  return n;
}

export function subscribe(cb: () => void): () => void {
  LISTENERS.add(cb);
  return () => { LISTENERS.delete(cb); };
}

export function getSnapshot(): readonly PortForwardSession[] {
  if (!snapshotDirty) return cachedSnapshot;
  cachedSnapshot = Array.from(SESSIONS.values()).map(toSnapshot);
  snapshotDirty = false;
  return cachedSnapshot;
}

function notify() {
  snapshotDirty = true;
  for (const cb of LISTENERS) cb();
}

function toSnapshot(s: Session): PortForwardSession {
  return {
    id: s.id,
    cluster: s.cluster,
    ns: s.ns,
    pod: s.pod,
    remotePort: s.remotePort,
    localPort: s.localPort,
    state: s.state,
    err: s.err,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    lastLine: s.lastLine,
  };
}

function connect(s: Session, localPort: number) {
  if (s.closed) return;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const path = `/api/v1/${encodeURIComponent(s.cluster)}/pods/${encodeURIComponent(s.ns)}/${encodeURIComponent(s.pod)}/portforward`;
  const url = `${proto}://${window.location.host}${path}?port=${s.remotePort}&local=${localPort}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e: any) {
    s.state = "error";
    s.err = e?.message ?? String(e);
    s.endedAt = Date.now();
    notify();
    return;
  }
  s.ws = ws;
  ws.onmessage = (ev) => onWsMessage(s, ev);
  ws.onerror = () => {
    s.state = "error";
    s.err ??= "websocket error";
    notify();
  };
  ws.onclose = () => {
    if (s.state !== "error") {
      s.state = s.state === "running" ? "ended" : (s.err ? "error" : "ended");
    }
    if (!s.endedAt) s.endedAt = Date.now();
    s.ws = null;
    notify();
  };
}

const READY_RE = /^ready\s+(\d+):(\d+)/i;

function onWsMessage(s: Session, ev: MessageEvent) {
  if (typeof ev.data !== "string") return;
  const text = ev.data;
  const ready = READY_RE.exec(text);
  if (ready) {
    s.localPort = Number(ready[1]) || s.localPort;
    s.state = "running";
    notify();
    return;
  }
  if (text.startsWith("error:")) {
    s.err = text.slice(6).trim();
    s.state = "error";
    notify();
    return;
  }
  if (text.startsWith("port-forward ended")) {
    s.lastLine = text.length > 200 ? text.slice(0, 200) + "…" : text;
    notify();
    return;
  }
  // Anything else is informational; keep just the latest 200 chars so the
  // UI has something to show in a tooltip without growing unbounded.
  s.lastLine = text.length > 200 ? text.slice(0, 200) + "…" : text;
}

function makeId(): string {
  return `pf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
