// useResourceList — keeps an in-memory map<UID, item> in sync with the
// backend's delta stream and re-renders only when the visible slice changes.
//
// The trick that lets us scale to 100k items: we never trigger React state
// updates on individual events. Deltas are merged into a Map outside React,
// and we snapshot the underlying array into state at most once per animation
// frame. Combined with TanStack Virtual, that keeps scrolling at 60 fps even
// while a hot watch stream is firing thousands of updates per second.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getClusterStream, StreamFrame } from "./stream";

export type Item = {
  apiVersion: string;
  kind: string;
  metadata: {
    uid: string;
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: any[];
    deletionTimestamp?: string;
    resourceVersion?: string;
  };
  spec?: any;
  status?: any;
  data?: Record<string, unknown>;
  binaryData?: Record<string, unknown>;
  type?: string;
  immutable?: boolean;
  endpoints?: any[];
  ports?: any[];
  addressType?: string;
  value?: number;
  globalDefault?: boolean;
  preemptionPolicy?: string;
  description?: string;
  handler?: string;
  overhead?: any;
  scheduling?: any;
  rules?: any[];
  subjects?: any[];
  roleRef?: any;
  provisioner?: string;
  reclaimPolicy?: string;
  volumeBindingMode?: string;
  allowVolumeExpansion?: boolean;
  secrets?: any[];
  imagePullSecrets?: any[];
};

type ResourceSnapshot = {
  items: Item[];
  ready: boolean;
  error: string | null;
};

class ResourceCollection {
  private items = new Map<string, Item>();
  private scopedItems = new Map<string, Set<string>>();
  private listeners = new Set<() => void>();
  private snapshot: ResourceSnapshot = { items: [], ready: false, error: null };
  private rafScheduled = false;
  ready = false;
  error: string | null = null;

  apply(f: StreamFrame) {
    this.applyFrom("__all__", f);
  }

  applyFrom(source: string, f: StreamFrame) {
    if (f.kind === "snapshot") {
      const previous = this.scopedItems.get(source);
      if (previous) {
        for (const uid of previous) this.items.delete(uid);
      }
      const next = new Set<string>();
      for (const it of f.list ?? []) {
        const u = (it as Item).metadata?.uid;
        if (u) {
          this.items.set(u, it as Item);
          next.add(u);
        }
      }
      this.scopedItems.set(source, next);
      this.ready = true;
      this.error = null;
      this.bumpAndNotify();
      return;
    }
    if (f.kind === "delete") {
      if (f.uid) {
        this.items.delete(f.uid);
        for (const set of this.scopedItems.values()) set.delete(f.uid);
      }
      this.bumpAndNotify();
      return;
    }
    if ((f.kind === "add" || f.kind === "update") && f.item) {
      const u = (f.item as Item).metadata?.uid;
      if (u) {
        this.items.set(u, f.item as Item);
        let sourceSet = this.scopedItems.get(source);
        if (!sourceSet) {
          sourceSet = new Set<string>();
          this.scopedItems.set(source, sourceSet);
        }
        sourceSet.add(u);
      }
      this.bumpAndNotify();
      return;
    }
  }

  fail(message: string) {
    this.ready = true;
    this.error = message;
    this.snapshot = {
      items: Array.from(this.items.values()),
      ready: this.ready,
      error: this.error,
    };
    for (const l of this.listeners) l();
  }

  private bumpAndNotify() {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.snapshot = {
        items: Array.from(this.items.values()),
        ready: this.ready,
        error: this.error,
      };
      for (const l of this.listeners) l();
    });
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): ResourceSnapshot => this.snapshot;
  hasResult(): boolean { return this.ready || this.error !== null; }

  // Subscription ownership — set once by the first useResourceList caller
  // for this collection (under refcount cache). The cleanup closure is held
  // here so the cache can run it when the refcount hits zero.
  private subscribed = false;
  cleanup: (() => void) | null = null;
  hasSubscription(): boolean { return this.subscribed; }
  markSubscribed() { this.subscribed = true; }
  teardown() {
    if (this.cleanup) {
      try { this.cleanup(); } catch { /* ignore */ }
      this.cleanup = null;
    }
    this.subscribed = false;
  }
}

// Module-scoped cache of (cluster|gvr|ns) → shared collection. Refcounted so
// we don't tear down a WS subscription only to immediately re-create it when
// React swaps a component (StrictMode double-mount, navigating between
// sibling routes that share the same list, etc.).
type CacheEntry = { collection: ResourceCollection; refs: number; teardownTimer?: number };
const collectionCache = new Map<string, CacheEntry>();
const COLLECTION_TEARDOWN_DELAY_MS = 1500;

function acquireCollection(key: string): {
  collection: ResourceCollection;
  retain: () => void;
  release: () => void;
} {
  let entry = collectionCache.get(key);
  if (!entry) {
    entry = { collection: new ResourceCollection(), refs: 0 };
    collectionCache.set(key, entry);
  }
  // Cancel any pending teardown — we have a new subscriber.
  if (entry.teardownTimer !== undefined) {
    window.clearTimeout(entry.teardownTimer);
    entry.teardownTimer = undefined;
  }
  // Pre-increment so the entry survives until the caller's cleanup effect
  // runs (also called once on every render path, paired with release()).
  entry.refs += 1;
  const retain = () => { entry!.refs += 1; };
  const release = () => {
    entry!.refs -= 1;
    if (entry!.refs > 0) return;
    // Defer teardown briefly so a navigation that unmounts and remounts the
    // same hook (or React's double-mount in dev) doesn't drop the WS.
    entry!.teardownTimer = window.setTimeout(() => {
      const cur = collectionCache.get(key);
      if (cur && cur.refs <= 0) {
        cur.collection.teardown();
        collectionCache.delete(key);
      }
    }, COLLECTION_TEARDOWN_DELAY_MS);
  };
  return { collection: entry.collection, retain, release };
}

export function useResourceList(
  cluster: string,
  gvr: string,
  namespace?: string | string[],
  opts: { enabled?: boolean } = {},
) {
  const enabled = opts.enabled ?? true;
  const namespaceKey = Array.isArray(namespace)
    ? [...new Set(namespace.filter(Boolean))].sort().join("\u0000")
    : (namespace ?? "");
  const namespaces = useMemo(() => normalizeNamespaces(namespace), [namespaceKey]);
  const k = `${enabled ? "on" : "off"}|${cluster}|${gvr}|${namespaces.join(",")}`;
  // Refcounted shared collection. Multiple useResourceList callers with the
  // same (cluster, gvr, ns) key now share one ResourceCollection AND one set
  // of WS subscriptions. Previously a page that had both a list table and a
  // counts strip held two parallel pod streams.
  const { collection, retain, release } = useMemo(
    () => acquireCollection(k),
    [k],
  );
  // Each render path retains the entry once on mount, releases on unmount.
  // The acquireCollection() above already pre-incremented the refcount; we
  // pair every render's "acquire" with a release in the cleanup effect.
  useEffect(() => () => release(), [release]);

  useEffect(() => {
    if (!enabled || !cluster || !gvr) return;
    if (collection.hasSubscription()) return; // first subscriber wins
    collection.markSubscribed();
    const stream = getClusterStream(cluster);
    const subscribeTo = namespaces.length > 0 ? namespaces : [undefined];
    const subs = subscribeTo.map((ns) => stream.subscribe(gvr, ns, (f) => {
      const source = ns ?? "__all__";
      if (f.kind === "error") {
        const msg = f.msg || "subscription failed";
        console.warn("resource subscription error:", { cluster, gvr, namespace: ns, msg });
        collection.fail(msg);
        return;
      }
      collection.applyFrom(source, f);
    }));
    const timeout = window.setTimeout(() => {
      if (!collection.hasResult()) {
        collection.fail("timed out waiting for initial stream snapshot");
      }
    }, 30_000);
    collection.cleanup = () => {
      window.clearTimeout(timeout);
      for (const sub of subs) sub.unsubscribe();
    };
    // Cleanup is owned by the cache (runs when refcount hits zero) so a
    // mid-render React unmount/mount swap doesn't tear down the WS only to
    // re-establish it 1ms later. Caller's release() drops the refcount.
    retain();
    return () => { release(); };
  }, [enabled, cluster, gvr, collection, retain, release, namespaceKey, namespaces]);

  const snapshot = useSyncExternalStore(collection.subscribe, collection.getSnapshot, collection.getSnapshot);

  return useMemo(
    () => ({
      items: snapshot.items,
      ready: snapshot.ready,
      error: snapshot.error,
      total: snapshot.items.length,
    }),
    [snapshot],
  );
}

function normalizeNamespaces(namespace?: string | string[]): string[] {
  if (Array.isArray(namespace)) {
    return [...new Set(namespace.filter(Boolean))].sort();
  }
  return namespace ? [namespace] : [];
}
