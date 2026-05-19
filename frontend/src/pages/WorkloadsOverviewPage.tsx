// WorkloadsOverviewPage — donut rings for every workload kind plus the most
// recent events. Lives at /:cluster/workloads. The cluster-level metric
// summary (node CPU/memory) is on the sibling /:cluster/overview page.

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { MoreVertical } from "lucide-react";
import { useApp } from "../stores/app";
import { Item, useResourceList } from "../lib/useResourceList";
import { age } from "../lib/format";
import { hrefToQuery } from "../components/DetailPanel";
import { podDisplayStatus } from "../lib/podStatus";
import { WorkloadTabsBar } from "../components/WorkloadTabsBar";

type StatusKind = "ok" | "warn" | "bad" | "info" | "mute";

type StatusCount = {
  label: string;
  count: number;
  kind: StatusKind;
};

type WorkloadSummary = {
  label: string;
  route: string;
  total: number;
  parts: StatusCount[];
  error?: string | null;
};

type EventItem = Item & {
  type?: string;
  message?: string;
  reason?: string;
  count?: number;
  series?: { count?: number; lastObservedTime?: string };
  eventTime?: string;
  lastTimestamp?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  source?: { component?: string; host?: string };
  reportingController?: string;
  reportedBy?: string;
};

export function WorkloadsOverviewPage() {
  const cluster = useApp((s) => s.cluster);
  const namespace = useApp((s) => s.namespace);
  const namespaces = useApp((s) => s.namespaces);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const selectedNamespaces = namespaces.length > 0 ? namespaces : (namespace ? [namespace] : []);
  const ns = selectedNamespaces.length > 0 ? selectedNamespaces : undefined;
  const namespaceLabel = selectedNamespaces.length === 0
    ? "All namespaces"
    : selectedNamespaces.length === 1
      ? selectedNamespaces[0]
      : `${selectedNamespaces.length} namespaces`;

  const openInPanel = (href: string) => {
    const ref = hrefToQuery(href);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", ref);
      return next;
    });
  };

  const pods = useResourceList(cluster, "/v1/Pod", ns);
  const deployments = useResourceList(cluster, "apps/v1/Deployment", ns);
  const daemonSets = useResourceList(cluster, "apps/v1/DaemonSet", ns);
  const statefulSets = useResourceList(cluster, "apps/v1/StatefulSet", ns);
  const replicaSets = useResourceList(cluster, "apps/v1/ReplicaSet", ns);
  const jobs = useResourceList(cluster, "batch/v1/Job", ns);
  const cronJobs = useResourceList(cluster, "batch/v1/CronJob", ns);
  const events = useResourceList(cluster, "/v1/Event", ns);

  const summaries = useMemo<WorkloadSummary[]>(() => [
    {
      label: "Pods", route: "pods",
      total: pods.items.length,
      parts: podStatusCounts(pods.items),
      error: pods.error,
    },
    {
      label: "Deployments", route: "deployments",
      total: deployments.items.length,
      parts: controllerStatusCounts(deployments.items, desiredDeployment, readyDeployment),
      error: deployments.error,
    },
    {
      label: "Daemon Sets", route: "daemonsets",
      total: daemonSets.items.length,
      parts: controllerStatusCounts(daemonSets.items, desiredDaemonSet, readyDaemonSet),
      error: daemonSets.error,
    },
    {
      label: "Stateful Sets", route: "statefulsets",
      total: statefulSets.items.length,
      parts: controllerStatusCounts(statefulSets.items, desiredStatefulSet, readyStatefulSet),
      error: statefulSets.error,
    },
    {
      label: "Replica Sets", route: "replicasets",
      total: replicaSets.items.length,
      parts: controllerStatusCounts(replicaSets.items, desiredReplicaSet, readyReplicaSet),
      error: replicaSets.error,
    },
    {
      label: "Jobs", route: "jobs",
      total: jobs.items.length,
      parts: jobStatusCounts(jobs.items),
      error: jobs.error,
    },
    {
      label: "Cron Jobs", route: "cronjobs",
      total: cronJobs.items.length,
      parts: cronJobStatusCounts(cronJobs.items),
      error: cronJobs.error,
    },
  ], [
    pods.items, pods.error,
    deployments.items, deployments.error,
    daemonSets.items, daemonSets.error,
    statefulSets.items, statefulSets.error,
    replicaSets.items, replicaSets.error,
    jobs.items, jobs.error,
    cronJobs.items, cronJobs.error,
  ]);

  const eventRows = useMemo(() => (events.items as EventItem[])
    .slice()
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, 10), [events.items]);

  const eventTotal = events.total;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <WorkloadTabsBar cluster={cluster} activeRoute="workloads" />

      <div className="flex-1 min-h-0 overflow-auto p-4">
        <section className="border border-line bg-bg-soft">
          <div className="h-14 flex items-center gap-3 px-4 border-b border-line">
            <h1 className="text-sm text-fg-soft font-medium">Overview</h1>
            <span className="ml-auto chip normal-case">{namespaceLabel}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 divide-y sm:divide-y-0 sm:divide-x divide-line/60">
            {summaries.map((summary) => (
              <WorkloadRing
                key={summary.route}
                summary={summary}
                onOpen={() => navigate(clusterHref(cluster, summary.route))}
              />
            ))}
          </div>
        </section>

        <section className="mt-4 border border-line bg-bg-soft">
          <div className="h-14 flex items-center gap-3 px-4 border-b border-line">
            <h2 className="text-sm text-fg-soft font-medium">Events</h2>
            <span className="text-xs text-fg-mute">
              ({eventRows.length} of {eventTotal.toLocaleString()})
            </span>
            {events.error && <span className="text-xs text-bad">{events.error}</span>}
            <button
              type="button"
              className="ml-auto text-xs text-accent hover:underline"
              onClick={() => navigate(clusterHref(cluster, "events"))}
            >
              View all events →
            </button>
          </div>
          <EventsTable cluster={cluster} events={eventRows} onOpen={openInPanel} />
        </section>
      </div>
    </div>
  );
}

function WorkloadRing({ summary, onOpen }: { summary: WorkloadSummary; onOpen: () => void }) {
  const visibleParts = summary.parts.filter((p) => p.count > 0);
  return (
    <div className="min-h-[260px] px-5 py-4 flex flex-col items-center">
      <button className="text-sm text-accent hover:underline underline-offset-2" onClick={onOpen}>
        {summary.label} ({summary.total.toLocaleString()})
      </button>
      <button
        className="relative mt-4 h-28 w-28 rounded-full shrink-0"
        style={{ background: ringGradient(summary.parts, summary.total) }}
        onClick={onOpen}
        aria-label={`Open ${summary.label}`}
      >
        <span className="absolute inset-[8px] rounded-full bg-bg-soft" />
      </button>
      <div className="mt-5 w-full max-w-[150px] space-y-3">
        {summary.error && (
          <div className="text-xs text-bad text-center">{summary.error}</div>
        )}
        {!summary.error && visibleParts.length === 0 && (
          <div className="text-xs text-fg-mute text-center">No items</div>
        )}
        {visibleParts.map((part) => (
          <div key={part.label} className="flex items-center justify-center gap-2 text-xs text-fg-soft">
            <span className={clsx("h-2 w-2 rounded-sm", dotClass(part.kind))} />
            <span>{part.label}: {part.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventsTable({
  cluster, events, onOpen,
}: {
  cluster: string;
  events: EventItem[];
  onOpen: (href: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1380px] text-sm table-fixed">
        <thead>
          <tr className="h-9 text-left text-[11px] uppercase tracking-wide text-fg-mute border-b border-line">
            <th className="px-4 font-medium w-[90px]">Type</th>
            <th className="px-3 font-medium">Message</th>
            <th className="px-3 font-medium w-[140px]">Namespace</th>
            <th className="px-3 font-medium w-[340px]">Involved Object</th>
            <th className="px-3 font-medium w-[180px]">Source</th>
            <th className="px-3 font-medium text-right w-[70px]">Count</th>
            <th className="px-3 font-medium text-right w-[80px]">Age</th>
            <th className="px-3 font-medium text-right w-[100px]">Last Seen</th>
            <th className="px-2 w-9" />
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr>
              <td className="px-4 py-5 text-fg-mute text-sm" colSpan={9}>No events</td>
            </tr>
          )}
          {events.map((event) => {
            const href = involvedHref(event);
            const objLabel = involvedLabel(event);
            return (
              <tr key={event.metadata.uid} className="h-9 border-b border-line/60 hover:bg-bg-mute/60">
                <td className="px-4 text-fg-soft truncate">{event.type ?? "Normal"}</td>
                <td className={clsx(
                  "px-3 truncate",
                  event.type === "Warning" ? "text-bad" : "text-fg-soft",
                )} title={event.message ?? event.reason ?? ""}>
                  {event.message ?? event.reason ?? "-"}
                </td>
                <td className="px-3 text-fg-soft truncate" title={event.metadata.namespace ?? ""}>
                  {event.metadata.namespace ?? "-"}
                </td>
                <td className="px-3" title={objLabel}>
                  {href ? (
                    <button
                      className="text-accent hover:underline block w-full text-left truncate"
                      onClick={() => onOpen(href)}
                    >
                      {objLabel}
                    </button>
                  ) : (
                    <span className="text-fg-soft block truncate">{objLabel}</span>
                  )}
                </td>
                <td className="px-3 text-fg-soft truncate" title={eventSource(event)}>{eventSource(event)}</td>
                <td className="px-3 text-right font-mono text-xs text-fg-soft">{event.count ?? event.series?.count ?? 1}</td>
                <td className="px-3 text-right font-mono text-xs text-fg-mute">{age(event.metadata.creationTimestamp)}</td>
                <td className="px-3 text-right font-mono text-xs text-fg-mute">{age(lastEventTime(event))}</td>
                <td className="px-2 text-center text-fg-mute">
                  <button
                    className="opacity-60 hover:opacity-100 disabled:opacity-20"
                    title={href ? "Open involved object" : `Event in ${cluster}`}
                    disabled={!href}
                    onClick={() => href && onOpen(href)}
                  >
                    <MoreVertical size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function podStatusCounts(items: Item[]): StatusCount[] {
  const counts = new Map<string, StatusCount>();
  for (const pod of items) {
    const status = podDisplayStatus(pod);
    addCount(counts, status.label, status.kind);
  }
  return preferredOrder(counts, ["Running", "Completed", "Succeeded", "Pending", "Terminating", "Failed", "Unknown"]);
}

function controllerStatusCounts(
  items: Item[],
  desiredOf: (it: Item) => number,
  readyOf: (it: Item) => number,
): StatusCount[] {
  const counts = new Map<string, StatusCount>();
  for (const it of items) {
    const desired = desiredOf(it);
    const ready = readyOf(it);
    if (desired === 0) addCount(counts, "Scaled: 0", "mute");
    else if (ready >= desired) addCount(counts, "Running", "ok");
    else if (ready > 0) addCount(counts, "Updating", "warn");
    else addCount(counts, "Pending", "warn");
  }
  return preferredOrder(counts, ["Running", "Updating", "Pending", "Scaled: 0"]);
}

function jobStatusCounts(items: Item[]): StatusCount[] {
  const counts = new Map<string, StatusCount>();
  for (const job of items) {
    if ((job.status?.failed ?? 0) > 0 && (job.status?.active ?? 0) === 0) {
      addCount(counts, "Failed", "bad");
    } else if ((job.status?.succeeded ?? 0) > 0 && (job.status?.active ?? 0) === 0) {
      addCount(counts, "Succeeded", "ok");
    } else if ((job.status?.active ?? 0) > 0) {
      addCount(counts, "Running", "ok");
    } else {
      addCount(counts, "Pending", "warn");
    }
  }
  return preferredOrder(counts, ["Running", "Succeeded", "Pending", "Failed"]);
}

function cronJobStatusCounts(items: Item[]): StatusCount[] {
  const counts = new Map<string, StatusCount>();
  for (const cronJob of items) {
    if (cronJob.spec?.suspend) addCount(counts, "Suspended", "warn");
    else if ((cronJob.status?.active ?? []).length > 0) addCount(counts, "Running", "ok");
    else addCount(counts, "Scheduled", "info");
  }
  return preferredOrder(counts, ["Running", "Scheduled", "Suspended"]);
}

function desiredDeployment(it: Item): number { return it.spec?.replicas ?? it.status?.replicas ?? 0; }
function readyDeployment(it: Item): number   { return it.status?.readyReplicas ?? it.status?.availableReplicas ?? 0; }
function desiredDaemonSet(it: Item): number  { return it.status?.desiredNumberScheduled ?? 0; }
function readyDaemonSet(it: Item): number    { return it.status?.numberReady ?? 0; }
function desiredStatefulSet(it: Item): number { return it.spec?.replicas ?? it.status?.replicas ?? 0; }
function readyStatefulSet(it: Item): number  { return it.status?.readyReplicas ?? 0; }
function desiredReplicaSet(it: Item): number { return it.spec?.replicas ?? it.status?.replicas ?? 0; }
function readyReplicaSet(it: Item): number   { return it.status?.readyReplicas ?? it.status?.availableReplicas ?? 0; }

function addCount(counts: Map<string, StatusCount>, label: string, kind: StatusKind) {
  const current = counts.get(label);
  if (current) { current.count += 1; return; }
  counts.set(label, { label, kind, count: 1 });
}

function preferredOrder(counts: Map<string, StatusCount>, order: string[]): StatusCount[] {
  const out: StatusCount[] = [];
  for (const label of order) {
    const item = counts.get(label);
    if (item) out.push(item);
  }
  for (const item of counts.values()) {
    if (!order.includes(item.label)) out.push(item);
  }
  return out;
}

function ringGradient(parts: StatusCount[], total: number): string {
  if (total <= 0) return "conic-gradient(rgb(var(--bg-mute)) 0deg 360deg)";
  let cursor = 0;
  const segments: string[] = [];
  for (const part of parts) {
    if (part.count <= 0) continue;
    const next = cursor + (part.count / total) * 360;
    segments.push(`${kindColor(part.kind)} ${cursor.toFixed(3)}deg ${next.toFixed(3)}deg`);
    cursor = next;
  }
  if (segments.length === 0) return "conic-gradient(rgb(var(--bg-mute)) 0deg 360deg)";
  if (cursor < 360) segments.push(`rgb(var(--bg-mute)) ${cursor.toFixed(3)}deg 360deg`);
  return `conic-gradient(${segments.join(", ")})`;
}

function kindColor(kind: StatusKind): string {
  switch (kind) {
    case "ok": return "rgb(var(--ok))";
    case "warn": return "rgb(var(--warn))";
    case "bad": return "rgb(var(--bad))";
    case "info": return "rgb(var(--info))";
    default: return "rgb(var(--fg-mute))";
  }
}

function dotClass(kind: StatusKind): string {
  switch (kind) {
    case "ok": return "bg-ok";
    case "warn": return "bg-warn";
    case "bad": return "bg-bad";
    case "info": return "bg-info";
    default: return "bg-fg-mute";
  }
}

function eventTime(event: EventItem): number {
  return new Date(lastEventTime(event) ?? event.metadata.creationTimestamp ?? 0).getTime();
}

function lastEventTime(event: EventItem): string | undefined {
  return event.lastTimestamp ?? event.eventTime ?? event.series?.lastObservedTime ?? event.metadata.creationTimestamp;
}

function involvedLabel(event: EventItem): string {
  const obj = event.involvedObject;
  if (!obj) return "-";
  return `${obj.kind ?? "Object"}: ${obj.name ?? "-"}`;
}

function eventSource(event: EventItem): string {
  const source = event.source;
  if (source?.component && source?.host) return `${source.component} ${source.host}`;
  if (source?.component) return source.component;
  return event.reportingController ?? event.reportedBy ?? "-";
}

function involvedHref(event: EventItem): string | null {
  const obj = event.involvedObject;
  if (!obj?.kind || !obj?.name) return null;
  const map: Record<string, { group: string; version: string; resource: string; namespaced: boolean }> = {
    Pod: { group: "core", version: "v1", resource: "pods", namespaced: true },
    Node: { group: "core", version: "v1", resource: "nodes", namespaced: false },
    Deployment: { group: "apps", version: "v1", resource: "deployments", namespaced: true },
    DaemonSet: { group: "apps", version: "v1", resource: "daemonsets", namespaced: true },
    StatefulSet: { group: "apps", version: "v1", resource: "statefulsets", namespaced: true },
    ReplicaSet: { group: "apps", version: "v1", resource: "replicasets", namespaced: true },
    Job: { group: "batch", version: "v1", resource: "jobs", namespaced: true },
    CronJob: { group: "batch", version: "v1", resource: "cronjobs", namespaced: true },
  };
  const found = map[obj.kind];
  if (!found) return null;
  const name = encodeURIComponent(obj.name);
  if (found.namespaced) {
    const ns = encodeURIComponent(obj.namespace ?? event.metadata.namespace ?? "default");
    return `resource/${found.group}/${found.version}/${found.resource}/ns/${ns}/${name}`;
  }
  return `resource/${found.group}/${found.version}/${found.resource}/${name}`;
}

function clusterHref(cluster: string, href: string): string {
  return `/${encodeURIComponent(cluster)}/${href.replace(/^\/+/, "")}`;
}
