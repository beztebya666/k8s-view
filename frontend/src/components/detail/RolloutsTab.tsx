// RolloutsTab — Deployment revision history + rollback (kubectl rollout undo).
//
// Backed by the server's `/rollouts/{ns}/{name}` endpoint, which enumerates
// every ReplicaSet owned by the Deployment, sorted by `deployment.kubernetes
// .io/revision` desc. The current revision is flagged inline so the user
// knows what they're rolling away from.
//
// Rollback is gated by a side-by-side diff (current pod template vs target
// pod template) rendered with the same Monaco DiffEditor used by the YAML
// tab. The user has to acknowledge the diff before the action goes through —
// rolling back a Deployment is visible to every consumer of the workload, so
// "are you sure" is non-negotiable.
//
// `change-cause` is opt-in via a per-device toggle (off by default). Setting
// it writes the kubernetes.io/change-cause annotation onto the Deployment so
// future rollout-history calls show *why* the rollback was made, but most
// clusters don't use this annotation and we don't want to silently start.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as YAML from "yaml";
import { History, RotateCcw, X, AlertTriangle, RefreshCcw, Image as ImageIcon, Check } from "lucide-react";
import clsx from "clsx";
import { api, type RolloutRevision } from "../../lib/api";
import { age } from "../../lib/format";
import { notify_ } from "../../lib/notifications";
import { usePersistedState } from "../../lib/usePersistedState";
import { YAMLDiffEditor } from "../YAMLEditor";

export function RolloutsTab({
  cluster, ns, name, currentTemplate, onRolledBack,
}: {
  cluster: string;
  ns: string;
  name: string;
  currentTemplate: any;          // deployment.spec.template
  onRolledBack: () => void;      // refetch parent so the side panel reflects the new RS
}) {
  const qc = useQueryClient();
  const enabled = !!cluster && !!ns && !!name;
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    enabled,
    queryKey: ["rollout-history", cluster, ns, name],
    queryFn: () => api.rolloutHistory(cluster, ns, name),
    // 5 s mirrors the right-panel resource refetch — keeps replica counts
    // current without hammering the apiserver while the panel is parked.
    refetchInterval: 5000,
  });

  const [target, setTarget] = useState<RolloutRevision | null>(null);

  if (!enabled) return null;

  if (error) {
    return (
      <div className="p-4 text-sm">
        <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-bad">
          {(error as any).message ?? "Failed to load revision history"}
        </div>
      </div>
    );
  }

  const revisions = data?.revisions ?? [];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-line flex items-center gap-2 text-xs text-fg-mute">
        <History size={13} />
        <span>
          {isLoading
            ? "Loading rollout history…"
            : revisions.length === 0
              ? "No ReplicaSets owned by this Deployment yet."
              : `${revisions.length} revision${revisions.length === 1 ? "" : "s"} · current is r${data?.currentRevision ?? "?"}`}
        </span>
        <div className="ml-auto">
          <button
            className="btn h-7"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh history"
          >
            <RefreshCcw size={12} className={clsx(isFetching && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {revisions.length === 0 && !isLoading ? (
          <EmptyState />
        ) : (
          <ul className="divide-y divide-line">
            {revisions.map((r) => (
              <RevisionRow
                key={r.uid}
                rev={r}
                onRollback={() => setTarget(r)}
              />
            ))}
          </ul>
        )}
      </div>

      {target && (
        <RollbackModal
          cluster={cluster}
          ns={ns}
          name={name}
          target={target}
          currentTemplate={currentTemplate}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            qc.invalidateQueries({ queryKey: ["rollout-history", cluster, ns, name] });
            onRolledBack();
          }}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-fg-mute px-6">
      <div className="text-center max-w-sm">
        <History size={24} className="mx-auto mb-2 opacity-60" />
        <div className="font-medium text-fg-soft">No rollout history yet</div>
        <div className="mt-1 text-xs">
          A new revision is recorded each time the Deployment's pod template
          changes (image bump, env edit, restart). Once you have one, it
          shows up here for one-click rollback.
        </div>
      </div>
    </div>
  );
}

function RevisionRow({ rev, onRollback }: { rev: RolloutRevision; onRollback: () => void }) {
  const created = rev.created ? new Date(rev.created) : null;
  const ready = `${rev.readyReplicas ?? 0}/${rev.replicas ?? 0}`;
  const isLive = rev.replicas > 0;
  return (
    <li className="px-4 py-3 hover:bg-bg-soft/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-12 text-right">
          <div className={clsx(
            "text-[15px] font-mono tabular-nums leading-none",
            rev.current ? "text-accent" : "text-fg",
          )}>
            r{rev.revision}
          </div>
          {rev.current && (
            <div className="mt-1 text-[9px] uppercase tracking-wider font-semibold text-accent">
              current
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-fg-mute">
            <span title={rev.replicaSet} className="truncate font-mono text-fg-soft">{rev.replicaSet}</span>
            {created && <span title={created.toUTCString()}>· {age(created.toISOString())}</span>}
            <span className={clsx(
              "ml-auto shrink-0 inline-flex items-center gap-1 rounded px-1.5 h-5 text-[10px] tabular-nums border",
              isLive
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-line bg-bg-soft text-fg-mute",
            )}>
              {isLive && <span className="h-1.5 w-1.5 rounded-full bg-ok" />}
              {ready}
            </span>
          </div>

          {rev.images.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {rev.images.map((img, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 max-w-full rounded bg-bg-mute/40 border border-line px-1.5 h-5 text-[10.5px] font-mono text-fg-soft"
                  title={img}
                >
                  <ImageIcon size={10} className="shrink-0 opacity-60" />
                  <span className="truncate">{img}</span>
                </span>
              ))}
            </div>
          )}

          {rev.changeCause && (
            <div className="mt-1.5 text-[11px] italic text-fg-mute truncate" title={rev.changeCause}>
              “{rev.changeCause}”
            </div>
          )}
        </div>

        <div className="shrink-0">
          {rev.current ? (
            <span className="btn h-7 cursor-default opacity-60">
              <Check size={12} /> Active
            </span>
          ) : (
            <button
              className="btn h-7"
              onClick={onRollback}
              title={`Roll back to revision ${rev.revision}`}
            >
              <RotateCcw size={12} />
              Roll back
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function RollbackModal({
  cluster, ns, name, target, currentTemplate, onClose, onDone,
}: {
  cluster: string;
  ns: string;
  name: string;
  target: RolloutRevision;
  currentTemplate: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // change-cause is off by default. The toggle persists per device so the
  // user's choice survives reloads — `usePersistedState` is the same shim
  // the logs panel uses for "show timestamps", "show pod name", etc.
  const [recordCause, setRecordCause] = usePersistedState("rollback.recordChangeCause", false);
  const [cause, setCause] = useState(`rollback to r${target.revision}`);

  const original = useMemo(() => yamlOrEmpty(stripTemplate(currentTemplate)), [currentTemplate]);
  const modified = useMemo(() => yamlOrEmpty(stripTemplate(target.template)), [target]);
  const noChanges = original === modified;

  // Esc closes — wired here rather than relying on a parent handler since
  // this modal can open over other modal-like surfaces (yaml diff, etc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const onConfirm = async () => {
    setBusy(true); setErr(null);
    try {
      const opts = recordCause && cause.trim() ? { changeCause: cause.trim() } : undefined;
      await api.rollbackDeployment(cluster, ns, name, target.revision, opts);
      notify_.ok(
        `Rolled back ${name} to r${target.revision}`,
        "Pods will recreate gradually.",
      );
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Rollback failed");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="bg-bg border border-line rounded-lg shadow-2xl w-full max-w-5xl h-[min(80vh,720px)] flex flex-col overflow-hidden">
        <header className="px-4 h-11 shrink-0 flex items-center gap-3 border-b border-line">
          <AlertTriangle size={14} className="text-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">
              Roll back <span className="font-mono">{name}</span> to revision r{target.revision}?
            </div>
            <div className="text-[11px] text-fg-mute truncate">
              From the active revision · target ReplicaSet <span className="font-mono">{target.replicaSet}</span>
            </div>
          </div>
          <button
            className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
            onClick={onClose}
            disabled={busy}
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </header>

        <div className="px-4 py-2 border-b border-line text-[11px] text-fg-mute flex items-center gap-2">
          <span>Side-by-side diff of <span className="font-mono">spec.template</span> — left is current, right is r{target.revision}.</span>
          {noChanges && (
            <span className="ml-auto text-warn">Templates are identical — rollback would be a no-op.</span>
          )}
        </div>

        <div className="flex-1 min-h-0">
          <YAMLDiffEditor original={original} modified={modified} height="100%" />
        </div>

        <footer className="shrink-0 border-t border-line px-4 py-3 flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-1.5 text-xs text-fg-soft cursor-pointer select-none">
            <input
              type="checkbox"
              className="kv-checkbox"
              checked={recordCause}
              onChange={(e) => setRecordCause(e.target.checked)}
              disabled={busy}
            />
            Record change cause annotation
          </label>
          {recordCause && (
            <input
              className="input flex-1 min-w-[180px] max-w-md"
              value={cause}
              onChange={(e) => setCause(e.target.value)}
              placeholder="e.g. revert bad image"
              disabled={busy}
            />
          )}
          {err && <div className="text-xs text-bad max-w-xs truncate" title={err}>{err}</div>}
          <div className="ml-auto flex items-center gap-2">
            <button className="btn h-8" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary h-8"
              onClick={onConfirm}
              disabled={busy || noChanges}
              title={noChanges ? "Templates are identical" : `Roll back to r${target.revision}`}
            >
              <RotateCcw size={13} />
              {busy ? "Rolling back…" : `Roll back to r${target.revision}`}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// stripTemplate removes server-managed metadata that's pure noise in a
// before/after diff: the pod-template-hash label (controller-injected — it
// always differs across revisions), creationTimestamp (always null on
// templates), and the leading top-level `metadata.creationTimestamp` Go's
// JSON encoder loves to leave around. Keeps the diff focused on what the
// operator actually changed.
function stripTemplate(t: any): any {
  if (!t) return {};
  const c = JSON.parse(JSON.stringify(t));
  if (c.metadata) {
    if (c.metadata.labels) {
      delete c.metadata.labels["pod-template-hash"];
      if (Object.keys(c.metadata.labels).length === 0) delete c.metadata.labels;
    }
    delete c.metadata.creationTimestamp;
  }
  return c;
}

function yamlOrEmpty(v: any): string {
  try {
    return YAML.stringify(v ?? {});
  } catch {
    return "";
  }
}
