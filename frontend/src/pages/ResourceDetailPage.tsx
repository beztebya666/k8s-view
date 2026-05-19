// ResourceDetailPage — opens any resource by GVR + (optional namespace) + name.
// Tabs: Summary / YAML / Events / Logs (pods only) / Exec (pods only).

import { forwardRef, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import * as YAML from "yaml";
import clsx from "clsx";
import {
  ArrowLeft, RefreshCcw, Trash2, Bell, Pencil,
  TerminalSquare, ScrollText, ChevronDown, Copy, Check, X,
  Info, Paperclip, Eye, EyeOff, KeyRound, Star, Scale, RotateCw, Pause, Play,
  History, Lock, ShieldOff, Power, WrapText,
} from "lucide-react";
import { api, GVR } from "../lib/api";
import { notify_ } from "../lib/notifications";
import { copyToClipboard } from "../lib/clipboard";
import { useApp } from "../stores/app";
import { useResourceList } from "../lib/useResourceList";
import { YAMLEditor, YAMLDiffEditor } from "../components/YAMLEditor";
import { age } from "../lib/format";
import { useNowTick } from "../lib/clock";
import { usePersistedState } from "../lib/usePersistedState";
import { useBottomPane, type BottomAction } from "../components/BottomPane";
import { PodSummaryView } from "./PodSummaryView";
import { modals } from "../components/Modals";
import { LinkCell, ownerToRef, refToQuery } from "../components/DetailPanel";
import { customViewFor } from "../components/detail/customViews";
import { describe } from "../components/detail/describe";
import { RolloutsTab } from "../components/detail/RolloutsTab";
import { NetworkPolicyGraph } from "../components/detail/NetworkPolicyGraph";
import { TopologyGraph } from "../components/detail/TopologyGraph";
import { FileSearch } from "lucide-react";
import { WorkloadMetrics } from "../components/charts/WorkloadMetrics";
import {
  getSnapshot as favSnapshotRef,
  isPinned as favIsPinned,
  subscribe as favSubscribe,
  toggle as favToggle,
} from "../lib/favourites";

type Tab = "summary" | "yaml" | "events" | "describe" | "rollouts";
const VALID_TABS = new Set(["summary", "yaml", "events", "describe", "rollouts"]);

// Resource kinds that carry pods (and therefore have CPU/memory time
// series we can chart from Prometheus). PodSummaryView already renders
// metrics inline for single Pods, so we leave Pod off this list to avoid
// stacking two metric blocks on the same panel.
const METRIC_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);
const TOPOLOGY_KINDS = new Set(["Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "Node"]);
// Kinds whose apiserver exposes a /scale subresource. Matched against the
// fetched object's `kind` and (as a backup, before the fetch resolves)
// against the GVR string.
const SCALABLE_KINDS = new Set(["Deployment", "StatefulSet", "ReplicaSet"]);
const SCALABLE_RESOURCES = new Set([
  "apps/v1/deployments",
  "apps/v1/statefulsets",
  "apps/v1/replicasets",
]);
// Restartable kinds are those whose pod template supports a kubectl-style
// rollout restart (annotation bump → controller rolls pods). DaemonSet
// gets the same affordance even though it's not "scaled".
const RESTARTABLE_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const RESTARTABLE_RESOURCES = new Set([
  "apps/v1/deployments",
  "apps/v1/statefulsets",
  "apps/v1/daemonsets",
]);

type DetailProps = {
  // When provided, override the route params. Used by the side-panel host
  // (DetailPanel) so the same component can render embedded.
  group?: string;
  version?: string;
  resource?: string;
  namespace?: string;
  name?: string;
  // Panel mode: when set, header swaps the back button for a Close action
  // and Delete navigates back to the list (panel) instead of `navigate(-1)`.
  onClose?: () => void;
  closeIcon?: React.ReactNode;
};

export function ResourceDetailPage(props: DetailProps = {}) {
  const routeParams = useParams();
  const group = props.group ?? routeParams.group ?? "core";
  const version = props.version ?? routeParams.version ?? "v1";
  const resource = props.resource ?? routeParams.resource ?? "";
  const namespace = props.namespace ?? routeParams.namespace;
  const name = props.name ?? routeParams.name ?? "";
  const onClose = props.onClose;
  const isPanel = !!onClose;

  const cluster = useApp((s) => s.cluster);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedTab = params.get("tab") || "summary";
  const tab = (VALID_TABS.has(requestedTab) ? requestedTab : "summary") as Tab;

  const gvr: GVR = { group: group === "core" ? "" : group, version, resource };
  const isPod = group === "core" && resource === "pods";
  const isDeployment = group === "apps" && resource === "deployments";
  const isNode = group === "core" && resource === "nodes";
  const nodeShellSettings = useApp((s) => s.getClusterSettings(cluster));
  const { data: fetchedData, isLoading, error, refetch } = useQuery({
    enabled: !!cluster && !!resource && !!name,
    queryKey: ["resource", cluster, gvr, namespace, name],
    queryFn: () => api.getResource(cluster, gvr, namespace ?? null, name),
    refetchInterval: isPod ? 1500 : 5000,
  });
  const watchedPods = useResourceList(cluster, "/v1/Pod", namespace, {
    enabled: isPod && !!cluster && !!namespace && !!name,
  });
  const watchedPod = useMemo(
    () => watchedPods.items.find((p) => p.metadata?.namespace === namespace && p.metadata?.name === name),
    [watchedPods.items, namespace, name],
  );
  const watchedPodMissing = isPod && watchedPods.ready && !watchedPod;
  const data = isPod
    ? (watchedPod ?? (watchedPodMissing ? null : fetchedData))
    : fetchedData;

  // goTab — clicking the active tab returns to Summary (toggle behaviour),
  // matching how the Logs / Shell / Attach pane buttons close themselves on
  // re-click. Without this you'd be stuck on Events with no obvious way
  // back short of closing the whole panel.
  const goTab = (id: Tab) => {
    const next = new URLSearchParams(params);
    if (id === "summary" || id === tab) next.delete("tab");
    else next.set("tab", id);
    setParams(next);
  };

  // Logs/Shell live in the bottom pane (`?b=...`). The pane supports many
  // tabs simultaneously, so the buttons here just push/focus the matching
  // tab via the shared helper instead of replacing the whole `?b` value.
  const bottom = useBottomPane();
  const isBottomFor = (action: BottomAction) =>
    bottom.isActive({ action, cluster, namespace: namespace || "default", name });
  const toggleBottom = (action: BottomAction) => {
    bottom.push({ action, cluster, namespace: namespace || "default", name });
  };
  const isYamlOpen = bottom.isActive({
    action: "yaml", cluster, namespace, name,
    gvr: `${gvr.group || "core"}/${gvr.version}/${gvr.resource}`,
  });
  const openYamlEdit = () => {
    bottom.push({
      action: "yaml",
      cluster,
      namespace,
      name,
      gvr: `${gvr.group || "core"}/${gvr.version}/${gvr.resource}`,
    });
  };

  const onDelete = async () => {
    let force = false;
    const ok = await modals.confirm({
      title: `Delete ${name}?`,
      body: namespace
        ? `Namespace: ${namespace}. This action cannot be undone. "Force delete" skips graceful termination (--force --grace-period=0) and may leave orphaned processes behind.`
        : `This action cannot be undone. "Force delete" skips graceful termination (--force --grace-period=0) and may leave orphaned processes behind.`,
      danger: true,
      okLabel: "Delete",
      forceLabel: "Force delete",
      onForce: () => { force = true; },
    });
    if (!ok) return;
    try {
      await api.deleteResource(cluster, gvr, namespace ?? null, name, force ? { force: true } : undefined);
      if (isPanel) onClose!();
      else navigate(-1);
    } catch (e: any) {
      await modals.alert({ title: `${force ? "Force delete" : "Delete"} failed`, body: e.message, tone: "bad" });
    }
  };

  // Scale icon — visible only for kinds the apiserver actually exposes a
  // /scale subresource for. ReplicaSet is included for symmetry with the
  // resource list page even though scaling a bare RS is rare in practice.
  const isScalable = SCALABLE_KINDS.has(data?.kind ?? "")
    || SCALABLE_RESOURCES.has(`${gvr.group || "core"}/${gvr.version}/${gvr.resource}`);
  const isRestartable = RESTARTABLE_KINDS.has(data?.kind ?? "")
    || RESTARTABLE_RESOURCES.has(`${gvr.group || "core"}/${gvr.version}/${gvr.resource}`);
  const onScale = async () => {
    if (!namespace) return;
    const currentN = Number(data?.spec?.replicas ?? data?.status?.replicas ?? 1);
    const max = Math.max(20, currentN * 2 + 5);
    const next = await modals.prompt({
      title: `Scale ${data?.kind ?? "workload"} ${name}`,
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
    try {
      await api.scale(cluster, gvr, namespace, name, replicas);
      notify_.ok(`Scaled ${data?.kind ?? "workload"} ${name}`, `Replicas → ${replicas}`);
      refetch();
    } catch (e: any) {
      notify_.bad("Scale failed", e.message);
    }
  };

  const isCronJob = data?.kind === "CronJob"
    || `${gvr.group || "core"}/${gvr.version}/${gvr.resource}` === "batch/v1/cronjobs";
  const cronSuspended = !!data?.spec?.suspend;

  const onCronToggleSuspend = async () => {
    if (!namespace) return;
    const next = !cronSuspended;
    const patch = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${JSON.stringify(name)}
  namespace: ${JSON.stringify(namespace)}
spec:
  suspend: ${next}
`;
    try {
      await api.applyResource(cluster, gvr, namespace, name, patch);
      notify_.ok(next ? `Suspended ${name}` : `Resumed ${name}`,
        next ? "Schedule paused; in-flight Jobs continue." : "Schedule reactivated.");
      refetch();
    } catch (e: any) {
      notify_.bad("Patch failed", e.message);
    }
  };

  const onCronTriggerNow = async () => {
    if (!namespace) return;
    const stamp = Math.floor(Date.now() / 1000).toString(36);
    const jobName = `${name}-manual-${stamp}`.slice(0, 63);
    const ok = await modals.confirm({
      title: `Trigger ${name}?`,
      body: `A one-shot Job named "${jobName}" will be created from the CronJob's jobTemplate.`,
      okLabel: "Trigger",
    });
    if (!ok) return;
    const tpl = data?.spec?.jobTemplate;
    if (!tpl?.spec) {
      notify_.bad("CronJob has no jobTemplate", "Nothing to trigger.");
      return;
    }
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace,
        labels: { ...(tpl.metadata?.labels ?? {}), "k8s-view.dev/manual-trigger": name },
        annotations: {
          ...(tpl.metadata?.annotations ?? {}),
          "cronjob.kubernetes.io/instantiate": "manual",
        },
        ownerReferences: [{
          apiVersion: data.apiVersion, kind: data.kind, name: data.metadata.name,
          uid: data.metadata.uid, controller: false, blockOwnerDeletion: true,
        }],
      },
      spec: tpl.spec,
    };
    try {
      await api.serverSideApply(cluster, JSON.stringify(job));
      notify_.ok(`Triggered ${name}`, `Job ${jobName} created.`);
    } catch (e: any) {
      notify_.bad("Trigger failed", e.message);
    }
  };

  const onRestart = async () => {
    if (!namespace) return;
    const ok = await modals.confirm({
      title: `Restart ${data?.kind ?? "workload"} ${name}?`,
      body: "Pods will be rolled out gradually using a template-annotation bump (kubectl-rollout-restart equivalent).",
      okLabel: "Restart",
    });
    if (!ok) return;
    try {
      await api.restart(cluster, gvr, namespace, name);
      notify_.ok(`Rolled out ${data?.kind ?? "workload"} ${name}`, "Pods will recreate gradually.");
      refetch();
    } catch (e: any) {
      notify_.bad("Restart failed", e.message);
    }
  };

  // ---- Node operations (only wired up when this object is a Node) --------
  const nodeCordoned = !!data?.spec?.unschedulable;
  const onCordonToggle = async () => {
    try {
      if (nodeCordoned) {
        await api.uncordon(cluster, name);
        notify_.ok(`Uncordoned ${name}`, "Node is schedulable again.");
      } else {
        await api.cordon(cluster, name);
        notify_.ok(`Cordoned ${name}`, "No new pods will be scheduled here.");
      }
      refetch();
    } catch (e: any) {
      notify_.bad(nodeCordoned ? "Uncordon failed" : "Cordon failed", e.message);
    }
  };
  const onDrainNode = async () => {
    const ok = await modals.confirm({
      title: `Drain node ${name}?`,
      body: "Every pod that isn't a DaemonSet or mirror pod will be evicted. The node is cordoned first.",
      danger: true,
      okLabel: "Drain",
    });
    if (!ok) return;
    try {
      const r = await api.drain(cluster, name);
      notify_.ok(`Drained ${name}`, `Evicted ${r.evicted}, skipped ${r.skipped}.`);
      refetch();
    } catch (e: any) {
      notify_.bad("Drain failed", e.message);
    }
  };
  const onNodeShell = async () => {
    try {
      const created = await api.nodeShell(cluster, name, {
        image: nodeShellSettings.nodeShellImage || undefined,
        pullSecret: nodeShellSettings.nodeShellPullSecret || undefined,
      });
      notify_.info(`Spawning node-shell on ${name}`,
        `Pod ${created.namespace}/${created.name} — opening exec…`);
      bottom.push({
        action: "exec",
        cluster,
        namespace: created.namespace,
        name: created.name,
        container: "shell",
      });
    } catch (e: any) {
      notify_.bad("node-shell failed", e.message);
    }
  };

  if ((error || watchedPodMissing) && !data) {
    return (
      <div className="h-full flex flex-col min-w-0">
        <header className="px-3 h-12 shrink-0 border-b border-line flex items-center gap-2 min-w-0 bg-bg-soft">
          {!isPanel && (
            <button className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
                    onClick={() => navigate(-1)} title="Back">
              <ArrowLeft size={14} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium truncate">{name || resource}</div>
            <div className="text-xs text-fg-mute truncate">
              {(group === "core" ? "" : group + "/")}{version}/{resource}
              {namespace ? ` · ${namespace}` : ""}
            </div>
          </div>
          <IconBtn onClick={() => refetch()} title="Refresh">
            <RefreshCcw size={14} />
          </IconBtn>
          {isPanel && (
            <IconBtn onClick={onClose} title="Close  (Esc)">
              {props.closeIcon ?? <X size={14} />}
            </IconBtn>
          )}
        </header>
        <div className="flex-1 min-h-0 p-4">
          <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error ? (error as any).message : "Pod has been deleted."}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button className="btn" onClick={() => refetch()}>
              <RefreshCcw size={13} /> Refresh
            </button>
            {isPanel && (
              <button className="btn" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      <header className="px-3 h-12 shrink-0 border-b border-line flex items-center gap-2 min-w-0 bg-bg-soft">
        {!isPanel && (
          <button className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
                  onClick={() => navigate(-1)} title="Back">
            <ArrowLeft size={14} />
          </button>
        )}
        <button
          className={clsx(
            "text-[15px] font-medium tracking-tight truncate min-w-0 text-left transition-colors",
            tab === "summary" ? "text-fg" : "text-fg-soft hover:text-fg",
          )}
          onClick={() => goTab("summary")}
          title={`${name} — Summary`}
        >
          {name}
        </button>
        {namespace && <span className="chip shrink-0">ns: {namespace}</span>}
        <span className="chip shrink-0">{(group === "core" ? "" : group + "/")}{version}/{resource}</span>

        {/* Header actions, grouped left→right by intent so it doesn't read
            as one undifferentiated row:
              1. Views   — Summary, then the things you actually open most
                           (Logs / Shell / Attach), then Events / Rollouts,
                           and Describe last (it's the least-reached view).
              2. Actions — edit / favourite / copy / scale / restart / …
              3. Lifecycle — Refresh / Delete / Close.
            Thin dividers separate the groups. */}
        <div className="ml-auto flex items-center gap-0.5 shrink-0 pl-2">
          {/* — Group 1: views — */}
          <IconBtn active={tab === "summary"} onClick={() => goTab("summary")} title="Summary">
            <Info size={14} />
          </IconBtn>
          {isPod && (
            <IconBtn active={isBottomFor("logs")} onClick={() => toggleBottom("logs")} title="Pod logs">
              <ScrollText size={14} />
            </IconBtn>
          )}
          {isPod && (
            <IconBtn active={isBottomFor("exec")} onClick={() => toggleBottom("exec")} title="Pod shell">
              <TerminalSquare size={14} />
            </IconBtn>
          )}
          {isPod && (
            <IconBtn active={isBottomFor("attach")} onClick={() => toggleBottom("attach")} title="Attach to pod">
              <Paperclip size={14} />
            </IconBtn>
          )}
          <IconBtn active={tab === "events"} onClick={() => goTab("events")} title="Events">
            <Bell size={14} />
          </IconBtn>
          {isDeployment && (
            <IconBtn active={tab === "rollouts"} onClick={() => goTab("rollouts")} title="Rollout history & rollback">
              <History size={14} />
            </IconBtn>
          )}

          <HeaderDivider />

          {/* — Group 2: actions (Describe sits here too — it's a
              secondary view, grouped with edit/favourite/copy) — */}
          <IconBtn active={tab === "describe"} onClick={() => goTab("describe")} title="Describe (kubectl-style)">
            <FileSearch size={14} />
          </IconBtn>
          <IconBtn active={isYamlOpen} onClick={openYamlEdit} title="Edit YAML (opens in bottom pane)">
            <Pencil size={14} />
          </IconBtn>
          {data && (
            <FavouriteToggle
              cluster={cluster}
              gvr={gvr}
              namespace={namespace}
              name={name}
              kind={data?.kind ?? prettyKind(gvr)}
            />
          )}
          <CopyKubectlMenu
            cluster={cluster}
            namespace={namespace}
            name={name}
            kind={data?.kind ?? ""}
            resource={resource}
            isPod={isPod}
          />
          {isScalable && (
            <IconBtn onClick={onScale} title="Scale replicas">
              <Scale size={14} />
            </IconBtn>
          )}
          {isRestartable && (
            <IconBtn onClick={onRestart} title="Restart rollout">
              <RotateCw size={14} />
            </IconBtn>
          )}
          {isNode && (
            <IconBtn
              active={nodeCordoned}
              onClick={onCordonToggle}
              title={nodeCordoned ? "Uncordon (mark schedulable)" : "Cordon (mark unschedulable)"}
            >
              {nodeCordoned ? <ShieldOff size={14} /> : <Lock size={14} />}
            </IconBtn>
          )}
          {isNode && (
            <IconBtn danger onClick={onDrainNode} title="Drain node (evict pods)">
              <Power size={14} />
            </IconBtn>
          )}
          {isNode && (
            <IconBtn onClick={onNodeShell} title="Open node shell">
              <TerminalSquare size={14} />
            </IconBtn>
          )}
          {isCronJob && (
            <IconBtn onClick={onCronTriggerNow} title="Trigger now (create manual Job)">
              <Play size={14} />
            </IconBtn>
          )}
          {isCronJob && (
            <IconBtn
              active={cronSuspended}
              onClick={onCronToggleSuspend}
              title={cronSuspended ? "Resume schedule" : "Suspend schedule"}
            >
              <Pause size={14} />
            </IconBtn>
          )}

          <HeaderDivider />

          {/* — Group 3: lifecycle — */}
          <IconBtn onClick={() => refetch()} title="Refresh">
            <RefreshCcw size={14} />
          </IconBtn>
          <IconBtn danger onClick={onDelete} title="Delete">
            <Trash2 size={14} />
          </IconBtn>
          {isPanel && (
            <IconBtn onClick={onClose} title="Close  (Esc)">
              {props.closeIcon ?? <X size={14} />}
            </IconBtn>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoading && <div className="p-4 text-fg-mute text-sm">loading…</div>}
        {data && tab === "summary" && (isPod ? <PodSummaryView obj={data} /> : <SummaryTab obj={data} />)}
        {data && tab === "yaml"    && <YAMLTab cluster={cluster} obj={data} gvr={gvr} namespace={namespace ?? null} name={name} onSaved={refetch} />}
        {data && tab === "events"  && (
          <EventsTab
            cluster={cluster}
            ns={namespace ?? "_all"}
            uid={data?.metadata?.uid}
            kind={data?.kind}
            name={data?.metadata?.name}
          />
        )}
        {data && tab === "describe" && (
          <DescribeTab
            cluster={cluster}
            ns={namespace ?? "_all"}
            uid={data?.metadata?.uid}
            kind={data?.kind}
            name={data?.metadata?.name}
            obj={data}
          />
        )}
        {data && tab === "rollouts" && isDeployment && namespace && (
          <RolloutsTab
            cluster={cluster}
            ns={namespace}
            name={name}
            currentTemplate={data?.spec?.template}
            onRolledBack={() => refetch()}
          />
        )}
      </div>
    </div>
  );
}

// DescribeTab — kubectl-describe-style monospace dump. Reuses the
// EventsTab's namespace events fetch (filtered to this object + its
// descendants) so the trailing "Events:" block matches what kubectl
// would have shown.
function DescribeTab({
  cluster, ns, uid, kind, name, obj,
}: {
  cluster: string;
  ns: string;
  uid?: string;
  kind?: string;
  name?: string;
  obj: any;
}) {
  const { data } = useQuery({
    enabled: !!cluster && !!ns,
    queryKey: ["events", cluster, ns],
    queryFn: () => api.events(cluster, ns),
    refetchInterval: 5000,
  });
  const descendants = useDescendantUIDs(cluster, ns, kind ?? "", uid ?? "");
  const matchSet = useMemo(() => {
    const s = new Set<string>();
    if (uid) s.add(uid);
    for (const u of descendants.uids) s.add(u);
    return s;
  }, [uid, descendants.uids]);
  const events = useMemo(() => {
    const all = (data?.items ?? []) as any[];
    if (!uid && !name) return all;
    return all.filter((e) => {
      const u = e.involvedObject?.uid;
      if (u && matchSet.has(u)) return true;
      if (e.involvedObject?.kind === kind && e.involvedObject?.name === name) return true;
      return false;
    });
  }, [data, matchSet, kind, name, uid]);
  const text = useMemo(() => describe(obj, events), [obj, events]);
  return (
    <div className="h-full overflow-auto bg-bg p-3">
      <pre className="font-mono text-[12px] leading-snug whitespace-pre-wrap text-fg">
        {text}
      </pre>
    </div>
  );
}

// ServiceEndpointsSection — for Service detail panels: list every backing
// pod through EndpointSlice. Shows ready/not-ready dots, target pod name,
// node, and the per-address port mappings. EndpointSlice carries a
// `kubernetes.io/service-name` label exactly for this lookup, so we
// filter the in-memory pool by that label without an extra API call.
function ServiceEndpointsSection({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const ns: string = obj?.metadata?.namespace ?? "";
  const name: string = obj?.metadata?.name ?? "";
  const slices = useResourceList(cluster, "discovery.k8s.io/v1/EndpointSlice", ns || undefined,
    { enabled: !!ns && !!name && !!cluster });

  const matched = useMemo(
    () => (slices.items as any[]).filter((s) => s?.metadata?.labels?.["kubernetes.io/service-name"] === name),
    [slices.items, name],
  );

  const flat = useMemo(() => {
    type Row = {
      address: string;
      ready: boolean;
      terminating: boolean;
      nodeName?: string;
      targetKind?: string;
      targetName?: string;
      ports: { name?: string; port: number; protocol?: string }[];
    };
    const rows: Row[] = [];
    for (const slice of matched) {
      const ports = (slice.ports ?? []).map((p: any) => ({
        name: p?.name,
        port: Number(p?.port),
        protocol: p?.protocol,
      })).filter((p: any) => Number.isFinite(p.port));
      for (const ep of (slice.endpoints ?? []) as any[]) {
        const addrs = (ep.addresses ?? []) as string[];
        for (const a of addrs) {
          rows.push({
            address: a,
            ready: ep.conditions?.ready !== false,
            terminating: ep.conditions?.terminating === true,
            nodeName: ep.nodeName,
            targetKind: ep.targetRef?.kind,
            targetName: ep.targetRef?.name,
            ports,
          });
        }
      }
    }
    return rows;
  }, [matched]);

  if (flat.length === 0 && matched.length === 0) {
    // Headless or selector-less services: surface nothing rather than an empty section.
    return null;
  }
  const readyCount = flat.filter((r) => r.ready).length;
  return (
    <Section title={`Endpoints (${readyCount}/${flat.length} ready)`} collapsible defaultOpen>
      <ul className="divide-y divide-line/60">
        {flat.map((r, i) => (
          <li key={`${r.address}:${i}`} className="px-3 py-1.5 flex items-center gap-2 text-xs">
            <span className={clsx("h-2 w-2 rounded-full shrink-0",
              r.terminating ? "bg-warn" : r.ready ? "bg-ok" : "bg-bad")} title={r.ready ? "ready" : r.terminating ? "terminating" : "not ready"} />
            <span className="font-mono text-fg">{r.address}</span>
            {r.ports.length > 0 && (
              <span className="text-fg-mute">
                {r.ports.map((p) => `${p.protocol ?? "TCP"}/${p.port}${p.name ? `:${p.name}` : ""}`).join(" · ")}
              </span>
            )}
            {r.nodeName && (
              <span className="ml-auto text-fg-mute font-mono truncate" title={`node: ${r.nodeName}`}>
                node {r.nodeName}
              </span>
            )}
            {r.targetKind === "Pod" && r.targetName && (
              <PodEndpointLink ns={obj.metadata.namespace} name={r.targetName} />
            )}
          </li>
        ))}
        {flat.length === 0 && (
          <li className="px-3 py-2 text-fg-mute text-xs">no addresses bound</li>
        )}
      </ul>
    </Section>
  );
}

function PodEndpointLink({ ns, name }: { ns: string; name: string }) {
  const [, setSearchParams] = useSearchParams();
  return (
    <button
      className="text-accent hover:text-accent/80 font-mono"
      onClick={(e) => {
        e.stopPropagation();
        const q = refToQuery({ group: "core", version: "v1", resource: "pods", namespace: ns, name });
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("d", q);
          next.delete("tab");
          return next;
        });
      }}
    >
      {name}
    </button>
  );
}

// IngressBackendsSection — flatten spec.rules into a (host, path, service,
// port) table. For default backends we hoist them to the top with a
// "default backend" tag so the user's first read of the section is the
// catch-all. Each Service is a clickable LinkCell jumping to its detail.
function IngressBackendsSection({ obj }: { obj: any }) {
  const ns: string = obj?.metadata?.namespace ?? "";
  type Backend = {
    host?: string;
    path?: string;
    pathType?: string;
    service: string;
    port?: string | number;
    isDefault?: boolean;
  };
  const rows = useMemo<Backend[]>(() => {
    const out: Backend[] = [];
    const def = obj?.spec?.defaultBackend?.service;
    if (def?.name) {
      out.push({
        service: def.name,
        port: def.port?.name ?? def.port?.number,
        isDefault: true,
      });
    }
    for (const rule of (obj?.spec?.rules ?? []) as any[]) {
      const host = rule?.host;
      for (const p of (rule?.http?.paths ?? []) as any[]) {
        const svc = p?.backend?.service;
        if (!svc?.name) continue;
        out.push({
          host,
          path: p?.path,
          pathType: p?.pathType,
          service: svc.name,
          port: svc.port?.name ?? svc.port?.number,
        });
      }
    }
    return out;
  }, [obj]);
  if (rows.length === 0) return null;
  return (
    <Section title={`Backends (${rows.length})`} collapsible defaultOpen>
      <ul className="divide-y divide-line/60">
        {rows.map((r, i) => (
          <li key={i} className="px-3 py-2 grid grid-cols-[2fr_1fr_2fr_minmax(60px,_auto)] items-center gap-3 text-xs">
            <span className="font-mono truncate text-fg" title={r.host ?? "*"}>
              {r.isDefault ? <span className="chip chip-info mr-1.5">default</span> : null}
              {r.host ?? "*"}
            </span>
            <span className="font-mono text-fg-mute truncate" title={r.path ?? "/"}>
              {r.path ?? "/"}
              {r.pathType && <span className="ml-1 text-[10px] text-fg-mute/70">{r.pathType}</span>}
            </span>
            <LinkCell
              target={{ group: "core", version: "v1", resource: "services", namespace: ns, name: r.service }}
              className="font-mono text-xs"
              title={`${ns}/${r.service}`}
            >
              {r.service}
            </LinkCell>
            <span className="font-mono text-xs text-fg-soft text-right">:{r.port ?? "?"}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// PodSecuritySection — render the three Pod Security admission modes
// (enforce / audit / warn) as chips on the Namespace summary, the way
// Lens does. The labels live in metadata, so this is a one-pass scan
// over `obj.metadata.labels`. If no PSA labels are set, the section
// stays collapsed-by-default to avoid a wall of "—" lines.
function PodSecuritySection({ obj }: { obj: any }) {
  const labels = (obj?.metadata?.labels ?? {}) as Record<string, string>;
  const modes: Array<{ key: "enforce" | "audit" | "warn"; level?: string; version?: string }> = [
    { key: "enforce", level: labels["pod-security.kubernetes.io/enforce"], version: labels["pod-security.kubernetes.io/enforce-version"] },
    { key: "audit",   level: labels["pod-security.kubernetes.io/audit"],   version: labels["pod-security.kubernetes.io/audit-version"] },
    { key: "warn",    level: labels["pod-security.kubernetes.io/warn"],    version: labels["pod-security.kubernetes.io/warn-version"] },
  ];
  const present = modes.filter((m) => m.level);
  if (present.length === 0) return null;
  return (
    <Section title="Pod Security Admission" collapsible defaultOpen>
      <ul className="divide-y divide-line/60">
        {present.map((m) => (
          <li key={m.key} className="px-3 py-1.5 flex items-center gap-2 text-xs">
            <span className="font-mono text-fg-mute uppercase tracking-wider w-[60px]">{m.key}</span>
            <span className={clsx("chip", m.level === "restricted" ? "chip-ok" : m.level === "baseline" ? "chip-info" : m.level === "privileged" ? "chip-warn" : undefined)}>
              {m.level}
            </span>
            {m.version && <span className="text-fg-mute font-mono ml-1">{m.version}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// RelatedSection — kubectl-describe-style "related objects" surface. For
// the focused resource we resolve a small adjacency list (owners,
// children, label-selected backends) and render each related row as a
// LinkCell into the detail panel. The watches are conditional on kind so
// opening a Service detail doesn't trigger a cluster-wide ReplicaSet
// stream just to be safe.
function RelatedSection({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const kind = obj?.kind ?? "";
  const ns = obj?.metadata?.namespace ?? "";
  const uid = obj?.metadata?.uid ?? "";
  const name = obj?.metadata?.name ?? "";

  const wantsPods = ["Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Node"].includes(kind);
  const wantsRS = kind === "Deployment" || kind === "Pod";
  const wantsJobs = kind === "CronJob" || kind === "Pod";
  const wantsServices = kind === "Pod";
  // Service watches scope to single ns where possible; Pod-related Service
  // lookups need cluster-wide because services from another namespace can
  // technically still target a pod via cross-namespace ExternalName etc.,
  // but the common case is same-ns selectors. Restrict to ns to keep cost
  // bounded on huge clusters.

  const pods = useResourceList(cluster, "/v1/Pod", ns || undefined, { enabled: wantsPods });
  const rss = useResourceList(cluster, "apps/v1/ReplicaSet", ns || undefined, { enabled: wantsRS });
  const jobs = useResourceList(cluster, "batch/v1/Job", ns || undefined, { enabled: wantsJobs });
  const services = useResourceList(cluster, "/v1/Service", ns || undefined, { enabled: wantsServices });

  const groups = useMemo(() => buildRelated(kind, uid, name, ns, obj, {
    pods: pods.items as any[],
    rss: rss.items as any[],
    jobs: jobs.items as any[],
    services: services.items as any[],
  }), [kind, uid, name, ns, obj, pods.items, rss.items, jobs.items, services.items]);

  if (groups.length === 0) return null;
  return (
    <Section title="Related" collapsible defaultOpen>
      <div className="divide-y divide-line/60">
        {groups.map((g) => (
          <RelatedGroup key={g.label} group={g} />
        ))}
      </div>
    </Section>
  );
}

interface RelatedItem {
  kind: string;
  group: string;
  version: string;
  resource: string;
  namespace?: string;
  name: string;
  /** Optional 1-line subtitle, typically a status string. */
  subtitle?: string;
  /** Optional severity tint for the dot ("ok" / "warn" / "bad" / "mute"). */
  tone?: "ok" | "warn" | "bad" | "mute";
  /** ISO creation stamp; powers the Age column + sort. */
  creationTimestamp?: string;
  /** Numeric stand-in for the subtitle so "status" sort is meaningful for
   *  e.g. replica counts (3/3 > 0/0) or pod phase (Running > Failed). When
   *  absent the sort falls back to lexicographic on subtitle. */
  statusKey?: number;
}

interface RelatedGroupT {
  label: string;
  items: RelatedItem[];
}

type SortColumn = "name" | "status" | "age";
type SortState = { col: SortColumn; dir: "asc" | "desc" };

// Default to "Age asc" — small numbers in the age column at the top, so
// recently-created objects sit above old ones. Matches Lens and the
// Deploy Revisions tab inline above this section.
const DEFAULT_SORT: SortState = { col: "age", dir: "asc" };
// First click direction per column — re-clicking the same column flips it.
const DEFAULT_DIR: Record<SortColumn, "asc" | "desc"> = {
  name: "asc",   // A → Z
  status: "desc", // healthiest first (3/3 RS, Running pods)
  age: "asc",    // youngest first (small "1m" above "3d")
};

function RelatedGroup({ group }: { group: RelatedGroupT }) {
  // Per-group sort persists per device so the user's last choice on
  // "ReplicaSets" doesn't get reset every time they reopen the panel.
  // Other groups (Pods, Jobs, …) keep their own keys via the same hook.
  const [sort, setSort] = usePersistedState<SortState>(
    `related.sort.${group.label}`,
    DEFAULT_SORT,
  );
  const sorted = useMemo(() => sortRelated(group.items, sort), [group.items, sort]);
  const onSort = (col: SortColumn) => {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: DEFAULT_DIR[col] },
    );
  };
  const limit = 25;
  const shown = sorted.slice(0, limit);
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-fg-mute">
        {group.label} <span className="text-fg-mute/70">· {group.items.length}</span>
      </div>
      <RelatedSortBar sort={sort} onSort={onSort} />
      <ul>
        {shown.map((r) => (
          <li key={`${r.kind}/${r.namespace ?? ""}/${r.name}`}>
            <RelatedRow item={r} />
          </li>
        ))}
        {sorted.length > limit && (
          <li className="px-3 py-1.5 text-xs text-fg-mute">+{sorted.length - limit} more</li>
        )}
      </ul>
    </div>
  );
}

// Layout shared by header + every row — keeps Status/Age columns aligned
// across rows even when names wrap to different widths.
//   [dot] [kind chip] [name + ns]  [status]  [age]
const RELATED_GRID = "grid-cols-[8px_auto_minmax(0,1fr)_auto_46px]";

function RelatedSortBar({ sort, onSort }: { sort: SortState; onSort: (c: SortColumn) => void }) {
  return (
    <div className={clsx(
      "grid items-center gap-2 px-3 pb-1 text-[10px] uppercase tracking-wider text-fg-mute/70",
      RELATED_GRID,
    )}>
      <span aria-hidden />
      <span aria-hidden />
      <SortHeaderBtn label="Name"   active={sort.col === "name"}   dir={sort.dir} onClick={() => onSort("name")} />
      <SortHeaderBtn label="Status" active={sort.col === "status"} dir={sort.dir} onClick={() => onSort("status")} className="text-right" />
      <SortHeaderBtn label="Age"    active={sort.col === "age"}    dir={sort.dir} onClick={() => onSort("age")} className="text-right" />
    </div>
  );
}

function SortHeaderBtn({
  label, active, dir, onClick, className,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-0.5 select-none transition-colors hover:text-fg",
        active && "text-fg",
        className,
      )}
      title={`Sort by ${label.toLowerCase()}${active ? ` (${dir})` : ""}`}
    >
      {className?.includes("text-right") && <span className="ml-auto">{label}</span>}
      {!className?.includes("text-right") && <span>{label}</span>}
      <ChevronDown
        size={9}
        className={clsx(
          "transition-transform shrink-0",
          !active && "opacity-30",
          // Default chevron points down (asc — small/recent at top).
          // Flip it for desc so the arrow visually agrees with the column's
          // value ordering.
          active && dir === "desc" && "rotate-180",
        )}
      />
    </button>
  );
}

function RelatedRow({ item }: { item: RelatedItem }) {
  const [, setSearchParams] = useSearchParams();
  // Subscribe to the 1Hz module ticker so the age cell re-renders in place
  // every second without forcing the parent group to recompute its sort.
  useNowTick();
  const tone =
    item.tone === "bad" ? "bg-bad" :
    item.tone === "warn" ? "bg-warn" :
    item.tone === "ok" ? "bg-ok" :
    "bg-fg-mute";
  const ageStr = item.creationTimestamp ? age(item.creationTimestamp) : "";
  const open = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", refToQuery({
        group: item.group, version: item.version, resource: item.resource,
        namespace: item.namespace, name: item.name,
      }));
      next.delete("tab");
      return next;
    });
  };
  return (
    <button
      type="button"
      onClick={open}
      className={clsx(
        "w-full text-left px-3 py-1.5 text-sm hover:bg-bg-mute grid items-center gap-2",
        RELATED_GRID,
      )}
    >
      <span className={clsx("h-2 w-2 rounded-sm shrink-0", tone)} />
      <span className="chip shrink-0 !h-4 !text-[9px] !px-1">{item.kind}</span>
      <span className="min-w-0 inline-flex items-baseline gap-2">
        <span className="text-accent truncate">{item.name}</span>
        {item.namespace && (
          <span className="text-fg-mute text-xs truncate">{item.namespace}</span>
        )}
      </span>
      <span className="justify-self-end text-fg-mute text-xs tabular-nums">
        {item.subtitle ?? ""}
      </span>
      <span className="justify-self-end text-fg-mute text-xs tabular-nums">
        {ageStr}
      </span>
    </button>
  );
}

function sortRelated(items: RelatedItem[], sort: SortState): RelatedItem[] {
  // Stable copy — the original is upstream React state and must not mutate.
  const arr = items.slice();
  const sign = sort.dir === "asc" ? 1 : -1;
  arr.sort((a, b) => sign * compareBy(a, b, sort.col));
  return arr;
}

function compareBy(a: RelatedItem, b: RelatedItem, col: SortColumn): number {
  if (col === "name") return a.name.localeCompare(b.name);
  if (col === "age") {
    // We compare *age* (duration), not timestamp. asc → youngest first
    // (small "1m" above "3d"), so the column reads top-to-bottom as
    // increasing numbers — mirrors kubectl's `Age` column visually.
    // Missing stamps sort to the bottom regardless of direction.
    const ta = a.creationTimestamp ? Date.parse(a.creationTimestamp) : NaN;
    const tb = b.creationTimestamp ? Date.parse(b.creationTimestamp) : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    // age = now - ts; comparing ages directly is equivalent to (tb - ta).
    return tb - ta;
  }
  // status — prefer numeric statusKey when both have one, else string fallback
  const ka = a.statusKey, kb = b.statusKey;
  if (typeof ka === "number" && typeof kb === "number") return ka - kb;
  return (a.subtitle ?? "").localeCompare(b.subtitle ?? "");
}

function buildRelated(
  kind: string,
  uid: string,
  name: string,
  ns: string,
  obj: any,
  data: { pods: any[]; rss: any[]; jobs: any[]; services: any[] },
): RelatedGroupT[] {
  const groups: RelatedGroupT[] = [];
  const ownedBy = (uidSet: Set<string>) => (it: any) =>
    (it.metadata?.ownerReferences ?? []).some((o: any) => uidSet.has(o.uid));

  if (kind === "Deployment") {
    const ownedRS = data.rss.filter(ownedBy(new Set([uid])));
    const rsUids = new Set(ownedRS.map((r) => r.metadata?.uid).filter(Boolean));
    const ownedPods = data.pods.filter(ownedBy(rsUids));
    if (ownedRS.length > 0) groups.push({ label: "ReplicaSets", items: ownedRS.map(rsItem) });
    if (ownedPods.length > 0) groups.push({ label: "Pods", items: ownedPods.map(podItem) });
  } else if (kind === "StatefulSet" || kind === "DaemonSet" || kind === "ReplicaSet") {
    const ownedPods = data.pods.filter(ownedBy(new Set([uid])));
    if (ownedPods.length > 0) groups.push({ label: "Pods", items: ownedPods.map(podItem) });
    if (kind === "ReplicaSet") {
      const dep = (obj?.metadata?.ownerReferences ?? []).find((o: any) => o.controller && o.kind === "Deployment");
      if (dep) groups.push({ label: "Owner", items: [{ kind: "Deployment", group: "apps", version: "v1", resource: "deployments", namespace: ns, name: dep.name }] });
    }
  } else if (kind === "Job") {
    const ownedPods = data.pods.filter(ownedBy(new Set([uid])));
    if (ownedPods.length > 0) groups.push({ label: "Pods", items: ownedPods.map(podItem) });
    const cron = (obj?.metadata?.ownerReferences ?? []).find((o: any) => o.controller && o.kind === "CronJob");
    if (cron) groups.push({ label: "Owner", items: [{ kind: "CronJob", group: "batch", version: "v1", resource: "cronjobs", namespace: ns, name: cron.name }] });
  } else if (kind === "CronJob") {
    const ownedJobs = data.jobs.filter(ownedBy(new Set([uid])));
    const jobUids = new Set(ownedJobs.map((j) => j.metadata?.uid).filter(Boolean));
    const ownedPods = data.pods.filter(ownedBy(jobUids));
    if (ownedJobs.length > 0) groups.push({ label: "Jobs", items: ownedJobs.map(jobItem) });
    if (ownedPods.length > 0) groups.push({ label: "Pods", items: ownedPods.map(podItem) });
  } else if (kind === "Service") {
    const selector = obj?.spec?.selector;
    if (selector && Object.keys(selector).length > 0) {
      const matched = data.pods.filter((p) => labelMatches(p?.metadata?.labels ?? {}, selector));
      if (matched.length > 0) groups.push({ label: "Backed by Pods", items: matched.map(podItem) });
    }
  } else if (kind === "Pod") {
    const owner = (obj?.metadata?.ownerReferences ?? []).find((o: any) => o.controller)
              ?? (obj?.metadata?.ownerReferences ?? [])[0];
    if (owner) {
      groups.push({ label: "Controller", items: [ownerItem(owner, ns)] });
    }
    // Services that select this pod
    const labels = obj?.metadata?.labels ?? {};
    const matched = data.services.filter((s) => {
      const sel = s?.spec?.selector;
      if (!sel || Object.keys(sel).length === 0) return false;
      return labelMatches(labels, sel);
    });
    if (matched.length > 0) {
      groups.push({
        label: "Selected by Services",
        items: matched.map((s) => ({
          kind: "Service",
          group: "core",
          version: "v1",
          resource: "services",
          namespace: s.metadata?.namespace,
          name: s.metadata?.name,
          subtitle: s.spec?.type,
          tone: "ok" as const,
          creationTimestamp: s.metadata?.creationTimestamp,
        })),
      });
    }
  } else if (kind === "Node") {
    const here = data.pods.filter((p) => p?.spec?.nodeName === name);
    if (here.length > 0) groups.push({ label: "Pods scheduled here", items: here.map(podItem) });
  }

  return groups;
}

function labelMatches(labels: Record<string, string>, selector: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

function ownerItem(owner: any, namespace?: string): RelatedItem {
  const apiVersion = owner.apiVersion ?? "v1";
  const slash = apiVersion.indexOf("/");
  const group = slash >= 0 ? apiVersion.slice(0, slash) : "core";
  const version = slash >= 0 ? apiVersion.slice(slash + 1) : apiVersion;
  const resource = pluraliseLocal(owner.kind);
  return {
    kind: owner.kind,
    group,
    version,
    resource,
    namespace: owner.kind === "Node" ? undefined : namespace,
    name: owner.name,
  };
}

// Phase rank: higher = "more alive". Drives the Status-column sort so
// Running pods cluster at the top in desc order, Failed/Unknown at the
// bottom — mirrors what the user usually wants to see first.
const POD_PHASE_RANK: Record<string, number> = {
  Running: 5, Succeeded: 4, Pending: 3, Failed: 2, Unknown: 1,
};

function podItem(p: any): RelatedItem {
  const phase = p?.status?.phase;
  const tone =
    phase === "Running" || phase === "Succeeded" ? "ok" :
    phase === "Pending" ? "warn" :
    phase === "Failed" || phase === "Unknown" ? "bad" :
    "mute";
  return {
    kind: "Pod",
    group: "core",
    version: "v1",
    resource: "pods",
    namespace: p?.metadata?.namespace,
    name: p?.metadata?.name,
    subtitle: phase,
    tone,
    creationTimestamp: p?.metadata?.creationTimestamp,
    statusKey: POD_PHASE_RANK[phase ?? ""] ?? 0,
  };
}

function rsItem(r: any): RelatedItem {
  const desired = Number(r?.spec?.replicas ?? 0);
  const ready = Number(r?.status?.readyReplicas ?? 0);
  return {
    kind: "ReplicaSet",
    group: "apps",
    version: "v1",
    resource: "replicasets",
    namespace: r?.metadata?.namespace,
    name: r?.metadata?.name,
    subtitle: `${ready}/${desired}`,
    tone: ready === desired && desired > 0 ? "ok" : ready === 0 ? "mute" : "warn",
    creationTimestamp: r?.metadata?.creationTimestamp,
    // Sort by ready primarily, then desired — so 3/3 > 1/3 > 0/3 > 0/0.
    // The 1000× weighting gives ready dominance up to thousands of replicas
    // before desired ever matters as a tiebreaker.
    statusKey: ready * 1000 + desired,
  };
}

function jobItem(j: any): RelatedItem {
  const succeeded = Number(j?.status?.succeeded ?? 0);
  const failed = Number(j?.status?.failed ?? 0);
  const completions = Number(j?.spec?.completions ?? 1);
  const tone = failed > 0 ? "bad" : succeeded === completions ? "ok" : "warn";
  return {
    kind: "Job",
    group: "batch",
    version: "v1",
    resource: "jobs",
    namespace: j?.metadata?.namespace,
    name: j?.metadata?.name,
    subtitle: `${succeeded}/${completions}${failed > 0 ? ` · ${failed} failed` : ""}`,
    tone,
    creationTimestamp: j?.metadata?.creationTimestamp,
    // Penalise failures so they sink in desc order; otherwise sort by
    // forward progress (succeeded count).
    statusKey: succeeded * 1000 - failed,
  };
}

function pluraliseLocal(kind: string): string {
  const k = kind.toLowerCase();
  if (k.endsWith("s")) return k + "es";
  if (k.endsWith("y")) return k.slice(0, -1) + "ies";
  return k + "s";
}

function FavouriteToggle({
  cluster, gvr, namespace, name, kind,
}: {
  cluster: string;
  gvr: GVR;
  namespace?: string;
  name: string;
  kind: string;
}) {
  // Subscribe to the favourites store so the star reflects changes from
  // anywhere — sidebar removal, another tab toggling the same resource.
  useSyncExternalStore(favSubscribe, favSnapshotRef);
  const ref = { cluster, group: gvr.group, version: gvr.version, resource: gvr.resource, namespace, name };
  const pinned = favIsPinned(ref);
  return (
    <IconBtn
      active={pinned}
      onClick={() => favToggle({ ...ref, kind })}
      title={pinned ? "Unpin from favourites" : "Pin to favourites"}
    >
      <Star size={14} className={clsx(pinned && "fill-current")} />
    </IconBtn>
  );
}

function prettyKind(gvr: GVR): string {
  const r = gvr.resource;
  if (!r) return "Resource";
  // Resource is plural lowercase (e.g. "deployments"); the kind we want is
  // PascalCase singular ("Deployment"). Drop trailing 's'/'es'/'ies' as a
  // heuristic, then capitalise. Good enough for the favourites chip — the
  // detail panel has already loaded `data.kind` for the authoritative form.
  let s = r;
  if (s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.endsWith("ses")) s = s.slice(0, -2);
  else if (s.endsWith("s")) s = s.slice(0, -1);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// CopyKubectlMenu — Lens-style "I'm just here for the kubectl command"
// affordance. A popover with the most common verbs (get -o yaml, describe,
// logs, exec, port-forward); clicking any one copies the shell-ready
// command with the cluster's context. We never store kubectl context names
// — pass `--context=<cluster>` so the copied line works against whatever
// kubeconfig the developer happens to have loaded.
function CopyKubectlMenu({
  cluster, namespace, name, kind, resource, isPod,
}: {
  cluster: string;
  namespace?: string;
  name: string;
  kind: string;
  resource: string;
  isPod: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 240) });
    setOpen((v) => !v);
  };

  const ns = namespace ? `-n ${shellQuote(namespace)} ` : "";
  const ctx = `--context=${shellQuote(cluster)}`;
  // Prefer Kind (proper case) when known; resource (plural lowercase) is
  // the URL form which kubectl also accepts but reads less naturally.
  const k = (kind || singularFromResource(resource)).toLowerCase();
  const target = `${k} ${shellQuote(name)}`;
  const items: Array<{ label: string; cmd: string }> = [
    { label: "kubectl get -o yaml", cmd: `kubectl ${ctx} ${ns}get ${target} -o yaml` },
    { label: "kubectl describe", cmd: `kubectl ${ctx} ${ns}describe ${target}` },
    { label: "kubectl edit",     cmd: `kubectl ${ctx} ${ns}edit ${target}` },
    { label: "kubectl delete",   cmd: `kubectl ${ctx} ${ns}delete ${target}` },
  ];
  if (isPod) {
    items.push(
      { label: "kubectl logs -f",       cmd: `kubectl ${ctx} ${ns}logs -f ${shellQuote(name)}` },
      { label: "kubectl logs --previous", cmd: `kubectl ${ctx} ${ns}logs --previous ${shellQuote(name)}` },
      { label: "kubectl exec -it sh",   cmd: `kubectl ${ctx} ${ns}exec -it ${shellQuote(name)} -- sh` },
      { label: "kubectl port-forward",  cmd: `kubectl ${ctx} ${ns}port-forward ${shellQuote(name)} LOCAL_PORT:POD_PORT` },
    );
  }

  const copy = async (cmd: string) => {
    if (await copyToClipboard(cmd)) notify_.ok("kubectl command copied", cmd);
    else notify_.bad("Clipboard write failed", "Try selecting the menu item and copying manually.");
    setOpen(false);
  };

  return (
    <>
      <IconBtn ref={btnRef} active={open} onClick={toggle} title="Copy kubectl command">
        <Copy size={14} />
      </IconBtn>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[1500] min-w-[260px] rounded-md border border-line bg-bg-soft py-1 text-xs shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
          style={{ left: pos.left, top: pos.top }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              className="w-full text-left px-3 py-1.5 text-fg-soft hover:text-fg hover:bg-bg-mute font-mono text-[11px] truncate"
              title={it.cmd}
              onClick={() => copy(it.cmd)}
            >
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function shellQuote(s: string): string {
  // Single-quote everything; escape embedded single quotes the POSIX way.
  // Suffices for kubectl arguments (cluster names, pod names, etc.) — none
  // contain newlines or characters that would break a single-quoted token.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function singularFromResource(r: string): string {
  if (r.endsWith("ies")) return r.slice(0, -3) + "y";
  if (r.endsWith("ses")) return r.slice(0, -2);
  if (r.endsWith("s")) return r.slice(0, -1);
  return r;
}

// Thin separator between the header's icon groups.
function HeaderDivider() {
  return <span className="mx-1 h-5 w-px bg-line shrink-0" aria-hidden />;
}

// forwardRef so callers like CopyKubectlMenu can anchor a popover to the
// real <button>. Without the ref the menu's `btnRef` stayed null and its
// `toggle` early-returned — that's why "Copy kubectl command" did nothing.
const IconBtn = forwardRef<HTMLButtonElement, {
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}>(function IconBtn({ active, danger, onClick, title, children }, ref) {
  return (
    <button
      ref={ref}
      className={clsx(
        "h-7 w-7 rounded-md flex items-center justify-center transition-colors",
        active && "bg-accent/15 text-accent",
        !active && !danger && "text-fg-soft hover:text-fg hover:bg-bg-mute",
        !active && danger && "text-fg-soft hover:text-bad hover:bg-bad/10",
      )}
      onClick={onClick}
      title={title}
      aria-pressed={active || undefined}
    >
      {children}
    </button>
  );
});

function SummaryTab({ obj }: { obj: any }) {
  const labels = obj?.metadata?.labels ?? {};
  const annotations = obj?.metadata?.annotations ?? {};
  const owners = obj?.metadata?.ownerReferences ?? [];
  const custom = customViewFor(obj);
  return (
    <div className="p-5 overflow-y-auto h-full text-sm space-y-5">
      {custom}
      <Section title="Metadata">
        <div className="space-y-1.5">
          <KV k="Name" v={obj.metadata.name} />
          <KV k="Namespace" v={obj.metadata.namespace ?? "—"} />
          <KV k="UID" v={obj.metadata.uid} mono />
          <KV k="Resource version" v={obj.metadata.resourceVersion} mono />
          <KV k="Created" v={`${obj.metadata.creationTimestamp} (${age(obj.metadata.creationTimestamp)})`} />
          {obj.metadata.deletionTimestamp && <KV k="Deletion" v={obj.metadata.deletionTimestamp} />}
          {owners.length > 0 && (
            <KV k="Owner" v={<OwnerLinks owners={owners} namespace={obj.metadata.namespace} />} />
          )}
        </div>
      </Section>

      <Section title={`Labels (${Object.keys(labels).length})`} collapsible defaultOpen>
        <KVList map={labels} emptyText="no labels" />
      </Section>

      <Section title={`Annotations (${Object.keys(annotations).length})`} collapsible defaultOpen={Object.keys(annotations).length <= 6}>
        <KVList map={annotations} emptyText="no annotations" wrapValues />
      </Section>

      {obj.spec && typeof obj.spec === "object" && !Array.isArray(obj.spec)
        && Object.keys(obj.spec).length > 0 && (
        <SpecSection spec={obj.spec} defaultOpen={!custom} />
      )}

      {(obj.kind === "Secret" || obj.kind === "ConfigMap") && (
        <DataSection obj={obj} />
      )}

      {(obj.kind === "Secret" || obj.kind === "ConfigMap") && (
        <MountedBySection obj={obj} />
      )}

      {TOPOLOGY_KINDS.has(obj.kind) && (
        <Section title="Topology" collapsible defaultOpen>
          <div className="p-3"><TopologyGraph obj={obj} /></div>
        </Section>
      )}

      <RelatedSection obj={obj} />

      {obj.kind === "Service" && <ServiceEndpointsSection obj={obj} />}
      {/* Ingress backends now rendered as a customView (top of SummaryTab) */}
      {obj.kind === "Namespace" && <PodSecuritySection obj={obj} />}
      {obj.kind === "NetworkPolicy" && (
        <Section title="Graph" collapsible defaultOpen>
          <div className="p-3"><NetworkPolicyGraph obj={obj} /></div>
        </Section>
      )}

      {METRIC_KINDS.has(obj.kind) && (
        <Section title="Metrics" collapsible defaultOpen>
          <div className="p-3">
            <WorkloadMetrics obj={obj} />
          </div>
        </Section>
      )}

      {obj.status && (
        <Section title="Status">
          <StatusView status={obj.status} />
        </Section>
      )}
    </div>
  );
}

// SpecSection — renders `.spec` as read-only YAML. Built-in kinds get
// purpose-built summaries above, but CRD instances (and any kind we don't
// special-case) would otherwise show nothing about what they actually
// declare unless you opened the YAML tab — the gap the user hit. We use a
// light <pre> (not Monaco) so the Summary tab stays cheap to render.
function SpecSection({ spec, defaultOpen }: { spec: unknown; defaultOpen: boolean }) {
  const yaml = useMemo(() => {
    try {
      return YAML.stringify(spec, { indent: 2, lineWidth: 0 });
    } catch {
      return String(spec);
    }
  }, [spec]);
  return (
    <Section title="Spec (YAML)" collapsible defaultOpen={defaultOpen}>
      <pre className="px-3 py-2 text-[12px] leading-[18px] font-mono text-fg-soft overflow-x-auto max-h-[420px] overflow-y-auto whitespace-pre">
        {yaml}
      </pre>
    </Section>
  );
}

// MountedBySection — reverse lookup for a ConfigMap / Secret: every pod in
// the same namespace that consumes it, as a volume, an envFrom, or an env
// valueFrom. Answers "what breaks if I change this?" from the resource's
// own panel instead of grepping pod specs.
function podConsumesResource(pod: any, name: string, isSecret: boolean): string | null {
  const spec = pod?.spec ?? {};
  for (const v of spec.volumes ?? []) {
    if (isSecret ? v?.secret?.secretName === name : v?.configMap?.name === name) return "volume";
    for (const s of v?.projected?.sources ?? []) {
      if (isSecret ? s?.secret?.name === name : s?.configMap?.name === name) return "volume";
    }
  }
  const all = [...(spec.containers ?? []), ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])];
  for (const c of all) {
    for (const ef of c?.envFrom ?? []) {
      if (isSecret ? ef?.secretRef?.name === name : ef?.configMapRef?.name === name) return "envFrom";
    }
    for (const e of c?.env ?? []) {
      const vf = e?.valueFrom;
      if (isSecret ? vf?.secretKeyRef?.name === name : vf?.configMapKeyRef?.name === name) return "env";
    }
  }
  return null;
}

function MountedBySection({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const ns: string | undefined = obj?.metadata?.namespace;
  const name: string = obj?.metadata?.name ?? "";
  const isSecret = obj?.kind === "Secret";
  const { items: pods } = useResourceList(cluster, "/v1/Pod", ns, { enabled: !!cluster && !!ns });
  const users = useMemo(() => {
    const out: { pod: any; via: string }[] = [];
    for (const p of pods) {
      const via = podConsumesResource(p, name, isSecret);
      if (via) out.push({ pod: p, via });
    }
    return out.sort((a, b) => (a.pod.metadata?.name ?? "").localeCompare(b.pod.metadata?.name ?? ""));
  }, [pods, name, isSecret]);

  return (
    <Section title={`Mounted by (${users.length})`} collapsible defaultOpen={users.length > 0}>
      {users.length === 0 ? (
        <div className="px-3 py-2 text-fg-mute text-xs">
          No pods in this namespace reference this {isSecret ? "Secret" : "ConfigMap"}.
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {users.map(({ pod, via }) => (
            <li key={pod.metadata?.uid ?? pod.metadata?.name} className="px-3 py-1.5 flex items-center gap-2">
              <LinkCell
                target={{ group: "core", version: "v1", resource: "pods", namespace: ns, name: pod.metadata.name }}
                className="font-mono text-xs"
              >
                {pod.metadata.name}
              </LinkCell>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-fg-mute">{via}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// DataSection — shows ConfigMap/Secret payload entries as a Lens-style list.
// Secret values are base64-decoded on display and hidden behind an eye toggle
// (per-row and a "Reveal all" / "Hide all" master at the top). ConfigMap data
// is plain-text already, ConfigMap binaryData stays masked because it isn't
// guaranteed to be UTF-8. Long values get a "..." expand inside a scroller
// so a 4 KB cert doesn't blow up the layout.
function DataSection({ obj }: { obj: any }) {
  const isSecret = obj.kind === "Secret";
  const data: Record<string, string> = obj.data ?? {};
  const binaryData: Record<string, string> = obj.binaryData ?? {};
  const keys = [...Object.keys(data), ...Object.keys(binaryData)].sort();
  const [revealAll, setRevealAll] = useState(!isSecret);
  // Word-wrap for long single-line values (helm release blobs, certs, …)
  // so you can read them instead of scrolling forever right. Persisted
  // and default-off, same contract as the log viewer's Wrap toggle.
  const [wrap, setWrap] = usePersistedState<boolean>("k8s-view:data:wrap", false);
  if (keys.length === 0) {
    return (
      <Section title="Data">
        <div className="px-3 py-2 text-fg-mute text-xs">no data</div>
      </Section>
    );
  }
  return (
    <Section title={`Data (${keys.length})`}>
      <div className="flex items-center justify-between border-b border-line/60 px-3 py-1.5 text-[11px]">
        <span className="text-fg-mute">
          {isSecret ? `Secret type: ${obj.type ?? "Opaque"}` : "ConfigMap"}
        </span>
        <div className="flex items-center gap-3">
          <button
            className={clsx("inline-flex items-center gap-1 hover:text-fg", wrap ? "text-accent" : "text-fg-soft")}
            onClick={() => setWrap((v) => !v)}
            title={wrap ? "Disable word wrap" : "Wrap long values instead of scrolling sideways"}
          >
            <WrapText size={12} />
            <span>Wrap</span>
          </button>
          {isSecret && (
            <button
              className="text-fg-soft hover:text-fg inline-flex items-center gap-1"
              onClick={() => setRevealAll((v) => !v)}
              title={revealAll ? "Hide all values" : "Reveal all values"}
            >
              {revealAll ? <EyeOff size={12} /> : <Eye size={12} />}
              <span>{revealAll ? "Hide all" : "Reveal all"}</span>
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-line/60">
        {keys.map((k) => (
          <DataRow
            key={k}
            name={k}
            raw={data[k] ?? binaryData[k] ?? ""}
            kind={k in binaryData ? "binary" : (isSecret ? "base64" : "plain")}
            forceReveal={revealAll}
            wrap={wrap}
          />
        ))}
      </ul>
    </Section>
  );
}

function DataRow({
  name, raw, kind, forceReveal, wrap,
}: {
  name: string;
  raw: string;
  kind: "plain" | "base64" | "binary";
  forceReveal: boolean;
  wrap: boolean;
}) {
  const [revealed, setRevealed] = useState(forceReveal);
  const [expanded, setExpanded] = useState(false);
  const [showJwt, setShowJwt] = useState(false);
  useEffect(() => { setRevealed(forceReveal); }, [forceReveal]);
  const decoded = useMemo(() => decodeForDisplay(raw, kind), [raw, kind]);
  const jwt = useMemo(() => (decoded.binary ? null : tryParseJwt(decoded.text)), [decoded]);
  const showSensitiveMask = kind !== "plain" && !revealed;
  const isBinary = kind === "binary" || decoded.binary;
  const value = showSensitiveMask
    ? "•".repeat(Math.min(40, decoded.length || 40))
    : decoded.text;
  const lineCount = value.split("\n").length;
  const collapsible = lineCount > 4 || value.length > 240;
  const visible = !collapsible || expanded ? value : value.slice(0, 240) + (value.length > 240 ? " …" : "");
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="font-mono text-xs text-fg flex-1 min-w-0 break-all">
          <span className="text-fg-mute mr-1">{name}</span>
          {isBinary && <span className="chip ml-1">binary · {decoded.length}B</span>}
          {jwt && <span className="chip chip-info ml-1">JWT</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0 text-fg-mute">
          {jwt && (
            <button
              className={clsx("hover:text-fg p-0.5", showJwt && "text-accent")}
              onClick={() => setShowJwt((v) => !v)}
              title={showJwt ? "Hide decoded JWT" : "Decode JWT (header/payload)"}
            >
              <KeyRound size={13} />
            </button>
          )}
          {kind !== "plain" && !isBinary && (
            <button
              className="hover:text-fg p-0.5"
              onClick={() => setRevealed((v) => !v)}
              title={revealed ? "Hide value" : "Reveal value"}
            >
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          )}
          <button
            className="hover:text-fg p-0.5"
            onClick={() => copyToClipboard(decoded.text)}
            title="Copy decoded value"
          >
            <Copy size={13} />
          </button>
        </div>
      </div>
      {!isBinary && !showJwt && (
        <pre
          className={clsx(
            "font-mono text-[11px] leading-snug mt-1 px-2 py-1 rounded bg-bg border border-line/60",
            wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto",
            collapsible && !expanded && "max-h-[88px] overflow-y-hidden",
          )}
        >
          {visible}
        </pre>
      )}
      {showJwt && jwt && <JwtView jwt={jwt} />}
      {collapsible && !isBinary && !showJwt && (
        <button
          className="text-[11px] text-fg-mute hover:text-fg mt-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Collapse" : `Show all (${lineCount} lines)`}
        </button>
      )}
    </li>
  );
}

// JwtView — renders header/payload as pretty JSON. We never verify the
// signature client-side — without the issuer's public key we couldn't,
// and Lens explicitly skips it too. The viewer's value is letting the
// user read which audience/expiry/sub the token has without decoding it
// in another tab.
function JwtView({ jwt }: { jwt: { header: any; payload: any; signature: string } }) {
  const expSec: number | undefined = typeof jwt.payload?.exp === "number" ? jwt.payload.exp : undefined;
  const iatSec: number | undefined = typeof jwt.payload?.iat === "number" ? jwt.payload.iat : undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = expSec !== undefined && expSec < nowSec;
  return (
    <div className="mt-1.5 space-y-2">
      <div className="rounded border border-line/60 bg-bg overflow-hidden">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-mute border-b border-line/60 flex items-center justify-between">
          <span>Header</span>
          <span>{String(jwt.header?.alg ?? "?")}</span>
        </div>
        <pre className="font-mono text-[11px] leading-snug px-2 py-1 overflow-x-auto">
          {JSON.stringify(jwt.header, null, 2)}
        </pre>
      </div>
      <div className="rounded border border-line/60 bg-bg overflow-hidden">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-mute border-b border-line/60 flex items-center gap-2">
          <span>Payload</span>
          {iatSec !== undefined && <span className="text-fg-mute/70">iat: {new Date(iatSec * 1000).toISOString()}</span>}
          {expSec !== undefined && (
            <span className={clsx(expired ? "text-bad" : "text-fg-mute/70")}>
              exp: {new Date(expSec * 1000).toISOString()}{expired && " (expired)"}
            </span>
          )}
        </div>
        <pre className="font-mono text-[11px] leading-snug px-2 py-1 overflow-x-auto">
          {JSON.stringify(jwt.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// JWTs are three base64url-encoded JSON segments separated by dots. The
// signature segment we keep as raw bytes — verification needs a key, and
// even without it the segment count alone is enough to filter false
// positives like "abc.def".
function tryParseJwt(text: string): { header: any; payload: any; signature: string } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  // Quick alphabet sanity check; blocks "config.cluster.local"-style noise.
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const header = JSON.parse(b64urlToString(parts[0]));
    const payload = JSON.parse(b64urlToString(parts[1]));
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
    if (!header.alg) return null;
    return { header, payload, signature: parts[2] };
  } catch {
    return null;
  }
}

function b64urlToString(s: string): string {
  // Re-pad and translate URL-safe alphabet, then UTF-8 decode the bytes.
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function decodeForDisplay(raw: string, kind: "plain" | "base64" | "binary"): { text: string; length: number; binary: boolean } {
  if (kind === "plain") {
    return { text: raw, length: raw.length, binary: false };
  }
  // base64 → bytes → utf-8 with replacement; if the input contained non-text
  // bytes, surface that as `binary` so we don't dump a stream of replacement
  // chars on the user's screen.
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let nonPrintable = 0;
    for (const b of bytes) {
      if (b !== 9 && b !== 10 && b !== 13 && (b < 32 || b === 127)) nonPrintable++;
    }
    const binary = nonPrintable > Math.max(8, bytes.length * 0.05);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { text, length: bytes.length, binary };
  } catch {
    return { text: raw, length: raw.length, binary: true };
  }
}

function Section({
  title, children, collapsible, defaultOpen = true,
}: { title: string; children: any; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div className="flex items-center mb-1.5">
        {collapsible ? (
          <button
            className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-fg-mute font-semibold hover:text-fg"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown size={11} className={clsx("transition-transform", !open && "-rotate-90")} />
            {title}
          </button>
        ) : (
          <div className="text-[11px] uppercase tracking-wider text-fg-mute font-semibold">{title}</div>
        )}
      </div>
      {(!collapsible || open) && (
        <div className="rounded-md border border-line bg-bg-soft">{children}</div>
      )}
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: any; mono?: boolean }) {
  // Allow ReactNode values (used for Owner links etc.) — only stringify when
  // the value is a primitive so accidental `[object Object]` renders are
  // impossible. Anything else (string/number/bigint) goes through String().
  const isPrimitive = v === null || v === undefined
    || typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean";
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 px-3 first:pt-3 last:pb-3">
      <div className="text-fg-mute">{k}</div>
      <div className={clsx("min-w-0 break-all", mono && "font-mono text-xs")}>
        {isPrimitive ? String(v ?? "—") : v}
      </div>
    </div>
  );
}

// OwnerLinks — Lens-style "Kind name" inline links for an object's
// ownerReferences. Lets the user step from a ReplicaSet up to its
// Deployment, or from a Job up to its CronJob, without leaving the side
// panel. Renders as plain text + accent link (NOT chip-style) so case
// stays mixed and the actual owner name is readable inline — the
// previous chip rendered "DEPLOYMENT/COREDNS" all-caps, hiding the name
// inside an uppercased blob.
function OwnerLinks({ owners, namespace }: { owners: any[]; namespace?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {owners.map((o, i) => {
        const target = ownerToRef(o, namespace);
        return (
          <span key={i} className="inline-flex items-center gap-1.5 min-w-0">
            <span className="text-fg-mute text-xs">{o.kind}</span>
            {target ? (
              <LinkCell target={target} className="text-accent hover:underline truncate max-w-[280px]" title={o.name}>
                {o.name}
              </LinkCell>
            ) : (
              <span className="text-fg-soft truncate max-w-[280px]" title={o.name}>{o.name}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// KVList — renders a map of key/value as a clean two-column list with
// per-row truncation, copy-to-clipboard, and click-to-expand on long
// values. Replaces the old inline chip wall, which broke layout for
// large/base64 annotation values.
function KVList({
  map, emptyText, wrapValues,
}: { map: Record<string, string>; emptyText: string; wrapValues?: boolean }) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) {
    return <div className="px-3 py-2 text-fg-mute text-xs">{emptyText}</div>;
  }
  return (
    <ul className="divide-y divide-line/60">
      {keys.map((k) => (
        <KVRow key={k} k={k} v={map[k]} wrap={!!wrapValues} />
      ))}
    </ul>
  );
}

function KVRow({ k, v, wrap }: { k: string; v: string; wrap: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = (v?.length ?? 0) > 120;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copyToClipboard(`${k}=${v}`).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <li className="grid grid-cols-[minmax(140px,260px)_1fr_28px] gap-2 px-3 py-1.5 items-start text-xs">
      <div className="font-mono text-fg-soft break-all leading-snug">{k}</div>
      <div
        className={clsx(
          "font-mono text-fg leading-snug",
          long && "cursor-pointer hover:text-accent",
          expanded ? "break-all" : "truncate",
          wrap && expanded && "whitespace-pre-wrap",
        )}
        title={long && !expanded ? v : undefined}
        onClick={() => long && setExpanded((s) => !s)}
      >
        {v || <span className="text-fg-mute italic">empty</span>}
      </div>
      <button
        className="opacity-40 hover:opacity-100 text-fg-mute hover:text-fg justify-self-end"
        title="Copy"
        onClick={copy}
      >
        {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
      </button>
    </li>
  );
}

// StatusView — renders the resource's `.status` block using friendly
// summaries (replicas, phase, conditions, addresses) instead of a raw
// JSON dump. Anything we don't have a recognizer for is shown as a
// folded JSON tree, so no information is lost — just better defaults.
function StatusView({ status }: { status: any }) {
  if (!status || typeof status !== "object") {
    return <div className="px-3 py-2 text-fg-mute text-xs">no status</div>;
  }

  const summaryKeys = [
    "phase", "qosClass", "hostIP", "podIP", "startTime",
    "replicas", "readyReplicas", "availableReplicas", "updatedReplicas",
    "unavailableReplicas", "fullyLabeledReplicas", "currentReplicas",
    "observedGeneration", "currentRevision", "updateRevision", "collisionCount",
    "numberAvailable", "numberReady", "currentNumberScheduled",
    "desiredNumberScheduled", "numberMisscheduled", "numberUnavailable",
    "active", "succeeded", "failed", "completionTime",
    "lastScheduleTime", "lastSuccessfulTime", "loadBalancer",
    "capacity", "allocatable",
  ];

  const summary: { k: string; v: any }[] = [];
  for (const k of summaryKeys) {
    if (status[k] !== undefined && !isObjectish(status[k])) {
      summary.push({ k, v: status[k] });
    }
  }
  // Pod IPs / addresses
  const podIPs = Array.isArray(status.podIPs) ? status.podIPs.map((x: any) => x.ip).filter(Boolean) : [];
  const addresses = Array.isArray(status.addresses) ? status.addresses : [];

  const conditions: any[] = Array.isArray(status.conditions) ? status.conditions : [];
  const cs: any[] = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
  const ics: any[] = Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : [];

  // Whatever wasn't covered above goes into "Other".
  const handled = new Set<string>([
    ...summaryKeys, "podIPs", "addresses", "conditions",
    "containerStatuses", "initContainerStatuses", "hostIPs",
  ]);
  const otherEntries = Object.entries(status).filter(([k]) => !handled.has(k));

  return (
    <div className="divide-y divide-line/60">
      {summary.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 px-3 py-2.5 text-xs">
          {summary.map(({ k, v }) => (
            <div key={k} className="flex items-center gap-2 min-w-0">
              <span className="text-fg-mute truncate">{humanize(k)}</span>
              <span className="font-mono text-fg truncate">{formatValue(v)}</span>
            </div>
          ))}
        </div>
      )}

      {(podIPs.length > 0 || addresses.length > 0) && (
        <div className="px-3 py-2 text-xs space-y-1">
          {podIPs.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-fg-mute">Pod IPs</span>
              <span className="font-mono text-fg">{podIPs.join(", ")}</span>
            </div>
          )}
          {addresses.map((a: any, i: number) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-fg-mute">{a.type}</span>
              <span className="font-mono text-fg">{a.address}</span>
            </div>
          ))}
        </div>
      )}

      {conditions.length > 0 && <Conditions list={conditions} />}

      {ics.length > 0 && <ContainerList title="Init containers" list={ics} />}
      {cs.length > 0 && <ContainerList title="Containers" list={cs} />}

      {otherEntries.length > 0 && (
        <details className="px-3 py-2 text-xs">
          <summary className="cursor-pointer text-fg-mute hover:text-fg select-none">
            Raw status ({otherEntries.length} more {otherEntries.length === 1 ? "field" : "fields"})
          </summary>
          <pre className="mt-2 font-mono text-[11px] whitespace-pre-wrap break-all bg-bg p-3 rounded border border-line max-h-[40vh] overflow-auto">
            {JSON.stringify(Object.fromEntries(otherEntries), null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function Conditions({ list }: { list: any[] }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-mute font-semibold mb-1.5">Conditions</div>
      <ul className="space-y-1">
        {list.map((c, i) => {
          const ok = c.status === "True";
          const isError = c.status === "False" && (c.type === "Ready" || c.type === "Available" || c.type === "ContainersReady");
          const cls = ok ? "chip-ok" : isError ? "chip-bad" : c.status === "Unknown" ? "chip-warn" : "chip";
          return (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={clsx(cls, "shrink-0")}>{c.status}</span>
              <span className="font-medium text-fg shrink-0 min-w-[140px]">{c.type}</span>
              <div className="flex-1 min-w-0">
                {c.reason && <span className="text-fg-soft">{c.reason}</span>}
                {c.message && <span className="text-fg-mute"> · {c.message}</span>}
              </div>
              <span className="text-fg-mute font-mono text-[10px] shrink-0">
                {age(c.lastTransitionTime ?? c.lastProbeTime)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ContainerList({ title, list }: { title: string; list: any[] }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-mute font-semibold mb-1.5">{title}</div>
      <ul className="space-y-1">
        {list.map((c) => {
          const state = c.state ? Object.keys(c.state)[0] : "unknown";
          const stateKind = state === "running" ? "chip-ok" : state === "terminated" ? "chip-bad" : "chip-warn";
          const reason = c.state?.waiting?.reason ?? c.state?.terminated?.reason;
          return (
            <li key={c.name} className="flex items-center gap-2 text-xs">
              <span className={clsx("shrink-0", stateKind)}>{state}</span>
              <span className="font-medium text-fg truncate min-w-0">{c.name}</span>
              {reason && <span className="text-fg-soft">{reason}</span>}
              <span className="ml-auto text-fg-mute font-mono">
                {c.ready ? "ready" : "not ready"} · restarts {c.restartCount ?? 0}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function isObjectish(v: any) {
  return v !== null && typeof v === "object";
}

function humanize(k: string) {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
}

function formatValue(v: any) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return "—";
  return String(v);
}

function YAMLTab({
  cluster, obj, gvr, namespace, name, onSaved,
}: { cluster: string; obj: any; gvr: GVR; namespace: string | null; name: string; onSaved: () => void }) {
  const original = useMemo(() => YAML.stringify(stripManaged(obj)), [obj?.metadata?.uid]);
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Reset when the object identity changes.
  useEffect(() => { setText(original); setShowDiff(false); }, [original]);

  const dirty = text !== original;
  const onApply = async () => {
    setBusy(true); setErr(null);
    try {
      await api.applyResource(cluster, gvr, namespace, name, text);
      setShowDiff(false);
      onSaved();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-line flex items-center gap-2 text-xs text-fg-mute">
        <span>{showDiff ? "Reviewing diff before apply" : "Editing as YAML — Save will server-side apply."}</span>
        <div className="ml-auto flex items-center gap-2">
          {showDiff ? (
            <>
              <button className="btn h-7" disabled={busy} onClick={() => setShowDiff(false)}>
                Back to editor
              </button>
              <button className="btn-primary h-7" disabled={busy} onClick={onApply}>
                {busy ? "Applying…" : "Apply changes"}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn h-7"
                disabled={busy || !dirty}
                title={dirty ? "Review what will change before applying" : "No changes to review"}
                onClick={() => setShowDiff(true)}
              >
                Review diff
              </button>
              <button
                className="btn-primary h-7"
                disabled={busy || !dirty}
                onClick={onApply}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
      {err && <div className="px-4 py-2 text-bad text-sm border-b border-line">{err}</div>}
      <div className="flex-1">
        {showDiff ? (
          <YAMLDiffEditor original={original} modified={text} height="100%" />
        ) : (
          <YAMLEditor value={text} onChange={setText} />
        )}
      </div>
    </div>
  );
}

function stripManaged(o: any) {
  if (!o) return o;
  const c = JSON.parse(JSON.stringify(o));
  if (c.metadata) {
    delete c.metadata.managedFields;
    delete c.metadata.generation;
    delete c.metadata.selfLink;
  }
  delete c.status;
  return c;
}

// EventsTab — events for the focused object PLUS its owned descendants.
// kubectl-describe-style propagation: a Deployment's "events" really means
// events on the Deployment + the ReplicaSets it owns + the Pods those RS
// own. Without that walk-up, the Events tab on a Deployment with a stuck
// pull would show nothing while the Pod underneath kept screaming.
function EventsTab({
  cluster, ns, uid, kind, name,
}: {
  cluster: string;
  ns: string;
  uid?: string;
  kind?: string;
  name?: string;
}) {
  const { data } = useQuery({
    enabled: !!cluster && !!ns,
    queryKey: ["events", cluster, ns],
    queryFn: () => api.events(cluster, ns),
    refetchInterval: 5000,
  });

  const descendantInfo = useDescendantUIDs(cluster, ns, kind ?? "", uid ?? "");
  const matchSet = useMemo(() => {
    const s = new Set<string>();
    if (uid) s.add(uid);
    for (const u of descendantInfo.uids) s.add(u);
    return s;
  }, [uid, descendantInfo.uids]);

  const items = useMemo(() => {
    const all = (data?.items ?? []) as any[];
    if (!uid && !name) return all;
    // Primary match by uid (set by every modern kubelet/controller). Fall
    // back to kind/name for events whose involvedObject pre-dates the uid
    // (e.g. NodeNotReady fired by an older kubelet, or replayed events
    // after etcd compaction).
    return all.filter((e) => {
      const u = e.involvedObject?.uid;
      if (u && matchSet.has(u)) return true;
      const k = e.involvedObject?.kind;
      const n = e.involvedObject?.name;
      if (k === kind && n === name) return true;
      return false;
    });
  }, [data, matchSet, kind, name, uid]);

  // Newest first — kubernetes returns events in arbitrary order.
  const sorted = useMemo(() => {
    const arr = items.slice();
    arr.sort((a, b) => eventTime(b) - eventTime(a));
    return arr;
  }, [items]);

  const childCount = descendantInfo.uids.size;
  return (
    <div className="p-3 overflow-y-auto h-full">
      {childCount > 0 && (
        <div className="mb-2 text-[11px] text-fg-mute">
          Including events from {descendantInfo.summary}.
        </div>
      )}
      {sorted.length === 0 && <div className="text-fg-mute text-sm">no events</div>}
      <ul className="space-y-1">
        {sorted.map((e) => (
          <li key={e.metadata.uid} className="rounded-md border border-line bg-bg-soft p-3">
            <div className="flex items-center gap-2 text-xs">
              <span className={clsx("chip", e.type === "Warning" ? "chip-warn" : "chip-info")}>{e.type}</span>
              <span className="font-medium">{e.reason}</span>
              <span className="text-fg-mute">×{e.count ?? 1}</span>
              <span className="ml-auto text-fg-mute">{age(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}</span>
            </div>
            <div className="mt-1 text-sm">{e.message}</div>
            <div className="mt-0.5 text-xs text-fg-mute">
              from {e.source?.component ?? e.reportingComponent ?? "?"} on {e.involvedObject?.kind}/{e.involvedObject?.name}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function eventTime(e: any): number {
  const ts = e?.lastTimestamp ?? e?.eventTime ?? e?.metadata?.creationTimestamp;
  return ts ? new Date(ts).getTime() : 0;
}

// useDescendantUIDs — walk owner chains within the same namespace and
// return the set of object uids that should also count as "this object's
// events". The walking is one-shot (per render): k8s ownerReferences are
// already direct parent-pointers, so a single sweep over the in-memory
// pod/rs/job lists is enough — no recursion needed. Empty set for kinds
// that have no children of interest (Pod, ConfigMap, Service, …).
function useDescendantUIDs(cluster: string, ns: string, kind: string, uid: string): { uids: Set<string>; summary: string } {
  const wantsPods = ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"].includes(kind);
  const wantsRS = kind === "Deployment";
  const wantsJobs = kind === "CronJob";

  const pods = useResourceList(cluster, "/v1/Pod", ns, { enabled: wantsPods && !!ns && ns !== "_all" });
  const rss = useResourceList(cluster, "apps/v1/ReplicaSet", ns, { enabled: wantsRS && !!ns && ns !== "_all" });
  const jobs = useResourceList(cluster, "batch/v1/Job", ns, { enabled: wantsJobs && !!ns && ns !== "_all" });

  return useMemo(() => {
    const uids = new Set<string>();
    if (!uid || !kind) return { uids, summary: "" };
    const pickByOwner = (items: any[], parents: Set<string>) => items.filter((it) =>
      (it.metadata?.ownerReferences ?? []).some((o: any) => parents.has(o.uid)));
    let podCount = 0;
    let rsCount = 0;
    let jobCount = 0;
    if (kind === "Deployment") {
      const ownedRS = pickByOwner(rss.items as any[], new Set([uid]));
      const rsUids = new Set<string>();
      for (const r of ownedRS) {
        const u = r.metadata?.uid;
        if (!u) continue;
        uids.add(u);
        rsUids.add(u);
        rsCount++;
      }
      const ownedPods = pickByOwner(pods.items as any[], rsUids);
      for (const p of ownedPods) {
        const u = p.metadata?.uid;
        if (u) {
          uids.add(u);
          podCount++;
        }
      }
    } else if (kind === "StatefulSet" || kind === "DaemonSet" || kind === "ReplicaSet" || kind === "Job") {
      const ownedPods = pickByOwner(pods.items as any[], new Set([uid]));
      for (const p of ownedPods) {
        const u = p.metadata?.uid;
        if (u) {
          uids.add(u);
          podCount++;
        }
      }
    } else if (kind === "CronJob") {
      const ownedJobs = pickByOwner(jobs.items as any[], new Set([uid]));
      const jobUids = new Set<string>();
      for (const j of ownedJobs) {
        const u = j.metadata?.uid;
        if (!u) continue;
        uids.add(u);
        jobUids.add(u);
        jobCount++;
      }
      const ownedPods = pickByOwner(pods.items as any[], jobUids);
      for (const p of ownedPods) {
        const u = p.metadata?.uid;
        if (u) {
          uids.add(u);
          podCount++;
        }
      }
    }
    const parts: string[] = [];
    if (rsCount > 0) parts.push(`${rsCount} ReplicaSet${rsCount === 1 ? "" : "s"}`);
    if (jobCount > 0) parts.push(`${jobCount} Job${jobCount === 1 ? "" : "s"}`);
    if (podCount > 0) parts.push(`${podCount} Pod${podCount === 1 ? "" : "s"}`);
    return { uids, summary: parts.join(", ") };
  }, [pods.items, rss.items, jobs.items, uid, kind]);
}
