// Demo bootstrap (k8s-view): swap fetch + WebSocket for the in-browser mock.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { demoFetch } from "./server";
import { DemoWebSocket } from "./stream";
import { getDB } from "./db";

export { resetDemo } from "./db";

export function isDemo(): boolean {
  try { const env = (import.meta as any).env; if (env && env.VITE_DEMO === "1") return true; } catch { /* */ }
  return typeof window !== "undefined" && (window as any).__DEMO__ === true;
}

let installed = false;
export function installDemo() {
  if (installed) return; installed = true;
  (window as any).__DEMO__ = true;
  window.fetch = ((i: any, o?: any) => demoFetch(i, o)) as any;
  (window as any).WebSocket = DemoWebSocket;
  getDB();
}
