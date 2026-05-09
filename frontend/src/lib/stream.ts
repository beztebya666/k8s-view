// stream.ts — single per-cluster WebSocket multiplexer.
//
// One socket per cluster carries any number of resource subscriptions. The
// backend supports msgpack and json subprotocols. We use JSON by default
// because it keeps browser-side diagnostics obvious and avoids cross-library
// MessagePack edge cases for Kubernetes' dynamic objects.

export type StreamFrame = {
  sid: number;
  kind: "snapshot" | "add" | "update" | "delete" | "error" | "pong";
  gvr?: string;
  uid?: string;
  item?: any;
  list?: any[];
  msg?: string;
};

export type Subscription = {
  sid: number;
  unsubscribe: () => void;
};

type Handler = (f: StreamFrame) => void;

// Hot-path: each WS frame from a busy informer would otherwise allocate a
// fresh TextDecoder. UTF-8 decoding is stateless here (we read whole frames,
// not partial chunks), so a single shared instance is safe.
const FRAME_DECODER = new TextDecoder();

// "Cluster gone" detection: a WebSocket that closes within this window of
// being opened (well before the typical informer snapshot lands) is almost
// always a server-side rejection — the cluster was removed, RBAC denied,
// the apiserver is unreachable. Past this threshold we treat the close as a
// regular network blip and reconnect with backoff like before.
const FAST_CLOSE_THRESHOLD_MS = 2_000;

export class ClusterStream {
  private url: string;
  private socket?: WebSocket;
  private nextSid = 1;
  private handlers = new Map<number, Handler>();
  // Pending subscriptions to (re)send on next open.
  private active = new Map<number, { gvr: string; ns?: string }>();
  private reconnectDelay = 500;
  private reconnectTimer: number | undefined;
  private listeners = new Set<(connected: boolean) => void>();
  private connected = false;
  // Connection lifecycle state used by the "cluster gone" detector.
  private connectStartedAt = 0;
  private everConnected = false;
  // Once a cluster is confirmed gone we stop the reconnect loop entirely.
  // The pool entry stays around so any in-flight subscribers see the error
  // frame, but no more sockets are opened.
  private dead = false;

  constructor(public cluster: string) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${window.location.host}/api/v1/${encodeURIComponent(cluster)}/stream`;
    this.connect();
  }

  onConnectionChange(fn: (connected: boolean) => void): () => void {
    this.listeners.add(fn);
    fn(this.connected);
    return () => this.listeners.delete(fn);
  }

  isConnected(): boolean { return this.connected; }
  isDead(): boolean { return this.dead; }

  private setConnected(v: boolean) {
    if (this.connected !== v) {
      this.connected = v;
      for (const fn of this.listeners) fn(v);
    }
  }

  private connect() {
    if (this.dead) return;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connectStartedAt = Date.now();
    const ws = new WebSocket(this.url, ["k8s-view.json.v1"]);
    ws.binaryType = "arraybuffer";
    this.socket = ws;

    ws.onopen = () => {
      this.everConnected = true;
      this.reconnectDelay = 500;
      this.setConnected(true);
      // Re-send active subscriptions after a reconnect.
      for (const [sid, sub] of this.active) {
        ws.send(JSON.stringify({ op: "subscribe", sid, gvr: sub.gvr, ns: sub.ns ?? "" }));
      }
    };
    ws.onclose = () => {
      this.setConnected(false);
      // Fast-close before any open: probably a 404 from the upgrade handler
      // (cluster removed, RBAC denied). Verify against /api/v1/clusters
      // before scheduling another retry — if the server doesn't list us we
      // declare the stream dead so we don't drum a 404 retry loop into the
      // backend log forever.
      const sinceConnect = Date.now() - this.connectStartedAt;
      if (!this.everConnected && sinceConnect < FAST_CLOSE_THRESHOLD_MS) {
        void this.checkAlive();
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
    ws.onmessage = (ev) => {
      try {
        const data = ev.data instanceof ArrayBuffer
          ? JSON.parse(FRAME_DECODER.decode(new Uint8Array(ev.data)))
          : JSON.parse(ev.data);
        const frame = data as StreamFrame;
        const h = this.handlers.get(frame.sid);
        if (h) {
          h(frame);
        } else {
          console.warn("stream frame without handler", frame);
        }
      } catch (e) {
        console.error("stream decode error", e);
      }
    };
  }

  // checkAlive asks the server whether our cluster name is still registered.
  // If it isn't, we mark the stream dead, fan an `error` frame to every
  // active subscriber, and short-circuit further reconnects. If the cluster
  // IS still listed, the close was a transient blip and we fall back to the
  // normal exponential reconnect.
  private async checkAlive() {
    try {
      const res = await fetch("/api/v1/clusters", { headers: { Accept: "application/json" } });
      if (!res.ok) {
        // Server reachable but the clusters list itself failed — don't kill
        // the stream on that, fall back to the regular retry path.
        this.scheduleReconnect();
        return;
      }
      const list: { name: string }[] = await res.json();
      const stillExists = Array.isArray(list) && list.some((c) => c?.name === this.cluster);
      if (stillExists) {
        this.scheduleReconnect();
        return;
      }
      this.declareDead("cluster removed");
    } catch {
      // Network down — that's a normal disconnect, retry as usual.
      this.scheduleReconnect();
    }
  }

  private declareDead(reason: string) {
    if (this.dead) return;
    this.dead = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Fan an error frame to every subscriber so tables / detail panels can
    // surface the "cluster gone" state instead of spinning on "connecting…".
    for (const [sid, handler] of this.handlers) {
      try { handler({ sid, kind: "error", msg: reason }); } catch { /* ignore */ }
    }
    this.setConnected(false);
  }

  private scheduleReconnect() {
    if (this.dead) return;
    if (this.reconnectTimer !== undefined) return;
    const delay = Math.min(this.reconnectDelay, 8000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 8000);
  }

  subscribe(gvr: string, ns: string | undefined, on: Handler): Subscription {
    const sid = this.nextSid++;
    this.handlers.set(sid, on);
    this.active.set(sid, { gvr, ns });
    // Stream already declared dead before this subscriber arrived — emit the
    // error frame inline so the caller doesn't sit waiting on an event that
    // will never come.
    if (this.dead) {
      try { on({ sid, kind: "error", msg: "cluster removed" }); } catch { /* ignore */ }
    } else if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ op: "subscribe", sid, gvr, ns: ns ?? "" }));
    }
    return {
      sid,
      unsubscribe: () => {
        this.handlers.delete(sid);
        this.active.delete(sid);
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ op: "unsubscribe", sid }));
        }
      },
    };
  }

  close() {
    this.handlers.clear();
    this.active.clear();
    this.socket?.close();
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
    }
    this.dead = true;
  }
}

// Cache one ClusterStream per cluster name.
const streams = new Map<string, ClusterStream>();
export function getClusterStream(cluster: string): ClusterStream {
  let s = streams.get(cluster);
  if (!s) {
    s = new ClusterStream(cluster);
    streams.set(cluster, s);
  }
  return s;
}

// destroyClusterStream tears down the cached ClusterStream for a removed
// cluster. Called by the Topbar after `api.removeCluster` succeeds so any
// future re-import of the same name gets a fresh stream rather than reusing
// a "dead" one. Also makes sure no orphan socket keeps reconnecting.
export function destroyClusterStream(cluster: string): void {
  const s = streams.get(cluster);
  if (!s) return;
  s.close();
  streams.delete(cluster);
}
