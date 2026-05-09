import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Folder, MoreHorizontal, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import {
  ClusterSettings,
  MetricsProvider,
  useApp,
} from "../stores/app";
import { triggerClockProbe, useClockSnapshot } from "../lib/clock";
import { notify_ } from "../lib/notifications";
import { copyToClipboard } from "../lib/clipboard";

type SettingsSection =
  | "general"
  | "proxy"
  | "terminal"
  | "namespaces"
  | "metrics"
  | "node-shell"
  | "time"
  | "session"
  | "lens-metrics";

const SECTIONS: { id: SettingsSection; label: string; group: "settings" | "extensions" }[] = [
  { id: "general", label: "General", group: "settings" },
  { id: "proxy", label: "Proxy", group: "settings" },
  { id: "terminal", label: "Terminal", group: "settings" },
  { id: "namespaces", label: "Namespaces", group: "settings" },
  { id: "metrics", label: "Metrics", group: "settings" },
  { id: "node-shell", label: "Node Shell", group: "settings" },
  { id: "time", label: "Time", group: "settings" },
  { id: "session", label: "Session", group: "settings" },
  { id: "lens-metrics", label: "Lens Metrics", group: "extensions" },
];

const PROVIDERS: { value: MetricsProvider; label: string; description: string }[] = [
  { value: "auto", label: "Automatic", description: "Prefer Prometheus when detected; otherwise use the Kubernetes Metrics Server." },
  { value: "prometheus", label: "Prometheus", description: "Force Prometheus. Errors will not silently fall back to metrics-server." },
  { value: "metrics-server", label: "Kubernetes Metrics Server", description: "Skip Prometheus discovery and read from metrics.k8s.io directly." },
  { value: "none", label: "No metrics", description: "Disable metrics queries entirely. Donuts and time-series will appear empty." },
];

const METRICS = [
  { id: "cluster-cpu", label: "Node CPU" },
  { id: "cluster-memory", label: "Node Memory" },
  { id: "pod-cpu", label: "Workload CPU" },
  { id: "pod-memory", label: "Workload Memory" },
];

// Prometheus deployment presets — same four flavours Lens lists in its
// metrics settings. Each preset is just a configuration of which
// auxiliary scrapers (kube-state-metrics, node-exporter) ship with that
// install layout, plus whether the bundle includes Prometheus itself.
// We don't need preset-specific service URLs because the backend's
// `/prometheus/info` route auto-detects the in-cluster Service.
type LensMetricsToggles = { prometheus: boolean; kubeStateMetrics: boolean; nodeExporter: boolean };
type PromPreset = {
  id: string;
  label: string;
  description: string;
  lensMetrics: LensMetricsToggles;
};

const PROM_PRESETS: PromPreset[] = [
  {
    id: "lens",
    label: "Lens default",
    description: "kube-state-metrics + node-exporter installed alongside the in-cluster Prometheus.",
    lensMetrics: { prometheus: true, kubeStateMetrics: true, nodeExporter: true },
  },
  {
    id: "helm",
    label: "Helm chart",
    description: "Vanilla helm install — Prometheus only, KSM and node-exporter not bundled.",
    lensMetrics: { prometheus: true, kubeStateMetrics: false, nodeExporter: false },
  },
  {
    id: "prometheus-operator",
    label: "Prometheus Operator",
    description: "kube-prometheus-stack with KSM bundled but node-exporter installed separately.",
    lensMetrics: { prometheus: true, kubeStateMetrics: true, nodeExporter: false },
  },
  {
    id: "kube-prometheus-stack",
    label: "kube-prometheus-stack",
    description: "Full prometheus-community/kube-prometheus-stack: Prometheus, KSM, node-exporter.",
    lensMetrics: { prometheus: true, kubeStateMetrics: true, nodeExporter: true },
  },
];

function matchesPreset(
  metrics: LensMetricsToggles,
  provider: MetricsProvider,
  preset: PromPreset,
): boolean {
  // A preset only counts as "active" if the user has actually committed to
  // Prometheus as the metrics source — otherwise the toggle states are
  // dormant and the card should stay neutral. This matches the UX
  // expectation that flipping the source dropdown to Automatic /
  // metrics-server / none deselects every preset card.
  if (provider !== "prometheus") return false;
  return metrics.prometheus === preset.lensMetrics.prometheus
    && metrics.kubeStateMetrics === preset.lensMetrics.kubeStateMetrics
    && metrics.nodeExporter === preset.lensMetrics.nodeExporter;
}

export function SettingsPage() {
  const { cluster: routeCluster = "", section = "general" } = useParams();
  const active = isSection(section) ? section : "general";
  const storeCluster = useApp((s) => s.cluster);
  const cluster = decodeURIComponent(routeCluster || storeCluster);
  const settings = useApp((s) => s.getClusterSettings(cluster));
  const setClusterSettings = useApp((s) => s.setClusterSettings);
  const navigate = useNavigate();

  const { data: clusters } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.clusters,
    staleTime: 30_000,
  });
  const info = clusters?.find((c) => c.name === cluster);

  const patch = (next: Partial<ClusterSettings>) => setClusterSettings(cluster, next);

  return (
    <div className="h-full grid grid-cols-[220px_1fr] bg-bg">
      <aside className="border-r border-line bg-bg-soft px-3 py-4 overflow-y-auto">
        <div className="flex items-center gap-2.5 px-1 pb-3 border-b border-line">
          <ClusterAvatar name={settings.displayName || cluster} />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{settings.displayName || cluster}</div>
            {info?.version && <div className="text-[11px] text-fg-mute truncate">{info.version}</div>}
          </div>
        </div>

        <SettingsNav active={active} onSelect={(id) => navigate(clusterHref(cluster, `settings/${id}`))} />
      </aside>

      <main className="relative overflow-auto">
        <div className="max-w-[860px] px-8 py-6">
          {active === "general" && (
            <GeneralSettings
              cluster={cluster}
              info={info}
              settings={settings}
              patch={patch}
            />
          )}
          {active === "proxy" && <ProxySettings settings={settings} patch={patch} />}
          {active === "terminal" && <TerminalSettings settings={settings} patch={patch} />}
          {active === "namespaces" && <NamespaceSettings settings={settings} patch={patch} />}
          {active === "metrics" && <MetricsSettings settings={settings} patch={patch} />}
          {active === "node-shell" && <NodeShellSettings settings={settings} patch={patch} />}
          {active === "time" && <TimeSettings />}
          {active === "session" && <SessionSettings />}
          {active === "lens-metrics" && <LensMetricsSettings settings={settings} patch={patch} />}
        </div>
      </main>
    </div>
  );
}

function SettingsNav({ active, onSelect }: { active: SettingsSection; onSelect: (id: SettingsSection) => void }) {
  return (
    <nav className="pt-5">
      <div className="mb-5">
        <div className="px-1 pb-2 text-[11px] uppercase font-semibold text-fg-mute">Settings</div>
        {SECTIONS.filter((s) => s.group === "settings").map((s) => (
          <NavButton key={s.id} active={active === s.id} onClick={() => onSelect(s.id)}>{s.label}</NavButton>
        ))}
      </div>
      <div className="pt-4 border-t border-line">
        <div className="px-1 pb-2 text-[11px] uppercase font-semibold text-fg-mute">Extensions</div>
        {SECTIONS.filter((s) => s.group === "extensions").map((s) => (
          <NavButton key={s.id} active={active === s.id} onClick={() => onSelect(s.id)}>{s.label}</NavButton>
        ))}
      </div>
    </nav>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={clsx(
        "w-full h-9 rounded-md px-3 text-left text-sm transition-colors",
        active ? "bg-bg-mute text-fg font-medium" : "text-fg-soft hover:text-fg hover:bg-bg-mute/60",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function GeneralSettings({
  cluster,
  info,
  settings,
  patch,
}: {
  cluster: string;
  info?: { server: string; kubeconfig?: string };
  settings: ClusterSettings;
  patch: (next: Partial<ClusterSettings>) => void;
}) {
  return (
    <section>
      <SectionTitle>General</SectionTitle>
      <Field label="Cluster name">
        <div className="flex items-center gap-4">
          <input
            className="input h-9 flex-1"
            value={settings.displayName || cluster}
            onChange={(e) => patch({ displayName: e.target.value })}
          />
          <ClusterAvatar name={settings.displayName || cluster} />
          <button className="btn" title="More">
            <MoreHorizontal size={16} />
          </button>
        </div>
      </Field>
      <ReadOnlyBlock label="Kubeconfig" value={info?.kubeconfig ?? ""} />
      <ReadOnlyBlock label="API server" value={info?.server ?? ""} />
      <div className="mt-8 pt-6 border-t border-line">
        <div className="mb-2 text-xs uppercase font-semibold text-fg-soft">Interface</div>
        <ToggleRow
          label="Save resized table columns"
          description="When off, dragged column widths stay temporary and reset after reload or view change."
          checked={settings.persistColumnWidths}
          onChange={(persistColumnWidths) => patch({ persistColumnWidths })}
        />
        <ToggleRow
          label="Show CPU/Memory columns on the Pods list"
          description="Inline sparkline + value columns. Off by default; turn on when a metrics source (metrics-server or Prometheus) is available."
          checked={settings.showPodMetricsColumns}
          onChange={(showPodMetricsColumns) => patch({ showPodMetricsColumns })}
        />
      </div>
    </section>
  );
}

function ProxySettings({ settings, patch }: SettingsProps) {
  return (
    <section>
      <SectionTitle>Proxy</SectionTitle>
      <Field label="HTTP proxy">
        <input
          className="input h-9 w-full"
          placeholder="http://<address>:<port>"
          value={settings.httpProxy}
          onChange={(e) => patch({ httpProxy: e.target.value })}
        />
      </Field>
      <Field label="HTTPS proxy">
        <input
          className="input h-9 w-full"
          placeholder="https://<address>:<port>"
          value={settings.httpsProxy}
          onChange={(e) => patch({ httpsProxy: e.target.value })}
        />
      </Field>
      <Field label="No proxy">
        <input
          className="input h-9 w-full"
          placeholder="localhost,127.0.0.1,.cluster.local"
          value={settings.noProxy}
          onChange={(e) => patch({ noProxy: e.target.value })}
        />
      </Field>
    </section>
  );
}

function TerminalSettings({ settings, patch }: SettingsProps) {
  return (
    <section>
      <SectionTitle>Terminal</SectionTitle>
      <Field label="Working directory">
        <div className="relative">
          <input
            className="input h-9 w-full pr-10"
            value={settings.terminalWorkingDirectory}
            onChange={(e) => patch({ terminalWorkingDirectory: e.target.value })}
          />
          <Folder size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-mute" />
        </div>
      </Field>
      <Field label="Default namespace">
        <input
          className="input h-9 w-full"
          value={settings.terminalDefaultNamespace}
          onChange={(e) => patch({ terminalDefaultNamespace: e.target.value })}
        />
      </Field>
      <Field label="Default shell">
        <select
          className="input h-9 w-full"
          value={settings.terminalDefaultShell}
          onChange={(e) => patch({ terminalDefaultShell: e.target.value })}
        >
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
          <option value="/bin/zsh">/bin/zsh</option>
        </select>
      </Field>
    </section>
  );
}

function NamespaceSettings({ settings, patch }: SettingsProps) {
  const [value, setValue] = useState("");
  const add = () => {
    const next = value.trim();
    if (!next || settings.accessibleNamespaces.includes(next)) return;
    patch({ accessibleNamespaces: [...settings.accessibleNamespaces, next].sort() });
    setValue("");
  };
  return (
    <section>
      <SectionTitle>Namespaces</SectionTitle>
      <Field label="Accessible namespaces">
        <input
          className="input h-9 w-full"
          placeholder="Add new namespace..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        {settings.accessibleNamespaces.map((n) => (
          <button
            key={n}
            className="chip normal-case h-7 text-xs"
            onClick={() => patch({ accessibleNamespaces: settings.accessibleNamespaces.filter((x) => x !== n) })}
          >
            {n} <span className="text-fg-mute">x</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function MetricsSettings({ settings, patch }: SettingsProps) {
  const hidden = new Set(settings.hiddenMetrics);
  const current = PROVIDERS.find((p) => p.value === settings.metricsProvider) ?? PROVIDERS[0];
  return (
    <section>
      <SectionTitle>Metrics</SectionTitle>
      <Field label="Metrics source">
        <select
          className="input h-9 w-full"
          value={settings.metricsProvider}
          onChange={(e) => patch({ metricsProvider: e.target.value as MetricsProvider })}
        >
          {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <p className="mt-2 text-xs leading-5 text-fg-mute">{current.description}</p>
        <p className="mt-1 text-[11px] text-fg-mute">
          Currently used metrics source: <span className="text-fg-soft">{current.label}</span>
        </p>
      </Field>
      <Field label="Prometheus preset">
        <p className="text-xs leading-5 text-fg-mute mb-2">
          Pick a preset that matches your cluster's Prometheus install. The
          backend already auto-detects the in-cluster Service; the preset
          here flips the corresponding kube-state-metrics / node-exporter
          chart toggles below to the values that ship with each layout.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(() => {
            // First-match-wins so two presets that share toggle values
            // (e.g. "Lens default" and "kube-prometheus-stack" both
            // enable Prometheus + KSM + node-exporter) don't both light
            // up at once.
            const activeIdx = PROM_PRESETS.findIndex((p) =>
              matchesPreset(settings.lensMetrics, settings.metricsProvider, p));
            return PROM_PRESETS.map((p, i) => {
              const active = i === activeIdx;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={clsx(
                    "rounded-md border p-3 text-left transition-colors",
                    active
                      ? "border-accent/60 bg-accent/10"
                      : "border-line hover:border-fg-mute hover:bg-bg-mute",
                  )}
                  onClick={() => patch({
                    metricsProvider: "prometheus",
                    lensMetrics: { ...p.lensMetrics },
                  })}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    {p.label}
                  </div>
                  <p className="mt-1 text-[11px] text-fg-mute leading-snug">{p.description}</p>
                </button>
              );
            });
          })()}
        </div>
      </Field>
      <div className="mt-10 pt-8 border-t border-line">
        <Field label="Hide metrics from the UI">
          <div className="flex gap-2">
            <select
              className="input h-9 flex-1"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (id && !hidden.has(id)) patch({ hiddenMetrics: [...settings.hiddenMetrics, id] });
              }}
            >
              <option value="">Select metrics to hide...</option>
              {METRICS.filter((m) => !hidden.has(m.id)).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button className="btn-primary h-9" onClick={() => patch({ hiddenMetrics: METRICS.map((m) => m.id) })}>
              Hide all metrics
            </button>
            <button className="btn h-9" onClick={() => patch({ hiddenMetrics: [] })}>Reset</button>
          </div>
        </Field>
        <div className="mt-3 min-h-14 rounded-md border border-line bg-bg-soft flex items-center justify-center text-sm text-fg-soft">
          {settings.hiddenMetrics.length === 0
            ? "All metrics are visible on the UI"
            : settings.hiddenMetrics.map((id) => METRICS.find((m) => m.id === id)?.label ?? id).join(", ")}
        </div>
      </div>
    </section>
  );
}

function NodeShellSettings({ settings, patch }: SettingsProps) {
  return (
    <section>
      <SectionTitle>Node Shell</SectionTitle>
      <Field label="Node shell image">
        <input
          className="input h-9 w-full"
          placeholder="docker.io/alpine:3.19"
          value={settings.nodeShellImage}
          onChange={(e) => patch({ nodeShellImage: e.target.value })}
        />
      </Field>
      <Field label="Image pull secret">
        <input
          className="input h-9 w-full"
          placeholder="Specify a secret name..."
          value={settings.nodeShellPullSecret}
          onChange={(e) => patch({ nodeShellPullSecret: e.target.value })}
        />
      </Field>
    </section>
  );
}

// TimeSettings — purely diagnostic: lets the user see whether their laptop
// clock agrees with the cluster, and re-run the probe on demand. None of
// the values shown here affect the way ages are rendered elsewhere — those
// are anchored to cluster time regardless of what's on this page.
function TimeSettings() {
  const snap = useClockSnapshot();
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  // Tick once per second so "Last synced" updates live.
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const onCheck = async () => {
    setBusy(true);
    try { await triggerClockProbe(); } finally { setBusy(false); }
  };

  const offsetSec = Math.round(snap.offsetMs / 1000);
  const offsetSign = offsetSec >= 0 ? "+" : "";
  const verdict = !snap.ready
    ? { tone: "info" as const, label: "Checking…" }
    : Math.abs(offsetSec) < 2
      ? { tone: "ok" as const, label: "In sync" }
      : Math.abs(offsetSec) < 30
        ? { tone: "warn" as const, label: "Mildly off" }
        : { tone: "bad" as const, label: "Significantly off" };
  const verdictClass =
    verdict.tone === "ok" ? "chip-ok" :
    verdict.tone === "warn" ? "chip-warn" :
    verdict.tone === "bad" ? "chip-bad" : "chip-info";

  const lastSyncedAgoSec = snap.lastSyncedAtClusterMs
    ? Math.max(0, Math.floor((Date.now() + snap.offsetMs - snap.lastSyncedAtClusterMs) / 1000))
    : null;

  return (
    <section>
      <SectionTitle>Time</SectionTitle>
      <p className="text-sm text-fg-soft mb-6 max-w-[640px]">
        Object ages everywhere in this UI are computed from the cluster's clock — they do not depend
        on the time set on your computer. This panel just lets you verify that
        your laptop and the cluster agree, in case you suspect drift.
      </p>

      <div className="rounded-md border border-line bg-bg-soft divide-y divide-line">
        <Row label="Status">
          <span className={clsx(verdictClass)}>{verdict.label}</span>
        </Row>
        <Row label="Cluster time">
          <span className="font-mono text-sm">
            {snap.ready ? new Date(Date.now() + snap.offsetMs).toISOString() : "—"}
          </span>
        </Row>
        <Row label="Your computer time">
          <span className="font-mono text-sm">{new Date().toISOString()}</span>
        </Row>
        <Row label="Difference">
          <span className="font-mono text-sm">
            {snap.ready
              ? `${offsetSign}${offsetSec}s (${offsetSign}${snap.offsetMs.toFixed(0)} ms)`
              : "—"}
          </span>
        </Row>
        <Row label="Round-trip">
          <span className="font-mono text-sm">
            {snap.rttMs !== null ? `${Math.round(snap.rttMs)} ms` : "—"}
          </span>
        </Row>
        <Row label="Last synced">
          <span className="font-mono text-sm">
            {lastSyncedAgoSec !== null ? `${lastSyncedAgoSec}s ago` : "—"}
          </span>
        </Row>
        {snap.error && (
          <Row label="Last error">
            <span className="text-bad text-sm">{snap.error}</span>
          </Row>
        )}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button className="btn-primary h-9" disabled={busy} onClick={onCheck}>
          <RefreshCw size={13} className={clsx(busy && "animate-spin")} />
          {busy ? "Checking…" : "Check now"}
        </button>
        {verdict.tone === "warn" || verdict.tone === "bad" ? (
          <span className="text-xs text-fg-mute max-w-[460px]">
            Heads up: your computer clock is {Math.abs(offsetSec)}s off from the cluster.
            Consider enabling automatic time sync on your OS — but the UI ages will stay
            correct regardless.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-center px-4 h-11">
      <div className="text-xs uppercase tracking-wider text-fg-mute font-semibold">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// SessionSettings — surfaces the per-browser device identity. Lets a user
// copy their device ID (so they can paste it in another browser) or adopt an
// existing ID (so the kubeconfigs they imported elsewhere reappear here).
// No login/password concept — k8s-view is "open and use" by default; this
// panel is the only piece of session UI we need.
function SessionSettings() {
  const [me, setMe] = useState<{ id: string; kind: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [adoptInput, setAdoptInput] = useState("");
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  useEffect(() => {
    api.whoAmI()
      .then((data) => setMe({ id: data.id, kind: data.kind }))
      .catch((e) => setLoadError(e.message ?? String(e)));
  }, []);

  const copy = async () => {
    if (!me) return;
    if (await copyToClipboard(me.id)) notify_.ok("Device ID copied");
    else notify_.bad("Clipboard write failed", "Try selecting the field manually and pressing Ctrl/Cmd+C.");
  };

  const adopt = async () => {
    const id = adoptInput.trim();
    if (!id) return;
    setAdoptBusy(true);
    setAdoptError(null);
    try {
      await api.adoptDevice(id);
      notify_.ok("Device adopted", "Reloading to pick up the imported clusters…");
      // Hard reload — the new cookie is in place; ResourceList caches need
      // to drop and re-subscribe under the new identity.
      window.setTimeout(() => window.location.reload(), 500);
    } catch (e: any) {
      setAdoptError(e.message ?? String(e));
      setAdoptBusy(false);
    }
  };

  return (
    <section>
      <SectionTitle>Session</SectionTitle>
      <p className="text-sm text-fg-soft mb-4 leading-relaxed">
        k8s-view stores your imported kubeconfigs under a long-lived cookie on this browser.
        No login or password — paste a kubeconfig once and it&apos;s yours.
        Use the device ID below to <strong>restore your kubeconfigs in a different browser</strong> (paste the
        same ID into the &ldquo;Adopt device&rdquo; field there).
      </p>

      {loadError && (
        <div className="rounded-md border border-bad/40 bg-bad/10 text-bad text-xs px-3 py-2 mb-4">
          {loadError}
        </div>
      )}

      <div className="rounded-md border border-line bg-bg-soft divide-y divide-line/60">
        <Row label="Device ID">
          <div className="flex items-center gap-2 min-w-0">
            <input
              readOnly
              type={revealed ? "text" : "password"}
              value={me?.id ?? "…"}
              className="input h-8 flex-1 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn h-8"
              onClick={() => setRevealed((v) => !v)}
              disabled={!me}
            >
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button type="button" className="btn h-8" onClick={copy} disabled={!me}>Copy</button>
          </div>
        </Row>
        <Row label="Kind">
          <span className="text-sm text-fg-soft">{me?.kind ?? "—"}</span>
        </Row>
      </div>

      <h3 className="mt-8 mb-2 text-sm font-medium text-fg">Adopt a device ID</h3>
      <p className="text-xs text-fg-mute mb-3 leading-relaxed">
        Paste the device ID from another browser to take over its session — this browser will then
        see exactly the same kubeconfigs. The previous browser keeps a copy of the same ID
        (it&apos;s not invalidated), so two browsers can actually share one identity if you want.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={adoptInput}
          onChange={(e) => setAdoptInput(e.target.value)}
          placeholder="dev_…"
          className="input h-9 flex-1 font-mono text-xs"
        />
        <button
          type="button"
          className="btn-primary h-9 min-w-[100px] justify-center"
          onClick={adopt}
          disabled={adoptBusy || !adoptInput.trim()}
        >
          {adoptBusy ? "Adopting…" : "Adopt"}
        </button>
      </div>
      {adoptError && (
        <div className="mt-2 text-xs text-bad">{adoptError}</div>
      )}
    </section>
  );
}

function LensMetricsSettings({ settings, patch }: SettingsProps) {
  return (
    <section>
      <SectionTitle>Lens Metrics</SectionTitle>
      <ToggleRow
        label="Enable bundled Prometheus metrics stack"
        checked={settings.lensMetrics.prometheus}
        onChange={(prometheus) => patch({ lensMetrics: { ...settings.lensMetrics, prometheus } })}
      />
      <ToggleRow
        label="Enable bundled kube-state-metrics stack"
        checked={settings.lensMetrics.kubeStateMetrics}
        onChange={(kubeStateMetrics) => patch({ lensMetrics: { ...settings.lensMetrics, kubeStateMetrics } })}
      />
      <ToggleRow
        label="Enable bundled node-exporter stack"
        checked={settings.lensMetrics.nodeExporter}
        onChange={(nodeExporter) => patch({ lensMetrics: { ...settings.lensMetrics, nodeExporter } })}
      />
      <button className="btn-primary mt-6 min-w-[160px]">Apply</button>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="py-4 border-b border-line/70 flex items-center gap-4">
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-1 text-xs leading-5 text-fg-mute">{description}</div>}
      </div>
      <button
        className={clsx(
          "h-7 w-12 rounded-full p-1 transition-colors",
          checked ? "bg-accent" : "bg-fg-mute/50",
        )}
        onClick={() => onChange(!checked)}
      >
        <span className={clsx(
          "block h-5 w-5 rounded-full bg-white transition-transform",
          checked && "translate-x-5",
        )} />
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mt-6">
      <div className="mb-2 text-xs uppercase font-semibold text-fg-soft">{label}</div>
      {children}
    </label>
  );
}

function ReadOnlyBlock({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="mt-4 rounded-md border border-line bg-bg-soft p-4">
      <div className="text-xs uppercase font-semibold text-fg-soft">{label}</div>
      <div className="mt-4 text-sm text-accent break-all">{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="text-xl font-semibold tracking-tight mb-7">{children}</h1>;
}

function ClusterAvatar({ name }: { name: string }) {
  const initials = useMemo(() => {
    const clean = name.trim() || "cluster";
    const parts = clean.split(/[\s._-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }, [name]);

  return (
    <div className="h-12 w-12 rounded bg-ok text-white flex items-center justify-center text-sm font-semibold shrink-0">
      {initials}
    </div>
  );
}

type SettingsProps = {
  settings: ClusterSettings;
  patch: (next: Partial<ClusterSettings>) => void;
};

function isSection(value: string): value is SettingsSection {
  return SECTIONS.some((s) => s.id === value);
}

function clusterHref(cluster: string, href: string): string {
  return `/${encodeURIComponent(cluster)}/${href.replace(/^\/+/, "")}`;
}
