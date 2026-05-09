// favourites — user-pinned resources, persisted across reloads.
// Lens calls this the "Hotbar"; functionally it's a small list of
// (cluster, group, version, resource, namespace?, name) records that the
// sidebar surfaces as a one-click jump area.
//
// Backed by a single localStorage key. Subscriptions go through a tiny
// listener set so React components can `useSyncExternalStore` and pick
// up cross-tab changes via the storage event below.

const STORAGE_KEY = "k8s-view:favourites:v1";
const MAX = 64;

export interface Favourite {
  cluster: string;
  group: string;
  version: string;
  resource: string;
  namespace?: string;
  name: string;
  /** Display kind for the sidebar chip ("Pod", "Deployment", …). */
  kind: string;
  /** When the user pinned the entry. Used for "recent first" sort. */
  pinnedAt: number;
}

const listeners = new Set<() => void>();
let cache: Favourite[] = read();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cache = read();
    for (const cb of listeners) cb();
  });
}

export function list(): readonly Favourite[] {
  return cache;
}

export function listFor(cluster: string): readonly Favourite[] {
  return cache.filter((f) => f.cluster === cluster);
}

export function isPinned(f: Omit<Favourite, "pinnedAt" | "kind">): boolean {
  return cache.some((c) => sameRef(c, f));
}

export function toggle(f: Omit<Favourite, "pinnedAt">): void {
  if (isPinned(f)) {
    remove(f);
  } else {
    add(f);
  }
}

export function add(f: Omit<Favourite, "pinnedAt">): void {
  const existing = cache.find((c) => sameRef(c, f));
  if (existing) return;
  const next: Favourite[] = [{ ...f, pinnedAt: Date.now() }, ...cache];
  if (next.length > MAX) next.length = MAX;
  cache = next;
  persist();
}

export function remove(f: Omit<Favourite, "pinnedAt" | "kind">): void {
  const next = cache.filter((c) => !sameRef(c, f));
  if (next.length === cache.length) return;
  cache = next;
  persist();
}

// Move the favourite at index `from` to index `to` within the SAME
// cluster slice (Hotbar reorder). Slot positions matter — the user
// expects 1-9 keyboard shortcuts to land on a stable target — so we
// rewrite the underlying array preserving cross-cluster relative order.
export function reorder(cluster: string, from: number, to: number): void {
  const slice: number[] = [];
  cache.forEach((c, i) => { if (c.cluster === cluster) slice.push(i); });
  if (from < 0 || to < 0 || from >= slice.length || to >= slice.length) return;
  if (from === to) return;
  const next = cache.slice();
  const movedIdx = slice[from];
  const targetIdx = slice[to];
  const [moved] = next.splice(movedIdx, 1);
  // Splice shifts everything after `movedIdx` down by 1; recompute
  // target if it lay after the source.
  const insertAt = targetIdx > movedIdx ? targetIdx - 1 : targetIdx;
  next.splice(insertAt, 0, moved);
  cache = next;
  persist();
}

// Open by 1-based slot, scoped to a cluster. Used for the global
// Cmd+1..Cmd+9 keyboard binding installed in App.
export function favouriteAt(cluster: string, slot: number): Favourite | undefined {
  const slice = cache.filter((f) => f.cluster === cluster);
  return slice[slot - 1];
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getSnapshot(): readonly Favourite[] {
  return cache;
}

function sameRef(a: Omit<Favourite, "pinnedAt" | "kind">, b: Omit<Favourite, "pinnedAt" | "kind">): boolean {
  return a.cluster === b.cluster
    && a.group === b.group
    && a.version === b.version
    && a.resource === b.resource
    && (a.namespace ?? "") === (b.namespace ?? "")
    && a.name === b.name;
}

function read(): Favourite[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid).slice(0, MAX);
  } catch {
    return [];
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch { /* ignore quota */ }
  for (const cb of listeners) cb();
}

function isValid(v: unknown): v is Favourite {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.cluster === "string"
    && typeof o.group === "string"
    && typeof o.version === "string"
    && typeof o.resource === "string"
    && typeof o.name === "string"
    && typeof o.kind === "string"
    && typeof o.pinnedAt === "number";
}
