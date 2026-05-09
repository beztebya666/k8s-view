// AddClusterModal — paste or upload a kubeconfig; we parse client-side,
// preview every context found, and let the user pick which ones to import
// before hitting the backend's `/clusters/import` route. The backend
// itself stores the YAML in `~/.k8s-view/imported/` and exposes every
// referenced context as its own Cluster — so picking 1 of 3 gives the
// user 1 cluster, no manual YAML editing required.
//
// Why parse client-side: Lens lets users skim the contexts before
// committing. Same UX here, plus we get to render server URLs and
// default namespaces in the preview without an extra round-trip.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FileUp, Loader2, RefreshCcw, X } from "lucide-react";
import * as YAML from "yaml";
import clsx from "clsx";
import { api, APIError, type ScannedContext } from "../lib/api";

type Props = {
  onClose: () => void;
  onImported: (names: string[]) => void;
};

interface ParsedContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  /** Resolved server URL, looked up from the referenced cluster. */
  server?: string;
}

interface ParsedKubeconfig {
  contexts: ParsedContext[];
  /** The original YAML root, kept around for filtered re-emission. */
  root: any;
  currentContext: string;
  error?: string;
}

interface ScanResult {
  files: { path: string; contexts: ScannedContext[] }[];
}

export function AddClusterModal({ onClose, onImported }: Props) {
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const parsed = useMemo(() => parseKubeconfig(yaml), [yaml]);

  // Whenever the parse result changes, re-pick everything by default —
  // the user usually wants all contexts they pasted, but they can
  // deselect before importing.
  useEffect(() => {
    setPicked(new Set(parsed.contexts.map((c) => c.name)));
  }, [parsed.contexts.map((c) => c.name).join(",")]);

  const onScan = async () => {
    setError(null);
    setScanning(true);
    try {
      const res = await api.scanKubeconfigs();
      setScanResult({ files: res.files ?? [] });
    } catch (e: any) {
      setError(`Scan failed: ${e.message ?? String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const importByPath = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await api.importCluster({ path, name: name.trim() });
      onImported(res.imported);
    } catch (e: unknown) {
      setError(importErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    if (!name) setName(file.name.replace(/\.(ya?ml|kubeconfig)$/i, ""));
    try {
      const text = await file.text();
      setYaml(text);
    } catch (e: any) {
      setError(`Failed to read file: ${e.message ?? String(e)}`);
    }
  };

  const togglePick = (n: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });

  const submit = async () => {
    setError(null);
    const trimmed = yaml.trim();
    if (!trimmed) {
      setError("Paste or upload a kubeconfig first");
      return;
    }
    let payload = trimmed;
    if (parsed.contexts.length > 0) {
      if (picked.size === 0) {
        setError("Pick at least one context to import");
        return;
      }
      // If the user pruned the context list, emit a filtered kubeconfig
      // so the backend only registers what they selected.
      if (picked.size !== parsed.contexts.length) {
        payload = filterKubeconfig(parsed.root, picked);
      }
    }
    setBusy(true);
    try {
      const res = await api.importCluster({ kubeconfig: payload, name: name.trim() });
      onImported(res.imported);
    } catch (e: unknown) {
      setError(importErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] grid place-items-center bg-black/55 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="w-[min(740px,92vw)] max-h-[88vh] flex flex-col rounded-lg border border-line bg-bg-soft shadow-[0_18px_48px_rgb(0_0_0/0.55)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="h-12 px-4 flex items-center border-b border-line">
          <h2 className="text-sm font-medium tracking-tight">Add cluster from kubeconfig</h2>
          <button
            type="button"
            className="ml-auto h-7 w-7 rounded-md grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X size={15} />
          </button>
        </header>

        <div className="px-4 py-3 space-y-3 overflow-auto">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wide text-fg-mute mb-1">File name (optional)</div>
            <input
              className="input h-9 w-full"
              placeholder="my-cluster"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            <div className="mt-1 text-[11px] text-fg-mute">
              Saved to <span className="font-mono">~/.k8s-view/imported/</span>. Context names from the kubeconfig become the cluster names.
            </div>
          </label>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="btn h-8"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <FileUp size={13} />
              Upload kubeconfig
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml,.kubeconfig,application/yaml,text/yaml"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className="btn h-8"
              onClick={onScan}
              disabled={busy || scanning}
              title="Read ~/.kube/config and any KUBECONFIG paths the backend host knows about"
            >
              {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
              Scan local kubeconfigs
            </button>
            <span className="text-[11px] text-fg-mute">or paste the YAML below</span>
          </div>

          {scanResult && scanResult.files.length === 0 && (
            <div className="rounded-md border border-line bg-bg/40 px-3 py-2 text-[11px] text-fg-mute">
              No kubeconfig files found in <span className="font-mono">~/.kube/config</span> or the
              <span className="font-mono"> KUBECONFIG</span> environment variable on the backend host.
            </div>
          )}

          {scanResult && scanResult.files.length > 0 && (
            <div className="rounded-md border border-line bg-bg/40">
              <div className="px-3 py-2 border-b border-line/60 text-[11px] uppercase tracking-wide text-fg-mute">
                Local kubeconfigs ({scanResult.files.reduce((n, f) => n + f.contexts.length, 0)} contexts)
              </div>
              <ul className="divide-y divide-line/60">
                {scanResult.files.map((f) => (
                  <li key={f.path} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="font-mono text-[11px] text-fg-soft truncate" title={f.path}>{f.path}</div>
                      <button
                        type="button"
                        className="ml-auto btn-primary h-6 text-[11px]"
                        disabled={busy}
                        onClick={() => importByPath(f.path)}
                      >
                        {busy ? "Importing…" : `Import all ${f.contexts.length}`}
                      </button>
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {f.contexts.slice(0, 8).map((c) => (
                        <li key={c.context} className="font-mono text-[11px] text-fg-mute truncate flex items-center gap-1.5">
                          <span className="text-fg-soft">{c.context}</span>
                          {c.currentContext && <span className="chip !h-4 !text-[9px] !px-1">CURRENT</span>}
                          {c.server && <span>· {c.server}</span>}
                          {c.namespace && <span>· ns: {c.namespace}</span>}
                        </li>
                      ))}
                      {f.contexts.length > 8 && (
                        <li className="text-[11px] text-fg-mute">+{f.contexts.length - 8} more</li>
                      )}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="block">
            <div className="text-[11px] uppercase tracking-wide text-fg-mute mb-1">Kubeconfig YAML</div>
            <textarea
              className="input min-h-[200px] w-full font-mono text-xs leading-5 resize-y py-2"
              spellCheck={false}
              placeholder={"apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://...\n  name: my-cluster\n..."}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              disabled={busy}
            />
          </label>

          {parsed.error && yaml.trim().length > 0 && (
            <div className="rounded-md border border-warn/30 bg-warn/5 text-warn text-xs px-3 py-2">
              Couldn't parse the YAML — {parsed.error}. Importing will send the raw text to the backend.
            </div>
          )}

          {parsed.contexts.length > 0 && (
            <div className="rounded-md border border-line bg-bg/40">
              <div className="px-3 py-2 border-b border-line/60 flex items-center text-[11px] text-fg-mute">
                <span className="uppercase tracking-wide">
                  Contexts in this kubeconfig ({parsed.contexts.length})
                </span>
                <button
                  type="button"
                  className="ml-auto text-fg-soft hover:text-fg"
                  onClick={() => setPicked(picked.size === parsed.contexts.length
                    ? new Set()
                    : new Set(parsed.contexts.map((c) => c.name)))}
                >
                  {picked.size === parsed.contexts.length ? "Deselect all" : "Select all"}
                </button>
              </div>
              <ul className="divide-y divide-line/60">
                {parsed.contexts.map((c) => {
                  const checked = picked.has(c.name);
                  return (
                    <li key={c.name}>
                      <button
                        type="button"
                        onClick={() => togglePick(c.name)}
                        className={clsx(
                          "w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-bg-mute",
                          checked && "bg-accent/[0.06]",
                        )}
                      >
                        <span
                          className={clsx(
                            "h-4 w-4 rounded border flex items-center justify-center shrink-0",
                            checked ? "border-accent bg-accent text-bg" : "border-line bg-bg",
                          )}
                        >
                          {checked && <Check size={11} strokeWidth={3} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs truncate flex items-center gap-1.5">
                            {c.name}
                            {c.name === parsed.currentContext && (
                              <span className="chip !h-4 !text-[9px] !px-1">CURRENT</span>
                            )}
                          </div>
                          <div className="text-[11px] text-fg-mute truncate">
                            {c.server ?? "no server"} · cluster: {c.cluster} · ns: {c.namespace ?? "default"}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-bad/40 bg-bad/10 text-bad text-xs px-3 py-2 whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>

        <footer className="h-12 px-4 flex items-center justify-end gap-2 border-t border-line">
          <button type="button" className="btn h-8" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary h-8" onClick={submit} disabled={busy || !yaml.trim()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy
              ? "Importing…"
              : parsed.contexts.length > 0
                ? `Import ${picked.size} context${picked.size === 1 ? "" : "s"}`
                : "Add cluster"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function parseKubeconfig(text: string): ParsedKubeconfig {
  if (!text.trim()) return { contexts: [], root: null, currentContext: "" };
  let root: any;
  try {
    root = YAML.parse(text);
  } catch (e: any) {
    return { contexts: [], root: null, currentContext: "", error: e.message ?? String(e) };
  }
  if (!root || typeof root !== "object") {
    return { contexts: [], root: null, currentContext: "", error: "not a YAML mapping" };
  }
  const rawContexts = Array.isArray(root.contexts) ? root.contexts : [];
  const rawClusters = Array.isArray(root.clusters) ? root.clusters : [];
  const clusterByName = new Map<string, any>();
  for (const c of rawClusters) {
    if (c?.name && c?.cluster) clusterByName.set(c.name, c.cluster);
  }
  const contexts: ParsedContext[] = [];
  for (const c of rawContexts) {
    const name = String(c?.name ?? "");
    const ctx = c?.context ?? {};
    if (!name) continue;
    const clusterName = String(ctx.cluster ?? "");
    const userName = String(ctx.user ?? "");
    const namespace = ctx.namespace ? String(ctx.namespace) : undefined;
    const server = clusterName ? clusterByName.get(clusterName)?.server : undefined;
    contexts.push({ name, cluster: clusterName, user: userName, namespace, server });
  }
  return {
    contexts,
    root,
    currentContext: typeof root["current-context"] === "string" ? root["current-context"] : "",
  };
}

// Build a YAML containing only the kubeconfig entries reachable from the
// picked contexts, so the backend's importer only registers those.
function filterKubeconfig(root: any, picked: Set<string>): string {
  const contexts = (root.contexts ?? []).filter((c: any) => picked.has(c?.name));
  const clusterRefs = new Set(contexts.map((c: any) => c?.context?.cluster).filter(Boolean));
  const userRefs = new Set(contexts.map((c: any) => c?.context?.user).filter(Boolean));
  const next: any = {
    apiVersion: root.apiVersion ?? "v1",
    kind: root.kind ?? "Config",
    contexts,
    clusters: (root.clusters ?? []).filter((c: any) => clusterRefs.has(c?.name)),
    users: (root.users ?? []).filter((u: any) => userRefs.has(u?.name)),
  };
  if (typeof root["current-context"] === "string" && picked.has(root["current-context"])) {
    next["current-context"] = root["current-context"];
  } else if (contexts.length > 0) {
    next["current-context"] = contexts[0]?.name;
  }
  if (root.preferences) next.preferences = root.preferences;
  return YAML.stringify(next);
}

function importErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    if (error.status === 404) {
      return "Import is not available yet. Make sure the k8s-view backend is running, then try again.";
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
