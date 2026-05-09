// Per-resource column sets. The list of columns is the *only* part of the
// list-view that varies between resource types; the rest of the rendering
// (virtualization, filter, sort, actions) is shared.

import { useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { AlertTriangle } from "lucide-react";
import { Item } from "../lib/useResourceList";
import { AgeCell, Column, type IssueInfo } from "../components/ResourceTable";
import { age, bytes, formatMillicores } from "../lib/format";
import { useApp } from "../stores/app";
import { podMetricKey, readPodMetric, usePodMetricsStore } from "../lib/podMetricsStore";
import { podDisplayStatus, podStatusClassName } from "../lib/podStatus";
import { LinkCell, ownerToRef } from "../components/DetailPanel";
import { EventIndexContext, eventsForItem, isSevereReason, type EventWarning } from "../lib/eventsIndex";
import { Sparkline } from "../components/charts/Sparkline";

const nameCol: Column = {
  key: "name", label: "Name", width: "minmax(220px, 2fr)",
  render: (it) => (
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-medium truncate">{it.metadata.name}</span>
    </div>
  ),
  sortValue: (it) => it.metadata.name,
};

function NameCell({ gvr, it }: { gvr: string; it: Item }) {
  // Pull events through context so the row-level badge stays in sync with
  // the same Warning event index the page-level WarningsToggle counts and
  // sorts by. Pages without an event subscription leave the binding null,
  // and issuesFor receives an empty list (structural-only path).
  const binding = useContext(EventIndexContext);
  const eventList = binding ? eventsForItem(binding.index, binding.gvr, it) : [];
  const issue = issuesFor(gvr, it, eventList);
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="font-medium truncate">{it.metadata.name}</span>
      {issue && <IssueBadge info={issue} />}
    </div>
  );
}

function nameColumnFor(gvr: string): Column {
  return {
    key: "name", label: "Name", width: "minmax(220px, 2fr)",
    render: (it) => <NameCell gvr={gvr} it={it} />,
    sortValue: (it) => it.metadata.name,
  };
}

const namespaceCol: Column = {
  key: "namespace", label: "Namespace", width: "minmax(140px, 1fr)",
  render: (it) => {
    const ns = it.metadata.namespace;
    if (!ns) return <span className="text-fg-mute">—</span>;
    return (
      <LinkCell
        target={{ group: "core", version: "v1", resource: "namespaces", name: ns }}
        title={ns}
      >
        {ns}
      </LinkCell>
    );
  },
  sortValue: (it) => it.metadata.namespace ?? "",
};

const ageCol: Column = {
  key: "age", label: "Age", width: "80px", align: "right",
  render: (it) => <AgeCell stamp={it.metadata.creationTimestamp} />,
  sortValue: (it) => -new Date(it.metadata.creationTimestamp ?? 0).getTime(),
};

function badge(text: string, kind: "ok" | "warn" | "bad" | "info" | "mute") {
  const cls = {
    ok: "chip-ok", warn: "chip-warn", bad: "chip-bad", info: "chip-info",
    mute: "chip",
  }[kind];
  return <span className={cls}>{text}</span>;
}

function IssueBadge({ info }: { info: IssueInfo }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    // Tooltip is `transform: translateX(-50%)`, so `left` is its center.
    // Clamp to keep ~halfwidth of the max-width inside the viewport.
    const halfWidth = 168;
    const center = rect.left + rect.width / 2;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(halfWidth + 8, Math.min(center, window.innerWidth - halfWidth - 8)),
    });
  };
  return (
    <span
      className={clsx("kv-issue shrink-0", info.severity === "bad" ? "kv-issue-bad" : "kv-issue-warn")}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setPos(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setPos(null)}
      tabIndex={0}
      role="img"
      aria-label={`${info.count} ${info.severity === "bad" ? "problem" : "warning"}${info.count === 1 ? "" : "s"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <AlertTriangle size={13} strokeWidth={2.25} />
      {pos && createPortal(
        <span className="kv-tooltip" style={{ top: pos.top, left: pos.left }}>
          <span className="kv-tooltip-title">
            {info.severity === "bad" ? "Problem" : "Warning"}
            {info.count > 1 && <span className="kv-tooltip-count"> {info.count}</span>}
          </span>
          {info.messages.slice(0, 4).map((m, i) => (
            <span key={i} className="kv-tooltip-line">{m}</span>
          ))}
          {info.messages.length > 4 && (
            <span className="kv-tooltip-line kv-tooltip-more">+{info.messages.length - 4} more</span>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}

export function issuesFor(gvr: string, it: Item, events: EventWarning[] = []): IssueInfo | null {
  const messages: string[] = [];
  let severity: IssueInfo["severity"] = "warn";
  const bad = (msg: string) => {
    severity = "bad";
    messages.push(msg);
  };
  const warn = (msg: string) => messages.push(msg);

  if (it.metadata?.deletionTimestamp) warn("Deletion is in progress.");

  if (gvr === "/v1/Event") {
    const event = it as any;
    if (event.type === "Warning") {
      const reason = event.reason ? `${event.reason}: ` : "";
      warn(`${reason}${event.message ?? "Warning event."}`);
    }
  } else if (gvr === "/v1/Node") {
    const conds = it.status?.conditions ?? [];
    const ready = conds.find((c: any) => c.type === "Ready");
    if (it.spec?.unschedulable) warn("Node is cordoned.");
    if (ready?.status !== "True") {
      const reason = ready?.reason ? `: ${ready.reason}` : "";
      bad(`Node is not ready${reason}.`);
    }
    for (const c of conds) {
      if (!c || c.type === "Ready") continue;
      if (c.status === "True") {
        const reason = c.reason ? `: ${c.reason}` : "";
        warn(`${c.type}${reason}.`);
      }
    }
  } else if (gvr === "/v1/Pod") {
    const phase = it.status?.phase ?? "Unknown";
    const initStatuses = it.status?.initContainerStatuses ?? [];
    const mainStatuses = it.status?.containerStatuses ?? [];
    if (phase === "Failed" || phase === "Unknown") bad(`Pod phase is ${phase}.`);
    else if (phase === "Pending") warn("Pod is pending.");

    // We deliberately stay narrow on the pod object itself: only flag
    // structural problems (image pull/crash backoffs, non-zero exits on
    // running pods). Restart count by itself is not a warning — a happily
    // self-healing pod can rack up dozens of restarts during the day; the
    // user's signal of trouble is the *event* fired by kubelet, not the
    // counter — so the kubelet-event cross-reference below carries that
    // weight instead of a row-level "N restart(s)" line.
    for (const c of initStatuses) {
      const name = c?.name ?? "container";
      const waiting = c?.state?.waiting;
      const terminated = c?.state?.terminated;
      if (waiting?.reason && waiting.reason !== "PodInitializing") {
        const msg = waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
        if (/CrashLoopBackOff|Err|Error|Failed|ImagePullBackOff/i.test(waiting.reason)) bad(`${name}: ${msg}`);
        else warn(`${name}: ${msg}`);
      }
      if (terminated && Number(terminated.exitCode ?? 0) !== 0) {
        const code = terminated.exitCode;
        const reason = terminated.reason ?? "terminated";
        bad(`${name}: ${reason}, exit ${code}.`);
      }
    }

    for (const c of mainStatuses) {
      const name = c?.name ?? "container";
      const waiting = c?.state?.waiting;
      const terminated = c?.state?.terminated;
      if (waiting?.reason) {
        const msg = waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
        if (/CrashLoopBackOff|Err|Error|Failed|ImagePullBackOff/i.test(waiting.reason)) bad(`${name}: ${msg}`);
        else warn(`${name}: ${msg}`);
      }
      if (terminated && phase !== "Succeeded") {
        const code = terminated.exitCode;
        const reason = terminated.reason ?? "terminated";
        if (code && code !== 0) bad(`${name}: ${reason}, exit ${code}.`);
      }
    }
  } else if (isWorkloadGVR(gvr)) {
    const desired = desiredReplicas(gvr, it);
    const ready = readyReplicas(gvr, it);
    const unavailable = Number(it.status?.unavailableReplicas ?? 0);
    const failed = Number(it.status?.failed ?? 0);
    if (desired > ready) warn(`Ready replicas ${ready}/${desired}.`);
    if (unavailable > 0) warn(`${unavailable} unavailable replica${unavailable === 1 ? "" : "s"}.`);
    if (failed > 0) bad(`${failed} failed pod${failed === 1 ? "" : "s"}.`);
    for (const c of it.status?.conditions ?? []) {
      if (!c) continue;
      const type = String(c.type ?? "Condition");
      const status = String(c.status ?? "");
      const reason = c.reason ? `: ${c.reason}` : "";
      if (type === "Progressing" && c.reason === "ProgressDeadlineExceeded") bad(`${type}${reason}.`);
      else if (["Available", "Ready", "Complete"].includes(type) && status === "False") warn(`${type} is False${reason}.`);
      else if (["Failed"].includes(type) && status === "True") bad(`${type}${reason}.`);
    }
  } else {
    for (const c of it.status?.conditions ?? []) {
      if (!c) continue;
      const type = String(c.type ?? "Condition");
      const status = String(c.status ?? "");
      const reason = c.reason ? `: ${c.reason}` : "";
      if (isNegativeConditionType(type)) {
        // Negative-meaning conditions (Failed=False is good). Warn only
        // when status flips to True. Common on CRDs: HelmChart's
        // `Failed=False`, cert-manager's `Issuing=False` after success,
        // operator-sdk's `Degraded=False` etc.
        if (status === "True") warn(`${type}${reason}.`);
        continue;
      }
      // Positive-meaning condition: missing-data and explicit False both
      // mean "not yet OK". Progressing is intentionally skipped — it's
      // True during a healthy rollout, False during a healthy steady
      // state, neither carries a useful binary.
      if (["False", "Unknown"].includes(status) && !["Progressing"].includes(type)) {
        warn(`${type} is ${status}${reason}.`);
      }
    }
  }

  // Lens parity: dedupe Warning events by reason — N "Liveness probe failed"
  // events show up as one bullet, not fifty. Severe reasons (CrashLoopBackOff,
  // OOMKilled, FailedScheduling, …) get promoted to bad; everything else
  // stays at warn so a single transient probe blip doesn't paint the row red.
  if (events.length > 0) {
    const dedup = new Map<string, EventWarning>();
    for (const e of events) {
      const k = e.reason || "Warning";
      const existing = dedup.get(k);
      if (!existing || e.lastSeen > existing.lastSeen) dedup.set(k, e);
    }
    for (const e of dedup.values()) {
      const reason = e.reason || "Warning";
      // Surface the freshness of the event so the user knows whether the
      // warning is "happening right now" or a stale event from the last
      // hour. Lens shows the same — a 50-minute-old probe blip should not
      // read like a live failure.
      const ageStr = ageHint(e.lastSeen);
      const text = `${reason}${e.message ? `: ${e.message}` : ""}${ageStr ? ` (${ageStr})` : ""}`;
      if (isSevereReason(reason)) bad(text);
      else warn(text);
    }
  }

  const clean = [...new Set(messages.filter(Boolean))];
  if (clean.length === 0) return null;
  return { count: clean.length, severity, messages: clean };
}

// ageHint — compact "X ago" for warning lastSeen timestamps. Empty string
// when the event is from the future or invalid (defensive — the apiserver
// occasionally returns clock-skewed timestamps).
function ageHint(lastSeenMs: number): string {
  if (!Number.isFinite(lastSeenMs) || lastSeenMs <= 0) return "";
  const diffSec = Math.floor((Date.now() - lastSeenMs) / 1000);
  if (diffSec < 0) return "";
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isWorkloadGVR(gvr: string): boolean {
  return [
    "apps/v1/Deployment",
    "apps/v1/StatefulSet",
    "apps/v1/DaemonSet",
    "apps/v1/ReplicaSet",
    "batch/v1/Job",
    "batch/v1/CronJob",
  ].includes(gvr);
}

function desiredReplicas(gvr: string, it: Item): number {
  if (gvr === "apps/v1/DaemonSet") return Number(it.status?.desiredNumberScheduled ?? 0);
  if (gvr === "batch/v1/Job") return Number(it.spec?.completions ?? 1);
  if (gvr === "batch/v1/CronJob") return Number((it.status?.active ?? []).length);
  return Number(it.spec?.replicas ?? it.status?.replicas ?? 0);
}

function readyReplicas(gvr: string, it: Item): number {
  if (gvr === "apps/v1/DaemonSet") return Number(it.status?.numberReady ?? 0);
  if (gvr === "batch/v1/Job") return Number(it.status?.succeeded ?? 0);
  if (gvr === "batch/v1/CronJob") return Number((it.status?.active ?? []).length);
  return Number(it.status?.readyReplicas ?? it.status?.availableReplicas ?? 0);
}

function podContainers(it: Item) {
  const specs = it.spec?.containers ?? [];
  const statuses = new Map<string, any>();
  for (const c of it.status?.containerStatuses ?? []) {
    statuses.set(c.name, c);
  }
  if (specs.length > 0) {
    return specs.map((c: any) => ({
      name: c.name,
      ready: !!statuses.get(c.name)?.ready,
    }));
  }
  return (it.status?.containerStatuses ?? []).map((c: any) => ({
    name: c.name,
    ready: !!c.ready,
  }));
}

function restartCount(it: Item) {
  return (it.status?.containerStatuses ?? [])
    .reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0);
}

function controllerFor(it: Item) {
  const refs = it.metadata?.ownerReferences ?? [];
  return refs.find((r: any) => r.controller) ?? refs[0] ?? null;
}

function dash() {
  return <span className="text-fg-mute">-</span>;
}

function mono(text?: any) {
  const value = text === undefined || text === null || text === "" ? "-" : text;
  return <span className="font-mono text-xs text-fg-soft truncate" title={String(value)}>{value}</span>;
}

function compactList(items: string[], max = 3): string {
  const clean = [...new Set(items.filter(Boolean))];
  if (clean.length === 0) return "";
  if (clean.length <= max) return clean.join(", ");
  return `${clean.slice(0, max).join(", ")} +${clean.length - max}`;
}

function listText(items: string[], max = 24): string {
  return compactList(items, max);
}

function listCell(items: string[], max = 24) {
  const text = listText(items, max);
  return text ? mono(text) : dash();
}

function yesNo(v: unknown): React.ReactNode {
  if (v === true) return <span className="font-mono text-xs text-ok">Yes</span>;
  if (v === false) return <span className="font-mono text-xs text-fg-mute">No</span>;
  return dash();
}

// 0 (unset/null/undefined) so unset rows pile up at the bottom of asc-sort,
// 1 for explicit false, 2 for explicit true — preserves a tri-state ordering.
function booleanSort(v: unknown): number {
  if (v === true) return 2;
  if (v === false) return 1;
  return 0;
}

function combinedKeys(it: Item): string[] {
  return [...Object.keys(it.data ?? {}), ...Object.keys(it.binaryData ?? {})];
}

function labelsText(labels?: Record<string, string>, max = 24): string {
  return compactList(Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`), max);
}

function labelsCell(labels?: Record<string, string>, max = 24) {
  const text = labelsText(labels, max);
  return text ? mono(text) : dash();
}

function selectorText(it: Item): string {
  return labelsText(it.spec?.selector?.matchLabels ?? it.spec?.selector, 3);
}

function imagesFor(it: Item): string {
  const podSpec = it.spec?.template?.spec ?? it.spec;
  return compactList((podSpec?.containers ?? []).map((c: any) => c.image), 2);
}

function conditionText(it: Item): string {
  const conds = it.status?.conditions ?? [];
  return compactList(conds
    .filter((c: any) => c.status === "True")
    .map((c: any) => c.type), 3);
}

// Condition types where status=True means trouble (i.e. False/Unknown is the
// healthy state). Custom CRD authors lean on this naming convention heavily —
// HelmChart writes `Failed`, cert-manager writes `Failing`, operator-sdk
// writes `Degraded`, kubelet writes `MemoryPressure`/`DiskPressure`. Without
// this knob the generic "False is bad" rule paints rows yellow on completed
// HelmCharts and idle Nodes alike. Suffix patterns catch the long tail
// ("XYZFailed", "FooBarPressure") without enumerating every operator's CRD.
const NEGATIVE_CONDITION_TYPES = new Set([
  "Failed", "Failure", "Failing",
  "Degraded", "Degrading",
  "Disrupted",
  "ReplicaFailure",
  "Unhealthy",
  "Stalled",
  "MemoryPressure", "DiskPressure", "PIDPressure",
  "NetworkUnavailable",
  "ContainerNotReady",
  "Suspended",
]);
const NEGATIVE_CONDITION_SUFFIX = /(?:Failed|Failure|Pressure|Unavailable|Disrupted|Stalled|Degraded|Unhealthy)$/;

function isNegativeConditionType(type: string): boolean {
  if (NEGATIVE_CONDITION_TYPES.has(type)) return true;
  return NEGATIVE_CONDITION_SUFFIX.test(type);
}

// Condition types where status=True is the "everything is fine" signal — those
// get the green ok-chip. Anything else gets a neutral chip so the Conditions
// column doesn't paint Deployment rows green just because Progressing=True
// (which is also true while a roll-out is failing).
const POSITIVE_TRUE_CONDITIONS = new Set([
  "Available", "Ready", "Complete", "Succeeded", "Healthy",
  "Established", "NamesAccepted", "Initialized",
  "ContainersReady", "PodScheduled", "PodReadyToStartContainers",
  "AbleToScale", "ScalingActive", "DisruptionAllowed",
  "LoadBalancerReady",
]);

// ConditionsCell — Lens-style render: small subtle pills per True condition,
// up to three with a "+N" tail. Centralised so Deployment/Job/HPA/etc all
// look the same instead of one column showing comma-text and another mono-
// text and a third something else.
function ConditionsCell({ it }: { it: Item }) {
  const conds = (it.status?.conditions ?? []) as any[];
  // Stable order: positive (chip-ok) types first, then everything else,
  // alphabetical within each group. Without this, the same Deployment
  // can render "Available, Progressing" on one row and the reverse on
  // another just because the controller happened to write the conditions
  // array in a different order.
  const trueConds = conds
    .filter((c) => c?.status === "True" && c?.type)
    .slice()
    .sort((a, b) => {
      const ap = POSITIVE_TRUE_CONDITIONS.has(a.type) ? 0 : 1;
      const bp = POSITIVE_TRUE_CONDITIONS.has(b.type) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return String(a.type).localeCompare(String(b.type));
    });
  if (trueConds.length === 0) return dash();
  const MAX = 3;
  const shown = trueConds.slice(0, MAX);
  const overflow = trueConds.length - shown.length;
  const tooltip = trueConds.map((c) => c.type).join(", ");
  return (
    <div className="flex items-center gap-1 min-w-0 truncate" title={tooltip}>
      {shown.map((c) => (
        <span
          key={c.type}
          className={clsx(
            "shrink-0",
            POSITIVE_TRUE_CONDITIONS.has(c.type) ? "chip-ok" : "chip",
          )}
        >
          {c.type}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-fg-mute text-[10px] shrink-0">+{overflow}</span>
      )}
    </div>
  );
}

function duration(start?: string, end?: string): string {
  if (!start) return "-";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return "-";
  const seconds = Math.max(0, Math.floor((e - s) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes - hours * 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

function quantityMapText(map?: Record<string, any>, max = 12): string {
  return compactList(Object.entries(map ?? {}).map(([k, v]) => `${k}: ${v}`), max);
}

function portsText(ports?: any[], max = 16): string {
  return compactList((ports ?? []).map((p: any) => {
    const port = p.port ?? p.targetPort ?? p.containerPort ?? "";
    const name = p.name ? `${p.name}:` : "";
    const proto = p.protocol && p.protocol !== "TCP" ? `/${p.protocol}` : "";
    const nodePort = p.nodePort ? ` -> ${p.nodePort}` : "";
    const target = p.targetPort && p.targetPort !== p.port ? ` -> ${p.targetPort}` : "";
    return `${name}${port}${target}${nodePort}${proto}`;
  }), max);
}

function serviceExternalIPs(it: Item): string {
  const lb = (it.status?.loadBalancer?.ingress ?? [])
    .map((x: any) => x.ip ?? x.hostname)
    .filter(Boolean);
  const external = it.spec?.externalIPs ?? [];
  return compactList([...lb, ...external], 8);
}

function endpointSliceAddresses(it: Item): string[] {
  return (it.endpoints ?? [])
    .flatMap((e: any) => e.addresses ?? [])
    .filter(Boolean);
}

function endpointReadyCount(it: Item): string {
  const endpoints = it.endpoints ?? [];
  if (endpoints.length === 0) return "0/0";
  const ready = endpoints.filter((e: any) => e.conditions?.ready !== false).length;
  return `${ready}/${endpoints.length}`;
}

function ingressAddresses(it: Item): string {
  return compactList((it.status?.loadBalancer?.ingress ?? [])
    .map((x: any) => x.ip ?? x.hostname)
    .filter(Boolean), 8);
}

function ingressRules(it: Item): string {
  return compactList((it.spec?.rules ?? []).map((r: any) => {
    const paths = (r.http?.paths ?? []).map((p: any) => p.path || "/").join(",");
    return r.host ? `${r.host}${paths ? ` ${paths}` : ""}` : paths;
  }), 12);
}

function networkPolicyRuleCount(rules?: any[]): number {
  return Array.isArray(rules) ? rules.length : 0;
}

function accessModes(it: Item): string[] {
  return it.spec?.accessModes ?? [];
}

function claimRefText(it: Item): string {
  const ref = it.spec?.claimRef;
  if (!ref) return "";
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

function isDefaultStorageClass(it: Item): boolean {
  const a = it.metadata?.annotations ?? {};
  return a["storageclass.kubernetes.io/is-default-class"] === "true"
    || a["storageclass.beta.kubernetes.io/is-default-class"] === "true";
}

function rulesOf(it: Item): any[] {
  return it.rules ?? [];
}

function ruleResources(it: Item): string[] {
  return rulesOf(it).flatMap((r: any) => r.resources ?? []);
}

function ruleVerbs(it: Item): string[] {
  return rulesOf(it).flatMap((r: any) => r.verbs ?? []);
}

function ruleApiGroups(it: Item): string[] {
  return rulesOf(it).flatMap((r: any) => r.apiGroups ?? []);
}

function subjectsText(it: Item): string {
  return compactList((it.subjects ?? []).map((s: any) => {
    const ns = s.namespace ? `${s.namespace}/` : "";
    return `${s.kind}/${ns}${s.name}`;
  }), 20);
}

function PodCpuCell({ podKey }: { podKey: string }) {
  const cluster = useApp((s) => s.cluster);
  const metric = usePodMetricsStore((s) => s.byCluster.get(cluster)?.get(podKey));
  const history = usePodMetricsStore((s) => s.history.get(cluster)?.get(podKey));
  // Memoise the projected sparkline series — when history ref is stable
  // (e.g., a pod that wasn't in this metrics tick), the Sparkline gets the
  // same array ref and skips work.
  const series = useMemo(() => history?.map((h) => h.cpu) ?? [], [history]);
  if (!metric) return <span className="text-fg-mute">—</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 font-mono text-xs text-fg-soft min-w-0">
      {series.length > 1 && <Sparkline values={series} className="text-accent shrink-0" />}
      <span className="truncate">{formatMillicores(metric.cpu)}</span>
    </span>
  );
}

function PodMemoryCell({ podKey }: { podKey: string }) {
  const cluster = useApp((s) => s.cluster);
  const metric = usePodMetricsStore((s) => s.byCluster.get(cluster)?.get(podKey));
  const history = usePodMetricsStore((s) => s.history.get(cluster)?.get(podKey));
  const series = useMemo(() => history?.map((h) => h.memory) ?? [], [history]);
  if (!metric) return <span className="text-fg-mute">—</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 font-mono text-xs text-fg-soft min-w-0">
      {series.length > 1 && <Sparkline values={series} className="text-accent shrink-0" />}
      <span className="truncate">{bytes(metric.memory)}</span>
    </span>
  );
}

function podMetricSortValue(it: Item, field: "cpu" | "memory"): number {
  const cluster = useApp.getState().cluster;
  const m = readPodMetric(cluster, podMetricKey(it.metadata?.namespace, it.metadata?.name));
  return m ? m[field] : -1;
}

const podColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "cpu", label: "CPU", width: "150px", align: "right",
    render: (it) => <PodCpuCell podKey={podMetricKey(it.metadata?.namespace, it.metadata?.name)} />,
    sortValue: (it) => podMetricSortValue(it, "cpu"),
  },
  {
    key: "memory", label: "Memory", width: "165px", align: "right",
    render: (it) => <PodMemoryCell podKey={podMetricKey(it.metadata?.namespace, it.metadata?.name)} />,
    sortValue: (it) => podMetricSortValue(it, "memory"),
  },
  {
    key: "containers", label: "Containers", width: "120px",
    render: (it) => {
      const cs = podContainers(it);
      const ready = cs.filter((c: any) => c.ready).length;
      if (cs.length === 0) return <span className="text-fg-mute">-</span>;
      return (
        <div className="flex items-center gap-1" title={`${ready}/${cs.length} containers ready`}>
          {cs.map((c: any) => (
            <span
              key={c.name}
              className="h-2 w-2 rounded-sm border border-line"
              style={{ backgroundColor: c.ready ? "rgb(var(--ok))" : "rgb(var(--fg-mute) / 0.55)" }}
            />
          ))}
          <span className="ml-1 font-mono text-[11px] text-fg-mute">{ready}/{cs.length}</span>
        </div>
      );
    },
    sortValue: (it) => podContainers(it).filter((c: any) => c.ready).length,
  },
  {
    key: "restarts", label: "Restarts", width: "90px", align: "right",
    render: (it) => {
      const r = restartCount(it);
      return <span className={clsx("font-mono text-xs",
        r > 5 ? "text-bad" : r > 0 ? "text-warn" : "text-fg-mute")}>{r}</span>;
    },
    sortValue: restartCount,
  },
  {
    key: "controlledBy", label: "Controlled By", width: "minmax(120px, 150px)",
    render: (it) => {
      const owner = controllerFor(it);
      if (!owner) return <span className="text-fg-mute">-</span>;
      return (
        <LinkCell target={ownerToRef(owner, it.metadata.namespace)} title={owner.name}>
          {owner.kind}
        </LinkCell>
      );
    },
    sortValue: (it) => {
      const owner = controllerFor(it);
      return owner ? `${owner.kind}/${owner.name}` : "";
    },
  },
  {
    key: "node", label: "Node", width: "minmax(140px, 1fr)",
    render: (it) => {
      const node = it.spec?.nodeName;
      if (!node) return <span className="text-fg-mute">—</span>;
      return (
        <LinkCell
          target={{ group: "core", version: "v1", resource: "nodes", name: node }}
          title={node}
        >
          {node}
        </LinkCell>
      );
    },
    sortValue: (it) => it.spec?.nodeName ?? "",
  },
  {
    key: "qos", label: "QoS", width: "110px",
    render: (it) => <span className="text-fg-soft">{it.status?.qosClass ?? "-"}</span>,
    sortValue: (it) => it.status?.qosClass ?? "",
  },
  ageCol,
  {
    key: "status", label: "Status", width: "minmax(110px, 150px)",
    render: (it) => {
      const status = podDisplayStatus(it);
      return <span className={podStatusClassName(status.kind)} title={status.detail}>{status.label}</span>;
    },
    sortValue: (it) => podDisplayStatus(it).label,
  },
];

const deploymentColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "ready", label: "Ready", width: "90px", align: "center",
    render: (it) => {
      const r = it.status?.readyReplicas ?? 0;
      const d = it.status?.replicas ?? it.spec?.replicas ?? 0;
      return <span className={clsx("font-mono text-xs",
        r === d ? "text-ok" : "text-warn")}>{r}/{d}</span>;
    },
    sortValue: (it) => (it.status?.readyReplicas ?? 0),
  },
  {
    key: "uptodate", label: "Up-to-date", width: "100px", align: "center",
    render: (it) => <span className="font-mono text-xs">{it.status?.updatedReplicas ?? 0}</span>,
  },
  {
    key: "available", label: "Available", width: "100px", align: "center",
    render: (it) => <span className="font-mono text-xs">{it.status?.availableReplicas ?? 0}</span>,
  },
  {
    key: "replicas", label: "Replicas", width: "90px", align: "center",
    render: (it) => mono(it.spec?.replicas ?? 0),
    sortValue: (it) => it.spec?.replicas ?? 0,
  },
  {
    key: "strategy", label: "Strategy", width: "130px",
    render: (it) => mono(it.spec?.strategy?.type ?? "-"),
    sortValue: (it) => it.spec?.strategy?.type ?? "",
  },
  {
    key: "images", label: "Images", width: "minmax(180px, 1.4fr)",
    defaultVisible: false,
    render: (it) => mono(imagesFor(it)),
    sortValue: imagesFor,
  },
  {
    key: "selector", label: "Selector", width: "minmax(180px, 1.4fr)",
    defaultVisible: false,
    render: (it) => mono(selectorText(it)),
    sortValue: selectorText,
  },
  {
    key: "conditions", label: "Conditions", width: "minmax(180px, 1.4fr)",
    render: (it) => <ConditionsCell it={it} />,
    sortValue: conditionText,
  },
  ageCol,
];

const daemonSetColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "ready", label: "Ready", width: "90px", align: "center",
    render: (it) => {
      const r = it.status?.numberReady ?? 0;
      const d = it.status?.desiredNumberScheduled ?? 0;
      return <span className={clsx("font-mono text-xs", r === d ? "text-ok" : "text-warn")}>{r}/{d}</span>;
    },
    sortValue: (it) => it.status?.numberReady ?? 0,
  },
  {
    key: "desired", label: "Desired", width: "90px", align: "right",
    render: (it) => mono(it.status?.desiredNumberScheduled ?? 0),
    sortValue: (it) => it.status?.desiredNumberScheduled ?? 0,
  },
  {
    key: "current", label: "Current", width: "90px", align: "right",
    render: (it) => mono(it.status?.currentNumberScheduled ?? 0),
    sortValue: (it) => it.status?.currentNumberScheduled ?? 0,
  },
  {
    key: "uptodate", label: "Up-to-date", width: "100px", align: "right",
    render: (it) => mono(it.status?.updatedNumberScheduled ?? 0),
    sortValue: (it) => it.status?.updatedNumberScheduled ?? 0,
  },
  {
    key: "available", label: "Available", width: "100px", align: "right",
    render: (it) => mono(it.status?.numberAvailable ?? 0),
    sortValue: (it) => it.status?.numberAvailable ?? 0,
  },
  {
    key: "nodeSelector", label: "Node Selector", width: "minmax(180px, 1.4fr)",
    render: (it) => mono(labelsText(it.spec?.template?.spec?.nodeSelector, 3)),
    sortValue: (it) => labelsText(it.spec?.template?.spec?.nodeSelector, 3),
  },
  {
    key: "images", label: "Images", width: "minmax(180px, 1.4fr)",
    defaultVisible: false,
    render: (it) => mono(imagesFor(it)),
    sortValue: imagesFor,
  },
  ageCol,
];

const statefulSetColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "ready", label: "Ready", width: "90px", align: "center",
    render: (it) => {
      const r = it.status?.readyReplicas ?? 0;
      const d = it.status?.replicas ?? it.spec?.replicas ?? 0;
      return <span className={clsx("font-mono text-xs", r === d ? "text-ok" : "text-warn")}>{r}/{d}</span>;
    },
    sortValue: (it) => it.status?.readyReplicas ?? 0,
  },
  {
    key: "replicas", label: "Replicas", width: "90px", align: "right",
    render: (it) => mono(it.spec?.replicas ?? 0),
    sortValue: (it) => it.spec?.replicas ?? 0,
  },
  {
    key: "current", label: "Current", width: "90px", align: "right",
    render: (it) => mono(it.status?.currentReplicas ?? 0),
    sortValue: (it) => it.status?.currentReplicas ?? 0,
  },
  {
    key: "updated", label: "Updated", width: "90px", align: "right",
    render: (it) => mono(it.status?.updatedReplicas ?? 0),
    sortValue: (it) => it.status?.updatedReplicas ?? 0,
  },
  {
    key: "service", label: "Service", width: "minmax(140px, 1fr)",
    render: (it) => mono(it.spec?.serviceName ?? "-"),
    sortValue: (it) => it.spec?.serviceName ?? "",
  },
  {
    key: "images", label: "Images", width: "minmax(180px, 1.4fr)",
    defaultVisible: false,
    render: (it) => mono(imagesFor(it)),
    sortValue: imagesFor,
  },
  ageCol,
];

const replicaSetColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "desired", label: "Desired", width: "90px", align: "right",
    render: (it) => mono(it.spec?.replicas ?? 0),
    sortValue: (it) => it.spec?.replicas ?? 0,
  },
  {
    key: "current", label: "Current", width: "90px", align: "right",
    render: (it) => mono(it.status?.replicas ?? 0),
    sortValue: (it) => it.status?.replicas ?? 0,
  },
  {
    key: "ready", label: "Ready", width: "90px", align: "right",
    render: (it) => mono(it.status?.readyReplicas ?? 0),
    sortValue: (it) => it.status?.readyReplicas ?? 0,
  },
  {
    key: "controlledBy", label: "Controlled By", width: "minmax(140px, 1fr)",
    render: (it) => {
      const owner = controllerFor(it);
      if (!owner) return dash();
      return (
        <LinkCell target={ownerToRef(owner, it.metadata.namespace)} title={owner.name}>
          {owner.kind}
        </LinkCell>
      );
    },
    sortValue: (it) => {
      const owner = controllerFor(it);
      return owner ? `${owner.kind}/${owner.name}` : "";
    },
  },
  {
    key: "images", label: "Images", width: "minmax(180px, 1.4fr)",
    defaultVisible: false,
    render: (it) => mono(imagesFor(it)),
    sortValue: imagesFor,
  },
  ageCol,
];

const jobColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "completions", label: "Completions", width: "120px", align: "center",
    render: (it) => mono(`${it.status?.succeeded ?? 0} / ${it.spec?.completions ?? 1}`),
    sortValue: (it) => it.status?.succeeded ?? 0,
  },
  {
    key: "active", label: "Active", width: "80px", align: "right",
    render: (it) => mono(it.status?.active ?? 0),
    sortValue: (it) => it.status?.active ?? 0,
  },
  {
    key: "failed", label: "Failed", width: "80px", align: "right",
    render: (it) => <span className={clsx("font-mono text-xs", (it.status?.failed ?? 0) > 0 ? "text-bad" : "text-fg-soft")}>{it.status?.failed ?? 0}</span>,
    sortValue: (it) => it.status?.failed ?? 0,
  },
  {
    key: "parallelism", label: "Parallelism", width: "110px", align: "right",
    defaultVisible: false,
    render: (it) => mono(it.spec?.parallelism ?? 1),
    sortValue: (it) => it.spec?.parallelism ?? 1,
  },
  {
    key: "duration", label: "Duration", width: "100px", align: "right",
    render: (it) => mono(duration(it.status?.startTime, it.status?.completionTime)),
    sortValue: (it) => new Date(it.status?.completionTime ?? it.status?.startTime ?? 0).getTime(),
  },
  {
    key: "conditions", label: "Conditions", width: "minmax(160px, 1fr)",
    render: (it) => <ConditionsCell it={it} />,
    sortValue: conditionText,
  },
  ageCol,
];

const cronJobColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "schedule", label: "Schedule", width: "minmax(140px, 1fr)",
    render: (it) => mono(it.spec?.schedule ?? "-"),
    sortValue: (it) => it.spec?.schedule ?? "",
  },
  {
    key: "suspend", label: "Suspend", width: "90px", align: "center",
    render: (it) => it.spec?.suspend ? badge("True", "warn") : badge("False", "mute"),
    sortValue: (it) => it.spec?.suspend ? 1 : 0,
  },
  {
    key: "active", label: "Active", width: "80px", align: "right",
    render: (it) => mono((it.status?.active ?? []).length),
    sortValue: (it) => (it.status?.active ?? []).length,
  },
  {
    key: "lastSchedule", label: "Last Schedule", width: "120px", align: "right",
    render: (it) => <AgeCell stamp={it.status?.lastScheduleTime} />,
    sortValue: (it) => -new Date(it.status?.lastScheduleTime ?? 0).getTime(),
  },
  {
    key: "lastSuccess", label: "Last Success", width: "120px", align: "right",
    defaultVisible: false,
    render: (it) => <AgeCell stamp={it.status?.lastSuccessfulTime} />,
    sortValue: (it) => -new Date(it.status?.lastSuccessfulTime ?? 0).getTime(),
  },
  {
    key: "concurrency", label: "Concurrency", width: "120px",
    defaultVisible: false,
    render: (it) => mono(it.spec?.concurrencyPolicy ?? "Allow"),
    sortValue: (it) => it.spec?.concurrencyPolicy ?? "",
  },
  ageCol,
];

const serviceColumns: Column[] = [
  nameCol, namespaceCol,
  { key: "type", label: "Type", width: "120px",
    render: (it) => <span className="font-mono text-xs">{it.spec?.type ?? "ClusterIP"}</span>,
    sortValue: (it) => it.spec?.type ?? "",
  },
  { key: "clusterIP", label: "ClusterIP", width: "140px",
    render: (it) => <span className="font-mono text-xs">{it.spec?.clusterIP || "—"}</span>,
  },
  { key: "ports", label: "Ports", width: "minmax(160px, 2fr)",
    render: (it) => <span className="font-mono text-xs">{(it.spec?.ports ?? [])
      .map((p: any) => `${p.port}${p.protocol && p.protocol !== "TCP" ? "/" + p.protocol : ""}${p.nodePort ? `→${p.nodePort}` : ""}`)
      .join(", ") || "—"}</span>,
  },
  ageCol,
];

const nodeColumns: Column[] = [
  nameCol,
  {
    key: "status", label: "Status", width: "120px",
    render: (it) => {
      const conds = it.status?.conditions ?? [];
      const ready = conds.find((c: any) => c.type === "Ready");
      const sched = it.spec?.unschedulable;
      if (sched) return badge("Cordoned", "warn");
      if (ready?.status === "True") return badge("Ready", "ok");
      return badge("NotReady", "bad");
    },
    sortValue: (it) => (it.status?.conditions ?? []).find((c: any) => c.type === "Ready")?.status ?? "",
  },
  { key: "roles", label: "Roles", width: "180px",
    render: (it) => <span className="font-mono text-xs">{nodeRoles(it).join(", ") || "worker"}</span>,
    sortValue: (it) => nodeRoles(it).join(",") || "worker",
  },
  { key: "version", label: "Version", width: "120px",
    render: (it) => <span className="font-mono text-xs">{it.status?.nodeInfo?.kubeletVersion ?? "—"}</span>,
    sortValue: (it) => it.status?.nodeInfo?.kubeletVersion ?? "",
  },
  { key: "os", label: "OS", width: "minmax(260px, 2fr)",
    render: (it) => <span className="text-xs text-fg-soft truncate" title={it.status?.nodeInfo?.osImage ?? ""}>{it.status?.nodeInfo?.osImage ?? ""}</span>,
    sortValue: (it) => it.status?.nodeInfo?.osImage ?? "",
  },
  { key: "internal", label: "Internal IP", width: "140px",
    render: (it) => <span className="font-mono text-xs">{nodeInternalIP(it) || "—"}</span>,
    // Sort numerically by octet so 10.211.18.9 comes before 10.211.18.10 —
    // string-sort of dotted-quads would put .10 before .9.
    sortValue: (it) => ipv4SortKey(nodeInternalIP(it)),
  },
  ageCol,
];

function nodeRoles(it: Item): string[] {
  const labels = it.metadata?.labels ?? {};
  return Object.keys(labels)
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.split("/")[1] || "node");
}

function nodeInternalIP(it: Item): string {
  return (it.status?.addresses ?? []).find((a: any) => a.type === "InternalIP")?.address ?? "";
}

// Convert "10.211.18.9" → 10*2^24 + 211*2^16 + 18*2^8 + 9. Returns Infinity
// for malformed input so unparseable rows sink to the bottom of an asc sort.
function ipv4SortKey(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v) || v < 0 || v > 255) return Number.POSITIVE_INFINITY;
    n = n * 256 + v;
  }
  return n;
}

const namespaceColumns: Column[] = [
  nameCol,
  { key: "status", label: "Status", width: "120px",
    render: (it) => badge(it.status?.phase ?? "Active",
      it.status?.phase === "Active" ? "ok" : "warn") },
  ageCol,
];

const eventColumns: Column[] = [
  { key: "type", label: "Type", width: "100px",
    render: (it: any) => badge(it.type ?? "Normal",
      it.type === "Warning" ? "warn" : "info"),
    sortValue: (it: any) => it.type ?? "",
  },
  namespaceCol,
  { key: "reason", label: "Reason", width: "160px",
    render: (it: any) => <span className="font-medium">{it.reason}</span>,
  },
  { key: "message", label: "Message", width: "minmax(300px, 5fr)",
    render: (it: any) => <span className="text-fg-soft truncate">{it.message}</span>,
  },
  { key: "involved", label: "Object", width: "minmax(160px, 2fr)",
    render: (it: any) => {
      const obj = it.involvedObject;
      if (!obj?.kind || !obj?.name) return <span className="text-fg-mute">—</span>;
      const target = ownerToRef(obj, obj.namespace ?? it.metadata?.namespace);
      return (
        <LinkCell target={target} title={`${obj.kind}/${obj.name}`} className="font-mono text-xs">
          {obj.kind}/{obj.name}
        </LinkCell>
      );
    },
    sortValue: (it: any) => `${it.involvedObject?.kind ?? ""}/${it.involvedObject?.name ?? ""}`,
  },
  { key: "count", label: "Count", width: "70px", align: "right",
    render: (it: any) => <span className="font-mono text-xs">{it.count ?? 1}</span>,
  },
  ageCol,
];

const ingressColumns: Column[] = [
  nameCol, namespaceCol,
  { key: "class", label: "Class", width: "140px",
    render: (it) => <span className="font-mono text-xs">{it.spec?.ingressClassName ?? "—"}</span>,
  },
  { key: "hosts", label: "Hosts", width: "minmax(200px, 3fr)",
    render: (it) => <span className="font-mono text-xs truncate">
      {(it.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean).join(", ") || "—"}
    </span>,
  },
  ageCol,
];

const pvcColumns: Column[] = [
  nameCol, namespaceCol,
  { key: "status", label: "Status", width: "100px",
    render: (it) => badge(it.status?.phase ?? "—",
      it.status?.phase === "Bound" ? "ok" : "warn") },
  { key: "volume", label: "Volume", width: "minmax(140px, 1fr)",
    render: (it) => <span className="font-mono text-xs truncate">{it.spec?.volumeName || "—"}</span> },
  { key: "capacity", label: "Capacity", width: "100px", align: "right",
    render: (it) => <span className="font-mono text-xs">{it.status?.capacity?.storage ?? "—"}</span> },
  { key: "sc", label: "StorageClass", width: "140px",
    render: (it) => <span className="font-mono text-xs">{it.spec?.storageClassName ?? "—"}</span> },
  ageCol,
];

const configMapColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "labels", label: "Labels", width: "minmax(260px, 2fr)",
    render: (it) => labelsCell(it.metadata?.labels),
    sortValue: (it) => labelsText(it.metadata?.labels),
  },
  {
    key: "keys", label: "Keys", width: "minmax(300px, 2.4fr)",
    render: (it) => {
      const keys = combinedKeys(it);
      return listCell(keys);
    },
    sortValue: (it) => combinedKeys(it).join(","),
  },
  {
    key: "keyCount", label: "Key Count", width: "100px", align: "right",
    render: (it) => mono(combinedKeys(it).length),
    sortValue: (it) => combinedKeys(it).length,
  },
  {
    key: "immutable", label: "Immutable", width: "100px", align: "center",
    render: (it) => it.immutable ? badge("True", "info") : badge("False", "mute"),
    sortValue: (it) => it.immutable ? 1 : 0,
  },
  ageCol,
];

const secretColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "labels", label: "Labels", width: "minmax(260px, 2fr)",
    render: (it) => labelsCell(it.metadata?.labels),
    sortValue: (it) => labelsText(it.metadata?.labels),
  },
  {
    key: "keys", label: "Keys", width: "minmax(260px, 2fr)",
    render: (it) => {
      const keys = combinedKeys(it);
      return listCell(keys);
    },
    sortValue: (it) => combinedKeys(it).join(","),
  },
  {
    key: "keyCount", label: "Key Count", width: "100px", align: "right",
    defaultVisible: false,
    render: (it) => mono(combinedKeys(it).length),
    sortValue: (it) => combinedKeys(it).length,
  },
  {
    key: "type", label: "Type", width: "minmax(180px, 1fr)",
    render: (it: any) => mono(it.type ?? "Opaque"),
    sortValue: (it: any) => it.type ?? "Opaque",
  },
  {
    key: "immutable", label: "Immutable", width: "100px", align: "center",
    defaultVisible: false,
    render: (it) => it.immutable ? badge("True", "info") : badge("False", "mute"),
    sortValue: (it) => it.immutable ? 1 : 0,
  },
  ageCol,
];

const crdColumns: Column[] = [
  nameCol,
  {
    key: "group", label: "Group", width: "minmax(180px, 1fr)",
    render: (it) => <span className="font-mono text-xs text-fg-soft truncate">{it.spec?.group ?? "-"}</span>,
    sortValue: (it) => it.spec?.group ?? "",
  },
  {
    key: "kind", label: "Kind", width: "minmax(150px, 1fr)",
    render: (it) => <span className="font-medium truncate">{it.spec?.names?.kind ?? "-"}</span>,
    sortValue: (it) => it.spec?.names?.kind ?? "",
  },
  {
    key: "scope", label: "Scope", width: "110px",
    render: (it) => <span className={clsx("text-xs", it.spec?.scope === "Namespaced" ? "text-accent" : "text-fg-mute")}>{it.spec?.scope ?? "-"}</span>,
    sortValue: (it) => it.spec?.scope ?? "",
  },
  {
    key: "versions", label: "Versions", width: "minmax(160px, 1fr)",
    render: (it) => <span className="font-mono text-xs text-fg-soft truncate">
      {(it.spec?.versions ?? []).map((v: any) => v.name).join(", ") || "-"}
    </span>,
  },
  {
    key: "established", label: "Status", width: "130px",
    render: (it) => {
      const cond = (it.status?.conditions ?? []).find((c: any) => c.type === "Established");
      return cond?.status === "True" ? badge("Established", "ok") : badge("Pending", "warn");
    },
    sortValue: (it) => (it.status?.conditions ?? []).find((c: any) => c.type === "Established")?.status ?? "",
  },
  ageCol,
];

const resourceQuotaColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "hard", label: "Hard", width: "minmax(260px, 2fr)",
    render: (it) => {
      const text = quantityMapText(it.status?.hard ?? it.spec?.hard);
      return text ? mono(text) : dash();
    },
    sortValue: (it) => quantityMapText(it.status?.hard ?? it.spec?.hard),
  },
  {
    key: "used", label: "Used", width: "minmax(260px, 2fr)",
    render: (it) => {
      const text = quantityMapText(it.status?.used);
      return text ? mono(text) : dash();
    },
    sortValue: (it) => quantityMapText(it.status?.used),
  },
  {
    key: "scopes", label: "Scopes", width: "minmax(160px, 1fr)",
    render: (it) => listCell(it.spec?.scopes ?? []),
    sortValue: (it) => (it.spec?.scopes ?? []).join(","),
  },
  {
    key: "scopeSelector", label: "Scope Selector", width: "minmax(220px, 1.4fr)",
    defaultVisible: false,
    render: (it) => {
      const text = compactList((it.spec?.scopeSelector?.matchExpressions ?? []).map((x: any) =>
        `${x.scopeName} ${x.operator}${x.values?.length ? ` ${x.values.join("|")}` : ""}`,
      ), 12);
      return text ? mono(text) : dash();
    },
  },
  ageCol,
];

const limitRangeColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "types", label: "Types", width: "minmax(160px, 1fr)",
    render: (it) => listCell((it.spec?.limits ?? []).map((x: any) => x.type)),
    sortValue: (it) => (it.spec?.limits ?? []).map((x: any) => x.type).join(","),
  },
  {
    key: "min", label: "Min", width: "minmax(220px, 1.5fr)",
    render: (it) => listCell((it.spec?.limits ?? []).map((x: any) => quantityMapText(x.min)).filter(Boolean)),
  },
  {
    key: "max", label: "Max", width: "minmax(220px, 1.5fr)",
    render: (it) => listCell((it.spec?.limits ?? []).map((x: any) => quantityMapText(x.max)).filter(Boolean)),
  },
  {
    key: "default", label: "Default", width: "minmax(220px, 1.5fr)",
    render: (it) => listCell((it.spec?.limits ?? []).map((x: any) => quantityMapText(x.default)).filter(Boolean)),
  },
  {
    key: "defaultRequest", label: "Default Request", width: "minmax(220px, 1.5fr)",
    defaultVisible: false,
    render: (it) => listCell((it.spec?.limits ?? []).map((x: any) => quantityMapText(x.defaultRequest)).filter(Boolean)),
  },
  {
    key: "ratio", label: "Max Limit/Request", width: "minmax(220px, 1.5fr)",
    defaultVisible: false,
    render: (it) => listCell((it.spec?.limits ?? []).map((x: any) => quantityMapText(x.maxLimitRequestRatio)).filter(Boolean)),
  },
  ageCol,
];

const hpaColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "reference", label: "Reference", width: "minmax(220px, 1.5fr)",
    render: (it) => {
      const ref = it.spec?.scaleTargetRef;
      return ref ? mono(`${ref.kind}/${ref.name}`) : dash();
    },
    sortValue: (it) => `${it.spec?.scaleTargetRef?.kind ?? ""}/${it.spec?.scaleTargetRef?.name ?? ""}`,
  },
  {
    key: "metrics", label: "Metrics", width: "minmax(220px, 1.5fr)",
    render: (it) => listCell((it.spec?.metrics ?? []).map((m: any) =>
      m.resource?.name ?? m.pods?.metric?.name ?? m.object?.metric?.name ?? m.external?.metric?.name ?? m.type,
    )),
  },
  {
    key: "minPods", label: "Min Pods", width: "90px", align: "right",
    render: (it) => mono(it.spec?.minReplicas ?? 1),
    sortValue: (it) => it.spec?.minReplicas ?? 1,
  },
  {
    key: "maxPods", label: "Max Pods", width: "90px", align: "right",
    render: (it) => mono(it.spec?.maxReplicas ?? 0),
    sortValue: (it) => it.spec?.maxReplicas ?? 0,
  },
  {
    key: "replicas", label: "Replicas", width: "110px", align: "center",
    render: (it) => mono(`${it.status?.currentReplicas ?? 0}/${it.status?.desiredReplicas ?? 0}`),
    sortValue: (it) => it.status?.desiredReplicas ?? 0,
  },
  {
    key: "conditions", label: "Conditions", width: "minmax(220px, 1.5fr)",
    render: (it) => <ConditionsCell it={it} />,
    sortValue: conditionText,
  },
  ageCol,
];

const pdbColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "minAvailable", label: "Min Available", width: "120px", align: "right",
    render: (it) => mono(it.spec?.minAvailable ?? "-"),
    sortValue: (it) => it.spec?.minAvailable ?? "",
  },
  {
    key: "maxUnavailable", label: "Max Unavailable", width: "140px", align: "right",
    render: (it) => mono(it.spec?.maxUnavailable ?? "-"),
    sortValue: (it) => it.spec?.maxUnavailable ?? "",
  },
  {
    key: "allowed", label: "Allowed Disruptions", width: "150px", align: "right",
    render: (it) => mono(it.status?.disruptionsAllowed ?? 0),
    sortValue: (it) => it.status?.disruptionsAllowed ?? 0,
  },
  {
    key: "currentHealthy", label: "Current Healthy", width: "130px", align: "right",
    render: (it) => mono(it.status?.currentHealthy ?? 0),
    sortValue: (it) => it.status?.currentHealthy ?? 0,
  },
  {
    key: "desiredHealthy", label: "Desired Healthy", width: "130px", align: "right",
    render: (it) => mono(it.status?.desiredHealthy ?? 0),
    sortValue: (it) => it.status?.desiredHealthy ?? 0,
  },
  {
    key: "expectedPods", label: "Expected Pods", width: "120px", align: "right",
    defaultVisible: false,
    render: (it) => mono(it.status?.expectedPods ?? 0),
    sortValue: (it) => it.status?.expectedPods ?? 0,
  },
  {
    key: "selector", label: "Selector", width: "minmax(240px, 1.8fr)",
    render: (it) => labelsCell(it.spec?.selector?.matchLabels),
    sortValue: (it) => labelsText(it.spec?.selector?.matchLabels),
  },
  ageCol,
];

const priorityClassColumns: Column[] = [
  nameCol,
  {
    key: "value", label: "Value", width: "140px", align: "right",
    render: (it) => mono(it.value ?? 0),
    sortValue: (it: any) => it.value ?? 0,
  },
  {
    key: "globalDefault", label: "Global Default", width: "140px", align: "center",
    render: (it: any) => it.globalDefault ? badge("True", "info") : badge("False", "mute"),
    sortValue: (it: any) => it.globalDefault ? 1 : 0,
  },
  {
    key: "preemption", label: "Preemption Policy", width: "minmax(180px, 1fr)",
    render: (it: any) => mono(it.preemptionPolicy ?? "PreemptLowerPriority"),
    sortValue: (it: any) => it.preemptionPolicy ?? "",
  },
  {
    key: "description", label: "Description", width: "minmax(300px, 2fr)",
    render: (it: any) => it.description ? <span className="text-fg-soft truncate" title={it.description}>{it.description}</span> : dash(),
    sortValue: (it: any) => it.description ?? "",
  },
  ageCol,
];

const runtimeClassColumns: Column[] = [
  nameCol,
  {
    key: "handler", label: "Handler", width: "minmax(180px, 1fr)",
    render: (it) => mono(it.handler ?? "-"),
    sortValue: (it: any) => it.handler ?? "",
  },
  {
    key: "overhead", label: "Overhead", width: "minmax(220px, 1.4fr)",
    render: (it) => {
      const text = quantityMapText(it.overhead?.podFixed);
      return text ? mono(text) : dash();
    },
  },
  {
    key: "nodeSelector", label: "Node Selector", width: "minmax(240px, 1.6fr)",
    render: (it) => labelsCell(it.scheduling?.nodeSelector),
    sortValue: (it: any) => labelsText(it.scheduling?.nodeSelector),
  },
  {
    key: "tolerations", label: "Tolerations", width: "110px", align: "right",
    defaultVisible: false,
    render: (it) => mono((it.scheduling?.tolerations ?? []).length),
    sortValue: (it: any) => (it.scheduling?.tolerations ?? []).length,
  },
  ageCol,
];

const leaseColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "holder", label: "Holder", width: "minmax(280px, 2fr)",
    render: (it) => mono(it.spec?.holderIdentity ?? "-"),
    sortValue: (it) => it.spec?.holderIdentity ?? "",
  },
  {
    key: "renewTime", label: "Renew Time", width: "130px", align: "right",
    render: (it) => <AgeCell stamp={it.spec?.renewTime} />,
    sortValue: (it) => -new Date(it.spec?.renewTime ?? 0).getTime(),
  },
  {
    key: "duration", label: "Duration", width: "100px", align: "right",
    render: (it) => mono(it.spec?.leaseDurationSeconds ? `${it.spec.leaseDurationSeconds}s` : "-"),
    sortValue: (it) => it.spec?.leaseDurationSeconds ?? 0,
  },
  {
    key: "transitions", label: "Transitions", width: "110px", align: "right",
    defaultVisible: false,
    render: (it) => mono(it.spec?.leaseTransitions ?? 0),
    sortValue: (it) => it.spec?.leaseTransitions ?? 0,
  },
  ageCol,
];

const richServiceColumns: Column[] = [
  nameCol, namespaceCol,
  { key: "type", label: "Type", width: "120px",
    render: (it) => mono(it.spec?.type ?? "ClusterIP"),
    sortValue: (it) => it.spec?.type ?? "",
  },
  { key: "clusterIP", label: "Cluster IP", width: "140px",
    render: (it) => mono(it.spec?.clusterIP || "-"),
    sortValue: (it) => it.spec?.clusterIP ?? "",
  },
  { key: "ports", label: "Ports", width: "minmax(220px, 2fr)",
    render: (it) => {
      const text = portsText(it.spec?.ports);
      return text ? mono(text) : dash();
    },
    sortValue: (it) => portsText(it.spec?.ports),
  },
  { key: "externalIP", label: "External IP", width: "minmax(160px, 1.2fr)",
    render: (it) => {
      const text = serviceExternalIPs(it);
      return text ? mono(text) : dash();
    },
    sortValue: serviceExternalIPs,
  },
  { key: "selector", label: "Selector", width: "minmax(260px, 2fr)",
    render: (it) => labelsCell(it.spec?.selector),
    sortValue: (it) => labelsText(it.spec?.selector),
  },
  { key: "sessionAffinity", label: "Session Affinity", width: "140px", defaultVisible: false,
    render: (it) => mono(it.spec?.sessionAffinity ?? "None"),
    sortValue: (it) => it.spec?.sessionAffinity ?? "",
  },
  { key: "ipFamilies", label: "IP Families", width: "130px", defaultVisible: false,
    render: (it) => listCell(it.spec?.ipFamilies ?? []),
    sortValue: (it) => (it.spec?.ipFamilies ?? []).join(","),
  },
  ageCol,
];

const endpointSliceColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "service", label: "Service", width: "minmax(180px, 1.2fr)",
    render: (it) => mono(it.metadata?.labels?.["kubernetes.io/service-name"] ?? "-"),
    sortValue: (it) => it.metadata?.labels?.["kubernetes.io/service-name"] ?? "",
  },
  {
    key: "addressType", label: "Address Type", width: "120px",
    render: (it) => mono(it.addressType ?? "-"),
    sortValue: (it: any) => it.addressType ?? "",
  },
  {
    key: "ready", label: "Ready", width: "90px", align: "center",
    render: (it) => mono(endpointReadyCount(it)),
    sortValue: (it) => Number(endpointReadyCount(it).split("/")[0] ?? 0),
  },
  {
    key: "addresses", label: "Addresses", width: "minmax(320px, 2.4fr)",
    render: (it) => listCell(endpointSliceAddresses(it), 24),
    sortValue: (it) => endpointSliceAddresses(it).join(","),
  },
  {
    key: "ports", label: "Ports", width: "minmax(160px, 1.4fr)",
    render: (it) => {
      const text = portsText(it.ports);
      return text ? mono(text) : dash();
    },
    sortValue: (it: any) => portsText(it.ports),
  },
  ageCol,
];

const richIngressColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "class", label: "Class", width: "140px",
    render: (it) => mono(it.spec?.ingressClassName ?? "-"),
    sortValue: (it) => it.spec?.ingressClassName ?? "",
  },
  {
    key: "hosts", label: "Hosts", width: "minmax(260px, 2fr)",
    render: (it) => listCell((it.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean), 24),
    sortValue: (it) => (it.spec?.rules ?? []).map((r: any) => r.host).join(","),
  },
  {
    key: "address", label: "Address", width: "minmax(180px, 1.2fr)",
    render: (it) => {
      const text = ingressAddresses(it);
      return text ? mono(text) : dash();
    },
    sortValue: ingressAddresses,
  },
  {
    key: "rules", label: "Rules", width: "minmax(300px, 2.4fr)",
    defaultVisible: false,
    render: (it) => {
      const text = ingressRules(it);
      return text ? mono(text) : dash();
    },
    sortValue: ingressRules,
  },
  {
    key: "tls", label: "TLS", width: "120px", align: "right",
    render: (it) => mono((it.spec?.tls ?? []).length),
    sortValue: (it) => (it.spec?.tls ?? []).length,
  },
  ageCol,
];

const networkPolicyColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "podSelector", label: "Pod Selector", width: "minmax(260px, 2fr)",
    render: (it) => labelsCell(it.spec?.podSelector?.matchLabels),
    sortValue: (it) => labelsText(it.spec?.podSelector?.matchLabels),
  },
  {
    key: "policyTypes", label: "Policy Types", width: "minmax(160px, 1fr)",
    render: (it) => listCell(it.spec?.policyTypes ?? []),
    sortValue: (it) => (it.spec?.policyTypes ?? []).join(","),
  },
  {
    key: "ingress", label: "Ingress Rules", width: "120px", align: "right",
    render: (it) => mono(networkPolicyRuleCount(it.spec?.ingress)),
    sortValue: (it) => networkPolicyRuleCount(it.spec?.ingress),
  },
  {
    key: "egress", label: "Egress Rules", width: "120px", align: "right",
    render: (it) => mono(networkPolicyRuleCount(it.spec?.egress)),
    sortValue: (it) => networkPolicyRuleCount(it.spec?.egress),
  },
  ageCol,
];

const pvColumns: Column[] = [
  nameCol,
  {
    key: "status", label: "Status", width: "110px",
    render: (it) => badge(it.status?.phase ?? "-", it.status?.phase === "Bound" ? "ok" : "warn"),
    sortValue: (it) => it.status?.phase ?? "",
  },
  {
    key: "capacity", label: "Capacity", width: "110px", align: "right",
    render: (it) => mono(it.spec?.capacity?.storage ?? "-"),
    sortValue: (it) => it.spec?.capacity?.storage ?? "",
  },
  {
    key: "accessModes", label: "Access Modes", width: "140px",
    render: (it) => listCell(accessModes(it)),
    sortValue: (it) => accessModes(it).join(","),
  },
  {
    key: "reclaimPolicy", label: "Reclaim Policy", width: "140px",
    render: (it) => mono(it.spec?.persistentVolumeReclaimPolicy ?? "-"),
    sortValue: (it) => it.spec?.persistentVolumeReclaimPolicy ?? "",
  },
  {
    key: "storageClass", label: "Storage Class", width: "minmax(160px, 1fr)",
    render: (it) => {
      const sc = it.spec?.storageClassName;
      if (!sc) return dash();
      return (
        <LinkCell
          target={{ group: "storage.k8s.io", version: "v1", resource: "storageclasses", name: sc }}
          title={sc}
          className="font-mono text-xs"
        >
          {sc}
        </LinkCell>
      );
    },
    sortValue: (it) => it.spec?.storageClassName ?? "",
  },
  {
    key: "claim", label: "Claim", width: "minmax(220px, 1.4fr)",
    render: (it) => {
      const ref = it.spec?.claimRef;
      if (!ref?.name || !ref?.namespace) return dash();
      return (
        <LinkCell
          target={{ group: "core", version: "v1", resource: "persistentvolumeclaims",
                    namespace: ref.namespace, name: ref.name }}
          title={`${ref.namespace}/${ref.name}`}
          className="font-mono text-xs"
        >
          {ref.namespace}/{ref.name}
        </LinkCell>
      );
    },
    sortValue: claimRefText,
  },
  {
    key: "volumeMode", label: "Volume Mode", width: "120px", defaultVisible: false,
    render: (it) => mono(it.spec?.volumeMode ?? "-"),
    sortValue: (it) => it.spec?.volumeMode ?? "",
  },
  ageCol,
];

const richPvcColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "status", label: "Status", width: "110px",
    render: (it) => badge(it.status?.phase ?? "-", it.status?.phase === "Bound" ? "ok" : "warn"),
    sortValue: (it) => it.status?.phase ?? "",
  },
  {
    key: "volume", label: "Volume", width: "minmax(180px, 1.2fr)",
    render: (it) => {
      const v = it.spec?.volumeName;
      if (!v) return dash();
      return (
        <LinkCell
          target={{ group: "core", version: "v1", resource: "persistentvolumes", name: v }}
          title={v}
          className="font-mono text-xs"
        >
          {v}
        </LinkCell>
      );
    },
    sortValue: (it) => it.spec?.volumeName ?? "",
  },
  {
    key: "capacity", label: "Capacity", width: "110px", align: "right",
    render: (it) => mono(it.status?.capacity?.storage ?? it.spec?.resources?.requests?.storage ?? "-"),
    sortValue: (it) => it.status?.capacity?.storage ?? it.spec?.resources?.requests?.storage ?? "",
  },
  {
    key: "accessModes", label: "Access Modes", width: "140px",
    render: (it) => listCell(accessModes(it)),
    sortValue: (it) => accessModes(it).join(","),
  },
  {
    key: "storageClass", label: "Storage Class", width: "minmax(160px, 1fr)",
    render: (it) => {
      const sc = it.spec?.storageClassName;
      if (!sc) return dash();
      return (
        <LinkCell
          target={{ group: "storage.k8s.io", version: "v1", resource: "storageclasses", name: sc }}
          title={sc}
          className="font-mono text-xs"
        >
          {sc}
        </LinkCell>
      );
    },
    sortValue: (it) => it.spec?.storageClassName ?? "",
  },
  {
    key: "volumeMode", label: "Volume Mode", width: "120px", defaultVisible: false,
    render: (it) => mono(it.spec?.volumeMode ?? "-"),
    sortValue: (it) => it.spec?.volumeMode ?? "",
  },
  ageCol,
];

const storageClassColumns: Column[] = [
  nameCol,
  {
    key: "provisioner", label: "Provisioner", width: "minmax(260px, 2fr)",
    render: (it) => mono(it.provisioner ?? "-"),
    sortValue: (it: any) => it.provisioner ?? "",
  },
  {
    key: "reclaimPolicy", label: "Reclaim Policy", width: "140px",
    render: (it) => mono(it.reclaimPolicy ?? "Delete"),
    sortValue: (it: any) => it.reclaimPolicy ?? "",
  },
  {
    key: "bindingMode", label: "Binding Mode", width: "180px",
    render: (it) => mono(it.volumeBindingMode ?? "-"),
    sortValue: (it: any) => it.volumeBindingMode ?? "",
  },
  {
    key: "allowExpansion", label: "Allow Expansion", width: "140px", align: "center",
    render: (it: any) => it.allowVolumeExpansion ? badge("True", "info") : badge("False", "mute"),
    sortValue: (it: any) => it.allowVolumeExpansion ? 1 : 0,
  },
  {
    key: "default", label: "Default", width: "100px", align: "center",
    render: (it) => isDefaultStorageClass(it) ? badge("True", "info") : badge("False", "mute"),
    sortValue: (it) => isDefaultStorageClass(it) ? 1 : 0,
  },
  ageCol,
];

const serviceAccountColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "secrets", label: "Secrets", width: "90px", align: "right",
    render: (it) => mono((it.secrets ?? []).length),
    sortValue: (it: any) => (it.secrets ?? []).length,
  },
  {
    key: "imagePullSecrets", label: "Image Pull Secrets", width: "minmax(220px, 1.6fr)",
    render: (it: any) => listCell((it.imagePullSecrets ?? []).map((s: any) => s.name)),
    sortValue: (it: any) => (it.imagePullSecrets ?? []).map((s: any) => s.name).join(","),
  },
  {
    key: "labels", label: "Labels", width: "minmax(260px, 2fr)", defaultVisible: false,
    render: (it) => labelsCell(it.metadata?.labels),
    sortValue: (it) => labelsText(it.metadata?.labels),
  },
  ageCol,
];

const roleColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "rules", label: "Rules", width: "80px", align: "right",
    render: (it) => mono(rulesOf(it).length),
    sortValue: (it) => rulesOf(it).length,
  },
  {
    key: "resources", label: "Resources", width: "minmax(260px, 2fr)",
    render: (it) => listCell(ruleResources(it)),
    sortValue: (it) => ruleResources(it).join(","),
  },
  {
    key: "verbs", label: "Verbs", width: "minmax(220px, 1.6fr)",
    render: (it) => listCell(ruleVerbs(it)),
    sortValue: (it) => ruleVerbs(it).join(","),
  },
  {
    key: "apiGroups", label: "API Groups", width: "minmax(180px, 1.2fr)", defaultVisible: false,
    render: (it) => listCell(ruleApiGroups(it).map((g) => g || "core")),
    sortValue: (it) => ruleApiGroups(it).join(","),
  },
  ageCol,
];

const clusterRoleColumns: Column[] = roleColumns.filter((c) => c.key !== "namespace");

const roleBindingColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "role", label: "Role", width: "minmax(220px, 1.4fr)",
    render: (it) => it.roleRef ? mono(`${it.roleRef.kind}/${it.roleRef.name}`) : dash(),
    sortValue: (it) => `${it.roleRef?.kind ?? ""}/${it.roleRef?.name ?? ""}`,
  },
  {
    key: "subjects", label: "Subjects", width: "minmax(320px, 2.4fr)",
    render: (it) => {
      const text = subjectsText(it);
      return text ? mono(text) : dash();
    },
    sortValue: subjectsText,
  },
  ageCol,
];

const clusterRoleBindingColumns: Column[] = roleBindingColumns.filter((c) => c.key !== "namespace");

const webhookConfigColumns: Column[] = [
  nameCol,
  {
    key: "webhooks", label: "Webhooks", width: "minmax(80px, 100px)", align: "right",
    render: (it: any) => mono((it.webhooks ?? []).length),
    sortValue: (it: any) => (it.webhooks ?? []).length,
  },
  {
    key: "names", label: "Hook Names", width: "minmax(220px, 2.4fr)",
    render: (it: any) => listCell((it.webhooks ?? []).map((w: any) => w?.name).filter(Boolean)),
    sortValue: (it: any) => (it.webhooks ?? []).map((w: any) => w?.name).join(","),
  },
  {
    key: "services", label: "Services", width: "minmax(220px, 2fr)",
    render: (it: any) => {
      const svcs = (it.webhooks ?? [])
        .map((w: any) => w?.clientConfig?.service)
        .filter(Boolean)
        .map((s: any) => `${s.namespace}/${s.name}`);
      return listCell([...new Set(svcs)] as string[]);
    },
  },
  ageCol,
];

const csiDriverColumns: Column[] = [
  nameCol,
  {
    key: "attachRequired", label: "Attach Required", width: "140px", align: "center",
    render: (it) => yesNo(it.spec?.attachRequired),
    sortValue: (it) => booleanSort(it.spec?.attachRequired),
  },
  {
    key: "podInfoOnMount", label: "Pod Info On Mount", width: "160px", align: "center",
    render: (it) => yesNo(it.spec?.podInfoOnMount),
    sortValue: (it) => booleanSort(it.spec?.podInfoOnMount),
  },
  {
    key: "modes", label: "Volume Modes", width: "minmax(160px, 1.4fr)",
    render: (it) => listCell(((it.spec?.volumeLifecycleModes ?? []) as string[])),
    sortValue: (it) => ((it.spec?.volumeLifecycleModes ?? []) as string[]).join(","),
  },
  {
    key: "fsGroupPolicy", label: "FS Group Policy", width: "140px", defaultVisible: false,
    render: (it) => mono(it.spec?.fsGroupPolicy ?? "—"),
    sortValue: (it) => it.spec?.fsGroupPolicy ?? "",
  },
  ageCol,
];

const csiNodeColumns: Column[] = [
  nameCol,
  {
    key: "drivers", label: "Drivers", width: "100px", align: "right",
    render: (it) => mono((it.spec?.drivers ?? []).length),
    sortValue: (it) => (it.spec?.drivers ?? []).length,
  },
  {
    key: "names", label: "Driver Names", width: "minmax(220px, 2.4fr)",
    render: (it) => listCell(((it.spec?.drivers ?? []) as any[]).map((d) => d?.name).filter(Boolean)),
    sortValue: (it) => ((it.spec?.drivers ?? []) as any[]).map((d) => d?.name).join(","),
  },
  ageCol,
];

const ingressClassColumns: Column[] = [
  nameCol,
  {
    key: "controller", label: "Controller", width: "minmax(220px, 2fr)",
    render: (it) => mono(it.spec?.controller ?? "—"),
    sortValue: (it) => it.spec?.controller ?? "",
  },
  {
    key: "params", label: "Parameters", width: "minmax(160px, 1.4fr)",
    render: (it) => {
      const p = it.spec?.parameters;
      if (!p?.kind || !p?.name) return dash();
      return mono(`${p.kind}/${p.name}`);
    },
    sortValue: (it) => `${it.spec?.parameters?.kind ?? ""}/${it.spec?.parameters?.name ?? ""}`,
  },
  {
    key: "default", label: "Default", width: "100px", align: "center",
    render: (it) => yesNo(it.metadata?.annotations?.["ingressclass.kubernetes.io/is-default-class"] === "true"),
    sortValue: (it) => booleanSort(it.metadata?.annotations?.["ingressclass.kubernetes.io/is-default-class"] === "true"),
  },
  ageCol,
];

const replicationControllerColumns: Column[] = [
  nameCol, namespaceCol,
  {
    key: "ready", label: "Ready", width: "90px", align: "center",
    render: (it) => {
      const r = Number(it.status?.readyReplicas ?? 0);
      const d = Number(it.spec?.replicas ?? it.status?.replicas ?? 0);
      return <span className={clsx("font-mono text-xs", r === d ? "text-ok" : "text-warn")}>{r}/{d}</span>;
    },
    sortValue: (it) => Number(it.status?.readyReplicas ?? 0),
  },
  {
    key: "current", label: "Current", width: "90px", align: "right",
    render: (it) => mono(it.status?.replicas ?? 0),
    sortValue: (it) => Number(it.status?.replicas ?? 0),
  },
  {
    key: "available", label: "Available", width: "100px", align: "right",
    render: (it) => mono(it.status?.availableReplicas ?? 0),
    sortValue: (it) => Number(it.status?.availableReplicas ?? 0),
  },
  {
    key: "selector", label: "Selector", width: "minmax(180px, 1.4fr)",
    defaultVisible: false,
    render: (it) => mono(labelsText(it.spec?.selector ?? {}, 3)),
    sortValue: (it) => labelsText(it.spec?.selector ?? {}, 3),
  },
  ageCol,
];

const defaultColumns: Column[] = [nameCol, namespaceCol, ageCol];

const REGISTRY: Record<string, Column[]> = {
  "/v1/Pod": podColumns,
  "/v1/ReplicationController": replicationControllerColumns,
  "/v1/Service": richServiceColumns,
  "/v1/Node": nodeColumns,
  "/v1/Namespace": namespaceColumns,
  "/v1/Event": eventColumns,
  "/v1/PersistentVolume": pvColumns,
  "/v1/PersistentVolumeClaim": richPvcColumns,
  "/v1/ServiceAccount": serviceAccountColumns,
  "/v1/ConfigMap": configMapColumns,
  "/v1/Secret": secretColumns,
  "/v1/ResourceQuota": resourceQuotaColumns,
  "/v1/LimitRange": limitRangeColumns,
  "apiextensions.k8s.io/v1/CustomResourceDefinition": crdColumns,
  "apps/v1/Deployment": deploymentColumns,
  "apps/v1/StatefulSet": statefulSetColumns,
  "apps/v1/DaemonSet": daemonSetColumns,
  "apps/v1/ReplicaSet": replicaSetColumns,
  "autoscaling/v2/HorizontalPodAutoscaler": hpaColumns,
  "batch/v1/Job": jobColumns,
  "batch/v1/CronJob": cronJobColumns,
  "coordination.k8s.io/v1/Lease": leaseColumns,
  "discovery.k8s.io/v1/EndpointSlice": endpointSliceColumns,
  "networking.k8s.io/v1/Ingress": richIngressColumns,
  "networking.k8s.io/v1/IngressClass": ingressClassColumns,
  "networking.k8s.io/v1/NetworkPolicy": networkPolicyColumns,
  "node.k8s.io/v1/RuntimeClass": runtimeClassColumns,
  "policy/v1/PodDisruptionBudget": pdbColumns,
  "rbac.authorization.k8s.io/v1/ClusterRole": clusterRoleColumns,
  "rbac.authorization.k8s.io/v1/ClusterRoleBinding": clusterRoleBindingColumns,
  "rbac.authorization.k8s.io/v1/Role": roleColumns,
  "rbac.authorization.k8s.io/v1/RoleBinding": roleBindingColumns,
  "scheduling.k8s.io/v1/PriorityClass": priorityClassColumns,
  "storage.k8s.io/v1/StorageClass": storageClassColumns,
  "storage.k8s.io/v1/CSIDriver": csiDriverColumns,
  "storage.k8s.io/v1/CSINode": csiNodeColumns,
  "admissionregistration.k8s.io/v1/MutatingWebhookConfiguration": webhookConfigColumns,
  "admissionregistration.k8s.io/v1/ValidatingWebhookConfiguration": webhookConfigColumns,
};

export function columnsFor(gvr: string): Column[] {
  const cols = REGISTRY[gvr] ?? defaultColumns;
  // Swap the placeholder name column for one that knows its gvr and renders
  // the inline issue badge. The static `nameCol` is just a template — every
  // resource list ends up with a gvr-aware name cell here.
  return cols.map((c) => c.key === "name" && c === nameCol ? nameColumnFor(gvr) : c);
}
