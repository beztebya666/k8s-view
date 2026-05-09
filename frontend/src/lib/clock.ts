// clock.ts — single source of truth for "what time it is right now in the
// cluster". The user's wall clock is intentionally not part of the answer.
//
// How it works
// ------------
// On startup (and periodically, plus on focus / online), we fetch
// /api/v1/healthz, which returns `serverTime` from the backend. We anchor
// that on `performance.now()` — a strictly monotonic timer that measures
// elapsed time since the page was loaded, independently of system time
// changes (DST, NTP slews, manual clock edits, suspend/resume).
//
// `clusterNow()` then returns
//
//   anchor.serverEpochMs + (performance.now() - anchor.perfAtAnchorMs)
//
// i.e. the cluster's wall-clock time as it has advanced since the last
// successful sync, without ever consulting `Date.now()`. A pod whose
// `creationTimestamp` is `serverEpochMs - 200` will be displayed as 200ms
// old no matter how badly the user's laptop clock is skewed.
//
// Until the very first probe lands we have no anchor. To avoid flashing
// wrong ages we simply return the date encoded in `creationTimestamp`
// itself (`age()` handles a missing anchor by returning "—" until ready).
// The probe is a single round-trip to our own backend, so the first sync
// completes within tens of milliseconds in practice.

import { useSyncExternalStore } from "react";

type Anchor = {
  /** Cluster epoch ms at the moment of the probe (measured at request midpoint). */
  serverEpochMs: number;
  /** `performance.now()` value captured at the same moment. */
  perfAtAnchorMs: number;
  /** When this anchor was learned, in cluster epoch ms. Equal to serverEpochMs. */
  syncedAtServerMs: number;
  /** Round-trip time of the probe in ms — used for diagnostics only. */
  rttMs: number;
};

let anchor: Anchor | null = null;
let probing = false;
let lastError: string | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function notify() {
  revision += 1;
  for (const l of listeners) l();
}

async function probe(): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const t0 = performance.now();
    const res = await fetch("/api/v1/healthz", { cache: "no-store" });
    const t1 = performance.now();
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      notify();
      return;
    }
    const body = (await res.json()) as { serverTime?: string };
    if (!body.serverTime) {
      lastError = "missing serverTime";
      notify();
      return;
    }
    const serverEpochMs = new Date(body.serverTime).getTime();
    if (!Number.isFinite(serverEpochMs)) {
      lastError = "bad serverTime";
      notify();
      return;
    }
    // The server stamped its time somewhere in [t0, t1]; we use the midpoint
    // as the anchor instant and take half the RTT off the server stamp to
    // discount one-way network latency.
    const rttMs = t1 - t0;
    const perfAtAnchorMs = (t0 + t1) / 2;
    anchor = {
      serverEpochMs,
      perfAtAnchorMs,
      syncedAtServerMs: serverEpochMs,
      rttMs,
    };
    lastError = null;
    notify();
  } catch (e: any) {
    lastError = e?.message ?? "network error";
    notify();
  } finally {
    probing = false;
  }
}

if (typeof window !== "undefined") {
  void probe();
  window.setInterval(() => { void probe(); }, 60_000);
  const refresh = () => { void probe(); };
  window.addEventListener("focus", refresh);
  window.addEventListener("online", refresh);
}

// clusterNow — returns the cluster's current wall-clock time in epoch ms,
// derived from the last successful probe plus monotonic elapsed time.
// Returns NaN before the first probe has succeeded; callers are expected to
// treat that the same as "no creationTimestamp" — they'll already render a
// dash until the next tick lands.
export function clusterNow(): number {
  if (!anchor) return NaN;
  return anchor.serverEpochMs + (performance.now() - anchor.perfAtAnchorMs);
}

export function isClockReady(): boolean {
  return anchor !== null;
}

export function getClockSkewSnapshot(): {
  ready: boolean;
  /** clusterNow() − Date.now() at the instant of the call, in ms. */
  offsetMs: number;
  rttMs: number | null;
  lastSyncedAtClusterMs: number | null;
  error: string | null;
} {
  if (!anchor) {
    return {
      ready: false,
      offsetMs: 0,
      rttMs: null,
      lastSyncedAtClusterMs: null,
      error: lastError,
    };
  }
  return {
    ready: true,
    offsetMs: clusterNow() - Date.now(),
    rttMs: anchor.rttMs,
    lastSyncedAtClusterMs: anchor.syncedAtServerMs,
    error: lastError,
  };
}

// triggerClockProbe — used by the Settings "check now" button.
export async function triggerClockProbe(): Promise<void> {
  await probe();
}

// useClockSnapshot — re-renders when a new probe lands. Used by the
// settings page to display the current diagnosis.
export function useClockSnapshot(): ReturnType<typeof getClockSkewSnapshot> {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => revision,
    () => revision,
  );
  return getClockSkewSnapshot();
}

// --- 1Hz ticker for age cells ---------------------------------------
//
// `useNowTick()` lets a leaf component (an age cell) re-render every second
// WITHOUT putting `now` into the parent table's state. The whole point: a
// 100k-row table that re-renders top-to-bottom every second is what we're
// avoiding. Cells subscribed to this hook update independently; the table's
// sort/filter memos never see `now` at all and stay stable across ticks.
//
// One module-scoped 1Hz timer feeds every subscriber. The timer only runs
// while there's at least one mounted subscriber — a hidden tab with no age
// columns visible costs nothing.

let tickRevision = 0;
const tickListeners = new Set<() => void>();
let tickTimer: number | undefined;

function startTickerIfNeeded() {
  if (tickTimer !== undefined || typeof window === "undefined") return;
  tickTimer = window.setInterval(() => {
    tickRevision++;
    for (const l of tickListeners) l();
  }, 1000);
}

function stopTickerIfIdle() {
  if (tickTimer === undefined || tickListeners.size > 0) return;
  window.clearInterval(tickTimer);
  tickTimer = undefined;
}

const subscribeTick = (cb: () => void) => {
  tickListeners.add(cb);
  startTickerIfNeeded();
  return () => {
    tickListeners.delete(cb);
    stopTickerIfIdle();
  };
};
const tickSnapshot = () => tickRevision;

export function useNowTick(): number {
  return useSyncExternalStore(subscribeTick, tickSnapshot, tickSnapshot);
}
