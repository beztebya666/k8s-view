import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { FileCode2, FileText, LogOut, Network, Paperclip, Pause, Play, RefreshCcw, Scale, ScrollText, Search, Terminal, Trash2, X } from "lucide-react";
import { useApp } from "../stores/app";
import { Item, useResourceList } from "../lib/useResourceList";
import { ResourceTable, WarningsToggle, type BulkAction, type Column, type RowAction } from "../components/ResourceTable";
import { columnsFor, issuesFor } from "./columns";
import { api } from "../lib/api";
import { hrefToQuery } from "../components/DetailPanel";
import { useBottomPane, type BottomAction } from "../components/BottomPane";
import { CreateFab } from "../components/CreateFab";
import { modals } from "../components/Modals";
import { usePodMetrics } from "../lib/podMetrics";
import { usePodMetricsStore } from "../lib/podMetricsStore";
import { useEventIndex, eventsForItem, EventIndexContext } from "../lib/eventsIndex";
import { podDisplayStatus, type PodStatusKind } from "../lib/podStatus";
import { notify_ } from "../lib/notifications";
import { WorkloadTabsBar, workloadRouteForGvr } from "../components/WorkloadTabsBar";

const CRD_GVR = "apiextensions.k8s.io/v1/CustomResourceDefinition";

export function ResourceListPage({ title, gvr, namespaced }: { title: string; gvr: string; namespaced: boolean }) {
  const cluster = useApp((s) => s.cluster);
  const [, setSearchParams] = useSearchParams();
  // Pod CPU/memory sparkline columns are gated behind a per-cluster toggle
  // (default off). Strip them out when the user hasn't opted in so the
  // PodMetricsBridge below can also stay dormant on the Pods list.
  const showPodMetrics = useApp((s) => s.getClusterSettings(cluster).showPodMetricsColumns);
  const columns: Column[] = useMemo(() => {
    const all = columnsFor(gvr);
    if (gvr === "/v1/Pod" && !showPodMetrics) {
      return all.filter((c) => c.key !== "cpu" && c.key !== "memory");
    }
    return all;
  }, [gvr, showPodMetrics]);
  const bottom = useBottomPane();
  const [localSearch, setLocalSearch] = useState("");
  const [issuesFirst, setIssuesFirst] = useState(false);
  const [issueCount, setIssueCount] = useState(0);
  // Pod-status chip filter — only relevant on the Pods page. `null` means
  // "no filter, show everything"; otherwise we keep only pods whose
  // computed status kind is in the active set. Lens uses a sidebar
  // dropdown for the same purpose, but inline chips fit our header better.
  const [podStatusFilter, setPodStatusFilter] = useState<Set<PodStatusKind> | null>(null);
  // Secret quick-filter, same idea as the Pod status strip but bucketed
  // by `.type` (TLS / Opaque / Helm / Docker / SA token / Other).
  const [secretTypeFilter, setSecretTypeFilter] = useState<Set<SecretBucket> | null>(null);
  // The Definitions (CRD) list is scoped by the Topbar's Group picker
  // instead of a namespace — CRDs are cluster-scoped and what you want to
  // narrow by is the API group.
  const apiGroup = useApp((s) => s.apiGroup);
  const listFilter = useCallback((it: Item) => {
    if (gvr === "/v1/Pod") {
      return !podStatusFilter || podStatusFilter.has(podDisplayStatus(it).kind);
    }
    if (gvr === "/v1/Secret") {
      return !secretTypeFilter || secretTypeFilter.has(secretBucket(it));
    }
    if (gvr === CRD_GVR) {
      return !apiGroup || ((it as any).spec?.group || "core") === apiGroup;
    }
    return true;
  }, [gvr, podStatusFilter, secretTypeFilter, apiGroup]);
  const hasQuickFilter = gvr === "/v1/Pod" || gvr === "/v1/Secret" || gvr === CRD_GVR;
  // Subscribe to /v1/Event only on rows whose warning badge can actually
  // benefit from kubelet/controller-manager Warning events — that's pods
  // and the workloads that own them. ConfigMaps, Secrets, etc. don't get
  // Warning events worth showing as a row badge.
  const eventsEnabled = wantsEvents(gvr);
  const events = useEventIndex(cluster, eventsEnabled);
  const issueAccessor = useCallback(
    (it: Item) => issuesFor(gvr, it, eventsEnabled ? eventsForItem(events, gvr, it) : []),
    [gvr, events, eventsEnabled],
  );

  // Open the right detail panel for `it`, optionally jumping to a tab.
  const openDetail = useCallback((it: Item, tab?: "yaml" | "events") => {
    const ref = hrefToQuery(detailHref(it, gvr));
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", ref);
      if (tab) next.set("tab", tab);
      else next.delete("tab");
      return next;
    });
  }, [gvr, setSearchParams]);

  // Open the bottom pane (logs/exec/attach) for a pod. Push as a new tab so
  // existing tabs aren't replaced.
  const openBottom = useCallback((it: Item, action: BottomAction, container?: string) => {
    const ns = it.metadata?.namespace ?? "default";
    bottom.push({ action, cluster, namespace: ns, name: it.metadata.name, container });
  }, [bottom, cluster]);

  // Edit YAML lives in the bottom pane too — Lens-style — so the list above
  // stays visible while the user edits and the right detail panel is free
  // for Summary / Events at the same time.
  const openYamlEdit = useCallback((it: Item) => {
    const [g, v, k] = gvr.split("/");
    const ref = { group: g || "core", version: v, resource: pluralise(k) };
    bottom.push({
      action: "yaml",
      cluster,
      namespace: it.metadata?.namespace,
      name: it.metadata.name,
      gvr: `${ref.group}/${ref.version}/${ref.resource}`,
    });
  }, [bottom, cluster, gvr]);

  // Stable references for the table — without these, every keystroke or
  // metrics tick re-renders the table with brand-new prop identities and
  // invalidates every memoized row/cell.
  const eventsCtx = useMemo(
    () => (eventsEnabled ? { index: events, gvr } : null),
    [eventsEnabled, events, gvr],
  );
  const actions = useMemo(
    () => defaultActions(cluster, gvr, openDetail, openBottom, openYamlEdit),
    [cluster, gvr, openDetail, openBottom, openYamlEdit],
  );
  const bulkActions = useMemo(
    () => defaultBulkActions(cluster, gvr),
    [cluster, gvr],
  );
  const rowHref = useCallback((it: Item) => detailHref(it, gvr), [gvr]);

  const workloadRoute = workloadRouteForGvr(gvr);

  return (
    <div className="h-full flex flex-col relative">
      {gvr === "/v1/Pod" && showPodMetrics && <PodMetricsBridge />}
      {workloadRoute && <WorkloadTabsBar cluster={cluster} activeRoute={workloadRoute} />}
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight shrink-0">{title}</h1>
        <span className="chip">{gvr.replace(/^\//, "core/")}</span>
        <WarningsToggle
          count={issueCount}
          active={issuesFirst}
          onToggle={() => setIssuesFirst((v) => !v)}
        />
        <div className="ml-auto relative w-[min(360px,40vw)]">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
          <input
            className="input h-8 w-full pl-7 pr-8"
            placeholder={`Search ${title}...`}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
          />
          {localSearch && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute"
              aria-label="Clear local search"
              title="Clear local search"
              onClick={() => setLocalSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </header>
      {gvr === "/v1/Pod" && (
        <PodStatusFilterStrip
          cluster={cluster}
          active={podStatusFilter}
          onChange={setPodStatusFilter}
        />
      )}
      {gvr === "/v1/Secret" && (
        <SecretTypeFilterStrip
          cluster={cluster}
          active={secretTypeFilter}
          onChange={setSecretTypeFilter}
        />
      )}
      <div className="flex-1 min-h-0">
        <EventIndexContext.Provider value={eventsCtx}>
          <ResourceTable
            cluster={cluster}
            gvr={gvr}
            namespaced={namespaced}
            columns={columns}
            rowHref={rowHref}
            actions={actions}
            bulkActions={bulkActions}
            localSearch={localSearch}
            issueAccessor={issueAccessor}
            issuesFirst={issuesFirst}
            onIssueCountChange={setIssueCount}
            filter={hasQuickFilter ? listFilter : undefined}
          />
        </EventIndexContext.Provider>
      </div>
      <CreateFab templateGvr={gvr} />
    </div>
  );
}

function detailHref(it: Item, gvr: string): string {
  const [g, v, k] = gvr.split("/");          // "" or "apps", "v1", "Deployment"
  const group = g || "core";
  const ns = it.metadata?.namespace;
  const name = encodeURIComponent(it.metadata.name);
  // Resource name lookup via Kind isn't ideal here; the backend route uses
  // the lowercase plural. We fall back to lowercase pluralisation when we
  // don't have the discovery answer cached at click-time.
  const resource = pluralise(k);
  if (ns) {
    return `resource/${group}/${v}/${resource}/ns/${encodeURIComponent(ns)}/${name}`;
  }
  return `resource/${group}/${v}/${resource}/${name}`;
}

function pluralise(kind: string): string {
  const k = kind.toLowerCase();
  if (k.endsWith("s")) return k + "es";
  if (k.endsWith("y")) return k.slice(0, -1) + "ies";
  return k + "s";
}

function containerActions(
  it: Item,
  onPick: (container?: string) => void,
  allLabel: string,
  includeAll = true,
): RowAction[] {
  const containers = [
    ...((it.spec?.containers ?? []) as any[]).map((c) => ({ name: String(c?.name ?? ""), kind: "container" })),
    ...((it.spec?.initContainers ?? []) as any[]).map((c) => ({ name: String(c?.name ?? ""), kind: "init" })),
    ...((it.spec?.ephemeralContainers ?? []) as any[]).map((c) => ({ name: String(c?.name ?? ""), kind: "ephemeral" })),
  ].filter((c) => c.name);
  const out: RowAction[] = [];
  if (includeAll) {
    out.push({ label: allLabel, onClick: () => onPick(undefined) });
  }
  for (const c of containers) {
    out.push({
      label: c.kind === "container" ? c.name : `${c.name} (${c.kind})`,
      onClick: () => onPick(c.name),
    });
  }
  return out;
}

function defaultActions(
  cluster: string,
  gvr: string,
  openDetail: (it: Item, tab?: "yaml" | "events") => void,
  openBottom: (it: Item, action: BottomAction, container?: string) => void,
  openYamlEdit: (it: Item) => void,
): RowAction[] {
  if (gvr === "/v1/Pod") {
    return [
      {
        label: "Attach Pod",
        icon: Paperclip,
        onClick: (it) => openBottom(it, "attach"),
        submenu: (it) => containerActions(it, (container) => openBottom(it, "attach", container), "Attach default container", false),
      },
      {
        label: "Shell",
        icon: Terminal,
        onClick: (it) => openBottom(it, "exec"),
        submenu: (it) => containerActions(it, (container) => openBottom(it, "exec", container), "Shell in default container", false),
      },
      { label: "Evict",      icon: LogOut,     onClick: (it) => evictPod(cluster, it) },
      { label: "Forward port", icon: Network,
        hidden: (it) => podContainerPorts(it).length === 0,
        onClick: (it) => startPodPortForward(cluster, it) },
      {
        label: "Logs",
        icon: ScrollText,
        onClick: (it) => openBottom(it, "logs"),
        submenu: (it) => containerActions(it, (container) => openBottom(it, "logs", container), "All containers"),
      },
      // Walks ownerReferences (Pod → ReplicaSet → Deployment, or directly to
      // STS/DS) and triggers a rollout restart on the controller. The label
      // tracks the owner kind ("Restart deployment" / "Restart statefulset"
      // / "Restart daemonset") so the user knows what they're rolling
      // before they click — "Restart controller" was too abstract. Job-
      // owned and naked pods don't get the action at all.
      {
        label: "Restart controller",
        icon: RefreshCcw,
        labelFor: (it) => {
          const kind = podRestartTargetKind(it);
          return kind ? `Restart ${kind.toLowerCase()}` : "Restart controller";
        },
        hidden: (it) => podRestartTargetKind(it) === null,
        onClick: (it) => restartPodController(cluster, it),
      },
      { label: "Edit",       icon: FileCode2,  onClick: (it) => openYamlEdit(it) },
      { label: "Delete",     icon: Trash2,     danger: true, onClick: (it) => deleteResource(cluster, gvr, it) },
      { label: "Force delete", icon: Trash2,   danger: true, onClick: (it) => deleteResource(cluster, gvr, it, true) },
    ];
  }

  if (gvr === "batch/v1/CronJob") {
    return [
      {
        label: "Trigger now",
        icon: Play,
        onClick: (it) => triggerCronJob(cluster, it),
      },
      {
        label: "Suspend",
        icon: Pause,
        labelFor: (it) => (it.spec?.suspend ? "Resume" : "Suspend"),
        onClick: (it) => toggleCronJobSuspend(cluster, it),
      },
      { label: "Edit",     icon: FileCode2, onClick: (it) => openYamlEdit(it) },
      { label: "Describe", icon: FileText,  onClick: (it) => openDetail(it) },
      { label: "Delete",   icon: Trash2,    danger: true, onClick: (it) => deleteResource(cluster, gvr, it) },
      { label: "Force delete", icon: Trash2, danger: true, onClick: (it) => deleteResource(cluster, gvr, it, true) },
    ];
  }

  if (isWorkload(gvr)) {
    const actions: RowAction[] = [];
    if (isScalable(gvr)) {
      actions.push({
        label: "Scale", icon: Scale,
        onClick: (it: Item) => scaleResource(cluster, gvr, it),
      });
    }
    if (isRestartable(gvr)) {
      actions.push({
        label: "Restart", icon: RefreshCcw,
        onClick: (it: Item) => restartResource(cluster, gvr, it),
      });
    }
    actions.push(
      { label: "Edit",     icon: FileCode2, onClick: (it) => openYamlEdit(it) },
      { label: "Describe", icon: FileText,  onClick: (it) => openDetail(it) },
      { label: "Delete",   icon: Trash2,    danger: true, onClick: (it) => deleteResource(cluster, gvr, it) },
      { label: "Force delete", icon: Trash2, danger: true, onClick: (it) => deleteResource(cluster, gvr, it, true) },
    );
    return actions;
  }

  return [
    { label: "Edit YAML", icon: FileCode2, onClick: (it) => openYamlEdit(it) },
    { label: "Describe",  icon: FileText,  onClick: (it) => openDetail(it) },
    { label: "Delete",    icon: Trash2,    danger: true, onClick: (it) => deleteResource(cluster, gvr, it) },
    { label: "Force delete", icon: Trash2, danger: true, onClick: (it) => deleteResource(cluster, gvr, it, true) },
  ];
}

function defaultBulkActions(cluster: string, gvr: string): BulkAction[] {
  return [
    {
      label: "Delete selected",
      icon: Trash2,
      danger: true,
      onClick: (items) => deleteResources(cluster, gvr, items),
    },
    {
      label: "Force delete selected",
      icon: Trash2,
      danger: true,
      onClick: (items) => deleteResources(cluster, gvr, items, true),
    },
  ];
}

function isWorkload(gvr: string): boolean {
  return [
    "apps/v1/Deployment",
    "apps/v1/StatefulSet",
    "apps/v1/DaemonSet",
    "apps/v1/ReplicaSet",
    "batch/v1/Job",
    "batch/v1/CronJob",
  ].includes(gvr);
}

function wantsEvents(gvr: string): boolean {
  return gvr === "/v1/Pod" || gvr === "/v1/Node" || isWorkload(gvr);
}

function isScalable(gvr: string): boolean {
  return ["apps/v1/Deployment", "apps/v1/StatefulSet", "apps/v1/ReplicaSet"].includes(gvr);
}

function isRestartable(gvr: string): boolean {
  return ["apps/v1/Deployment", "apps/v1/StatefulSet", "apps/v1/DaemonSet"].includes(gvr);
}

async function scaleResource(cluster: string, gvr: string, it: Item) {
  const ns = it.metadata.namespace;
  if (!ns) return;
  const currentN = Number(it.spec?.replicas ?? it.status?.replicas ?? 1);
  const max = Math.max(20, currentN * 2 + 5);
  const next = await modals.prompt({
    title: `Scale ${it.kind} ${it.metadata.name}`,
    default: String(currentN),
    placeholder: "0",
    okLabel: "Scale",
    slider: {
      min: 0,
      max,
      currentLabel: `Current replica scale: ${currentN}`,
      readoutLabel: "Desired number of replicas",
    },
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== v.trim()) {
        return "Replicas must be a non-negative integer.";
      }
      return null;
    },
  });
  if (next === null) return;
  const replicas = Number.parseInt(next, 10);
  const [g, v, k] = gvr.split("/");
  try {
    await api.scale(cluster, { group: g, version: v, resource: pluralise(k) }, ns, it.metadata.name, replicas);
    notify_.ok(`Scaled ${it.kind} ${it.metadata.name}`, `Replicas → ${replicas}`);
  } catch (e: any) {
    notify_.bad("Scale failed", e.message);
  }
}

async function restartResource(cluster: string, gvr: string, it: Item) {
  const ns = it.metadata.namespace;
  if (!ns) return;
  const ok = await modals.confirm({
    title: `Restart ${it.kind} ${it.metadata.name}?`,
    body: "All managed pods will be rolled out gradually.",
    okLabel: "Restart",
  });
  if (!ok) return;
  const [g, v, k] = gvr.split("/");
  try {
    await api.restart(cluster, { group: g, version: v, resource: pluralise(k) }, ns, it.metadata.name);
    notify_.ok(`Rolled out ${it.kind} ${it.metadata.name}`, "Pods will recreate gradually.");
  } catch (e: any) {
    notify_.bad("Restart failed", e.message);
  }
}

// --- CronJob actions --------------------------------------------------

async function toggleCronJobSuspend(cluster: string, it: Item) {
  const ns = it.metadata?.namespace;
  if (!ns) return;
  const next = !it.spec?.suspend;
  // Server-side apply patch — minimal fields only. The apiserver merges
  // it with the existing spec without touching the schedule, jobTemplate
  // or any field the operator owns.
  const patch = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${JSON.stringify(it.metadata.name)}
  namespace: ${JSON.stringify(ns)}
spec:
  suspend: ${next}
`;
  try {
    await api.applyResource(cluster, { group: "batch", version: "v1", resource: "cronjobs" }, ns, it.metadata.name, patch);
    notify_.ok(next ? `Suspended ${it.metadata.name}` : `Resumed ${it.metadata.name}`,
      next ? "Schedule paused; in-flight Jobs continue." : "Schedule reactivated.");
  } catch (e: any) {
    notify_.bad("Patch failed", e.message);
  }
}

async function triggerCronJob(cluster: string, it: Item) {
  const ns = it.metadata?.namespace;
  if (!ns) return;
  // Generate a unique manual run name so re-clicking spawns a new Job
  // rather than 409-ing on the previous one.
  const stamp = Math.floor(Date.now() / 1000).toString(36);
  const jobName = `${it.metadata.name}-manual-${stamp}`.slice(0, 63);
  const ok = await modals.confirm({
    title: `Trigger ${it.metadata.name}?`,
    body: `A one-shot Job named "${jobName}" will be created from the CronJob's jobTemplate.`,
    okLabel: "Trigger",
  });
  if (!ok) return;
  // Fetch the CronJob to copy its jobTemplate. Could rely on the cached
  // `it` but the live fetch guarantees we use the current spec, not a
  // potentially-stale informer snapshot.
  let live: any;
  try {
    live = await api.getResource(cluster, { group: "batch", version: "v1", resource: "cronjobs" }, ns, it.metadata.name);
  } catch (e: any) {
    notify_.bad("Couldn't read CronJob", e.message);
    return;
  }
  const tpl = live?.spec?.jobTemplate;
  if (!tpl?.spec) {
    notify_.bad("CronJob has no jobTemplate", "Nothing to trigger.");
    return;
  }
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: ns,
      labels: { ...(tpl.metadata?.labels ?? {}), "k8s-view.dev/manual-trigger": it.metadata.name },
      annotations: {
        ...(tpl.metadata?.annotations ?? {}),
        "cronjob.kubernetes.io/instantiate": "manual",
      },
      ownerReferences: [{
        apiVersion: live.apiVersion,
        kind: live.kind,
        name: live.metadata.name,
        uid: live.metadata.uid,
        controller: false,
        blockOwnerDeletion: true,
      }],
    },
    spec: tpl.spec,
  };
  try {
    await api.serverSideApply(cluster, JSON.stringify(job));
    notify_.ok(`Triggered ${it.metadata.name}`, `Job ${jobName} created.`);
  } catch (e: any) {
    notify_.bad("Trigger failed", e.message);
  }
}

// Optimistic mapping from a pod's direct owner to the controller kind that
// will end up being rolled. ReplicaSet pods are nearly always Deployment-
// managed (a standalone RS is rare); we surface "Restart deployment" for
// them and let the click-time walk-up confirm the actual Deployment name.
// Returns null when there's nothing rollable — Jobs, naked pods, and
// custom controllers fall through here so the kebab hides the action.
function podRestartTargetKind(it: Item): "Deployment" | "StatefulSet" | "DaemonSet" | null {
  const owner = (it.metadata?.ownerReferences ?? []).find((o: any) => o.controller)
            ?? (it.metadata?.ownerReferences ?? [])[0];
  if (!owner?.kind) return null;
  if (owner.kind === "Deployment" || owner.kind === "ReplicaSet") return "Deployment";
  if (owner.kind === "StatefulSet") return "StatefulSet";
  if (owner.kind === "DaemonSet") return "DaemonSet";
  return null;
}

// Restart the workload that owns this pod. Walks the ownership chain so a
// pod backed by a Deployment (Pod → RS → Deployment) restarts the Deployment
// rather than the intermediate RS, which is what every "rollout restart"
// operator-action UX (kubectl, k9s, Lens) does. Owners we can't usefully
// restart (Jobs, naked pods, custom controllers) get a clear refusal.
async function restartPodController(cluster: string, it: Item) {
  const ns = it.metadata?.namespace;
  const owner = (it.metadata?.ownerReferences ?? []).find((o: any) => o.controller)
             ?? (it.metadata?.ownerReferences ?? [])[0];
  if (!ns || !owner?.kind || !owner?.name) {
    await modals.alert({
      title: "No controller",
      body: "This pod has no controller — nothing to restart.",
      tone: "warn",
    });
    return;
  }

  let target: { kind: string; name: string; gvr: { group: string; version: string; resource: string } } | null = null;
  if (owner.kind === "ReplicaSet") {
    try {
      const rs: any = await api.getResource(cluster,
        { group: "apps", version: "v1", resource: "replicasets" }, ns, owner.name);
      const dep = (rs.metadata?.ownerReferences ?? []).find((o: any) => o.controller && o.kind === "Deployment");
      if (dep) {
        target = { kind: "Deployment", name: dep.name, gvr: { group: "apps", version: "v1", resource: "deployments" } };
      }
    } catch (e: any) {
      await modals.alert({ title: "Restart failed", body: `Could not look up ReplicaSet: ${e.message}`, tone: "bad" });
      return;
    }
  } else if (owner.kind === "Deployment" || owner.kind === "StatefulSet" || owner.kind === "DaemonSet") {
    target = {
      kind: owner.kind,
      name: owner.name,
      gvr: { group: "apps", version: "v1", resource: pluralise(owner.kind) },
    };
  }

  if (!target) {
    await modals.alert({
      title: "Cannot restart",
      body: `${owner.kind}/${owner.name} doesn't support a rollout restart. Only Deployments, StatefulSets and DaemonSets are restartable.`,
      tone: "warn",
    });
    return;
  }

  const ok = await modals.confirm({
    title: `Restart ${target.kind} ${target.name}?`,
    body: `Namespace: ${ns}. All managed pods will be rolled out gradually.`,
    okLabel: "Restart",
  });
  if (!ok) return;

  try {
    await api.restart(cluster, target.gvr, ns, target.name);
    notify_.ok(`Rolled out ${target.kind} ${target.name}`, "Pods will recreate gradually.");
  } catch (e: any) {
    notify_.bad("Restart failed", e.message);
  }
}

// Collect every distinct containerPort declared on the pod's containers.
// Used to gate the "Forward port" action and seed the prompt's default.
function podContainerPorts(it: Item): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const c of (it.spec?.containers ?? []) as any[]) {
    for (const p of (c?.ports ?? []) as any[]) {
      const n = Number(p?.containerPort);
      if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

async function startPodPortForward(cluster: string, it: Item) {
  const ns = it.metadata?.namespace;
  if (!ns) return;
  const ports = podContainerPorts(it);
  const def = ports[0] ? String(ports[0]) : "";
  const choice = await modals.prompt({
    title: `Forward port for ${it.metadata.name}`,
    body: ports.length > 0
      ? `Container ports: ${ports.join(", ")}. Local port 0 picks an ephemeral one on the backend host.`
      : "Pod doesn't declare any containerPorts. Enter the port to forward.",
    default: def,
    placeholder: "8080",
    okLabel: "Forward",
    validate: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 65535 || String(Math.floor(n)) !== v.trim()) {
        return "Port must be a positive integer between 1 and 65535.";
      }
      return null;
    },
  });
  if (choice === null) return;
  const port = Number(choice);
  const { open: openPF } = await import("../lib/portForwards");
  openPF({ cluster, ns, pod: it.metadata.name, port });
  notify_.info(`Forwarding ${it.metadata.name}:${port}`, "Open the Port Forwards page to grab the URL once it's bound.");
}

async function evictPod(cluster: string, it: Item) {
  const ns = it.metadata.namespace;
  if (!ns) return;
  const ok = await modals.confirm({
    title: `Evict pod ${it.metadata.name}?`,
    body: `Namespace: ${ns}. The pod's controller will recreate it elsewhere.`,
    okLabel: "Evict",
  });
  if (!ok) return;
  try {
    await api.evictPod(cluster, ns, it.metadata.name);
  } catch (e: any) {
    await modals.alert({ title: "Evict failed", body: e.message, tone: "bad" });
  }
}

async function deleteResource(cluster: string, gvr: string, it: Item, force = false) {
  const nsLine = it.metadata.namespace ? `Namespace: ${it.metadata.namespace}. ` : "";
  const ok = await modals.confirm({
    title: `${force ? "Force delete" : "Delete"} ${it.kind ?? prettyKind(gvr)} ${it.metadata.name}?`,
    body: force
      ? `${nsLine}Force delete skips graceful termination (--force --grace-period=0). The object is removed from the API server immediately even if its controller never confirms. This can leave orphaned processes/containers behind. Cannot be undone.`
      : `${nsLine}This action cannot be undone.`,
    danger: true,
    okLabel: force ? "Force delete" : "Delete",
  });
  if (!ok) return;
  const [g, v, k] = gvr.split("/");
  try {
    await api.deleteResource(cluster, { group: g, version: v, resource: pluralise(k) },
      it.metadata.namespace ?? null, it.metadata.name, force ? { force: true } : undefined);
  } catch (e: any) {
    await modals.alert({ title: `${force ? "Force delete" : "Delete"} failed`, body: e.message, tone: "bad" });
  }
}

async function deleteResources(cluster: string, gvr: string, items: Item[], force = false) {
  if (items.length === 0) return false;
  const kind = items[0]?.kind ?? prettyKind(gvr);
  const sample = items.slice(0, 8);
  const hidden = items.length - sample.length;
  const ok = await modals.confirm({
    title: `${force ? "Force delete" : "Delete"} ${items.length} selected ${kind}${items.length === 1 ? "" : "s"}?`,
    body: (
      <div className="space-y-2">
        <div>
          {force
            ? "Force delete skips graceful termination (--force --grace-period=0) for every item below — removed from the API server immediately, may leave orphaned processes. Cannot be undone."
            : "This action cannot be undone."}
        </div>
        <div className="max-h-40 overflow-auto rounded-md border border-line bg-bg px-2 py-1 font-mono text-xs">
          {sample.map((it) => (
            <div key={it.metadata.uid ?? `${it.metadata.namespace}/${it.metadata.name}`} className="truncate">
              {it.metadata.namespace ? `${it.metadata.namespace}/` : ""}{it.metadata.name}
            </div>
          ))}
          {hidden > 0 && <div className="text-fg-mute">...and {hidden} more</div>}
        </div>
      </div>
    ),
    danger: true,
    okLabel: force ? "Force delete" : "Delete",
  });
  if (!ok) return false;

  const [g, v, k] = gvr.split("/");
  const ref = { group: g, version: v, resource: pluralise(k) };
  const results = await Promise.allSettled(items.map((it) =>
    api.deleteResource(cluster, ref, it.metadata.namespace ?? null, it.metadata.name, force ? { force: true } : undefined),
  ));
  const failures = results
    .map((r, i) => ({ result: r, item: items[i] }))
    .filter((x) => x.result.status === "rejected") as Array<{
      result: PromiseRejectedResult;
      item: Item;
    }>;
  if (failures.length > 0) {
    await modals.alert({
      title: `Failed to delete ${failures.length} item${failures.length === 1 ? "" : "s"}`,
      body: failures.slice(0, 6).map((f) => {
        const reason = f.result.reason instanceof Error ? f.result.reason.message : String(f.result.reason);
        return `${f.item.metadata.name}: ${reason}`;
      }).join("\n"),
      tone: "bad",
    });
  }
  return true;
}

function prettyKind(gvr: string): string {
  const parts = gvr.split("/");
  return parts[parts.length - 1] || "resource";
}

// PodStatusFilterStrip — Lens-style status chip row above the Pods table.
// Five buckets: Healthy / Pending / Error / Completed / Other. Counts are
// computed from the same in-memory pool ResourceTable will read, so they
// stay perfectly in sync at no extra subscription cost.
function PodStatusFilterStrip({
  cluster, active, onChange,
}: {
  cluster: string;
  active: Set<PodStatusKind> | null;
  onChange: (next: Set<PodStatusKind> | null) => void;
}) {
  const namespace = useApp((s) => s.namespace);
  const namespaces = useApp((s) => s.namespaces);
  const ns = namespaces.length > 0 ? namespaces : (namespace ? [namespace] : undefined);
  const { items } = useResourceList(cluster, "/v1/Pod", ns);
  const counts = useMemo(() => {
    const out: Record<PodStatusKind, number> = { ok: 0, warn: 0, bad: 0, info: 0, mute: 0 };
    for (const it of items) out[podDisplayStatus(it).kind]++;
    return out;
  }, [items]);
  const buckets: { kind: PodStatusKind; label: string; tone: string }[] = [
    { kind: "ok",   label: "Running",   tone: "border-ok/40 bg-ok/10 text-ok" },
    { kind: "warn", label: "Pending",   tone: "border-warn/40 bg-warn/10 text-warn" },
    { kind: "bad",  label: "Error",     tone: "border-bad/40 bg-bad/10 text-bad" },
    { kind: "info", label: "Completed", tone: "border-info/40 bg-info/10 text-info" },
    { kind: "mute", label: "Other",     tone: "border-line bg-bg-mute text-fg-mute" },
  ];
  const toggle = (k: PodStatusKind) => {
    const next = new Set(active ?? []);
    if (next.has(k)) {
      next.delete(k);
      if (next.size === 0) {
        onChange(null);
        return;
      }
    } else {
      next.add(k);
    }
    onChange(next);
  };
  const allOff = active === null;
  return (
    <div className="px-4 py-2 border-b border-line/60 flex items-center gap-1.5 text-xs">
      <button
        type="button"
        className={clsx("h-7 px-2 rounded-md border text-[11px] tracking-wide",
          allOff ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-fg-soft hover:text-fg hover:bg-bg-mute")}
        onClick={() => onChange(null)}
      >
        All <span className="ml-1 text-fg-mute">{items.length.toLocaleString()}</span>
      </button>
      <span className="mx-1 h-4 w-px bg-line" aria-hidden />
      {buckets.map((b) => {
        const checked = active?.has(b.kind) ?? false;
        const dim = !allOff && !checked;
        return (
          <button
            key={b.kind}
            type="button"
            className={clsx(
              "h-7 px-2 rounded-md border text-[11px] tracking-wide transition-opacity",
              b.tone,
              dim && "opacity-50",
            )}
            onClick={() => toggle(b.kind)}
            title={`${b.label}: ${counts[b.kind].toLocaleString()} pod${counts[b.kind] === 1 ? "" : "s"}`}
          >
            {b.label}
            <span className="ml-1 text-fg-mute">{counts[b.kind].toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}

type SecretBucket = "tls" | "opaque" | "helm" | "docker" | "sa" | "other";

// Classify a Secret by its `.type` into the buckets operators actually
// reach for ("show me the TLS certs", "where are the Helm releases").
function secretBucket(it: Item): SecretBucket {
  const t = (it as any).type as string | undefined;
  switch (t) {
    case "kubernetes.io/tls":
      return "tls";
    case "kubernetes.io/dockerconfigjson":
    case "kubernetes.io/dockercfg":
      return "docker";
    case "kubernetes.io/service-account-token":
      return "sa";
    case undefined:
    case "":
    case "Opaque":
      return "opaque";
    default:
      // Helm stores releases as helm.sh/release.v1 (sh.helm.release.v1
      // on very old charts) — fold both in.
      if (t.startsWith("helm.sh/") || t.startsWith("sh.helm.")) return "helm";
      return "other";
  }
}

// SecretTypeFilterStrip — the Secrets analogue of PodStatusFilterStrip.
// Counts come from the same in-memory pool the table reads, so they never
// drift from what's on screen.
function SecretTypeFilterStrip({
  cluster, active, onChange,
}: {
  cluster: string;
  active: Set<SecretBucket> | null;
  onChange: (next: Set<SecretBucket> | null) => void;
}) {
  const namespace = useApp((s) => s.namespace);
  const namespaces = useApp((s) => s.namespaces);
  const ns = namespaces.length > 0 ? namespaces : (namespace ? [namespace] : undefined);
  const { items } = useResourceList(cluster, "/v1/Secret", ns);
  const counts = useMemo(() => {
    const out: Record<SecretBucket, number> = { tls: 0, opaque: 0, helm: 0, docker: 0, sa: 0, other: 0 };
    for (const it of items) out[secretBucket(it)]++;
    return out;
  }, [items]);
  const buckets: { kind: SecretBucket; label: string; tone: string }[] = [
    { kind: "tls",    label: "TLS",      tone: "border-ok/40 bg-ok/10 text-ok" },
    { kind: "opaque", label: "Opaque",   tone: "border-info/40 bg-info/10 text-info" },
    { kind: "helm",   label: "Helm",     tone: "border-accent/40 bg-accent/10 text-accent" },
    { kind: "docker", label: "Docker",   tone: "border-warn/40 bg-warn/10 text-warn" },
    { kind: "sa",     label: "SA token", tone: "border-line bg-bg-mute text-fg-soft" },
    { kind: "other",  label: "Other",    tone: "border-line bg-bg-mute text-fg-mute" },
  ];
  const toggle = (k: SecretBucket) => {
    const next = new Set(active ?? []);
    if (next.has(k)) {
      next.delete(k);
      if (next.size === 0) { onChange(null); return; }
    } else {
      next.add(k);
    }
    onChange(next);
  };
  const allOff = active === null;
  return (
    <div className="px-4 py-2 border-b border-line/60 flex items-center gap-1.5 text-xs flex-wrap">
      <button
        type="button"
        className={clsx("h-7 px-2 rounded-md border text-[11px] tracking-wide",
          allOff ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-fg-soft hover:text-fg hover:bg-bg-mute")}
        onClick={() => onChange(null)}
      >
        All <span className="ml-1 text-fg-mute">{items.length.toLocaleString()}</span>
      </button>
      <span className="mx-1 h-4 w-px bg-line" aria-hidden />
      {buckets.map((b) => {
        const checked = active?.has(b.kind) ?? false;
        const dim = !allOff && !checked;
        return (
          <button
            key={b.kind}
            type="button"
            className={clsx(
              "h-7 px-2 rounded-md border text-[11px] tracking-wide transition-opacity",
              b.tone,
              dim && "opacity-50",
            )}
            onClick={() => toggle(b.kind)}
            title={`${b.label}: ${counts[b.kind].toLocaleString()} secret${counts[b.kind] === 1 ? "" : "s"}`}
          >
            {b.label}
            <span className="ml-1 text-fg-mute">{counts[b.kind].toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}

// Mounted only on the Pods list. Pulls per-pod CPU/memory once and pushes the
// result into a shared store so the column cells can render without each one
// running its own query.
function PodMetricsBridge() {
  const cluster = useApp((s) => s.cluster);
  const namespace = useApp((s) => s.namespace);
  const namespaces = useApp((s) => s.namespaces);
  const ns = namespaces.length > 0 ? namespaces : (namespace ? [namespace] : []);
  const result = usePodMetrics(cluster, ns.length > 0 ? ns : undefined);
  const setMetrics = usePodMetricsStore((s) => s.setMetrics);

  useEffect(() => {
    if (!cluster) return;
    setMetrics(cluster, result.data, result.source);
  }, [cluster, result.data, result.source, setMetrics]);

  return null;
}
