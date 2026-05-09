// notifications — module-scoped toast queue. Modal dialogs were our only
// surface for "operation succeeded / failed" messages, which is too
// heavyweight for non-blocking signals (port-forward bound, restart
// kicked off, YAML applied). The toast tray below covers that gap.
//
// Design constraints:
//   • Cap the queue at MAX so a flapping operation can't drown the UI.
//   • Auto-dismiss after `duration` ms (default 4 s for info, 6 s for
//     warn/bad). Errors stay sticky until dismissed manually.
//   • Each toast carries a stable id so React can keyframe-animate
//     entry/exit without losing identity on a re-render.

const MAX = 5;

export type ToastTone = "ok" | "info" | "warn" | "bad";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  /** ms before auto-dismiss; 0 means sticky. */
  duration: number;
  createdAt: number;
}

const queue: Toast[] = [];
const listeners = new Set<() => void>();

export function getSnapshot(): readonly Toast[] {
  return queue;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export interface PushOpts {
  title: string;
  body?: string;
  tone?: ToastTone;
  duration?: number;
}

export function push(opts: PushOpts): string {
  const tone = opts.tone ?? "info";
  const duration = opts.duration ?? defaultDuration(tone);
  const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const t: Toast = {
    id,
    tone,
    title: opts.title,
    body: opts.body,
    duration,
    createdAt: Date.now(),
  };
  queue.unshift(t);
  if (queue.length > MAX) queue.length = MAX;
  notify();
  if (duration > 0) {
    window.setTimeout(() => dismiss(id), duration);
  }
  return id;
}

export function dismiss(id: string): void {
  const idx = queue.findIndex((t) => t.id === id);
  if (idx < 0) return;
  queue.splice(idx, 1);
  notify();
}

export function clearAll(): void {
  if (queue.length === 0) return;
  queue.length = 0;
  notify();
}

// Convenience helpers — same shape as `modals.alert`/etc, just non-blocking.
export const notify_ = {
  ok:   (title: string, body?: string) => push({ title, body, tone: "ok" }),
  info: (title: string, body?: string) => push({ title, body, tone: "info" }),
  warn: (title: string, body?: string) => push({ title, body, tone: "warn" }),
  bad:  (title: string, body?: string) => push({ title, body, tone: "bad", duration: 0 }),
};

function defaultDuration(tone: ToastTone): number {
  // "bad" used to be sticky (0). Real-world usage showed the queue piling
  // up to MAX with no easy escape when the underlying error fired in a
  // loop (e.g. clipboard helper throwing on every keystroke), so we cap
  // it at 12 s — long enough to read, short enough to clear without help.
  // The "Dismiss all" button on the tray is the manual escape.
  if (tone === "bad") return 12_000;
  if (tone === "warn") return 6_000;
  return 4_000;
}

function notify() {
  for (const cb of listeners) cb();
}
