// eventsIndex — cluster-wide /v1/Event subscription rolled up by
// involvedObject. Pages that decorate rows with warning badges (Pods,
// workloads) call `useEventIndex` and look each item up via
// `eventsForItem` to surface only those warnings that actually correspond
// to recent kubelet/controller-manager Warning events.
//
// Why this exists, not just "trust the pod status":
//   • The pod's own conditions miss probe-failure events ("Liveness probe
//     failed: 503") — kubelet retries the probe, the pod stays Running and
//     Ready, but the user definitely wants a warning icon.
//   • Lens does the same: the warning indicator on a row is sourced from
//     Warning-type events involving that object, deduped per reason and
//     bounded by the cluster event TTL (default 1 h).
//   • Putting it in a single hook means one subscription per cluster, not
//     one per row — the row-level cost is just a Map lookup.

import { createContext, useEffect, useMemo, useRef, useState } from "react";
import { useResourceList, type Item } from "./useResourceList";

export type EventWarning = {
  reason: string;
  message: string;
  count: number;
  /** Last-seen timestamp in ms since epoch. */
  lastSeen: number;
};

export type EventIndex = {
  /** Primary lookup key: involvedObject.uid (set by kubelet for pods/etc.). */
  byUid: Map<string, EventWarning[]>;
  /** Fallback key for objects whose events arrived before/after the object
   *  was reaped, where the uid no longer matches: `Kind/namespace/name`. */
  byKey: Map<string, EventWarning[]>;
};

const EMPTY_INDEX: EventIndex = { byUid: new Map(), byKey: new Map() };

// 1 h matches the kube-apiserver default `--event-ttl`. We could trust the
// store to evict for us, but a stale event left in the local cache would
// keep flagging a row long after the underlying issue cleared, so we
// explicitly cap the recency window here.
const RECENT_WINDOW_MS = 60 * 60 * 1000;

// Minimum interval between full index rebuilds. Warning badges are
// effectively a UX hint — sub-second freshness isn't useful, and rebuilding
// 7.5k Warning events on every rAF burns CPU. Cap rebuilds to once per
// REBUILD_TTL_MS; in-between, return the cached index.
const REBUILD_TTL_MS = 3_000;

export function useEventIndex(cluster: string, enabled: boolean): EventIndex {
  const { items } = useResourceList(cluster, "/v1/Event", undefined, { enabled });
  // Force a re-evaluation every TTL even when items hasn't changed since
  // last render — events drop out of the recency window over time.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setTick((n) => n + 1), REBUILD_TTL_MS);
    return () => window.clearInterval(t);
  }, [enabled]);

  const cacheRef = useRef<{ at: number; itemsRef: any; idx: EventIndex } | null>(null);
  return useMemo(() => {
    if (!enabled || items.length === 0) return EMPTY_INDEX;
    const cached = cacheRef.current;
    const now = Date.now();
    if (cached && cached.itemsRef === items && now - cached.at < REBUILD_TTL_MS) {
      return cached.idx;
    }
    const byUid = new Map<string, EventWarning[]>();
    const byKey = new Map<string, EventWarning[]>();
    for (const ev of items as any[]) {
      if (ev?.type !== "Warning") continue;
      // Prefer lastTimestamp (legacy events.v1) → eventTime (events.k8s.io
      // v1) → creationTimestamp. The first non-empty one wins.
      const tsStr = ev.lastTimestamp ?? ev.eventTime ?? ev.metadata?.creationTimestamp;
      const last = tsStr ? new Date(tsStr).getTime() : 0;
      if (!Number.isFinite(last) || now - last > RECENT_WINDOW_MS) continue;
      const obj = ev.involvedObject ?? {};
      const summary: EventWarning = {
        reason: String(ev.reason ?? "Warning"),
        message: String(ev.message ?? "").trim(),
        count: Number(ev.count ?? 1),
        lastSeen: last,
      };
      if (obj.uid) {
        const arr = byUid.get(obj.uid) ?? [];
        arr.push(summary);
        byUid.set(obj.uid, arr);
      }
      if (obj.kind && obj.name) {
        const fallback = `${obj.kind}/${obj.namespace ?? ""}/${obj.name}`;
        const arr = byKey.get(fallback) ?? [];
        arr.push(summary);
        byKey.set(fallback, arr);
      }
    }
    const idx = { byUid, byKey };
    cacheRef.current = { at: now, itemsRef: items, idx };
    return idx;
  }, [items, enabled, tick]);
}

export function eventsForItem(
  idx: EventIndex,
  gvr: string,
  it: Pick<Item, "kind" | "metadata">,
): EventWarning[] {
  const uid = it.metadata?.uid;
  if (uid) {
    const found = idx.byUid.get(uid);
    if (found && found.length > 0) return found;
  }
  const kind = it.kind || kindFromGvr(gvr);
  const name = it.metadata?.name;
  if (kind && name) {
    const fallback = `${kind}/${it.metadata?.namespace ?? ""}/${name}`;
    return idx.byKey.get(fallback) ?? [];
  }
  return [];
}

/** Reasons severe enough to be flagged as `bad` rather than `warn`. The
 *  list mirrors what Lens promotes to red — the rest stay yellow.
 *  Kept anchored (^...$) so e.g. "BackOff" doesn't accidentally match. */
const SEVERE_REASONS = /^(CrashLoopBackOff|OOMKilled|Evicted|FailedScheduling|ImagePullBackOff|ErrImagePull|InvalidImageName|FailedCreatePodSandBox|FailedSync|ProgressDeadlineExceeded)$/;

export function isSevereReason(reason: string): boolean {
  return SEVERE_REASONS.test(reason);
}

function kindFromGvr(gvr: string): string {
  return gvr.split("/").pop() ?? "";
}

// Context plumbing: the row-level NameCell (rendered deep inside the
// virtualized table) reads the index from here so each cell doesn't have
// to re-subscribe. Pages that don't surface event-driven warnings (e.g.
// the Events page itself, ConfigMap list) leave the value at null —
// `eventsForItem` then returns an empty array and `issuesFor` falls back
// to its structural-only checks.
export type EventIndexBinding = { index: EventIndex; gvr: string };
export const EventIndexContext = createContext<EventIndexBinding | null>(null);
