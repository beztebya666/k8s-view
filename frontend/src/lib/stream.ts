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

  private setConnected(v: boolean) {
    if (this.connected !== v) {
      this.connected = v;
      for (const fn of this.listeners) fn(v);
    }
  }

  private connect() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = new WebSocket(this.url, ["k8s-view.json.v1"]);
    ws.binaryType = "arraybuffer";
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.setConnected(true);
      // Re-send active subscriptions after a reconnect.
      for (const [sid, sub] of this.active) {
        ws.send(JSON.stringify({ op: "subscribe", sid, gvr: sub.gvr, ns: sub.ns ?? "" }));
      }
    };
    ws.onclose = () => {
      this.setConnected(false);
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

  private scheduleReconnect() {
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
    if (this.socket?.readyState === WebSocket.OPEN) {
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
