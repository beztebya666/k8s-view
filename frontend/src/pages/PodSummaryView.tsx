// PodSummaryView — rich Lens-style summary for a Pod. Lives next to
// ResourceDetailPage's generic SummaryTab and is used in its place when the
// resource is a /v1/Pod.
//
// Top: metric tabs (CPU / Memory / Network / Filesystem) — they currently
// render a "Metrics not available at the moment" placeholder because we do
// not yet have a per-pod time-series source. The strip is in place so the
// information architecture matches Lens; wiring real numbers later is a
// drop-in change.
//
// Below the metrics we render a two-column key/value list (Created, Name,
// Namespace, Labels, Controlled By, Status, Node, Pod IP/IPs, Service
// Account, Priority Class, QoS, Conditions, Tolerations, Affinities) and a
// per-container card list with their own metric strip, image, ports
// (with port-forward), and environment.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as YAML from "yaml";
import clsx from "clsx";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ExternalLink } from "lucide-react";
import { age } from "../lib/format";
import { useApp } from "../stores/app";
import { containerDisplayStatus, podDisplayStatus, podStatusClassName, type PodStatusKind } from "../lib/podStatus";
import { WorkloadMetrics } from "../components/charts/WorkloadMetrics";

type Pod = any;

export function PodSummaryView({ obj }: { obj: Pod }) {
  const goRef = useDetailNavigator();
  const labels = obj?.metadata?.labels ?? {};
  const meta = obj.metadata ?? {};
  const spec = obj.spec ?? {};
  const status = obj.status ?? {};
  const cs: any[] = status.containerStatuses ?? [];
  const ics: any[] = status.initContainerStatuses ?? [];
  const containers: any[] = spec.containers ?? [];
  const initContainers: any[] = spec.initContainers ?? [];
  const owners: any[] = meta.ownerReferences ?? [];
  const podIPs: string[] = (Array.isArray(status.podIPs)
    ? status.podIPs.map((x: any) => x.ip).filter(Boolean)
    : status.podIP
      ? [status.podIP]
      : []);
  const conditions: any[] = Array.isArray(status.conditions) ? status.conditions : [];
  const tolerations: any[] = Array.isArray(spec.tolerations) ? spec.tolerations : [];
  const affinity = spec.affinity ?? null;
  const podUiStatus = podDisplayStatus(obj);

  // Pair each container spec with its status so a single card has everything
  // we need to render.
  const containerRows = useMemo(() => containers.map((c) => ({
    spec: c, status: cs.find((s) => s.name === c.name),
  })), [containers, cs]);
  const initContainerRows = useMemo(() => initContainers.map((c) => ({
    spec: c, status: ics.find((s) => s.name === c.name),
  })), [initContainers, ics]);

  return (
    <div className="overflow-y-auto h-full text-sm">
      <PodMetricStrip pod={obj} />

      <div className="px-5 py-4 space-y-1.5">
        <KV k="Created" v={
          <span>
            {age(meta.creationTimestamp)} ago{" "}
            <span className="text-fg-mute">{meta.creationTimestamp}</span>
          </span>
        } />
        <KV k="Name" v={meta.name} />
        <KV k="Namespace" v={meta.namespace ?? "—"} />

        <KVRow k="Labels">
          <LabelChips map={labels} />
        </KVRow>

        <KVRow k="Controlled By">
          <OwnerChain ns={meta.namespace} owners={owners} goRef={goRef} />
        </KVRow>

        <KV k="Status" v={
          <span className={podStatusClassName(podUiStatus.kind)} title={podUiStatus.detail}>
            {podUiStatus.label}
          </span>
        } />
        <KVRow k="Node">
          {spec.nodeName ? (
            <DetailLink
              goRef={goRef}
              target={{ group: "core", version: "v1", resource: "nodes", name: spec.nodeName }}
            >
              {spec.nodeName}
            </DetailLink>
          ) : <span className="text-fg-mute">—</span>}
        </KVRow>
        <KV k="Pod IP" v={status.podIP ?? "—"} />
        <KVRow k="Pod IPs">
          {podIPs.length === 0 ? <span className="text-fg-mute">—</span> : (
            <div className="flex flex-wrap gap-1">
              {podIPs.map((ip) => <span key={ip} className="chip">{ip}</span>)}
            </div>
          )}
        </KVRow>
        <KVRow k="Service Account">
          {spec.serviceAccountName ? (
            <DetailLink
              goRef={goRef}
              target={{ group: "core", version: "v1", resource: "serviceaccounts", namespace: meta.namespace, name: spec.serviceAccountName }}
            >
              {spec.serviceAccountName}
            </DetailLink>
          ) : <span className="text-fg-mute">default</span>}
        </KVRow>
        <KVRow k="Priority Class">
          {spec.priorityClassName ? (
            <DetailLink
              goRef={goRef}
              target={{ group: "scheduling.k8s.io", version: "v1", resource: "priorityclasses", name: spec.priorityClassName }}
            >
              {spec.priorityClassName}
            </DetailLink>
          ) : <span className="text-fg-mute">—</span>}
        </KVRow>
        <KV k="QoS Class" v={status.qosClass ?? "—"} />

        <KVRow k="Conditions">
          {conditions.length === 0 ? <span className="text-fg-mute">—</span> : (
            <div className="flex flex-wrap gap-1">
              {conditions.map((c, i) => (
                <span
                  key={i}
                  className={clsx(
                    "chip cursor-help",
                    c.status === "True" && "chip-ok",
                    c.status === "False" && "chip-bad",
                    c.status === "Unknown" && "chip-warn",
                  )}
                  title={[
                    `${c.type} = ${c.status}`,
                    c.reason && `reason: ${c.reason}`,
                    c.message && `message: ${c.message}`,
                    c.lastTransitionTime && `since: ${c.lastTransitionTime}`,
                  ].filter(Boolean).join("\n")}
                >
                  {c.type}
                </span>
              ))}
            </div>
          )}
        </KVRow>

        <KVRow k="Tolerations">
          <TolerationsBlock list={tolerations} />
        </KVRow>

        <KVRow k="Affinities">
          <AffinitiesBlock affinity={affinity} />
        </KVRow>
      </div>

      {initContainerRows.length > 0 && (
        <ContainerSection title="Init Containers" rows={initContainerRows} pod={obj} />
      )}
      <ContainerSection title="Containers" rows={containerRows} pod={obj} />
    </div>
  );
}

// --- Layout primitives -------------------------------------------------

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 items-baseline">
      <div className="text-fg-mute text-xs">{k}</div>
      <div className="min-w-0 break-words">{v}</div>
    </div>
  );
}

function KVRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 items-start">
      <div className="text-fg-mute text-xs pt-0.5">{k}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function LabelChips({ map }: { map: Record<string, string> }) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return <span className="text-fg-mute">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {keys.map((k) => (
        <span key={k} className="chip" title={`${k}=${map[k]}`}>
          {k}={map[k]}
        </span>
      ))}
    </div>
  );
}

// --- Owner chain (Controlled By) ---------------------------------------

// OwnerChain — render the controllerRef chain. Many pods are owned by a
// ReplicaSet which is itself owned by a Deployment / Job; the screenshot
// shows all the rungs as separate clickable chips ("ReplicaSet, Job, Job"
// with a tooltip naming `helm-install-traefik`). Each chip opens that owner
// in the side detail panel; from there the user can step further up the
// chain.
function OwnerChain({
  ns, owners, goRef,
}: {
  ns?: string; owners: any[]; goRef: (r: DetailRef) => void;
}) {
  if (!owners || owners.length === 0) return <span className="text-fg-mute">—</span>;
  // Lens-style: render "Kind name" inline so the user sees the actual owner
  // name (e.g. "Deployment coredns") without having to hover for a tooltip
  // or click through. The previous chip-only ("REPLICASET") version was the
  // bug the user spotted — uppercase from the .chip class plus no name.
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {owners.map((o, i) => (
        <span key={`${o.kind}/${o.uid ?? o.name ?? i}`} className="inline-flex items-center gap-1.5">
          <span className="text-fg-mute text-xs">{o.kind}</span>
          <button
            type="button"
            className="text-accent hover:underline truncate max-w-[280px]"
            title={o.name}
            onClick={() => goRef({
              group: groupOfApiVersion(o.apiVersion),
              version: versionOfApiVersion(o.apiVersion),
              resource: pluraliseKind(o.kind),
              namespace: ns,
              name: o.name,
            })}
          >
            {o.name}
          </button>
        </span>
      ))}
    </div>
  );
}

type DetailRef = {
  group: string;
  version: string;
  resource: string;
  namespace?: string;
  name: string;
};

// useDetailNavigator — return a callback that mutates the current URL's `?d=`
// parameter, opening the side detail panel without leaving the current page.
function useDetailNavigator() {
  const [, setParams] = useSearchParams();
  return useCallback((r: DetailRef) => {
    const enc = (s: string) => encodeURIComponent(s);
    const d = r.namespace
      ? `${r.group}/${r.version}/${r.resource}/ns/${enc(r.namespace)}/${enc(r.name)}`
      : `${r.group}/${r.version}/${r.resource}/${enc(r.name)}`;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", d);
      next.delete("tab");
      return next;
    });
  }, [setParams]);
}

function DetailLink({
  goRef, target, children,
}: {
  goRef: (r: DetailRef) => void; target: DetailRef; children: React.ReactNode;
}) {
  return (
    <button
      className="text-accent hover:underline"
      onClick={() => goRef(target)}
    >
      {children}
    </button>
  );
}

// --- Tolerations & Affinities -----------------------------------------

function TolerationsBlock({ list }: { list: any[] }) {
  const [open, setOpen] = useState(false);
  if (!list || list.length === 0) return <span className="text-fg-mute">—</span>;
  return (
    <div className="rounded-md border border-line bg-bg-soft">
      <button
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-bg-mute"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{list.length}</span>
        <span className="text-accent flex items-center gap-1">
          {open ? "Hide" : "Show"}
          <ChevronDown size={11} className={clsx("transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open && (
        <div className="border-t border-line overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-bg">
              <tr className="text-left text-fg-mute">
                <th className="px-3 py-1.5 font-medium">Key</th>
                <th className="px-3 py-1.5 font-medium">Operator</th>
                <th className="px-3 py-1.5 font-medium">Value</th>
                <th className="px-3 py-1.5 font-medium">Effect</th>
                <th className="px-3 py-1.5 font-medium">Seconds</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="px-3 py-1.5 font-mono">{t.key ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono">{t.operator ?? "Equal"}</td>
                  <td className="px-3 py-1.5 font-mono">{t.value ?? ""}</td>
                  <td className="px-3 py-1.5 font-mono">{t.effect ?? ""}</td>
                  <td className="px-3 py-1.5 font-mono">{t.tolerationSeconds ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AffinitiesBlock({ affinity }: { affinity: any }) {
  const [open, setOpen] = useState(false);
  if (!affinity || Object.keys(affinity).length === 0) return <span className="text-fg-mute">—</span>;
  const yaml = useMemo(() => {
    try { return YAML.stringify(affinity); } catch { return JSON.stringify(affinity, null, 2); }
  }, [affinity]);
  return (
    <div className="rounded-md border border-line bg-bg-soft">
      <button
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-bg-mute"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{Object.keys(affinity).length}</span>
        <span className="text-accent flex items-center gap-1">
          {open ? "Hide" : "Show"}
          <ChevronDown size={11} className={clsx("transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open && (
        <pre className="border-t border-line bg-bg p-3 font-mono text-[11px] whitespace-pre overflow-auto max-h-[40vh]">
          {yaml}
        </pre>
      )}
    </div>
  );
}

// --- Metric strip (placeholder) ----------------------------------------

function PodMetricStrip({ pod }: { pod: Pod }) {
  return (
    <div className="px-5 pt-4 pb-3 border-b border-line">
      <WorkloadMetrics obj={pod} />
    </div>
  );
}

function ContainerMetricStrip({ pod, container }: { pod: Pod; container: string }) {
  return (
    <div className="py-2 border-b border-line">
      <WorkloadMetrics obj={pod} container={container} />
    </div>
  );
}

// --- Container cards ---------------------------------------------------

function ContainerSection({
  title, rows, pod,
}: { title: string; rows: { spec: any; status?: any }[]; pod: Pod }) {
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-line bg-bg-soft px-5 py-4">
      <div className="text-[11px] uppercase tracking-wider text-fg-mute font-semibold mb-2">{title}</div>
      <div className="space-y-3">
        {rows.map((r) => (
          <ContainerCard key={r.spec.name} spec={r.spec} status={r.status} pod={pod} />
        ))}
      </div>
    </div>
  );
}

function ContainerCard({ spec, status, pod }: { spec: any; status?: any; pod: Pod }) {
  const ns = pod?.metadata?.namespace ?? "default";
  const podName = pod?.metadata?.name ?? "";
  const kubeStatus = containerDisplayStatus(pod, spec.name);
  const stateKey = status?.state ? Object.keys(status.state)[0] : undefined;
  const state = stateKey
    ? { kind: stateKey, ...status.state[stateKey] }
    : { kind: "unknown" };
  const startedAt = state.kind === "running" ? state.startedAt : undefined;

  const ready = !!status?.ready;
  const fallbackStateLabel = state.kind === "unknown"
    ? "unknown"
    : state.kind === "running"
      ? (ready ? "running, ready" : "running, not ready")
      : `${state.kind}${state.reason ? ` (${state.reason})` : ""}`;
  const stateLabel = kubeStatus?.label ?? fallbackStateLabel;
  const stateClass = textClassForStatusKind(kubeStatus?.kind ?? fallbackKindForContainerState(state.kind, ready));

  return (
    <div className="rounded-md border border-line bg-bg">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span
          className={clsx(
            "inline-block h-2 w-2 rounded-sm",
            dotClassForStatusKind(kubeStatus?.kind ?? fallbackKindForContainerState(state.kind, ready)),
          )}
          title={[
            `${spec.name} ${stateLabel}`,
            startedAt && `Started At ${startedAt}`,
          ].filter(Boolean).join("\n")}
        />
        <span className="font-medium">{spec.name}</span>
        <span className={clsx("ml-auto text-xs font-mono", stateClass)} title={kubeStatus?.detail}>{stateLabel}</span>
      </header>

      <ContainerMetricStrip pod={pod} container={spec.name} />

      <div className="p-3 space-y-1.5 text-xs">
        <KV k="Status" v={<span className={stateClass} title={kubeStatus?.detail}>{stateLabel}</span>} />
        {startedAt && <KV k="Started At" v={startedAt} />}
        {state.kind === "terminated" && state.reason && (
          <KV k="Last reason" v={`${state.reason}${state.exitCode !== undefined ? ` (exit ${state.exitCode})` : ""}`} />
        )}
        <KV k="Image" v={<span className="font-mono text-[11px] break-all">{spec.image}</span>} />
        <KV k="Image ID" v={<span className="font-mono text-[11px] break-all text-fg-mute">{status?.imageID ?? "—"}</span>} />

        <KVRow k="Ports">
          <ContainerPorts ports={spec.ports ?? []} ns={ns} podName={podName} />
        </KVRow>

        <KVRow k="Environment">
          <ContainerEnv env={spec.env ?? []} envFrom={spec.envFrom ?? []} />
        </KVRow>

        {(spec.volumeMounts?.length ?? 0) > 0 && (
          <KVRow k="Mounts">
            <div className="space-y-0.5">
              {(spec.volumeMounts ?? []).map((m: any, i: number) => (
                <div key={i} className="font-mono text-[11px]">
                  {m.mountPath} <span className="text-fg-mute">← {m.name}{m.readOnly ? " (ro)" : ""}{m.subPath ? `:${m.subPath}` : ""}</span>
                </div>
              ))}
            </div>
          </KVRow>
        )}
      </div>
    </div>
  );
}

function ContainerPorts({
  ports, ns, podName,
}: { ports: any[]; ns: string; podName: string }) {
  if (!ports || ports.length === 0) return <span className="text-fg-mute">—</span>;
  return (
    <ul className="space-y-1">
      {ports.map((p, i) => {
        const label = `${p.name ? `${p.name}: ` : ""}${p.containerPort}/${p.protocol ?? "TCP"}`;
        return (
          <PortForwardRow
            key={`${p.containerPort}-${p.protocol ?? "TCP"}-${i}`}
            label={label}
            ns={ns}
            podName={podName}
            port={p.containerPort}
            protocol={p.protocol ?? "TCP"}
          />
        );
      })}
    </ul>
  );
}

type PFState = "idle" | "starting" | "ready" | "error" | "closed";

// PortForwardRow — clicking "Forward…" opens a backend port-forward over a
// WebSocket. The server picks an ephemeral local port and reports it back as
// a `ready LOCAL:REMOTE` text frame. We surface that local port as a
// clickable HTTP link so the user can hit the service directly. Closing the
// row tears the WebSocket down so the kubelet stream is cleaned up.
function PortForwardRow({
  label, ns, podName, port, protocol,
}: {
  label: string; ns: string; podName: string; port: number; protocol: string;
}) {
  const cluster = useApp((s) => s.cluster);
  const [state, setState] = useState<PFState>("idle");
  const [localPort, setLocalPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const stop = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setState("idle");
    setLocalPort(null);
    setError(null);
  }, []);

  const start = useCallback(() => {
    if (state !== "idle" && state !== "error" && state !== "closed") return;
    setError(null);
    setState("starting");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${proto}//${window.location.host}/api/v1/${encodeURIComponent(cluster)}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(podName)}/portforward`);
    url.searchParams.set("port", String(port));
    url.searchParams.set("local", "0");
    const ws = new WebSocket(url.toString());
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const m = /^ready\s+(\d+):(\d+)/.exec(ev.data);
      if (m) {
        setLocalPort(Number(m[1]));
        setState("ready");
      } else if (ev.data.startsWith("error:") || ev.data.startsWith("port-forward ended:")) {
        setError(ev.data);
        setState("error");
      }
    };
    ws.onerror = () => {
      setError("connection error");
      setState("error");
    };
    ws.onclose = () => {
      setState((s) => (s === "ready" || s === "starting" ? "closed" : s));
    };
  }, [cluster, ns, podName, port, state]);

  useEffect(() => () => { wsRef.current?.close(); }, []);

  const httpish = protocol === "TCP" && (port === 80 || port === 8080 || port === 443 || port === 3000 || port === 8443 || (port >= 1024 && port < 65536));
  const localUrl = localPort ? `http://localhost:${localPort}` : null;

  return (
    <li className="flex items-center gap-2 flex-wrap">
      <span className="font-mono text-[11px] text-fg">{label}</span>
      {state === "idle" && (
        <button className="btn h-5 px-1.5 text-[10px]" onClick={start} title="Port-forward">
          Forward…
        </button>
      )}
      {state === "starting" && (
        <span className="chip chip-warn">starting…</span>
      )}
      {state === "ready" && localUrl && (
        <>
          <span className="chip chip-ok" title="Forward active">localhost:{localPort}</span>
          {httpish && (
            <a
              className="btn h-5 px-1.5 text-[10px] gap-1"
              href={localUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={localUrl}
            >
              <ExternalLink size={10} /> Open
            </a>
          )}
          <button className="btn h-5 px-1.5 text-[10px]" onClick={stop}>
            Stop
          </button>
        </>
      )}
      {(state === "error" || state === "closed") && (
        <>
          <span className={clsx("chip", state === "error" ? "chip-bad" : "chip-warn")} title={error ?? undefined}>
            {state === "error" ? "error" : "closed"}
          </span>
          <button className="btn h-5 px-1.5 text-[10px]" onClick={start}>Retry</button>
        </>
      )}
    </li>
  );
}

function ContainerEnv({ env, envFrom }: { env: any[]; envFrom: any[] }) {
  const [open, setOpen] = useState(true);
  const total = (env?.length ?? 0) + (envFrom?.length ?? 0);
  if (total === 0) return <span className="text-fg-mute">—</span>;
  return (
    <div className="rounded border border-line bg-bg">
      <button
        className="w-full flex items-center justify-between px-2 py-1 text-[11px] hover:bg-bg-mute"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{total} entries</span>
        <span className="text-accent">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="divide-y divide-line/60">
          {env.map((e, i) => (
            <li key={`e${i}`} className="px-2 py-1 font-mono text-[11px]">
              <span className="text-fg-soft">{e.name}</span>
              <span className="text-fg-mute"> : </span>
              <span className="break-all">
                {e.value !== undefined
                  ? e.value
                  : e.valueFrom
                    ? formatValueFrom(e.valueFrom)
                    : "—"}
              </span>
            </li>
          ))}
          {envFrom.map((e, i) => (
            <li key={`f${i}`} className="px-2 py-1 font-mono text-[11px]">
              <span className="text-fg-mute">envFrom</span>
              <span className="text-fg-mute"> : </span>
              <span className="break-all">
                {e.configMapRef?.name && `configMap/${e.configMapRef.name}`}
                {e.secretRef?.name && `secret/${e.secretRef.name}`}
                {e.prefix && ` prefix=${e.prefix}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatValueFrom(v: any): string {
  if (v.fieldRef) return `fieldRef ${v.fieldRef.fieldPath}`;
  if (v.resourceFieldRef) return `resourceFieldRef ${v.resourceFieldRef.resource}`;
  if (v.configMapKeyRef) return `configMap/${v.configMapKeyRef.name}.${v.configMapKeyRef.key}`;
  if (v.secretKeyRef) return `secret/${v.secretKeyRef.name}.${v.secretKeyRef.key}`;
  return "valueFrom";
}

// --- helpers -----------------------------------------------------------

function fallbackKindForContainerState(kind: string, ready: boolean): PodStatusKind {
  if (kind === "running") return ready ? "ok" : "warn";
  if (kind === "waiting") return "warn";
  if (kind === "terminated") return "bad";
  return "mute";
}

function textClassForStatusKind(kind: PodStatusKind): string {
  if (kind === "ok") return "text-ok";
  if (kind === "warn") return "text-warn";
  if (kind === "bad") return "text-bad";
  if (kind === "info") return "text-info";
  return "text-fg-mute";
}

function dotClassForStatusKind(kind: PodStatusKind): string {
  if (kind === "ok") return "bg-ok";
  if (kind === "warn") return "bg-warn";
  if (kind === "bad") return "bg-bad";
  if (kind === "info") return "bg-accent";
  return "bg-fg-mute/40";
}

function pluraliseKind(kind: string): string {
  if (!kind) return "";
  const k = kind.toLowerCase();
  if (k.endsWith("s")) return k + "es";
  if (k.endsWith("y")) return k.slice(0, -1) + "ies";
  return k + "s";
}

function groupOfApiVersion(av?: string): string {
  if (!av) return "core";
  const i = av.lastIndexOf("/");
  return i < 0 ? "core" : av.slice(0, i);
}

function versionOfApiVersion(av?: string): string {
  if (!av) return "v1";
  const i = av.lastIndexOf("/");
  return i < 0 ? av : av.slice(i + 1);
}
