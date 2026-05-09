// logStreams.ts — module-scoped pool of pod-log streams.
//
// Why this exists: at enterprise scale a logs viewer that stores its buffer
// in component state loses everything on remount, pause/resume, or pod
// deletion. We move all stream/buffer ownership outside React so the data
// survives:
//
//   • component unmount / tab switching     (subscribers come and go)
//   • pause / resume / setting changes      (rendering only, not stream)
//   • pod deletion / rollout                (buffer freezes, last lines kept)
//   • full page reload                      (sessionStorage hydration)
//
// Storage budget — the worst case the math has to fit:
//
//   ABSOLUTE_MAX_LINES (20 000)  ·  ~200 B/line  ≈ 4 MB / stream
//   MAX_STREAMS (32)             ·  4 MB         ≈ 128 MB resident worst case
//   sessionStorage tail (PERSIST_MAX_LINES * PERSIST_MAX_STREAMS) ≈ 4 MB
//
// Per-stream `bufferCap` (default 500) is the user-controllable knob: it
// trims the in-browser ring live without disturbing the WebSocket. Switching
// from 500 → 5 000 enlarges the ring (existing lines are preserved); going
// 5 000 → 500 drops the oldest lines on the spot. Server-side initial tail
// is set independently from `OpenOpts.tail`, since we don't want the server
// to re-stream tens of thousands of lines on every cap change.
//
// Threading model: one WebSocket per (cluster, ns, pod, container, previous,
// follow) tuple. `tail` is no longer part of the key — it's only the
// initial-fetch hint. Subscribers receive change notifications batched per
// requestAnimationFrame so a 5 000-line burst becomes one render, not 5 000.

const ABSOLUTE_MAX_LINES = 20_000;
const DEFAULT_BUFFER_CAP = 500;
const MAX_STREAMS = 32;
const PERSIST_KEY = "k8s-view:logs:v1";
const PERSIST_MAX_STREAMS = 12;
const PERSIST_MAX_LINES = 2_000;
const REGISTRY_KEY = "k8s-view:pod-registry:v1";
const REGISTRY_MAX_ENTRIES = 256;
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

// Hot-path: a chatty pod can deliver thousands of WS frames per second. A
// fresh TextDecoder() per frame is wasteful (and shows up in profiles).
// Decoding is stateless here (one frame = one complete payload), so a
// single shared instance is correct.
const FRAME_DECODER = new TextDecoder();

/** Maximum allowed buffer cap (used by callers picking "Unlimited"). */
export const LOG_BUFFER_HARD_CAP = ABSOLUTE_MAX_LINES;
/** Default buffer cap when none is supplied. */
export const LOG_BUFFER_DEFAULT_CAP = DEFAULT_BUFFER_CAP;

export type StreamState =
  | "connecting"
  | "streaming"
  | "waiting"      // container not running yet (transient — auto-retry)
  | "reconnecting" // unexpected close, scheduled retry pending
  | "ended"        // server closed and we gave up retrying
  | "pod-gone"     // 404 — pod object no longer exists
  | "error";       // other fatal error

export interface OpenOpts {
  cluster: string;
  ns: string;
  pod: string;
  container: string;
  previous: boolean;
  follow: boolean;
  tail: number;
  /** RFC3339 timestamp used for the initial request when the user picks a
   *  calendar/time range. Reconnects still continue from lastLineAt. */
  sinceTime?: string;
}

export interface StreamSnapshot {
  key: string;
  opts: OpenOpts;
  state: StreamState;
  err: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Monotonic — bumps on every batch flush or state transition. */
  version: number;
  lineCount: number;
}

interface LogStream {
  key: string;
  opts: OpenOpts;
  state: StreamState;
  err: string | null;
  startedAt: number;
  endedAt: number | null;
  version: number;
  // Ring buffer. `bufferCap` is the user-controllable cap; the buffer stops
  // growing past it and trims the oldest line on every push. Live mutation
  // via setBufferCap reallocates / drops as needed.
  bufferCap: number;
  buf: (string | undefined)[];
  head: number;
  size: number;
  /** Stream-monotonic counter — bumps once per successfully appended line.
   *  The seq of the i-th line currently in `readBuf` output is
   *  `totalAppended - size + i + 1`. Used as a stable React key so a line
   *  that survives a ring rotation keeps the same key (without this, every
   *  line's positional index shifts when the ring trims, killing
   *  virtualization performance on capped buffers). */
  totalAppended: number;
  seenLineKeys: Set<string>;
  seenLineQueue: string[];
  lastLineAt: string | null;
  // Network.
  ws: WebSocket | null;
  retryTimer: number | null;
  pingTimer: number | null;
  closed: boolean; // permanently closed (close() called)
  /** Number of consecutive reconnect attempts that produced zero data.
   *  Resets to 0 on any successful data frame. After MAX_BLIND_RETRIES we
   *  give up and mark the stream "ended" so the user sees a stable
   *  terminal state. */
  blindRetries: number;
  /** Connections that closed within FAST_EMPTY_WINDOW_MS without delivering
   *  any new data — the signature of a terminated/Job pod whose log stream
   *  the server closes immediately because there's nothing to follow. After
   *  FAST_EMPTY_GIVEUP we transition to "ended" so the UI doesn't churn the
   *  Reconnecting chip forever on a Completed Job. */
  fastEmptyCloses: number;
  /** Wall-clock at which the current WebSocket transitioned to OPEN. Reset
   *  to 0 in connect() so a failed upgrade doesn't carry over a stale
   *  timestamp from the last successful one. */
  connectedAt: number;
  /** Per-connection: did this socket actually push a NEW line into the ring?
   *  k8s `--since-time` is inclusive, so the server re-emits the last seen
   *  line on every reconnect — those duplicates set `gotData` but pushLine
   *  drops them, which used to trick the fast-empty-close detector into
   *  thinking the stream was alive. */
  appendedThisConnection: boolean;
  // Stream-local connect state.
  gotData: boolean;
  transientErr: boolean;
  // Subscribers — notified after a rAF flush.
  subscribers: Set<() => void>;
  pendingFlush: boolean;
  rafHandle: number | null;
  // LRU.
  lastTouchedAt: number;
  // Memoized snapshot, replaced (new reference) on every version bump.
  cachedSnapshot: StreamSnapshot;
}

const MAX_BLIND_RETRIES = 6;
const PING_INTERVAL_MS = 25_000;
/** A WebSocket that closed within this window of opening, with no data, is
 *  treated as evidence the upstream has nothing to follow (terminated pod /
 *  completed Job). 2 s is well above normal RTT, well below the proxy idle
 *  windows that produce legitimate long-running closes. */
const FAST_EMPTY_WINDOW_MS = 2_000;
const FAST_EMPTY_GIVEUP = 3;

const pool = new Map<string, LogStream>();
const EMPTY_LINES: readonly string[] = Object.freeze([]);

// ──────────────────────────────────────────────────────────────────────────
// Public API.
// ──────────────────────────────────────────────────────────────────────────

export function streamKey(o: OpenOpts): string {
  // `tail` and `bufferCap` deliberately do NOT participate in the key:
  // changing how many lines we keep in browser memory must not fork the
  // stream. The stream identity is the (cluster, ns, pod, container,
  // previous, follow, sinceTime) tuple — anything else is a runtime knob.
  return [
    o.cluster, o.ns, o.pod, o.container,
    o.previous ? "p" : "_",
    o.follow ? "f" : "_",
    o.sinceTime ?? "_",
  ].join("|");
}

export function open(o: OpenOpts): string {
  const key = streamKey(o);
  let s = pool.get(key);
  if (!s) {
    s = createStream(key, o);
    pool.set(key, s);
    evictLRU();
    connect(s);
  } else {
    s.lastTouchedAt = Date.now();
    // Re-opening with a *larger* tail grows the existing ring so the next
    // refetch path (or the steady-state buffer) has room. We never auto-
    // shrink here: callers — PodLogsPage's effective-ring-cap effect, and
    // the explicit user pick — own that decision. Auto-shrink would silently
    // drop accumulated lines when an uncapped buffer's dropdown moves down.
    const desired = clampBufferCap(o.tail);
    if (desired > s.bufferCap) setBufferCap(key, desired);
    if (o.follow && !s.closed && !s.ws && s.retryTimer === null && s.state === "reconnecting") {
      reconnect(key);
    }
    // If a previous session left the stream frozen (page reload hydration,
    // or an earlier ended stream the user is revisiting) and the user is
    // explicitly opening it again, do nothing — they'll see the cached
    // buffer. They can call reconnect(key) to actively re-stream.
  }
  return key;
}

/** Force-reopen a stream's WebSocket. Buffer is preserved; only the WS
 *  lifecycle resets. Used both by the manual "Reconnect" button and by
 *  visibility-restore (browsers throw away the connection when a tab has
 *  been backgrounded long enough). */
export function reconnect(key: string): void {
  const s = pool.get(key);
  if (!s) return;
  closeSocket(s);
  s.state = "connecting";
  s.err = null;
  s.endedAt = null;
  s.gotData = false;
  s.transientErr = false;
  s.blindRetries = 0;
  s.fastEmptyCloses = 0;
  s.connectedAt = 0;
  s.appendedThisConnection = false;
  markDirty(s);
  connect(s);
}

export function subscribe(key: string, cb: () => void): () => void {
  const s = pool.get(key);
  if (!s) return () => {};
  s.subscribers.add(cb);
  s.lastTouchedAt = Date.now();
  return () => {
    s.subscribers.delete(cb);
    // Note: we deliberately do NOT close the WS or evict the buffer when the
    // last subscriber leaves. Component unmount must not lose data — the
    // user might just be switching tabs. LRU eviction handles cleanup.
  };
}

export function getSnapshot(key: string): StreamSnapshot | null {
  return pool.get(key)?.cachedSnapshot ?? null;
}

export function getLines(key: string): readonly string[] {
  const s = pool.get(key);
  if (!s) return EMPTY_LINES;
  return readBuf(s);
}

/** Same as getLines, but also returns the stream-monotonic seq of the first
 *  returned line (1-indexed). Callers that want stable React keys across
 *  ring rotation should derive `seq = firstSeq + lineIndex` per line — this
 *  way a line that survives a trim keeps the same key. */
export function getLinesWithSeq(key: string): { lines: readonly string[]; firstSeq: number } {
  const s = pool.get(key);
  if (!s) return { lines: EMPTY_LINES, firstSeq: 0 };
  return { lines: readBuf(s), firstSeq: s.totalAppended - s.size + 1 };
}

export function clearLines(key: string): void {
  const s = pool.get(key);
  if (!s) return;
  s.head = 0;
  s.size = 0;
  // We deliberately do NOT reset totalAppended — leaving the seq monotonic
  // even across a manual clear keeps existing React keys distinct from any
  // new lines that arrive next, so the virtualizer doesn't briefly map a
  // new line to an old DOM row.
  s.seenLineKeys.clear();
  s.seenLineQueue = [];
  s.lastLineAt = null;
  for (let i = 0; i < s.buf.length; i++) s.buf[i] = undefined;
  markDirty(s);
}

/** Resize the live ring buffer. Cap is clamped to [1, ABSOLUTE_MAX_LINES].
 *
 *  - mode `"trim"` (default): purely display-layer resize. Existing lines
 *    survive (or get trimmed from the head if the cap shrinks). The
 *    WebSocket is never touched.
 *  - mode `"refetch"`: also re-issue the stream with `tail = cap`. This is
 *    the path the user hits when they pick a *bigger* buffer in the UI —
 *    the server resends the last `cap` lines so they immediately see what
 *    they asked for instead of waiting for new lines to dribble in.
 *
 *  When refetching we drop the prior buffer entirely. The fresh server
 *  response IS the new tail; merging would just produce duplicates against
 *  the timestamp-deduped seen-set.
 */
export function setBufferCap(
  key: string,
  cap: number,
  mode: "trim" | "refetch" = "trim",
  serverTail?: number,
): void {
  const s = pool.get(key);
  if (!s) return;
  const next = clampBufferCap(cap);
  if (mode === "refetch") {
    s.bufferCap = next;
    // Persist the new tail on opts so subsequent silent reconnects (kubelet
    // idle drops, page-restore, etc.) ask for the same window. `serverTail`
    // lets the caller decouple ring size from the tail re-fetched from the
    // server — e.g., uncapped mode keeps a HARD_CAP-sized ring but only
    // re-fetches the user-selected tail.
    const tail = serverTail !== undefined ? clampBufferCap(serverTail) : next;
    s.opts = { ...s.opts, tail };
    closeSocket(s);
    s.buf = new Array(next);
    s.head = 0;
    s.size = 0;
    s.seenLineKeys.clear();
    s.seenLineQueue = [];
    s.lastLineAt = null;
    s.endedAt = null;
    s.err = null;
    s.gotData = false;
    s.transientErr = false;
    s.blindRetries = 0;
    s.fastEmptyCloses = 0;
    s.connectedAt = 0;
    s.appendedThisConnection = false;
    s.state = "connecting";
    markDirty(s);
    connect(s);
    return;
  }
  if (next === s.bufferCap) return;
  // Linearise the current ring in arrival order so we can resize without
  // having to think about head/tail wrap on the new buffer.
  const lines = readBuf(s);
  const keep = lines.slice(Math.max(0, lines.length - next));
  s.buf = new Array(next);
  for (let i = 0; i < keep.length; i++) s.buf[i] = keep[i];
  s.size = keep.length;
  s.head = keep.length % next;
  s.bufferCap = next;
  // Trim the dedupe set so it can't grow past the new cap either.
  while (s.seenLineQueue.length > next) {
    const old = s.seenLineQueue.shift();
    if (old) s.seenLineKeys.delete(old);
  }
  markDirty(s);
}

function clampBufferCap(n: number | undefined): number {
  if (!Number.isFinite(n) || (n as number) <= 0) return DEFAULT_BUFFER_CAP;
  return Math.min(ABSOLUTE_MAX_LINES, Math.max(1, Math.floor(n as number)));
}

export function findPodLogContainers(args: { cluster: string; ns: string; pod: string }): string[] {
  const seen = new Set<string>();
  for (const s of pool.values()) {
    if (s.opts.cluster !== args.cluster || s.opts.ns !== args.ns || s.opts.pod !== args.pod) continue;
    if (s.opts.container) seen.add(s.opts.container);
  }
  return Array.from(seen).sort();
}

export function close(key: string): void {
  const s = pool.get(key);
  if (!s) return;
  s.closed = true;
  closeSocket(s);
  pool.delete(key);
}

/** All streams currently in the pool (subscribed or frozen). */
export function listStreams(): StreamSnapshot[] {
  return Array.from(pool.values()).map((s) => s.cachedSnapshot);
}

// ──────────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────────

function createStream(key: string, opts: OpenOpts): LogStream {
  const now = Date.now();
  const cap = clampBufferCap(opts.tail);
  const s: LogStream = {
    key,
    opts,
    state: "connecting",
    err: null,
    startedAt: now,
    endedAt: null,
    version: 0,
    bufferCap: cap,
    buf: new Array(cap),
    head: 0,
    size: 0,
    totalAppended: 0,
    seenLineKeys: new Set(),
    seenLineQueue: [],
    lastLineAt: null,
    ws: null,
    retryTimer: null,
    pingTimer: null,
    closed: false,
    blindRetries: 0,
    fastEmptyCloses: 0,
    connectedAt: 0,
    appendedThisConnection: false,
    gotData: false,
    transientErr: false,
    subscribers: new Set(),
    pendingFlush: false,
    rafHandle: null,
    lastTouchedAt: now,
    cachedSnapshot: undefined as unknown as StreamSnapshot,
  };
  s.cachedSnapshot = makeSnapshot(s);
  return s;
}

function makeSnapshot(s: LogStream): StreamSnapshot {
  return {
    key: s.key,
    opts: s.opts,
    state: s.state,
    err: s.err,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    version: s.version,
    lineCount: s.size,
  };
}

// markDirty — coalesce burst-rate state changes (one mark per line, vs.
// 16ms of flush work). At 100 lines/ms that's the difference between
// allocating a fresh snapshot 100 times per frame and once per frame. The
// hot path stays O(1) per line — no allocations beyond the line itself.
function markDirty(s: LogStream): void {
  scheduleFlush(s);
}

function scheduleFlush(s: LogStream): void {
  if (s.pendingFlush) return;
  s.pendingFlush = true;
  s.rafHandle = requestAnimationFrame(() => flush(s));
}

function flush(s: LogStream): void {
  s.pendingFlush = false;
  s.rafHandle = null;
  // useSyncExternalStore demands that getSnapshot return a stable reference
  // between subscriber notifications. We swap the snapshot reference and
  // notify atomically so React reads the new state on the very next render.
  s.version++;
  s.cachedSnapshot = makeSnapshot(s);
  for (const cb of s.subscribers) cb();
}

function pushLine(s: LogStream, line: string): boolean {
  const ts = logLineTimestamp(line);
  const key = ts ? line : null;
  if (key && s.seenLineKeys.has(key)) return false;

  const cap = s.bufferCap;
  s.buf[s.head] = line;
  s.head = (s.head + 1) % cap;
  if (s.size < cap) s.size++;
  s.totalAppended++;
  if (ts) s.lastLineAt = ts;
  if (key) {
    s.seenLineKeys.add(key);
    s.seenLineQueue.push(key);
    while (s.seenLineQueue.length > cap) {
      const old = s.seenLineQueue.shift();
      if (old) s.seenLineKeys.delete(old);
    }
  }
  return true;
}

const K8S_LOG_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s/;

function logLineTimestamp(line: string): string | null {
  // The UI asks the API for Kubernetes timestamps. Accept both UTC (`Z`) and
  // local-offset forms (`+03:00`) because CRI/kubelet implementations differ.
  return K8S_LOG_TS.exec(line)?.[1] ?? null;
}

function readBuf(s: LogStream): readonly string[] {
  if (s.size === 0) return EMPTY_LINES;
  const cap = s.bufferCap;
  const out = new Array<string>(s.size);
  if (s.size < cap) {
    for (let i = 0; i < s.size; i++) out[i] = s.buf[i] as string;
  } else {
    // Full ring — start at head, wrap.
    let j = 0;
    for (let i = s.head; i < cap; i++) out[j++] = s.buf[i] as string;
    for (let i = 0; i < s.head; i++) out[j++] = s.buf[i] as string;
  }
  return out;
}

function closeSocket(s: LogStream): void {
  if (s.retryTimer !== null) {
    window.clearTimeout(s.retryTimer);
    s.retryTimer = null;
  }
  if (s.pingTimer !== null) {
    window.clearInterval(s.pingTimer);
    s.pingTimer = null;
  }
  if (s.rafHandle !== null) {
    cancelAnimationFrame(s.rafHandle);
    s.rafHandle = null;
    s.pendingFlush = false;
  }
  if (s.ws) {
    try { s.ws.close(); } catch { /* ignore */ }
    s.ws = null;
  }
}

// scheduleReconnect — exponential backoff up to MAX_BLIND_RETRIES blind
// (no-data) attempts. The kubelet, the API server, and pretty much every
// reverse proxy in front of them will drop an idle log stream eventually
// (60–600 s typical idle window). For an actively-running pod we MUST
// recover transparently — silent reconnect is the right behaviour.
function scheduleReconnect(s: LogStream): void {
  if (s.closed) return;
  if (!s.opts.follow && s.blindRetries >= MAX_BLIND_RETRIES) {
    s.state = "ended";
    if (!s.endedAt) s.endedAt = Date.now();
    markDirty(s);
    return;
  }
  // 250 ms, 500 ms, 1 s, 2 s, 4 s, 8 s. Caps at 8 s so a long-idle pod
  // always recovers within ~8 s of the next log line.
  const delay = Math.min(250 * (1 << Math.min(s.blindRetries, MAX_BLIND_RETRIES)), 8_000);
  s.state = "reconnecting";
  s.endedAt = null;
  markDirty(s);
  s.retryTimer = window.setTimeout(() => {
    s.retryTimer = null;
    connect(s);
  }, delay);
}

function connect(s: LogStream): void {
  if (s.closed) return;
  // Preserve "reconnecting" so the chip doesn't flicker through "connecting"
  // on every retry — the user sees a stable state until either data flows
  // again or we give up.
  if (s.state !== "reconnecting") s.state = "connecting";
  s.gotData = false;
  s.transientErr = false;
  s.connectedAt = 0;
  s.appendedThisConnection = false;

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(
    `${proto}//${window.location.host}/api/v1/${encodeURIComponent(s.opts.cluster)}/pods/${encodeURIComponent(s.opts.ns)}/${encodeURIComponent(s.opts.pod)}/logs`,
  );
  url.searchParams.set("container", s.opts.container);
  url.searchParams.set("follow", String(s.opts.follow));
  if (s.opts.follow && s.lastLineAt) {
    url.searchParams.set("sinceTime", s.lastLineAt);
  } else if (s.opts.sinceTime) {
    url.searchParams.set("sinceTime", s.opts.sinceTime);
  } else {
    url.searchParams.set("tail", String(s.opts.tail));
  }
  url.searchParams.set("timestamps", "true");
  if (s.opts.previous) url.searchParams.set("previous", "true");

  const ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";
  s.ws = ws;

  ws.onopen = () => {
    s.state = "streaming";
    s.connectedAt = Date.now();
    markDirty(s);
    // Application-level keepalive. Browser WebSocket API does not expose
    // ping frames, but the backend's reader drains and discards anything
    // the client sends — so a tiny periodic message is enough to keep
    // every intermediate proxy from idling out the connection. 25 s is
    // safely under the 30 s default of most reverse proxies.
    if (s.pingTimer !== null) window.clearInterval(s.pingTimer);
    s.pingTimer = window.setInterval(() => {
      if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        try { s.ws.send("ping"); } catch { /* ignore */ }
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = (ev) => {
    const data = typeof ev.data === "string"
      ? ev.data
      : FRAME_DECODER.decode(new Uint8Array(ev.data as ArrayBuffer));
    let appended = false;
    for (const l of data.split("\n")) {
      if (!l) continue;
      // "pod gone" — fatal & informative; surface as state, not as a buffer
      // line. We only treat the *first* such message as decisive — once we
      // have real data we don't want a late kubelet error reframing the
      // stream.
      if (!s.gotData && PROBE_POD_GONE.test(l)) {
        s.state = "pod-gone";
        s.err = l.replace(/^error:\s*/, "");
        s.endedAt = Date.now();
        markDirty(s);
        continue;
      }
      // "container is starting up" — drop the line, hint the UI, retry on
      // close.
      if (!s.gotData && isTransientLogError(l)) {
        s.transientErr = true;
        if (s.state !== "waiting") {
          s.state = "waiting";
          markDirty(s);
        }
        continue;
      }
      // gotData stays as "received any payload at all" — needed so the
      // PROBE_POD_GONE / transient-error guards above only fire on the
      // FIRST inbound line of a connection.
      s.gotData = true;
      // appendedThisConnection only flips on a *new* line, since k8s
      // `--since-time=` is inclusive and the server re-emits the previous
      // tail on every reconnect. Without this distinction the fast-empty
      // detector treats a terminated Job's reconnect-with-dupe-line as a
      // healthy stream and loops forever.
      if (pushLine(s, l)) {
        appended = true;
        s.appendedThisConnection = true;
        s.blindRetries = 0;
        s.fastEmptyCloses = 0;
      }
    }
    if (appended) {
      if (s.state !== "streaming") s.state = "streaming";
      s.lastTouchedAt = Date.now();
      markDirty(s);
    }
  };

  ws.onclose = () => {
    s.ws = null;
    if (s.pingTimer !== null) {
      window.clearInterval(s.pingTimer);
      s.pingTimer = null;
    }
    if (s.closed) return;
    if (s.state === "pod-gone" || s.state === "error") {
      // Already terminal — keep state.
      markDirty(s);
      return;
    }
    if (!s.gotData && s.transientErr) {
      // Container is starting — short retry without bumping the blind
      // counter. Different failure mode from "kubelet dropped us idle".
      s.retryTimer = window.setTimeout(() => {
        s.retryTimer = null;
        connect(s);
      }, 2000);
      return;
    }
    // Detect terminated-pod / completed-Job: the WS opened, did not append
    // any new line, and the server closed it almost immediately. Even if
    // the server re-shipped the last buffered line as a duplicate (k8s'
    // sinceTime= is inclusive), pushLine drops it, so
    // `appendedThisConnection` stays false — the only reliable signal that
    // there is genuinely nothing more to follow. kubectl logs --follow on a
    // Succeeded pod just exits, and so should we.
    const fastEmpty = !s.appendedThisConnection
      && s.connectedAt > 0
      && (Date.now() - s.connectedAt) < FAST_EMPTY_WINDOW_MS;
    if (fastEmpty) s.fastEmptyCloses++;
    else if (s.appendedThisConnection) s.fastEmptyCloses = 0;
    if (s.fastEmptyCloses >= FAST_EMPTY_GIVEUP) {
      s.state = "ended";
      if (!s.endedAt) s.endedAt = Date.now();
      markDirty(s);
      return;
    }
    if (!s.appendedThisConnection) s.blindRetries++;
    scheduleReconnect(s);
  };

  ws.onerror = () => {
    // Errors trigger onclose; nothing more to do here. Keep silent so the UI
    // doesn't get a duplicate "error" state for what is really a close.
  };

  markDirty(s);
}

function evictLRU(): void {
  if (pool.size <= MAX_STREAMS) return;
  // Sort by lastTouchedAt ascending; evict from the front, but never evict
  // a stream that has live subscribers — those are owned by mounted UI.
  const candidates = Array.from(pool.values())
    .filter((s) => s.subscribers.size === 0)
    .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);
  while (pool.size > MAX_STREAMS && candidates.length > 0) {
    const victim = candidates.shift()!;
    close(victim.key);
  }
}

const PROBE_POD_GONE = /^error:\s*(?:pods?\s+["']?[\w.-]+["']?\s+not found|the server could not find the requested resource)/i;

const TRANSIENT_PATTERNS = /ContainerCreating|PodInitializing|is waiting to start|not yet started|in pod ".*" is waiting/i;

function isTransientLogError(line: string): boolean {
  if (!line.startsWith("error:")) return false;
  return TRANSIENT_PATTERNS.test(line);
}

// ──────────────────────────────────────────────────────────────────────────
// Persistence (Phase 2) — survive a full page reload.
//
// We dump the tail of the most-recently-touched streams to sessionStorage
// on visibilitychange/pagehide. On module init we hydrate them as
// "ended" frozen buffers — the user sees their old logs, and can hit
// reconnect() to re-stream if the pod still exists.
// ──────────────────────────────────────────────────────────────────────────

interface PersistedStream {
  key: string;
  opts: OpenOpts;
  state: StreamState;
  err: string | null;
  startedAt: number;
  endedAt: number | null;
  lines: string[];
}

function persistAll(): void {
  if (pool.size === 0) {
    try { sessionStorage.removeItem(PERSIST_KEY); } catch { /* ignore */ }
    return;
  }
  const ordered = Array.from(pool.values())
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
    .slice(0, PERSIST_MAX_STREAMS);
  const out: PersistedStream[] = ordered.map((s) => {
    const all = readBuf(s);
    const tail = all.length > PERSIST_MAX_LINES ? all.slice(all.length - PERSIST_MAX_LINES) : all.slice();
    return {
      key: s.key,
      opts: s.opts,
      // We persist alive streams as "ended" — on hydrate the UI shows them
      // as frozen until the user explicitly reconnects. Saves us guessing
      // whether the pod still exists post-reload.
      state: s.state === "streaming" || s.state === "connecting" || s.state === "waiting" || s.state === "reconnecting"
        ? (s.opts.follow ? "reconnecting" : "ended")
        : s.state,
      err: s.err,
      startedAt: s.startedAt,
      endedAt: s.opts.follow ? null : (s.endedAt ?? Date.now()),
      lines: tail,
    };
  });
  try {
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify(out));
  } catch {
    // Quota exceeded or storage unavailable — drop silently. Persistence is
    // best-effort.
  }
}

function hydrateAll(): void {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(PERSIST_KEY); } catch { return; }
  if (!raw) return;
  let arr: PersistedStream[];
  try { arr = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(arr)) return;
  for (const p of arr) {
    if (!p || typeof p.key !== "string" || !p.opts || !Array.isArray(p.lines)) continue;
    if (pool.has(p.key)) continue;
    const s = createStream(p.key, p.opts);
    s.state = p.opts?.follow && (p.state === "ended" || p.state === "connecting" || p.state === "streaming")
      ? "reconnecting"
      : (p.state ?? "ended");
    s.err = p.err ?? null;
    s.startedAt = p.startedAt ?? Date.now();
    s.endedAt = s.state === "reconnecting" ? null : (p.endedAt ?? Date.now());
    for (const line of p.lines) {
      if (typeof line === "string") pushLine(s, line);
    }
    s.cachedSnapshot = makeSnapshot(s);
    pool.set(p.key, s);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Pod registry (Phase 3) — track which pods we've shown logs for, grouped by
// their controller, so the UI can offer "predecessor pod" navigation after
// a rollout. Lives in sessionStorage so it survives reload along with the
// stream tails.
// ──────────────────────────────────────────────────────────────────────────

export interface PodRegistryEntry {
  cluster: string;
  ns: string;
  pod: string;
  controllerKey: string;       // canonical owner identity (see below)
  controllerLabel: string;     // pretty label, e.g. "Deployment/foo"
  firstSeen: number;
  lastSeen: number;
}

// In-memory mirror of the registry. Cheap reads and writes; persisted in a
// debounced fashion.
const registry = new Map<string, PodRegistryEntry>();
let persistTimer: number | null = null;

function regKey(cluster: string, ns: string, pod: string): string {
  return `${cluster}/${ns}/${pod}`;
}

function schedulePersistRegistry(): void {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      const arr = Array.from(registry.values());
      sessionStorage.setItem(REGISTRY_KEY, JSON.stringify(arr));
    } catch { /* ignore */ }
  }, 1000);
}

function hydrateRegistry(): void {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(REGISTRY_KEY); } catch { return; }
  if (!raw) return;
  let arr: PodRegistryEntry[];
  try { arr = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(arr)) return;
  const cutoff = Date.now() - REGISTRY_TTL_MS;
  for (const e of arr) {
    if (!e || typeof e.pod !== "string") continue;
    if (e.lastSeen < cutoff) continue;
    registry.set(regKey(e.cluster, e.ns, e.pod), e);
  }
}

/** Record that the user has viewed logs for this pod. Pass the live pod
 *  object (from the existing useQuery) — we extract owner info from it.
 *  Calling this repeatedly for the same pod just bumps lastSeen. */
export function notePodVisit(opts: OpenOpts, pod: any): void {
  const ck = computeControllerKey(opts.ns, pod);
  const k = regKey(opts.cluster, opts.ns, opts.pod);
  const now = Date.now();
  const existing = registry.get(k);
  if (existing) {
    existing.lastSeen = now;
    if (ck) {
      existing.controllerKey = ck.key;
      existing.controllerLabel = ck.label;
    }
  } else {
    registry.set(k, {
      cluster: opts.cluster,
      ns: opts.ns,
      pod: opts.pod,
      controllerKey: ck?.key ?? `pod:${opts.pod}`,
      controllerLabel: ck?.label ?? opts.pod,
      firstSeen: now,
      lastSeen: now,
    });
  }
  // Cap registry size — drop oldest entries.
  if (registry.size > REGISTRY_MAX_ENTRIES) {
    const sorted = Array.from(registry.values()).sort((a, b) => a.lastSeen - b.lastSeen);
    const drop = sorted.length - REGISTRY_MAX_ENTRIES;
    for (let i = 0; i < drop; i++) registry.delete(regKey(sorted[i].cluster, sorted[i].ns, sorted[i].pod));
  }
  schedulePersistRegistry();
}

/** A pod we've viewed in the same controller. Includes the currently-open
 *  one (marked `isCurrent`) so the UI can list every workload pod the user
 *  has touched in one place. `bufferedLines` and `state` reflect any hot
 *  buffer in the pool (largest one wins across container/previous tuples). */
export interface WorkloadPodEntry extends PodRegistryEntry {
  bufferedLines: number;
  state: StreamState | null;
  isCurrent: boolean;
}

export function findWorkloadPods(opts: OpenOpts): WorkloadPodEntry[] {
  const me = registry.get(regKey(opts.cluster, opts.ns, opts.pod));
  // The controller key for the current pod might not be in the registry yet
  // (first visit) — fall back to a heuristic on the pod name.
  const ck = me?.controllerKey ?? guessControllerKeyFromName(opts.pod);
  const out: WorkloadPodEntry[] = [];
  for (const e of registry.values()) {
    if (e.cluster !== opts.cluster || e.ns !== opts.ns) continue;
    if (e.controllerKey !== ck) continue;
    // Look up any cached buffer for this pod across our active stream tuples.
    let bufferedLines = 0;
    let state: StreamState | null = null;
    for (const s of pool.values()) {
      if (s.opts.cluster === e.cluster && s.opts.ns === e.ns && s.opts.pod === e.pod) {
        if (s.size > bufferedLines) {
          bufferedLines = s.size;
          state = s.state;
        }
      }
    }
    out.push({ ...e, bufferedLines, state, isCurrent: e.pod === opts.pod });
  }
  // Current pod first, then most-recently-seen. This is the order users
  // expect when scanning a list of "pods I've worked with on this workload".
  return out.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });
}

function computeControllerKey(ns: string, pod: any): { key: string; label: string } | null {
  const refs: any[] = pod?.metadata?.ownerReferences ?? [];
  const ctrl = refs.find((r) => r?.controller) ?? refs[0];
  if (!ctrl?.kind || !ctrl?.name) return null;
  // ReplicaSets are a rolling-rollout artefact — strip the trailing
  // pod-template hash so we group across rollouts within the same
  // Deployment. Same heuristic kubectl uses for "deployment-XXXXX-YYYYY"
  // pod names.
  if (ctrl.kind === "ReplicaSet") {
    const stripped = stripHashSuffix(ctrl.name);
    return { key: `Deployment/${ns}/${stripped}`, label: `Deployment/${stripped}` };
  }
  return { key: `${ctrl.kind}/${ns}/${ctrl.name}`, label: `${ctrl.kind}/${ctrl.name}` };
}

function guessControllerKeyFromName(podName: string): string {
  // Best-effort fallback when we don't have the pod object yet — group by
  // everything before the last two hash segments. Matches the
  // `<deployment>-<rs-hash>-<pod-hash>` pattern.
  const parts = podName.split("-");
  if (parts.length >= 3) return `guess:${parts.slice(0, -2).join("-")}`;
  return `pod:${podName}`;
}

function stripHashSuffix(s: string): string {
  // ReplicaSet names: `<deployment>-<10-char-hash>`. The hash is alphanumeric
  // and 5–10 chars in current k8s. Strip a single trailing segment that
  // looks hashy.
  const m = /^(.*)-([a-z0-9]{5,10})$/.exec(s);
  return m ? m[1] : s;
}

// ──────────────────────────────────────────────────────────────────────────
// Module init.
// ──────────────────────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  hydrateAll();
  hydrateRegistry();
  // Persist on visibility change AND on pagehide — Safari fires only the
  // latter on tab close, Chrome fires the former when backgrounded.
  const onHide = () => persistAll();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistAll();
  });
  window.addEventListener("pagehide", onHide);
  // Best-effort beforeunload — some browsers skip pagehide on hard reload.
  window.addEventListener("beforeunload", onHide);
}
