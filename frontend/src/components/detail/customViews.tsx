// Custom CR detail views for popular operators. Each view is a tiny
// component rendered above the generic Summary so users get a Lens-style
// "I know what this is" experience without us shipping a full Lens
// extension runtime. The selection key is `<apiGroup>/<Kind>` from the
// object — we never trust the spec until we've confirmed the exact GVK.

import { useState } from "react";
import clsx from "clsx";
import { age, bytes, cpuToMillicores, formatMillicores, memToBytes } from "../../lib/format";
import { useResourceList } from "../../lib/useResourceList";
import { useApp } from "../../stores/app";
import { copyToClipboard } from "../../lib/clipboard";

type Renderer = (obj: any) => React.ReactNode;

// Lazy-evaluated registry. Adding a new operator here is a one-line
// change; the SummaryTab consumer doesn't need to learn about specific
// GVKs.
const REGISTRY = new Map<string, Renderer>([
  ["cert-manager.io/Certificate", (o) => <CertManagerCertificate obj={o} />],
  ["cert-manager.io/Issuer", (o) => <CertManagerIssuer obj={o} />],
  ["cert-manager.io/ClusterIssuer", (o) => <CertManagerIssuer obj={o} />],
  ["argoproj.io/Application", (o) => <ArgoApplication obj={o} />],
  ["argoproj.io/AppProject", (o) => <ArgoAppProject obj={o} />],
  ["tekton.dev/TaskRun", (o) => <TektonRun obj={o} kind="TaskRun" />],
  ["tekton.dev/PipelineRun", (o) => <TektonRun obj={o} kind="PipelineRun" />],
  ["velero.io/Backup", (o) => <VeleroBackup obj={o} />],
  ["velero.io/Restore", (o) => <VeleroRestore obj={o} />],
  ["/Namespace", (o) => <NamespaceUsage obj={o} />],
  ["/Secret", (o) => <SecretReveal obj={o} />],
  ["networking.k8s.io/Ingress", (o) => <IngressBackends obj={o} />],
  ["/PersistentVolumeClaim", (o) => <PVCBinding obj={o} />],
  ["/PersistentVolume", (o) => <PVBinding obj={o} />],
  ["storage.k8s.io/StorageClass", (o) => <StorageClassDetail obj={o} />],
]);

export function customViewFor(obj: any): React.ReactNode | null {
  if (!obj || typeof obj.apiVersion !== "string" || typeof obj.kind !== "string") return null;
  const slash = obj.apiVersion.indexOf("/");
  const group = slash >= 0 ? obj.apiVersion.slice(0, slash) : "";
  const key = `${group}/${obj.kind}`;
  const renderer = REGISTRY.get(key);
  if (!renderer) return null;
  try {
    return renderer(obj);
  } catch {
    return null;
  }
}

// --- shared primitives ----------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-fg-mute font-semibold mb-1.5">{title}</div>
      <div className="rounded-md border border-line bg-bg-soft p-3 space-y-1.5">
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 text-sm">
      <div className="text-fg-mute">{label}</div>
      <div className={clsx("min-w-0 break-all", mono && "font-mono text-xs")}>{value ?? "—"}</div>
    </div>
  );
}

function Chip({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "mute"; children: React.ReactNode }) {
  const cls =
    tone === "ok" ? "chip-ok" :
    tone === "warn" ? "chip-warn" :
    tone === "bad" ? "chip-bad" :
    tone === "info" ? "chip-info" :
    "chip";
  return <span className={cls}>{children}</span>;
}

function condStatus(o: any, type: string): "True" | "False" | "Unknown" | undefined {
  const c = (o?.status?.conditions ?? []).find((c: any) => c?.type === type);
  return c?.status;
}

// --- cert-manager ---------------------------------------------------------

function CertManagerCertificate({ obj }: { obj: any }) {
  const ready = condStatus(obj, "Ready");
  const tone = ready === "True" ? "ok" : ready === "False" ? "bad" : "warn";
  const issuer = obj?.spec?.issuerRef;
  const dnsNames: string[] = obj?.spec?.dnsNames ?? [];
  const ips: string[] = obj?.spec?.ipAddresses ?? [];
  const notAfter = obj?.status?.notAfter;
  const notBefore = obj?.status?.notBefore;
  const renewTime = obj?.status?.renewalTime;
  const expired = notAfter && new Date(notAfter).getTime() < Date.now();
  return (
    <Card title="Certificate">
      <Field label="Status" value={<Chip tone={tone}>{ready === "True" ? "Ready" : ready === "False" ? "Not Ready" : "Unknown"}</Chip>} />
      <Field label="Secret" value={<span className="font-mono text-xs">{obj?.spec?.secretName ?? "—"}</span>} />
      <Field label="Issuer" value={<span className="font-mono text-xs">{issuer?.kind ?? "Issuer"}/{issuer?.name ?? "—"}{issuer?.group ? ` (${issuer.group})` : ""}</span>} />
      <Field label="Common Name" value={obj?.spec?.commonName} mono />
      <Field label="DNS Names" value={dnsNames.length === 0 ? "—" : <span className="font-mono text-xs">{dnsNames.join(", ")}</span>} />
      {ips.length > 0 && <Field label="IP Addresses" value={<span className="font-mono text-xs">{ips.join(", ")}</span>} />}
      <Field label="Not Before" value={notBefore} mono />
      <Field
        label="Not After"
        value={notAfter ? <span className={clsx(expired && "text-bad")}>{notAfter}{expired && " (expired)"}</span> : "—"}
      />
      <Field label="Renewal" value={renewTime ? `${renewTime} (${age(renewTime)} from now)` : "—"} />
    </Card>
  );
}

function CertManagerIssuer({ obj }: { obj: any }) {
  const ready = condStatus(obj, "Ready");
  const tone = ready === "True" ? "ok" : ready === "False" ? "bad" : "warn";
  const types = Object.keys(obj?.spec ?? {}).filter((k) => k !== "labels");
  return (
    <Card title="Issuer">
      <Field label="Status" value={<Chip tone={tone}>{ready === "True" ? "Ready" : ready === "False" ? "Not Ready" : "Unknown"}</Chip>} />
      <Field label="Type" value={<span className="font-mono text-xs">{types.join(", ") || "—"}</span>} />
    </Card>
  );
}

// --- ArgoCD ---------------------------------------------------------------

function ArgoApplication({ obj }: { obj: any }) {
  const sync = obj?.status?.sync?.status ?? "Unknown";
  const health = obj?.status?.health?.status ?? "Unknown";
  const syncTone =
    sync === "Synced" ? "ok" :
    sync === "OutOfSync" ? "warn" :
    "mute";
  const healthTone =
    health === "Healthy" ? "ok" :
    health === "Degraded" ? "bad" :
    health === "Progressing" ? "info" :
    health === "Suspended" ? "warn" :
    "mute";
  const src = obj?.spec?.source ?? obj?.spec?.sources?.[0];
  const dest = obj?.spec?.destination;
  const project = obj?.spec?.project;
  const lastSync = obj?.status?.operationState?.finishedAt ?? obj?.status?.history?.[0]?.deployedAt;
  return (
    <Card title="Application">
      <Field label="Sync" value={<Chip tone={syncTone}>{sync}</Chip>} />
      <Field label="Health" value={<Chip tone={healthTone}>{health}</Chip>} />
      <Field label="Project" value={project} mono />
      {src && <Field label="Repo" value={<span className="font-mono text-xs">{src.repoURL}</span>} />}
      {src?.path && <Field label="Path" value={src.path} mono />}
      {src?.targetRevision && <Field label="Revision" value={src.targetRevision} mono />}
      {src?.chart && <Field label="Chart" value={src.chart} mono />}
      {dest && <Field label="Destination" value={<span className="font-mono text-xs">{dest.server ?? "?"} → {dest.namespace ?? "—"}</span>} />}
      {lastSync && <Field label="Last Sync" value={`${lastSync} (${age(lastSync)})`} />}
    </Card>
  );
}

function ArgoAppProject({ obj }: { obj: any }) {
  return (
    <Card title="AppProject">
      <Field label="Description" value={obj?.spec?.description} />
      <Field label="Source repos" value={<span className="font-mono text-xs">{(obj?.spec?.sourceRepos ?? []).join(", ") || "—"}</span>} />
      <Field
        label="Destinations"
        value={
          <span className="font-mono text-xs">
            {(obj?.spec?.destinations ?? []).map((d: any) => `${d.server ?? "?"}/${d.namespace ?? "*"}`).join(", ") || "—"}
          </span>
        }
      />
    </Card>
  );
}

// --- Tekton ---------------------------------------------------------------

function TektonRun({ obj, kind }: { obj: any; kind: "TaskRun" | "PipelineRun" }) {
  const succeeded = condStatus(obj, "Succeeded");
  const reason = (obj?.status?.conditions ?? []).find((c: any) => c?.type === "Succeeded")?.reason;
  const tone =
    reason === "Running" || reason === "Started" ? "info" :
    succeeded === "True" ? "ok" :
    succeeded === "False" ? "bad" :
    "warn";
  const start = obj?.status?.startTime;
  const end = obj?.status?.completionTime;
  const taskRef = obj?.spec?.taskRef;
  const pipelineRef = obj?.spec?.pipelineRef;
  const dur = duration(start, end);
  return (
    <Card title={kind}>
      <Field label="Status" value={<Chip tone={tone}>{reason ?? succeeded ?? "Unknown"}</Chip>} />
      {taskRef && <Field label="Task" value={<span className="font-mono text-xs">{taskRef.name}{taskRef.kind ? ` (${taskRef.kind})` : ""}</span>} />}
      {pipelineRef && <Field label="Pipeline" value={<span className="font-mono text-xs">{pipelineRef.name}</span>} />}
      <Field label="Started" value={start ? `${start} (${age(start)})` : "—"} />
      <Field label="Completed" value={end ?? "—"} />
      <Field label="Duration" value={dur ?? "—"} mono />
    </Card>
  );
}

// --- Velero ---------------------------------------------------------------

function VeleroBackup({ obj }: { obj: any }) {
  const phase = obj?.status?.phase ?? "Unknown";
  const tone =
    phase === "Completed" ? "ok" :
    phase === "PartiallyFailed" ? "warn" :
    phase === "Failed" || phase === "FailedValidation" ? "bad" :
    phase === "InProgress" ? "info" :
    "mute";
  const expiration = obj?.status?.expiration;
  const expired = expiration && new Date(expiration).getTime() < Date.now();
  return (
    <Card title="Backup">
      <Field label="Phase" value={<Chip tone={tone}>{phase}</Chip>} />
      <Field label="Storage Location" value={obj?.spec?.storageLocation} mono />
      <Field label="Included NS" value={<span className="font-mono text-xs">{(obj?.spec?.includedNamespaces ?? ["*"]).join(", ")}</span>} />
      <Field label="Excluded NS" value={<span className="font-mono text-xs">{(obj?.spec?.excludedNamespaces ?? []).join(", ") || "—"}</span>} />
      <Field label="Started" value={obj?.status?.startTimestamp} />
      <Field label="Completed" value={obj?.status?.completionTimestamp} />
      <Field
        label="Expiration"
        value={expiration ? <span className={clsx(expired && "text-bad")}>{expiration}{expired && " (expired)"}</span> : "—"}
      />
      <Field label="Items" value={`${obj?.status?.progress?.itemsBackedUp ?? 0} / ${obj?.status?.progress?.totalItems ?? 0}`} mono />
    </Card>
  );
}

function VeleroRestore({ obj }: { obj: any }) {
  const phase = obj?.status?.phase ?? "Unknown";
  const tone =
    phase === "Completed" ? "ok" :
    phase === "PartiallyFailed" ? "warn" :
    phase === "Failed" || phase === "FailedValidation" ? "bad" :
    phase === "InProgress" ? "info" :
    "mute";
  return (
    <Card title="Restore">
      <Field label="Phase" value={<Chip tone={tone}>{phase}</Chip>} />
      <Field label="Backup" value={obj?.spec?.backupName} mono />
      <Field label="Started" value={obj?.status?.startTimestamp} />
      <Field label="Completed" value={obj?.status?.completionTimestamp} />
      <Field label="Warnings" value={String(obj?.status?.warnings ?? 0)} mono />
      <Field label="Errors" value={String(obj?.status?.errors ?? 0)} mono />
    </Card>
  );
}

function duration(start?: string, end?: string): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const ms = Math.max(0, e - s);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSec = seconds - minutes * 60;
  if (minutes < 60) return restSec > 0 ? `${minutes}m${restSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes - hours * 60;
  return restMin > 0 ? `${hours}h${restMin}m` : `${hours}h`;
}


// --- Namespace usage (ResourceQuota + LimitRange) -------------------------

// NamespaceUsage — Lens-style usage bars for the namespace, sourced from
// ResourceQuota objects defined on it (used / hard per resource type) plus
// a small table of LimitRange entries. Renders nothing when neither kind
// is configured for the namespace, so most users never see this card.
function NamespaceUsage({ obj }: { obj: any }) {
  const ns: string = obj?.metadata?.name ?? "";
  const cluster = useApp((s) => s.cluster);
  const quotas = useResourceList(cluster, "/v1/ResourceQuota", ns, { enabled: !!ns });
  const limits = useResourceList(cluster, "/v1/LimitRange", ns, { enabled: !!ns });
  if (!ns) return null;
  if (quotas.items.length === 0 && limits.items.length === 0) return null;
  return (
    <div className="space-y-3">
      {quotas.items.map((q: any) => (
        <ResourceQuotaCard key={q.metadata?.uid ?? q.metadata?.name} quota={q} />
      ))}
      {limits.items.length > 0 && <LimitRangeCard items={limits.items} />}
    </div>
  );
}

function ResourceQuotaCard({ quota }: { quota: any }) {
  const hard: Record<string, string> = quota?.status?.hard ?? quota?.spec?.hard ?? {};
  const used: Record<string, string> = quota?.status?.used ?? {};
  const keys = Object.keys(hard).sort();
  return (
    <Card title={`ResourceQuota · ${quota?.metadata?.name ?? ""}`}>
      {keys.length === 0 && <div className="text-fg-mute text-xs">no limits set</div>}
      {keys.map((k) => {
        const u = used[k];
        const h = hard[k];
        return <QuotaBar key={k} resource={k} used={u} hard={h} />;
      })}
    </Card>
  );
}

function QuotaBar({ resource, used, hard }: { resource: string; used?: string; hard: string }) {
  const u = parseQuotaValue(resource, used ?? "0");
  const h = parseQuotaValue(resource, hard);
  const pct = h > 0 ? Math.min(100, (u / h) * 100) : 0;
  const tone = pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div className="grid grid-cols-[180px_1fr_auto] items-center gap-3 text-xs">
      <span className="text-fg-soft truncate" title={resource}>{resource}</span>
      <div className="h-1.5 rounded-sm bg-bg-mute overflow-hidden">
        <div className={clsx("h-full transition-all", tone)} style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <span className="font-mono text-fg-mute tabular-nums">{formatQuotaValue(resource, u)} / {formatQuotaValue(resource, h)}</span>
    </div>
  );
}

function LimitRangeCard({ items }: { items: any[] }) {
  return (
    <Card title="LimitRange">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-mute border-b border-line/60">
              <th className="py-1 pr-3 font-medium">Type</th>
              <th className="py-1 pr-3 font-medium">Resource</th>
              <th className="py-1 pr-3 font-medium">Min</th>
              <th className="py-1 pr-3 font-medium">Max</th>
              <th className="py-1 pr-3 font-medium">Default</th>
              <th className="py-1 pr-3 font-medium">Default Request</th>
            </tr>
          </thead>
          <tbody>
            {items.flatMap((lr: any) => (lr?.spec?.limits ?? []).flatMap((l: any) => {
              const resources = new Set<string>([
                ...Object.keys(l?.min ?? {}),
                ...Object.keys(l?.max ?? {}),
                ...Object.keys(l?.default ?? {}),
                ...Object.keys(l?.defaultRequest ?? {}),
              ]);
              return [...resources].map((res) => (
                <tr key={`${lr.metadata?.uid}/${l.type}/${res}`} className="border-b border-line/40">
                  <td className="py-1 pr-3 text-fg-soft">{l.type ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono">{res}</td>
                  <td className="py-1 pr-3 font-mono text-fg-mute">{l?.min?.[res] ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-fg-mute">{l?.max?.[res] ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-fg-mute">{l?.default?.[res] ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-fg-mute">{l?.defaultRequest?.[res] ?? "—"}</td>
                </tr>
              ));
            }))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function parseQuotaValue(resource: string, raw: string): number {
  if (!raw) return 0;
  if (resource.includes("cpu")) return cpuToMillicores(raw);
  if (resource.includes("memory") || resource.includes("storage") || resource.includes("ephemeral-storage")) {
    return memToBytes(raw);
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function formatQuotaValue(resource: string, n: number): string {
  if (resource.includes("cpu")) return formatMillicores(n);
  if (resource.includes("memory") || resource.includes("storage") || resource.includes("ephemeral-storage")) {
    return bytes(n);
  }
  return n.toLocaleString();
}



// --- Secret reveal --------------------------------------------------------

// SecretReveal — Lens-style decoder for the data map. Each key starts hidden
// (•••) with a per-key Reveal/Hide toggle plus a Copy-decoded button. Toggle
// "Reveal all" flips them in bulk. binaryData (raw bytes) is shown as
// "<binary, N bytes>" with copy-as-base64 — decoding random bytes to text
// is rarely useful and risks breaking the layout.
function SecretReveal({ obj }: { obj: any }) {
  const data: Record<string, string> = obj?.data ?? {};
  const binary: Record<string, string> = obj?.binaryData ?? {};
  const dataKeys = Object.keys(data).sort();
  const binaryKeys = Object.keys(binary).sort();
  const [revealedAll, setRevealedAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  if (dataKeys.length === 0 && binaryKeys.length === 0) {
    return null;
  }

  const isShown = (k: string) => revealedAll || revealed.has(k);
  const toggle = (k: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const copy = (text: string) => { void copyToClipboard(text); };

  return (
    <Card title={`Secret · ${obj?.type ?? "Opaque"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-fg-mute">
          {dataKeys.length} {dataKeys.length === 1 ? "key" : "keys"}
          {binaryKeys.length > 0 && ` · ${binaryKeys.length} binary`}
          {obj?.immutable && " · immutable"}
        </div>
        <button
          type="button"
          className="text-xs text-accent hover:underline"
          onClick={() => setRevealedAll((v) => !v)}
        >
          {revealedAll ? "Hide all" : "Reveal all"}
        </button>
      </div>
      {dataKeys.map((k) => {
        const decoded = safeDecodeBase64(data[k]);
        return (
          <SecretRow
            key={k}
            keyName={k}
            visible={isShown(k)}
            decoded={decoded}
            raw={data[k]}
            onToggle={() => toggle(k)}
            onCopy={() => copy(decoded ?? data[k])}
          />
        );
      })}
      {binaryKeys.map((k) => (
        <SecretRow
          key={"bin/" + k}
          keyName={k}
          visible={isShown(k)}
          decoded={null}
          raw={binary[k]}
          binaryHint={`<binary, ~${approxBase64Bytes(binary[k])} bytes>`}
          onToggle={() => toggle(k)}
          onCopy={() => copy(binary[k])}
        />
      ))}
    </Card>
  );
}

function SecretRow({
  keyName, visible, decoded, raw, binaryHint, onToggle, onCopy,
}: {
  keyName: string;
  visible: boolean;
  decoded: string | null;
  raw: string;
  binaryHint?: string;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const display = !visible
    ? "•••••••••••••••"
    : binaryHint
      ? binaryHint
      : decoded ?? "<not valid base64>";
  return (
    <div className="grid grid-cols-[180px_1fr_auto_auto] gap-2 items-center text-xs">
      <span className="font-mono text-fg-soft truncate" title={keyName}>{keyName}</span>
      <span className={clsx(
        "font-mono break-all whitespace-pre-wrap min-w-0",
        visible ? "text-fg" : "text-fg-mute select-none",
      )} title={visible && decoded ? decoded : undefined}>
        {display}
      </span>
      <button
        type="button"
        className="text-fg-mute hover:text-fg px-1.5 py-0.5 rounded hover:bg-bg-mute"
        onClick={onToggle}
        title={visible ? "Hide" : "Reveal"}
      >
        {visible ? "Hide" : "Reveal"}
      </button>
      <button
        type="button"
        className="text-fg-mute hover:text-fg px-1.5 py-0.5 rounded hover:bg-bg-mute"
        onClick={onCopy}
        title={binaryHint ? "Copy as base64" : "Copy decoded value"}
      >
        Copy
      </button>
    </div>
  );
}

function safeDecodeBase64(s: string | undefined): string | null {
  if (!s) return "";
  try {
    return atob(s);
  } catch {
    return null;
  }
}

function approxBase64Bytes(s: string | undefined): number {
  if (!s) return 0;
  // Each 4 base64 chars ≈ 3 bytes; padding shaves 1-2.
  const len = s.length;
  const pad = (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor(len * 3 / 4) - pad);
}



// --- Ingress backends graph ----------------------------------------------

// IngressBackends — Lens-style host → path → service → endpoints walker.
// We resolve services by name in the same namespace and tag the row with
// the live ready-endpoint count so a 404 from a misrouted Ingress is one
// glance away. TLS hosts get a small chip alongside the host header.
function IngressBackends({ obj }: { obj: any }) {
  const ns: string = obj?.metadata?.namespace ?? "";
  const cluster = useApp((s) => s.cluster);
  const services = useResourceList(cluster, "/v1/Service", ns, { enabled: !!ns });
  const endpoints = useResourceList(cluster, "/v1/Endpoints", ns, { enabled: !!ns });

  const tlsHosts = new Set<string>(
    (obj?.spec?.tls ?? []).flatMap((t: any) => (t?.hosts ?? []) as string[]),
  );
  const rules: any[] = obj?.spec?.rules ?? [];
  const ingressClass = obj?.spec?.ingressClassName ?? obj?.metadata?.annotations?.["kubernetes.io/ingress.class"];

  const lookupSvc = (name: string) => services.items.find((s: any) => s.metadata?.name === name);
  const lookupEp = (name: string): number => {
    const ep = endpoints.items.find((e: any) => e.metadata?.name === name) as any;
    if (!ep) return 0;
    let count = 0;
    for (const subset of (ep.subsets ?? []) as any[]) {
      count += ((subset?.addresses ?? []) as any[]).length;
    }
    return count;
  };

  if (!rules.length && !obj?.spec?.defaultBackend) return null;

  return (
    <Card title={`Ingress${ingressClass ? ` · ${ingressClass}` : ""}`}>
      {rules.map((rule: any, i: number) => {
        const host = rule?.host ?? "*";
        const paths: any[] = rule?.http?.paths ?? [];
        return (
          <div key={i} className="border border-line/60 rounded-md bg-bg/40 p-2.5 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono text-fg break-all">{host}</span>
              {tlsHosts.has(host) && (
                <span className="chip-info text-[10px]">TLS</span>
              )}
            </div>
            {paths.length === 0 && (
              <div className="text-fg-mute text-xs pl-4">no paths defined</div>
            )}
            {paths.map((p: any, j: number) => {
              const svcName: string = p?.backend?.service?.name ?? "";
              const port = p?.backend?.service?.port?.number ?? p?.backend?.service?.port?.name ?? "—";
              const svc = svcName ? lookupSvc(svcName) : null;
              const ready = svcName ? lookupEp(svcName) : 0;
              const tone = !svc ? "bad" : ready === 0 ? "warn" : "ok";
              const toneCls = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ok";
              const pathStr = p?.path ?? "/";
              const pathType = p?.pathType ?? "ImplementationSpecific";
              return (
                <div key={j} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 text-xs pl-4 border-l border-line/40 ml-1">
                  <span className="font-mono text-fg-soft truncate" title={`${pathType}: ${pathStr}`}>
                    <span className="text-fg-mute">{pathType === "Prefix" ? "≈" : "="}</span> {pathStr}
                  </span>
                  <span className="text-fg-mute">→</span>
                  <span className="font-mono text-accent truncate" title={svcName}>
                    {svcName || "—"}:{port}
                  </span>
                  <span className={clsx("font-mono text-[10px] tabular-nums", toneCls)}>
                    {!svc ? "no svc" : `${ready} ready`}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {obj?.spec?.defaultBackend && (
        <div className="text-xs text-fg-mute mt-1">
          default backend: <span className="font-mono text-accent">{obj.spec.defaultBackend?.service?.name ?? "—"}:{obj.spec.defaultBackend?.service?.port?.number ?? "—"}</span>
        </div>
      )}
    </Card>
  );
}



// --- PV / PVC binding + StorageClass --------------------------------------

function PVCBinding({ obj }: { obj: any }) {
  const ns: string = obj?.metadata?.namespace ?? "";
  const cluster = useApp((s) => s.cluster);
  const phase = obj?.status?.phase ?? "Pending";
  const tone = phase === "Bound" ? "ok" : phase === "Lost" ? "bad" : "warn";
  const volName: string = obj?.spec?.volumeName ?? "";
  const reqStorage = obj?.spec?.resources?.requests?.storage ?? obj?.spec?.resources?.limits?.storage ?? "—";
  const actStorage = obj?.status?.capacity?.storage ?? "—";
  const sc = obj?.spec?.storageClassName ?? "";
  const access: string[] = obj?.spec?.accessModes ?? [];
  const pods = useResourceList(cluster, "/v1/Pod", ns, { enabled: !!ns });
  const claimName = obj?.metadata?.name as string;
  const consumers = pods.items.filter((p: any) => {
    const vols = (p.spec?.volumes ?? []) as any[];
    return vols.some((v) => v?.persistentVolumeClaim?.claimName === claimName);
  });
  return (
    <Card title="PersistentVolumeClaim">
      <Field label="Status" value={<Chip tone={tone}>{phase}</Chip>} />
      <Field label="Volume" value={volName ? <span className="font-mono text-xs">{volName}</span> : "—"} />
      <Field label="Storage Class" value={sc ? <span className="font-mono text-xs">{sc}</span> : "—"} />
      <Field label="Capacity" value={`${actStorage} (req ${reqStorage})`} mono />
      <Field label="Access Modes" value={access.length === 0 ? "—" : <span className="font-mono text-xs">{access.join(", ")}</span>} />
      <Field
        label={`Used by (${consumers.length})`}
        value={
          consumers.length === 0 ? "—" : (
            <div className="font-mono text-xs space-y-0.5">
              {consumers.slice(0, 8).map((p: any) => (
                <div key={p.metadata?.uid} className="text-fg-soft truncate">{p.metadata?.name}</div>
              ))}
              {consumers.length > 8 && <div className="text-fg-mute">+ {consumers.length - 8} more</div>}
            </div>
          )
        }
      />
    </Card>
  );
}

function PVBinding({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const phase = obj?.status?.phase ?? "Available";
  const tone = phase === "Bound" ? "ok" : phase === "Released" ? "warn" : phase === "Failed" ? "bad" : "info";
  const claim = obj?.spec?.claimRef;
  const reclaim = obj?.spec?.persistentVolumeReclaimPolicy ?? "—";
  const sc = obj?.spec?.storageClassName ?? "";
  const cap = obj?.spec?.capacity?.storage ?? "—";
  const access: string[] = obj?.spec?.accessModes ?? [];
  const driver: string = obj?.spec?.csi?.driver
    || (obj?.spec?.hostPath ? "hostPath" : "")
    || (obj?.spec?.nfs ? "nfs" : "")
    || "—";
  // Resolve the live PVC matching this claimRef so we can flag dangling
  // PVs whose binding target was deleted out from under them.
  const claimNs: string = claim?.namespace ?? "";
  const claimName: string = claim?.name ?? "";
  const pvcs = useResourceList(cluster, "/v1/PersistentVolumeClaim", claimNs, { enabled: !!claimNs });
  const claimAlive = !!(claimNs && claimName && pvcs.items.find((p: any) => p.metadata?.name === claimName));
  return (
    <Card title="PersistentVolume">
      <Field label="Status" value={<Chip tone={tone}>{phase}</Chip>} />
      <Field label="Capacity" value={cap} mono />
      <Field label="Access Modes" value={access.length === 0 ? "—" : <span className="font-mono text-xs">{access.join(", ")}</span>} />
      <Field label="Reclaim" value={reclaim} mono />
      <Field label="Storage Class" value={sc || "—"} mono />
      <Field label="Driver" value={driver || "—"} mono />
      <Field
        label="Claim"
        value={!claim ? "—" : (
          <span className="font-mono text-xs flex items-center gap-2">
            {claim.namespace}/{claim.name}
            {!claimAlive && claimNs && <Chip tone="warn">orphan?</Chip>}
          </span>
        )}
      />
    </Card>
  );
}

function StorageClassDetail({ obj }: { obj: any }) {
  const cluster = useApp((s) => s.cluster);
  const provisioner = obj?.provisioner ?? "—";
  const reclaim = obj?.reclaimPolicy ?? "Delete";
  const binding = obj?.volumeBindingMode ?? "Immediate";
  const expand = !!obj?.allowVolumeExpansion;
  const isDefault = obj?.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true"
    || obj?.metadata?.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true";
  // Live PVCs/PVs using this class (cluster-wide). Just shows totals;
  // listing names would dominate the panel on a 5k-PVC cluster.
  const pvcs = useResourceList(cluster, "/v1/PersistentVolumeClaim", undefined);
  const pvs = useResourceList(cluster, "/v1/PersistentVolume", undefined);
  const className = obj?.metadata?.name as string;
  const usedByPVC = pvcs.items.filter((p: any) => p.spec?.storageClassName === className);
  const usedByPV = pvs.items.filter((p: any) => p.spec?.storageClassName === className);
  return (
    <Card title={`StorageClass${isDefault ? " · default" : ""}`}>
      <Field label="Provisioner" value={provisioner} mono />
      <Field label="Reclaim" value={reclaim} mono />
      <Field label="Volume binding" value={binding} mono />
      <Field label="Volume expansion" value={expand ? "Allowed" : "Not allowed"} />
      <Field label={`PVCs using (${usedByPVC.length})`} value={usedByPVC.length === 0 ? "—" : <span className="text-xs text-fg-soft">{usedByPVC.length.toLocaleString()} bound/pending</span>} />
      <Field label={`PVs using (${usedByPV.length})`} value={usedByPV.length === 0 ? "—" : <span className="text-xs text-fg-soft">{usedByPV.length.toLocaleString()} provisioned</span>} />
    </Card>
  );
}
