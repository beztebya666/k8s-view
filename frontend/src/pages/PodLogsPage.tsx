// PodLogsPage — live tail of a pod's logs.
//
// All the heavy lifting (WebSocket lifecycle, line buffer, persistence,
// cross-rollout pod registry) lives in `lib/logStreams.ts`. This file is
// presentation only — it picks settings, subscribes to the pool, renders
// the buffer through a virtualized scroller, and offers a small popover
// for jumping to predecessor pods after a rollout.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, History, Pause, Play, RotateCcw,
  Trash2, X,
} from "lucide-react";
import { api } from "../lib/api";
import { useResourceList } from "../lib/useResourceList";
import {
  containerDisplayStatus,
  guessedPodControllerKey,
  podControllerKey,
  podDisplayStatus,
  podStatusClassName,
  type PodDisplayStatus,
} from "../lib/podStatus";
import { useApp } from "../stores/app";
import {
  clearLines,
  findWorkloadPods,
  findPodLogContainers,
  getLinesWithSeq,
  getSnapshot,
  LOG_BUFFER_DEFAULT_CAP,
  LOG_BUFFER_HARD_CAP,
  notePodVisit,
  open as openStream,
  reconnect as reconnectStream,
  setBufferCap as setStreamBufferCap,
  streamKey,
  subscribe as subscribeStream,
  type OpenOpts,
  type StreamSnapshot,
  type WorkloadPodEntry,
} from "../lib/logStreams";
import { Select } from "../components/Select";
import { LogSearchBar, EMPTY_SEARCH, type LogSearchValue } from "../components/LogSearchBar";
import { LogRow, type LogChunk, type MatchRange } from "../components/LogRow";
import { WheelColumn } from "../components/WheelColumn";
import { usePersistedState } from "../lib/usePersistedState";
import { useBottomPane } from "../components/BottomPane";

export function PodLogsPage(props: {
  clusterOverride?: string;
  ns?: string;
  podName?: string;
  initialContainer?: string;
  onClose?: () => void;
} = {}) {
  const params = useParams();
  const namespace = props.ns ?? params.namespace ?? "";
  const name = props.podName ?? params.name ?? "";
  const onClose = props.onClose;
  const activeCluster = useApp((s) => s.cluster);
  const cluster = props.clusterOverride ?? activeCluster;
  const navigate = useNavigate();
  const bottomPane = useBottomPane();

  // selectedContainers === null is the explicit "All containers" state.
  // selectedContainers === undefined is the "not yet initialised" state — on
  // first render of a pod we pick the first *regular* container so opening
  // logs for `calico-node` doesn't dump the user into 113 init-container
  // "unable to retrieve" errors. The initialisation flag in `initializedRef`
  // prevents the auto-default from clobbering a user pick on later renders.
  const [selectedContainers, setSelectedContainers] = useState<string[] | null | undefined>(
    () => props.initialContainer ? [props.initialContainer] : undefined,
  );
  const initializedRef = useRef(!!props.initialContainer);
  const [search, setSearch] = useState<LogSearchValue>(EMPTY_SEARCH);
  const [paused, setPaused] = useState(false);
  const [bufferCap, setBufferCap] = useState<number>(LOG_BUFFER_DEFAULT_CAP);
  // When `bufferGrow` is on the in-browser ring is sized to LOG_BUFFER_HARD_CAP
  // and lines accumulate past `bufferCap` (the user's dropdown pick still
  // drives the *server-side* initial tail). When off, the ring strictly trims
  // at `bufferCap` — old lines drop from the top, newest stay at the bottom.
  // Persisted because users tend to want one mode per machine, not per pod.
  const [bufferGrow, setBufferGrow] = usePersistedState<boolean>("k8s-view:logs:buffer-grow", false);
  // Defaults are off; the user's choice is remembered across pods / sessions
  // via localStorage so opening logs for a different pod respects the last
  // explicit preference instead of resetting every time.
  const [showTimestamps, setShowTimestamps] = usePersistedState<boolean>("k8s-view:logs:show-timestamps", false);
  const [showResourceName, setShowResourceName] = usePersistedState<boolean>("k8s-view:logs:show-resource-name", false);
  const [previous, setPrevious] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);
  const [follow] = useState(true);
  const [atPresent, setAtPresent] = useState(true);
  const [sinceLocal, setSinceLocal] = useState("");

  // One-shot fetch — covers the cold-start window before the watch below
  // has filled. The watch (`watchedPods`) is what keeps the container-state
  // chip live after that, so we no longer poll on a 1.5s cadence (it was a
  // duplicate of the informer trafffic).
  const { data: queriedPod, error: podError } = useQuery({
    enabled: !!cluster && !!namespace && !!name,
    queryKey: ["pod", cluster, namespace, name],
    queryFn: () => api.getResource(cluster, { group: "", version: "v1", resource: "pods" }, namespace, name),
    refetchInterval: false,
    retry: false,
  });
  const watchedPods = useResourceList(cluster, "/v1/Pod", namespace, {
    enabled: !!cluster && !!namespace,
  });
  const watchedPod = useMemo(
    () => watchedPods.items.find((p) => p.metadata?.namespace === namespace && p.metadata?.name === name),
    [watchedPods.items, namespace, name],
  );
  const podMissing = watchedPods.ready && !watchedPod;
  const statusPod = podMissing ? null : (watchedPod ?? queriedPod);
  const podForLogMetadata = watchedPod ?? queriedPod;

  const containerOptions = useMemo<ContainerOption[]>(() => {
    const cs = podForLogMetadata?.spec?.containers ?? [];
    const ics = podForLogMetadata?.spec?.initContainers ?? [];
    const ecs = podForLogMetadata?.spec?.ephemeralContainers ?? [];
    const fromPod = [
      ...cs.map((c: any) => ({ name: String(c.name ?? ""), kind: "container" as const })),
      ...ics.map((c: any) => ({ name: String(c.name ?? ""), kind: "init" as const })),
      ...ecs.map((c: any) => ({ name: String(c.name ?? ""), kind: "ephemeral" as const })),
    ].filter((c) => c.name);
    if (fromPod.length > 0) return fromPod;
    const cached = cluster && namespace && name
      ? findPodLogContainers({ cluster, ns: namespace, pod: name })
      : [];
    if (cached.length > 0) {
      return cached.map((container) => ({ name: container, kind: "container" as const }));
    }
    return props.initialContainer
      ? [{ name: props.initialContainer, kind: "container" as const }]
      : [];
  }, [podForLogMetadata, cluster, namespace, name, props.initialContainer]);

  const containers = useMemo(() => containerOptions.map((c) => c.name), [containerOptions]);

  const firstRegularContainer = useMemo(() => {
    const reg = containerOptions.find((c) => c.kind === "container");
    return reg?.name ?? containerOptions[0]?.name ?? null;
  }, [containerOptions]);

  const activeContainers = useMemo(() => {
    if (selectedContainers === null) return containers;
    if (!selectedContainers || selectedContainers.length === 0) {
      return firstRegularContainer ? [firstRegularContainer] : containers.slice(0, 1);
    }
    const allowed = new Set(containers);
    const picked = selectedContainers.filter((c) => allowed.has(c));
    return picked.length > 0
      ? picked
      : (firstRegularContainer ? [firstRegularContainer] : containers.slice(0, 1));
  }, [containers, selectedContainers, firstRegularContainer]);
  const activeContainersKey = activeContainers.join("\n");

  // First-time defaulting: as soon as we know the container list, pick the
  // first regular container. After that, leave whatever the user picked
  // alone (including their explicit "All containers" selection).
  useEffect(() => {
    if (initializedRef.current) return;
    if (containers.length === 0) return;
    initializedRef.current = true;
    if (selectedContainers === undefined) {
      setSelectedContainers(firstRegularContainer ? [firstRegularContainer] : [containers[0]]);
    }
  }, [containers, firstRegularContainer, selectedContainers]);

  // Drop selections for containers that disappeared (rolled to a new pod with
  // a different container set).
  useEffect(() => {
    if (containers.length === 0 || selectedContainers === null || !selectedContainers) return;
    const allowed = new Set(containers);
    const next = selectedContainers.filter((c) => allowed.has(c));
    if (next.length === 0) {
      setSelectedContainers(firstRegularContainer ? [firstRegularContainer] : [containers[0]]);
    } else if (next.length !== selectedContainers.length) {
      setSelectedContainers(next);
    }
  }, [containers, selectedContainers, firstRegularContainer]);

  const sinceTime = useMemo(() => {
    if (!sinceLocal) return undefined;
    const d = new Date(sinceLocal);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }, [sinceLocal]);

  // hasPreviousTerminated — only enable the toggle when the live pod actually
  // has a previous instance to fetch. Note: we no longer auto-flip
  // `previous` to false when this becomes false. Doing so used to trigger a
  // cascade of buffer-clearing rerenders on pod deletion. Now the toggle's
  // intent stays put; only the visual disabled-state reflects availability.
  const hasPreviousTerminated = useMemo(
    () => activeContainers.some((c) => containerHasPrevious(podForLogMetadata, c)),
    [podForLogMetadata, activeContainersKey],
  );
  const logContainers = useMemo(
    () => previous ? activeContainers.filter((c) => containerHasPrevious(podForLogMetadata, c)) : activeContainers,
    [previous, activeContainersKey, podForLogMetadata],
  );
  const logContainersKey = logContainers.join("\n");

  // Stream subscription — useSyncExternalStore gives us tear-free reads
  // straight out of the module-scoped pool. The component holds zero log
  // state of its own.
  const optsList = useMemo<OpenOpts[]>(() => {
    if (!cluster || !namespace || !name) return [];
    return logContainers.map((container) => ({
      cluster,
      ns: namespace,
      pod: name,
      container,
      previous,
      follow,
      tail: bufferCap,
      sinceTime,
    }));
  }, [cluster, namespace, name, logContainersKey, previous, follow, bufferCap, sinceTime]);

  const streamBundle = useLogBundle(optsList);
  const primaryOpts = optsList[0] ?? null;

  // Open the stream synchronously inside `subscribe` rather than from a
  // sibling effect — useSyncExternalStore registers the callback during the
  // commit phase, before sibling useEffects run, so opening from an effect
  // would attach the callback to a not-yet-existing stream and miss the
  // first version bump. open() is idempotent, so repeated invocations on
  // re-render are free.
  // Opening/subscribing is handled by useLogBundle for every selected container.

  // Record this visit in the pod registry so future sessions can show this
  // pod as a predecessor. Doing it here keeps the registry colocated with
  // the only callsite that actually has the pod object.
  useEffect(() => {
    if (!primaryOpts || !podForLogMetadata) return;
    notePodVisit(primaryOpts, podForLogMetadata);
  }, [primaryOpts, podForLogMetadata]);

  // Re-assert the effective ring cap on every (re)open and whenever the
  // user's pick changes. `open()` only auto-grows; an uncapped buffer with a
  // fresh dropdown pick or a newly-mounted container needs an explicit nudge
  // to either widen the ring (uncap) or trim it (cap). Trim mode is a no-op
  // when the size already matches, so this stays cheap to run on every render.
  useEffect(() => {
    const ringCap = bufferGrow ? LOG_BUFFER_HARD_CAP : bufferCap;
    for (const opts of optsList) {
      setStreamBufferCap(streamKey(opts), ringCap, "trim");
    }
  }, [optsList, bufferGrow, bufferCap]);

  // Pause: freeze the rendered set without affecting the upstream stream.
  // The buffer keeps growing in the background; on resume we jump back to
  // live lines (and the user sees what was buffered while they were paused).
  const [pausedLines, setPausedLines] = useState<readonly SourceLine[]>(EMPTY_SOURCE_LINES);
  useEffect(() => {
    if (paused) setPausedLines(streamBundle.lines);
    else if (pausedLines !== EMPTY_SOURCE_LINES) setPausedLines(EMPTY_SOURCE_LINES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);
  const lines = paused ? pausedLines : streamBundle.lines;
  const sourceForceShow = logContainers.length > 1 || previous;
  const showSource = sourceForceShow || showResourceName;

  // Search compile — `null` = empty query (no filtering), `"invalid"` =
  // user typed a regex that didn't compile (we still show all lines but
  // emit no highlights and surface a "invalid regex" hint in the bar).
  const compiledSearch = useMemo<RegExp | "invalid" | null>(() => {
    if (!search.query) return null;
    const flags = search.caseSensitive ? "g" : "gi";
    if (search.regex) {
      try {
        return new RegExp(search.query, flags);
      } catch {
        return "invalid";
      }
    }
    const escaped = search.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }, [search.query, search.caseSensitive, search.regex]);

  // Single pass over the buffer that does both jobs at once:
  //   * `compiledSearch` null/"invalid"  → just parse lines, no highlights
  //   * search.filter ON                 → drop lines without a match (Lens
  //                                        "filtering mode")
  //   * search.filter OFF                → keep every line, attach matches
  //                                        only where they exist (highlight
  //                                        + navigation, no hiding)
  // `totalMatches` is the global count used by the navigation cursor.
  const { filtered, totalMatches } = useMemo(() => {
    const rows: LogChunk[] = [];
    if (!compiledSearch || compiledSearch === "invalid") {
      for (const line of lines) {
        rows.push(parseLogChunk(line));
      }
      return { filtered: rows, totalMatches: 0 };
    }
    let next = 0;
    for (const line of lines) {
      const chunk = parseLogChunk(line);
      const matches = collectMatches(chunk.body, compiledSearch, next);
      if (matches.length === 0) {
        if (search.filter) continue;
        rows.push(chunk);
        continue;
      }
      next += matches.length;
      rows.push({ ...chunk, matches });
    }
    return { filtered: rows, totalMatches: next };
  }, [lines, compiledSearch, search.filter]);

  // Reset the active hit cursor whenever the matchset changes shape so we
  // never end up pointing past the end of the array.
  useEffect(() => {
    if (activeMatch >= totalMatches) {
      setActiveMatch(totalMatches > 0 ? 0 : 0);
    }
  }, [totalMatches, activeMatch]);
  useEffect(() => {
    setActiveMatch(0);
  }, [search.query, search.caseSensitive, search.regex, search.filter]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const v = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 18,
    overscan: 30,
  });

  const onSearchPrev = useCallback(() => {
    if (totalMatches === 0) return;
    setActiveMatch((i) => (i - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);
  const onSearchNext = useCallback(() => {
    if (totalMatches === 0) return;
    setActiveMatch((i) => (i + 1) % totalMatches);
  }, [totalMatches]);

  // Scroll the active match into view. We look up the row index containing
  // it and scroll the virtualiser to align it in the center — gives the
  // user some context lines above and below.
  useEffect(() => {
    if (totalMatches === 0) return;
    const idx = filtered.findIndex((r) => r.matches.some((m) => m.index === activeMatch));
    if (idx >= 0) v.scrollToIndex(idx, { align: "center" });
  }, [activeMatch, filtered, totalMatches, v]);

  // Auto-follow: keep live logs visually smooth. Small live increments are
  // animated with rAF; large initial tails/bursts jump immediately so a
  // 20k-line paste cannot spend seconds "catching up".
  const followingRef = useRef(true);
  const autoScrollingRef = useRef(false);
  const autoScrollFrameRef = useRef<number | null>(null);
  const prevFilteredLengthRef = useRef(0);

  const cancelAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    autoScrollingRef.current = false;
  }, []);

  useEffect(() => cancelAutoScroll, [cancelAutoScroll]);

  const jumpToPresent = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    cancelAutoScroll();
    followingRef.current = true;
    autoScrollingRef.current = true;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    setAtPresent(true);
    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollingRef.current = false;
      autoScrollFrameRef.current = null;
      const near = isNearBottom(el);
      followingRef.current = near;
      setAtPresent(near);
    });
  }, [cancelAutoScroll]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const prevLength = prevFilteredLengthRef.current;
    prevFilteredLengthRef.current = filtered.length;
    if (!el || !followingRef.current) return;

    const added = Math.max(0, filtered.length - prevLength);
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    const start = el.scrollTop;
    const distance = target - start;
    if (distance <= 1) {
      if (isNearBottom(el)) setAtPresent(true);
      return;
    }

    cancelAutoScroll();

    if (added > 80 || distance > el.clientHeight * 0.8) {
      autoScrollingRef.current = true;
      el.scrollTop = target;
      autoScrollFrameRef.current = requestAnimationFrame(() => {
        autoScrollingRef.current = false;
        autoScrollFrameRef.current = null;
        const near = isNearBottom(el);
        followingRef.current = near;
        setAtPresent(near);
      });
      return;
    }

    const duration = Math.min(140, Math.max(60, distance * 2));
    let startedAt = 0;
    autoScrollingRef.current = true;
    const tick = (now: number) => {
      if (!startedAt) startedAt = now;
      const t = Math.min(1, (now - startedAt) / duration);
      el.scrollTop = start + distance * easeOutCubic(t);
      if (t < 1 && followingRef.current) {
        autoScrollFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      autoScrollingRef.current = false;
      autoScrollFrameRef.current = null;
      const near = isNearBottom(el);
      followingRef.current = near;
      setAtPresent(near);
    };
    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }, [filtered.length, cancelAutoScroll]);

  const downloadFor = (opt: DownloadPick) => {
    // "visible" downloads what the user actually sees (post-search-filter),
    // "all" downloads every line in the buffer regardless of search. Both
    // run through the original raw → string formatter so the file matches
    // what kubectl logs would emit.
    const body = opt.scope === "visible"
      ? filtered
          .map((c) => formatChunkForDownload(c, opt.timestamps, showSource))
          .join("\n")
      : lines.map((l) => formatLogLine(l, opt.timestamps, showSource)).join("\n");
    const suffix = selectedContainers === null ? "all-containers" : logContainers.join("+") || "logs";
    download(`${name}-${previous ? "previous-" : ""}${suffix}.${opt.ext}`, body);
  };

  const workloadPods = useMemo<WorkloadPodMenuEntry[]>(() => {
    if (!primaryOpts) return [];
    return buildWorkloadPodMenuEntries({
      current: primaryOpts,
      currentPodForGroup: podForLogMetadata,
      currentLivePod: statusPod,
      registryEntries: findWorkloadPods(primaryOpts),
      livePods: watchedPods.items,
      liveReady: watchedPods.ready,
    });
  }, [primaryOpts, podForLogMetadata, statusPod, watchedPods.items, watchedPods.ready, streamBundle.token]);

  const onPickWorkloadPod = useCallback((entry: WorkloadPodMenuEntry) => {
    if (entry.isCurrent) return;
    if (onClose) {
      bottomPane.push({ action: "logs", cluster: entry.cluster, namespace: entry.ns, name: entry.pod });
    } else if (cluster) {
      navigate(`/${encodeURIComponent(cluster)}/pods/ns/${encodeURIComponent(entry.ns)}/${encodeURIComponent(entry.pod)}/logs`);
    }
  }, [onClose, bottomPane, cluster, navigate]);

  const stateByContainer = useMemo(() => {
    const byName = new Map<string, ContainerStateView>();
    for (const c of activeContainers) {
      const snap = streamBundle.snapshots.find((s) => s.opts.container === c) ?? null;
      byName.set(c, deriveContainerState({ pod: statusPod, podMissing, podError, container: c, snapshot: snap }));
    }
    return byName;
  }, [statusPod, podMissing, podError, activeContainersKey, streamBundle.snapshots]);
  const containerState = aggregateContainerStates([...stateByContainer.values()]);
  const podState = useMemo(
    () => derivePodState({ pod: statusPod, podMissing, podError, snapshots: streamBundle.snapshots }),
    [statusPod, podMissing, podError, streamBundle.snapshots],
  );
  const canReconnect = streamBundle.snapshots.some((snap) => {
    const state = stateByContainer.get(snap.opts.container) ?? containerState;
    return canReconnectLogStream(state, snap);
  });
  const autoReconnectKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const snap of streamBundle.snapshots) {
      const state = stateByContainer.get(snap.opts.container) ?? containerState;
      if (snap.state === "streaming" || snap.state === "connecting" || snap.state === "reconnecting" || snap.state === "waiting") {
        autoReconnectKeysRef.current.delete(snap.key);
      }
      if (canReconnectLogStream(state, snap) && !autoReconnectKeysRef.current.has(snap.key)) {
        autoReconnectKeysRef.current.add(snap.key);
        reconnectStream(snap.key);
      }
    }
  }, [streamBundle.token, stateByContainer, containerState]);

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="h-10 px-3 border-b border-line flex items-center gap-2 bg-bg-soft text-xs">
        <ContainerPicker
          options={containerOptions}
          selected={selectedContainers}
          states={stateByContainer}
          fallback={props.initialContainer}
          onChange={setSelectedContainers}
        />
        <ContainerStateChip state={podState} />
        {workloadPods.length > 1 && (
          <WorkloadPodsButton entries={workloadPods} onPick={onPickWorkloadPod} />
        )}
        {canReconnect ? (
          <button
            className="btn"
            onClick={() => optsList.forEach((opts) => reconnectStream(streamKey(opts)))}
            title="Reconnect selected log streams. Kubernetes status stays unchanged."
          >
            Reconnect
          </button>
        ) : null}
        <Select<number>
          value={bufferCap}
          onChange={(next) => {
            // Going UP — re-issue every active stream with the new tail so
            // the user immediately sees `next` lines of history. Going DOWN
            // is a pure ring-trim, no reconnect (existing tail stays as-is,
            // newest `next` lines kept). This is what users expect from a
            // "tail N" knob — pick a number, see that many lines now.
            // When `bufferGrow` is on, the ring stays sized at HARD_CAP and
            // only the *server tail* tracks `next`; the trim branch is then
            // a no-op (the effect below also re-asserts the cap).
            const grew = next > bufferCap;
            setBufferCap(next);
            const nextRingCap = bufferGrow ? LOG_BUFFER_HARD_CAP : next;
            for (const opts of optsList) {
              setStreamBufferCap(streamKey(opts), nextRingCap, grew ? "refetch" : "trim", next);
            }
          }}
          buttonHeight={7}
          ariaLabel="Tail size"
          title="Server-side initial tail and (when Buffer is off) the in-browser ring size. Picking a larger value re-fetches the last N lines from the API server."
          options={BUFFER_OPTIONS}
        />
        <Toggle
          checked={bufferGrow}
          onChange={(grow) => {
            setBufferGrow(grow);
            const nextRingCap = grow ? LOG_BUFFER_HARD_CAP : bufferCap;
            for (const opts of optsList) {
              setStreamBufferCap(streamKey(opts), nextRingCap, "trim");
            }
          }}
          label="Buffer"
          title="Off: ring trims at the selected size — oldest lines drop, newest stay. On: lines accumulate past the size up to a 20 000-line hard cap."
        />
        <button className={clsx("btn", paused && "text-warn border-warn/40")} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
          {paused ? "Resume" : "Pause"}
        </button>
        <LogTimeButton value={sinceLocal} onChange={setSinceLocal} />
        <button className="btn" onClick={() => optsList.forEach((opts) => clearLines(streamKey(opts)))}><Trash2 size={12} /> Clear</button>
        <LogSearchBar
          className="ml-auto"
          value={search}
          onChange={setSearch}
          matchCount={totalMatches}
          activeIndex={activeMatch}
          onPrev={onSearchPrev}
          onNext={onSearchNext}
          invalid={compiledSearch === "invalid"}
        />
        <button
          className={clsx(
            "btn h-7",
            atPresent
              ? "border-ok/30 bg-ok/5 text-ok"
              : "border-accent/40 bg-accent/10 text-accent",
          )}
          onClick={jumpToPresent}
          title={atPresent ? "Following the newest log lines" : "Scroll to the newest log line and follow"}
        >
          {atPresent ? "Following" : "Jump to present"}
        </button>
        <span className="text-fg-mute">{filtered.length.toLocaleString()} lines</span>
        {onClose && (
          <button
            className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
            onClick={() => {
              const url = `/${encodeURIComponent(cluster)}/pods/ns/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/logs`;
              window.open(url, `kvlogs:${cluster}:${namespace}:${name}`, "popup,width=1280,height=860");
            }}
            title="Open logs in a new window"
          >
            <ExternalLink size={13} />
          </button>
        )}
        {onClose && (
          <button
            className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
            onClick={onClose}
            title="Close"
          >
            <X size={13} />
          </button>
        )}
      </header>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto font-mono text-[12px] leading-[18px] px-3 py-2 bg-black text-[#cfeacf] relative"
        onWheel={cancelAutoScroll}
        onPointerDown={cancelAutoScroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (autoScrollingRef.current) {
            followingRef.current = true;
            setAtPresent(true);
            return;
          }
          const near = isNearBottom(el);
          followingRef.current = near;
          setAtPresent(near);
        }}
      >
        {previous && logContainers.length === 0 && lines.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-3 py-2 rounded-md border border-line bg-bg-soft text-fg-mute text-xs max-w-md text-center">
              No previous terminated container is available for the selected source.
            </div>
          </div>
        )}
        {streamBundle.snapshots.some((s) => s.state === "waiting") && lines.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-3 py-2 rounded-md border border-warn/40 bg-warn/10 text-warn text-xs flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-warn animate-pulse" />
              Waiting for selected container logs...
            </div>
          </div>
        )}
        {streamBundle.snapshots.some((s) => s.state === "pod-gone" || s.state === "ended") && lines.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-3 py-2 rounded-md border border-line bg-bg-soft text-fg-mute text-xs max-w-md text-center">
              {streamBundle.snapshots.some((s) => s.state === "pod-gone")
                ? "This pod no longer exists. Its logs are not retained by the API server."
                : "Stream ended. No buffered lines are available."}
              {workloadPods.length > 1 && " Use the history button above to jump to another pod in this workload."}
            </div>
          </div>
        )}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const chunk = filtered[vi.index];
            if (!chunk) return null;
            return (
              <div key={vi.key as string}
                className="absolute left-0 right-0 whitespace-pre"
                style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}>
                <LogRow
                  chunk={chunk}
                  showTimestamp={showTimestamps}
                  showSource={showSource}
                  activeMatchIndex={activeMatch}
                />
              </div>
            );
          })}
        </div>
      </div>

      <footer className="h-9 px-3 border-t border-line flex items-center gap-3 bg-bg-soft text-xs text-fg-soft">
        <span className="text-fg-mute font-mono">
          Logs from {oldestLogTime(lines.map((l) => l.raw)) ?? (sinceLocal ? new Date(sinceLocal).toLocaleString() : "-")}
        </span>

        <Toggle
          checked={showTimestamps}
          onChange={setShowTimestamps}
          label="Show timestamps"
        />
        <Toggle
          checked={showResourceName || sourceForceShow}
          onChange={(v) => setShowResourceName(v)}
          disabled={sourceForceShow}
          label="Show resource name"
          title={sourceForceShow
            ? "Auto-shown when multiple containers / previous logs are selected"
            : "Tag every line with its container's name"}
        />
        <Toggle
          checked={previous}
          onChange={setPrevious}
          disabled={!hasPreviousTerminated}
          label="Previous container"
          title={!hasPreviousTerminated ? "No previous terminated instance for selected containers" : undefined}
        />

        <DownloadMenu
          onPick={downloadFor}
          className="ml-auto"
        />
      </footer>
    </div>
  );
}

const EMPTY_SOURCE_LINES: readonly SourceLine[] = Object.freeze([]);

// Tail-size presets exposed in the toolbar. The "Buffer" toggle next to this
// dropdown controls whether the in-browser ring strictly caps at the selected
// value or grows past it up to LOG_BUFFER_HARD_CAP (20 000) — going higher
// than that risks GC pauses on a 100k-row session.
const BUFFER_OPTIONS = [
  { value: 500,                 label: "500" },
  { value: 1_000,               label: "1 000" },
  { value: 5_000,               label: "5 000" },
  { value: LOG_BUFFER_HARD_CAP, label: "20 000" },
];

// Section order/labels for the ContainerPicker dropdown — same grouping
// Lens uses: regular containers first, then init, then ephemeral.
const CONTAINER_KIND_ORDER: ContainerOption["kind"][] = ["container", "init", "ephemeral"];
const CONTAINER_KIND_LABEL: Record<ContainerOption["kind"], string> = {
  container: "Containers",
  init: "Init containers",
  ephemeral: "Ephemeral containers",
};

interface ContainerOption {
  name: string;
  kind: "container" | "init" | "ephemeral";
}

interface SourceLine {
  key: string;
  raw: string;
  source: string;
  previous: boolean;
  ts: number;
  order: number;
}

interface DownloadPick {
  scope: "visible" | "all";
  ext: "log" | "txt";
  timestamps: boolean;
}

type WorkloadPodMenuEntry = WorkloadPodEntry & {
  kubePod?: any;
  kubeStatus?: PodDisplayStatus;
  kubeMissing?: boolean;
};

// ──────────────────────────────────────────────────────────────────────────
// Sub-components.
// ──────────────────────────────────────────────────────────────────────────

function useLogBundle(optsList: OpenOpts[]) {
  const signature = useMemo(() => optsList.map(streamKey).join("\n"), [optsList]);
  const subscribe = useCallback((cb: () => void) => {
    if (optsList.length === 0) return () => {};
    const unsubs = optsList.map((opts) => {
      const key = openStream(opts);
      return subscribeStream(key, cb);
    });
    return () => {
      for (const u of unsubs) u();
    };
  }, [signature, optsList]);

  const token = useSyncExternalStore(
    subscribe,
    () => optsList.map((opts) => {
      const key = streamKey(opts);
      const snap = getSnapshot(key);
      return `${key}:${snap?.version ?? 0}:${snap?.state ?? "missing"}:${snap?.lineCount ?? 0}`;
    }).join("|"),
    () => "",
  );

  const snapshots = useMemo(
    () => optsList.map((opts) => getSnapshot(streamKey(opts))).filter((x): x is StreamSnapshot => !!x),
    [signature, token],
  );

  const lines = useMemo<readonly SourceLine[]>(() => {
    const out: SourceLine[] = [];
    optsList.forEach((opts, sourceIndex) => {
      const key = streamKey(opts);
      const { lines: sourceLines, firstSeq } = getLinesWithSeq(key);
      sourceLines.forEach((raw, lineIndex) => {
        // seq is stream-monotonic so keys stay stable across ring rotation
        // — without this every push past `bufferCap` would renumber every
        // existing line's React key, hammering the virtualizer.
        const seq = firstSeq + lineIndex;
        out.push({
          key: `${key}:${seq}`,
          raw,
          source: opts.container,
          previous: opts.previous,
          ts: parseLogTimestamp(raw) ?? Number.MAX_SAFE_INTEGER,
          order: sourceIndex * 1_000_000_000 + seq,
        });
      });
    });
    if (optsList.length > 1) {
      out.sort((a, b) => (a.ts - b.ts) || (a.order - b.order));
    }
    return out;
  }, [signature, token]);

  return { token, snapshots, lines };
}

function ContainerPicker({
  options,
  selected,
  states,
  fallback,
  onChange,
}: {
  options: ContainerOption[];
  selected: string[] | null | undefined;
  states: Map<string, ContainerStateView>;
  fallback?: string;
  onChange: (next: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const names = options.map((o) => o.name);
  const allSelected = selected === null;
  const effectiveSelection = allSelected ? names : (selected ?? []);
  const selectedSet = new Set(effectiveSelection);
  const label =
    names.length === 0 ? (fallback ?? "No containers") :
    allSelected ? "All containers" :
    selectedSet.size === 0 ? (fallback ?? names[0] ?? "container") :
    selectedSet.size === 1 ? [...selectedSet][0] :
    `${selectedSet.size} containers`;

  const setAll = () => onChange(null);
  const toggleOne = (name: string) => {
    if (names.length <= 1) {
      onChange([name]);
      return;
    }
    const next = allSelected ? names.filter((n) => n !== name) : [...effectiveSelection];
    if (!allSelected) {
      const idx = next.indexOf(name);
      if (idx >= 0) next.splice(idx, 1);
      else next.push(name);
    }
    if (next.length === 0) {
      onChange([name]);
    } else if (next.length === names.length) {
      onChange(null);
    } else {
      onChange(next);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        className="btn h-7 text-xs max-w-[260px] min-w-[150px] justify-between"
        onClick={() => setOpen((s) => !s)}
        disabled={names.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="truncate text-left">{label}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-50 left-0 top-full mt-1 min-w-[280px] max-h-[320px] overflow-auto rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] py-1 text-xs"
        >
          <button
            role="menuitemcheckbox"
            aria-checked={allSelected}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-bg-mute text-fg"
            onClick={setAll}
          >
            <input className="kv-checkbox" type="checkbox" checked={allSelected} readOnly tabIndex={-1} />
            <span className="flex-1">All containers</span>
            <span className="text-fg-mute">{names.length}</span>
          </button>
          {CONTAINER_KIND_ORDER.map((kind) => {
            const group = options.filter((o) => o.kind === kind);
            if (group.length === 0) return null;
            return (
              <div key={kind}>
                <div className="mt-1 border-t border-line" />
                <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-fg-mute">
                  {CONTAINER_KIND_LABEL[kind]}
                </div>
                {group.map((opt) => {
                  const checked = selectedSet.has(opt.name);
                  const state = states.get(opt.name);
                  return (
                    <button
                      key={opt.name}
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-bg-mute text-fg-soft hover:text-fg"
                      onClick={() => toggleOne(opt.name)}
                    >
                      <input className="kv-checkbox" type="checkbox" checked={checked} readOnly tabIndex={-1} />
                      <span className="flex-1 min-w-0 truncate">{opt.name}</span>
                      {state && <ContainerStateDot state={state} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContainerStateDot({ state }: { state: ContainerStateView }) {
  const cls =
    state.kind === "running" ? "bg-ok" :
    state.kind === "waiting" || state.kind === "terminating" || state.kind === "reconnecting" ? "bg-warn" :
    state.kind === "completed" ? "bg-accent" :
    state.kind === "failed" || state.kind === "missing" || state.kind === "terminated" ? "bg-bad" :
    "bg-fg-mute";
  return <span className={clsx("h-2 w-2 rounded-sm shrink-0", cls)} title={state.label} />;
}

function LogTimeButton({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => valueToDate(value) ?? new Date());
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setDraft(valueToDate(value) ?? new Date());
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        className={clsx("btn h-7", value && "border-accent/40 bg-accent/10 text-accent")}
        onClick={() => setOpen((s) => !s)}
        title={value ? `Logs since ${new Date(value).toLocaleString()}` : "Pick logs start time"}
      >
        <CalendarClock size={12} />
        {value ? "Since" : "Time"}
      </button>
      {open && (
        <div className="absolute z-50 left-0 top-full mt-1 w-[360px] overflow-hidden rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] text-xs">
          <div className="grid grid-cols-[224px_136px]">
            <div className="p-3">
              <div className="mb-2 grid h-7 grid-cols-[28px_1fr_28px] items-center">
                <button
                  className="h-7 w-7 rounded-md grid place-items-center text-fg-mute hover:bg-bg-mute hover:text-fg"
                  onClick={() => setDraft(addMonths(draft, -1))}
                  title="Previous month"
                  aria-label="Previous month"
                >
                  <ChevronLeft size={13} />
                </button>
                <div className="text-center text-sm font-semibold text-fg-soft">{formatMonth(draft)}</div>
                <button
                  className="h-7 w-7 rounded-md grid place-items-center text-fg-mute hover:bg-bg-mute hover:text-fg"
                  onClick={() => setDraft(addMonths(draft, 1))}
                  title="Next month"
                  aria-label="Next month"
                >
                  <ChevronRight size={13} />
                </button>
              </div>
              <div className="grid grid-cols-7 text-center text-[10px] uppercase text-fg-mute">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => <span key={d}>{d}</span>)}
              </div>
              <div className="mt-1 grid grid-cols-7">
                {calendarDays(draft).map((d) => {
                  const selected = sameDay(d, draft);
                  const today = sameDay(d, new Date());
                  const muted = d.getMonth() !== draft.getMonth();
                  return (
                    <button
                      key={d.toISOString()}
                      className={clsx(
                        "h-7 w-7 rounded-md text-center font-mono text-[12px] outline-none transition-colors",
                        "hover:bg-bg-mute focus-visible:ring-2 focus-visible:ring-accent/35",
                        selected && "bg-accent text-white hover:bg-accent",
                        !selected && today && "text-accent",
                        muted && !selected && !today && "text-fg-mute",
                        !muted && !selected && !today && "text-fg-soft",
                      )}
                      onClick={() => setDraft(copyDateKeepTime(draft, d))}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="border-l border-line bg-bg/20 p-3 flex flex-col">
              <div className="mb-2 h-7 flex items-center text-[10px] uppercase tracking-wide text-fg-mute">Time</div>
              <div className="grid grid-cols-[1fr_8px_1fr] items-center gap-1">
                <WheelColumn
                  ariaLabel="Hours"
                  min={0}
                  max={24}
                  value={draft.getHours()}
                  onChange={(h) => setDraft(setTimePart(draft, "h", h))}
                />
                <span className="text-center text-fg-mute font-mono">:</span>
                <WheelColumn
                  ariaLabel="Minutes"
                  min={0}
                  max={60}
                  value={draft.getMinutes()}
                  onChange={(m) => setDraft(setTimePart(draft, "m", m))}
                />
              </div>
              <button
                type="button"
                className="mt-2 h-6 rounded-md border border-line bg-bg-soft text-[10px] uppercase tracking-wide text-fg-mute hover:bg-bg-mute hover:text-fg transition-colors"
                onClick={() => setDraft(new Date())}
                title="Snap to the current local time"
              >
                Now
              </button>
            </div>
          </div>
          <div className="h-10 border-t border-line bg-bg-mute/35 px-2 flex items-center justify-between">
            <button className="btn h-7" onClick={() => onChange("")}>
              <RotateCcw size={12} /> Reset
            </button>
            <button
              className="btn-primary h-7"
              onClick={() => {
                onChange(dateToLocalValue(draft));
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkloadPodsButton({
  entries, onPick,
}: {
  entries: WorkloadPodMenuEntry[];
  onPick: (e: WorkloadPodMenuEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const others = entries.length - 1;
  return (
    <div ref={ref} className="relative">
      <button
        className="btn h-7 text-xs flex items-center gap-1.5"
        onClick={() => setOpen((s) => !s)}
        title={`${entries.length} pod${entries.length === 1 ? "" : "s"} tracked in this workload`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <History size={12} />
        {entries.length}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-40 left-0 top-full mt-1 w-[420px] max-w-[calc(100vw-32px)] rounded-md border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)] text-xs flex flex-col"
        >
          <div className="px-3 py-1.5 text-fg-mute uppercase tracking-wider text-[10px] border-b border-line/70 shrink-0 flex items-center gap-2">
            <span className="flex-1 truncate">Pods in this workload</span>
            <span className="text-fg-mute normal-case tracking-normal">
              {entries.length} total{others > 0 ? ` · ${others} other${others === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {/* Cap to ~10 rows · 28 px each. Anything more lands in the scroll
              region — Lens-style minimal flyout, never the whole viewport. */}
          <div className="overflow-y-auto py-0.5" style={{ maxHeight: 280 }}>
            {entries.map((e) => (
              <button
                key={e.pod}
                role="menuitem"
                disabled={e.isCurrent}
                className={clsx(
                  "w-full text-left h-7 px-3 flex items-center gap-2",
                  e.isCurrent
                    ? "bg-bg-mute text-fg cursor-default"
                    : "text-fg-soft hover:bg-bg-mute hover:text-fg",
                )}
                onClick={() => { setOpen(false); onPick(e); }}
                title={e.isCurrent ? "Selected pod" : "Switch to this pod's buffer"}
              >
                <span className="font-mono flex-1 truncate">{e.pod}</span>
                <PodStateBadge entry={e} />
                <span className="text-fg-mute shrink-0 w-[60px] text-right tabular-nums">{relTime(e.lastSeen)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// PodStateBadge mirrors the Kubernetes-derived status used by the Pods list.
// Log stream state is intentionally not used here, otherwise deletion/recreate
// races make the dropdown disagree with the actual pod object.
function PodStateBadge({ entry }: { entry: WorkloadPodMenuEntry }) {
  if (entry.kubeStatus) {
    return (
      <span
        className={clsx(podStatusClassName(entry.kubeStatus.kind), "shrink-0", entry.isCurrent && "ring-1 ring-accent/60")}
        title={entry.kubeStatus.detail}
      >
        {entry.kubeStatus.label}
      </span>
    );
  }
  if (entry.kubeMissing) {
    return <span className={clsx("chip-bad shrink-0", entry.isCurrent && "ring-1 ring-accent/60")}>Deleted</span>;
  }
  return <span className={clsx("chip shrink-0", entry.isCurrent && "ring-1 ring-accent/60")}>Unknown</span>;
}

function Toggle({
  checked, onChange, label, disabled, title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      className={clsx(
        "inline-flex items-center gap-1.5 select-none",
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:text-fg",
      )}
      title={title}
    >
      <input
        type="checkbox"
        className="kv-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function DownloadMenu({
  onPick, className,
}: {
  onPick: (opt: DownloadPick) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className={clsx("relative", className)}>
      <button
        className="btn-primary"
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download size={12} /> Download <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-40 right-0 bottom-full mb-1 min-w-[220px] rounded-md border border-line bg-bg-soft shadow-lg py-1"
        >
          <DownloadMenuItem
            onClick={() => { setOpen(false); onPick({ scope: "visible", ext: "log", timestamps: true }); }}
            label="Visible logs with timestamps"
          />
          <DownloadMenuItem
            onClick={() => { setOpen(false); onPick({ scope: "visible", ext: "txt", timestamps: false }); }}
            label="Visible logs without timestamps"
          />
          <div className="my-1 border-t border-line" />
          <DownloadMenuItem
            onClick={() => { setOpen(false); onPick({ scope: "all", ext: "log", timestamps: true }); }}
            label="All buffered logs"
          />
          <DownloadMenuItem
            onClick={() => { setOpen(false); onPick({ scope: "all", ext: "txt", timestamps: false }); }}
            label="All buffered without timestamps"
          />
        </div>
      )}
    </div>
  );
}

function DownloadMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-mute text-fg-soft hover:text-fg"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

interface ContainerStateView {
  kind:
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "terminating"
    | "terminated"
    | "unknown"
    | "missing"
    | "frozen"
    | "stream-ended"
    | "stream-error"
    | "reconnecting";
  label: string;
  detail?: string;
}

// deriveContainerState — composes pod status with the stream state. The
// Kubernetes status is primary; the stream state is only a fallback while
// the pod object is still loading or gone.
function deriveContainerState(args: {
  pod: any;
  podMissing: boolean;
  podError: unknown;
  container: string;
  snapshot: StreamSnapshot | null;
}): ContainerStateView {
  const { pod, podMissing, podError, container, snapshot } = args;
  if (pod) {
    const fromPod = containerDisplayStatus(pod, container);
    if (fromPod) return stateViewFromPodStatus(fromPod);
  }
  if (podMissing) {
    return { kind: "terminated", label: "DELETED", detail: "Pod is absent from the Kubernetes watch snapshot." };
  }
  if (snapshot?.state === "pod-gone") {
    return { kind: "terminated", label: "DELETED", detail: snapshot.err ?? "Pod has been deleted." };
  }
  if (snapshot?.state === "error") {
    return { kind: "stream-error", label: "ERROR", detail: snapshot.err ?? undefined };
  }
  if (snapshot?.state === "reconnecting") {
    return {
      kind: "reconnecting",
      label: "CONNECTING",
      detail: "Refreshing pod status. Buffered log lines are preserved.",
    };
  }
  if (snapshot?.state === "ended") {
    return {
      kind: "terminated",
      label: "TERMINATED",
      detail: "Stream ended. Buffered log lines are preserved.",
    };
  }
  if (podError) {
    return { kind: "terminated", label: "DELETED", detail: (podError as any)?.message };
  }
  if (!pod) return { kind: "unknown", label: "LOADING" };
  return { kind: "unknown", label: "NO STATUS" };
}

function derivePodState(args: {
  pod: any;
  podMissing: boolean;
  podError: unknown;
  snapshots: StreamSnapshot[];
}): ContainerStateView {
  if (args.pod) return stateViewFromPodStatus(podDisplayStatus(args.pod));
  if (args.podMissing) return { kind: "terminated", label: "DELETED", detail: "Pod is absent from the Kubernetes watch snapshot." };
  const gone = args.snapshots.find((s) => s.state === "pod-gone");
  if (gone) return { kind: "terminated", label: "DELETED", detail: gone.err ?? "Pod has been deleted." };
  if (args.podError) return { kind: "terminated", label: "DELETED", detail: (args.podError as any)?.message };
  return { kind: "unknown", label: "LOADING" };
}

function stateViewFromPodStatus(status: PodDisplayStatus): ContainerStateView {
  const kind: ContainerStateView["kind"] =
    status.label === "Terminating" ? "terminating" :
    status.kind === "ok" ? "running" :
    status.kind === "info" ? "completed" :
    status.kind === "bad" ? "failed" :
    status.kind === "warn" ? "waiting" :
    "unknown";
  return { kind, label: status.label.toUpperCase(), detail: status.detail };
}

function buildWorkloadPodMenuEntries(args: {
  current: OpenOpts;
  currentPodForGroup: any;
  currentLivePod: any;
  registryEntries: WorkloadPodEntry[];
  livePods: any[];
  liveReady: boolean;
}): WorkloadPodMenuEntry[] {
  const byName = new Map<string, WorkloadPodMenuEntry>();
  const currentRegistry = args.registryEntries.find((e) => e.isCurrent);
  const currentKey = args.currentPodForGroup
    ? podControllerKey(args.currentPodForGroup)
    : (currentRegistry?.controllerKey ?? guessedPodControllerKey(args.current.ns, args.current.pod));
  if (!currentKey) return args.registryEntries;

  for (const entry of args.registryEntries) {
    if (entry.controllerKey === currentKey || entry.isCurrent) {
      byName.set(entry.pod, { ...entry, kubeMissing: args.liveReady });
    }
  }

  const now = Date.now();
  for (const pod of args.livePods) {
    if ((pod.metadata?.namespace ?? args.current.ns) !== args.current.ns) continue;
    if (podControllerKey(pod) !== currentKey) continue;
    const podName = String(pod.metadata?.name ?? "");
    if (!podName) continue;
    const existing = byName.get(podName);
    byName.set(podName, {
      cluster: args.current.cluster,
      ns: pod.metadata?.namespace ?? args.current.ns,
      pod: podName,
      controllerKey: existing?.controllerKey ?? currentKey,
      controllerLabel: existing?.controllerLabel ?? controllerLabelFromKey(currentKey),
      firstSeen: existing?.firstSeen ?? new Date(pod.metadata?.creationTimestamp ?? now).getTime(),
      lastSeen: existing?.lastSeen ?? now,
      bufferedLines: existing?.bufferedLines ?? 0,
      state: existing?.state ?? null,
      isCurrent: podName === args.current.pod,
      kubePod: pod,
      kubeStatus: podDisplayStatus(pod),
      kubeMissing: false,
    });
  }

  if (!byName.has(args.current.pod)) {
    byName.set(args.current.pod, {
      cluster: args.current.cluster,
      ns: args.current.ns,
      pod: args.current.pod,
      controllerKey: currentKey,
      controllerLabel: controllerLabelFromKey(currentKey),
      firstSeen: now,
      lastSeen: now,
      bufferedLines: 0,
      state: null,
      isCurrent: true,
      kubePod: args.currentLivePod,
      kubeStatus: args.currentLivePod ? podDisplayStatus(args.currentLivePod) : undefined,
      kubeMissing: args.liveReady && !args.currentLivePod,
    });
  }

  return Array.from(byName.values()).sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (!!a.kubeStatus !== !!b.kubeStatus) return a.kubeStatus ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });
}

function controllerLabelFromKey(key: string): string {
  const parts = key.split("/");
  if (parts.length >= 3) return `${parts[0]}/${parts.slice(2).join("/")}`;
  return key;
}

function aggregateContainerStates(states: ContainerStateView[]): ContainerStateView {
  if (states.length === 0) return { kind: "unknown", label: "NO CONTAINERS" };
  if (states.length === 1) return states[0];
  const order: ContainerStateView["kind"][] = [
    "failed",
    "missing",
    "terminating",
    "waiting",
    "reconnecting",
    "running",
    "completed",
    "terminated",
    "frozen",
    "unknown",
  ];
  const counts = new Map<ContainerStateView["kind"], number>();
  for (const s of states) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const primary = order.find((k) => counts.has(k)) ?? "unknown";
  const parts = order
    .filter((k) => counts.has(k))
    .map((k) => `${labelForKind(k)} ${counts.get(k)}`);
  return {
    kind: primary,
    label: parts.join(", "),
    detail: states.map((s) => s.label).join(" / "),
  };
}

function labelForKind(kind: ContainerStateView["kind"]): string {
  if (kind === "running") return "RUNNING";
  if (kind === "completed") return "COMPLETED";
  if (kind === "failed") return "FAILED";
  if (kind === "waiting") return "WAITING";
  if (kind === "terminating") return "TERMINATING";
  if (kind === "reconnecting") return "CONNECTING";
  if (kind === "missing") return "MISSING";
  if (kind === "terminated") return "TERMINATED";
  if (kind === "frozen") return "TERMINATED";
  return "UNKNOWN";
}

function containerHasPrevious(pod: any, container: string): boolean {
  const all = [
    ...(pod?.status?.containerStatuses ?? []),
    ...(pod?.status?.initContainerStatuses ?? []),
    ...(pod?.status?.ephemeralContainerStatuses ?? []),
  ];
  const cs = all.find((c: any) => c.name === container);
  if (!cs) return false;
  if ((cs.restartCount ?? 0) > 0) return true;
  return !!cs?.lastState?.terminated;
}

function canReconnectLogStream(state: ContainerStateView, snapshot: StreamSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.state !== "ended" && snapshot.state !== "error") return false;
  if (state.kind === "completed" || state.kind === "failed" || state.kind === "missing" || state.kind === "terminated" || state.kind === "terminating") return false;
  return true;
}

function ContainerStateChip({ state }: { state: ContainerStateView }) {
  const cls =
    state.kind === "running" ? "chip-ok" :
    state.kind === "waiting" || state.kind === "terminating" || state.kind === "reconnecting" ? "chip-warn" :
    state.kind === "completed" || state.kind === "stream-ended" ? "chip-info" :
    state.kind === "failed" || state.kind === "terminated" || state.kind === "missing" || state.kind === "stream-error" ? "chip-bad" :
    state.kind === "frozen" ? "chip-warn" :
    "chip";
  return (
    <span
      className={clsx(cls, "shrink-0", state.detail && "cursor-help")}
      title={state.detail}
    >
      {state.label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers.
// ──────────────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(Math.max(0, Math.min(99, Math.trunc(n)))).padStart(2, "0");
}

function valueToDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateToLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatMonth(d: Date): string {
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function addMonths(d: Date, delta: number): Date {
  const next = new Date(d);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + delta);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, maxDay));
  return next;
}

function calendarDays(draft: Date): Date[] {
  const first = new Date(draft.getFullYear(), draft.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function copyDateKeepTime(base: Date, day: Date): Date {
  const next = new Date(day);
  next.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return next;
}

function setTimePart(base: Date, part: "h" | "m", value: number): Date {
  const next = new Date(base);
  if (part === "h") next.setHours(Math.max(0, Math.min(23, value)));
  else next.setMinutes(Math.max(0, Math.min(59, value)));
  next.setSeconds(0, 0);
  return next;
}

const TS_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s/;

function parseLogTimestamp(raw: string): number | null {
  const m = TS_PREFIX.exec(raw);
  if (!m) return null;
  const ts = new Date(m[1]).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function formatLogLine(line: SourceLine, showTimestamps: boolean, showSource: boolean): string {
  const m = TS_PREFIX.exec(line.raw);
  const timestamp = m ? m[0] : "";
  const body = m ? line.raw.slice(m[0].length) : line.raw;
  const source = showSource ? `[${line.source}${line.previous ? " previous" : ""}] ` : "";
  if (showTimestamps && timestamp) return `${timestamp}${source}${body}`;
  return `${source}${body}`;
}

function stripTimestamp(raw: string): string {
  const m = TS_PREFIX.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

const EMPTY_MATCHES: ReadonlyArray<MatchRange> = Object.freeze([]);

function parseLogChunk(line: SourceLine): LogChunk {
  const m = TS_PREFIX.exec(line.raw);
  const timestamp = m ? m[1] : null;
  const body = m ? line.raw.slice(m[0].length) : line.raw;
  const source = `${line.source}${line.previous ? " · prev" : ""}`;
  return { key: line.key, timestamp, source, body, matches: EMPTY_MATCHES };
}

function formatChunkForDownload(c: LogChunk, timestamps: boolean, showSource: boolean): string {
  const ts = timestamps && c.timestamp ? `${c.timestamp} ` : "";
  const src = showSource && c.source ? `[${c.source}] ` : "";
  return `${ts}${src}${c.body}`;
}

function collectMatches(body: string, re: RegExp, baseIndex: number): MatchRange[] {
  re.lastIndex = 0;
  const out: MatchRange[] = [];
  let n = baseIndex;
  let safety = 0;
  // Cap iterations defensively — a runaway regex with 50 000 hits per line
  // would otherwise lock the renderer. 1 024 hits / line is plenty for any
  // realistic search; beyond that the user wants a different filter anyway.
  while (safety++ < 1024) {
    const m = re.exec(body);
    if (!m) break;
    out.push({ start: m.index, end: m.index + m[0].length, index: n++ });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function oldestLogTime(lines: readonly string[]): string | null {
  for (const l of lines) {
    const m = TS_PREFIX.exec(l);
    if (m) {
      const d = new Date(m[1]);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
  }
  return null;
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 28;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function download(name: string, body: string) {
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
