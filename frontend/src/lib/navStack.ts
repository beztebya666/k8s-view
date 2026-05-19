// navStack — an in-app navigation history, the "← →" the user asked for
// ("как в Lens'e — нету стрелочек вперёд и назад"). React-Router doesn't
// expose can-go-back / can-go-forward, so we keep our own linear stack:
// every committed location is recorded; Back/Forward move an index inside
// it (truncating the forward tail on a fresh navigation, exactly like a
// browser). The arrows disable at the ends so Back can never walk the
// user out of the SPA into whatever was open before.
//
// Module-level singleton (same shape as lib/favourites) so it survives
// component remounts and any view can read it via useSyncExternalStore.

const listeners = new Set<() => void>();
let entries: string[] = [];
let index = -1;
// When the user clicks our own arrows we call navigate(-1)/navigate(1);
// the resulting location change must move the index instead of pushing a
// new entry. This flag carries that intent across the async commit.
let pending: "back" | "forward" | null = null;

const MAX = 200;

function emit(): void {
  for (const cb of listeners) cb();
}

// Called for every committed location (full path + search).
export function record(loc: string): void {
  if (pending === "back") {
    pending = null;
    if (index > 0) index--;
    emit();
    return;
  }
  if (pending === "forward") {
    pending = null;
    if (index < entries.length - 1) index++;
    emit();
    return;
  }
  if (index >= 0 && entries[index] === loc) return; // no-op / refresh
  entries = entries.slice(0, index + 1);
  entries.push(loc);
  if (entries.length > MAX) entries = entries.slice(entries.length - MAX);
  index = entries.length - 1;
  emit();
}

export function markBack(): void { pending = "back"; }
export function markForward(): void { pending = "forward"; }

export function canBack(): boolean { return index > 0; }
export function canForward(): boolean { return index < entries.length - 1; }

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// A scalar that changes iff the navigable state changes — enough for
// useSyncExternalStore to decide whether to re-render the arrows.
export function snapshot(): string {
  return `${index}/${entries.length}`;
}
