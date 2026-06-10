// Fake WebSocket for the k8s-view demo. For /stream it speaks the informer
// protocol: on {op:"subscribe",sid,gvr,ns} it replies {sid,kind:"snapshot",gvr,list}
// from the seeded cluster. For pod-log sockets it streams a few canned lines.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDB } from "./db";

type Cb = ((ev: any) => void) | null;

const LOG_LINES = [
  "[INFO] starting application v1.4.2 (commit a1b2c3d)",
  "[INFO] connected to postgres://postgres:5432/app",
  "[INFO] cache warmed: 4213 entries in 84ms",
  "level=info msg=\"HTTP server listening\" addr=:8080",
  "level=info msg=\"GET /healthz 200 0.4ms\"",
  "level=info msg=\"GET /api/users 200 12.1ms\" rows=42",
  "level=warn msg=\"slow query\" durationMs=412 query=\"SELECT * FROM orders\"",
  "level=info msg=\"POST /api/checkout 201 88ms\" order=A1042",
  "[INFO] reconcile loop tick — 3 deployments, 0 drift",
];

export class DemoWebSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  url: string; readyState = 0; binaryType = "blob"; protocol = "";
  onopen: Cb = null; onmessage: Cb = null; onclose: Cb = null; onerror: Cb = null;
  private closed = false; private timers: number[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = typeof url === "string" ? url : String(url);
    this.protocol = Array.isArray(protocols) ? protocols[0] : (protocols || "");
    setTimeout(() => this.start(), 0);
  }
  private emit(data: string) { if (!this.closed) this.onmessage?.({ data }); }
  private start() {
    if (this.closed) return;
    this.readyState = this.OPEN;
    this.onopen?.({});
    if (/\/(log|logs|exec)\b/.test(this.url) || this.url.includes("/log")) {
      let i = 0;
      const tick = () => { if (this.closed) return; this.emit(new Date().toISOString() + " " + LOG_LINES[i++ % LOG_LINES.length]); this.timers.push(window.setTimeout(tick, 900 + Math.random() * 900)); };
      this.timers.push(window.setTimeout(tick, 250));
    }
    // /stream waits for subscribe messages (handled in send()).
  }
  send(data?: string) {
    if (this.closed || typeof data !== "string") return;
    let msg: any; try { msg = JSON.parse(data); } catch { return; }
    if (msg.op === "ping") { this.emit(JSON.stringify({ kind: "pong", sid: msg.sid })); return; }
    if (msg.op === "subscribe") {
      const gvr: string = msg.gvr; const ns: string = msg.ns || "";
      let list = (getDB() as any).resources[gvr] || [];
      if (ns) list = list.filter((it: any) => it.metadata?.namespace === ns);
      this.timers.push(window.setTimeout(() => this.emit(JSON.stringify({ sid: msg.sid, kind: "snapshot", gvr, list })), 60));
    }
  }
  addEventListener() { /* on* props used */ }
  removeEventListener() { /* */ }
  close() { if (this.closed) return; this.closed = true; this.readyState = this.CLOSED; this.timers.forEach((t) => clearTimeout(t)); this.onclose?.({ code: 1000, wasClean: true }); }
}
