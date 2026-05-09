// YAMLEditPane — bottom-pane YAML editor. Mirrors Lens behaviour: clicking
// "Edit" on any resource row docks an editor at the bottom of the workspace
// (instead of taking over the right detail panel), so the list above stays
// visible and the user can flip between resources without losing context.
//
// Header line: "Editing as YAML — Save will server-side apply." plus a
// primary Save button on the right and the standard tab close X (provided
// by the surrounding tab strip). Footer mirrors Lens with status text and a
// Cancel button to reset the buffer to the latest server copy.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as YAML from "yaml";
import { Eye, RefreshCcw } from "lucide-react";
import { api, type GVR } from "../lib/api";
import { YAMLDiffEditor, YAMLEditor } from "./YAMLEditor";

export function YAMLEditPane({
  cluster, gvr, namespace, name, onClose,
}: {
  cluster: string;
  /** "group/version/resource"; "core" group is encoded literally so the URL
   *  keeps a non-empty segment. */
  gvr: string;
  namespace?: string;
  name: string;
  onClose: () => void;
}) {
  const ref = useMemo<GVR>(() => parseGVR(gvr), [gvr]);
  const ns = namespace ?? null;

  const { data, refetch, isLoading, error } = useQuery({
    enabled: !!cluster && !!name && !!ref.resource,
    queryKey: ["yaml-edit", cluster, ref.group, ref.version, ref.resource, ns, name],
    queryFn: () => api.getResource(cluster, ref, ns, name),
    refetchInterval: false,
  });

  const [text, setText] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // dry-run preview: when set, shows a side-by-side diff of (current
  // server YAML) vs (what server-side apply would produce). Closes the
  // edit view temporarily — Apply / Cancel from inside the preview.
  const [previewText, setPreviewText] = useState<string | null>(null);

  // Reset the buffer whenever the server's resourceVersion advances — keeps
  // the editor aligned with reality after a successful apply or an external
  // change. We compare on uid + resourceVersion so editing isn't clobbered
  // mid-typing on every refetch.
  const stamp = data?.metadata
    ? `${data.metadata.uid}:${data.metadata.resourceVersion}`
    : "";
  useEffect(() => {
    if (!data) return;
    setText(YAML.stringify(stripManaged(data)));
    setErr(null);
  }, [stamp]);

  const onSave = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.applyResource(cluster, ref, ns, name, text);
      setSavedAt(Date.now());
      await refetch();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    setErr(null);
    setPreviewText(null);
    await refetch();
  };

  const onPreview = async () => {
    setBusy(true);
    setErr(null);
    try {
      const result = await api.applyResourceDryRun(cluster, ref, ns, name, text);
      setPreviewText(YAML.stringify(stripManaged(result)));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const target = namespace ? `${namespace}/${name}` : name;

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="h-9 shrink-0 px-3 border-b border-line flex items-center gap-3 bg-bg-soft text-xs">
        <span className="text-fg-mute">Editing as YAML — Save will server-side apply.</span>
        <span className="text-fg-soft truncate">{target}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn h-7"
            onClick={onReset}
            title="Reload from cluster, discarding edits"
            disabled={isLoading || busy}
          >
            <RefreshCcw size={12} />
            Reload
          </button>
          <button
            type="button"
            className="btn h-7"
            onClick={onPreview}
            title="Show server-side dry-run diff before saving"
            disabled={busy || isLoading || !text}
          >
            <Eye size={12} />
            Preview
          </button>
          <button
            type="button"
            className="btn-primary h-7"
            onClick={onSave}
            disabled={busy || isLoading || !text}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {err && (
        <div className="px-3 py-1.5 text-xs text-bad border-b border-bad/30 bg-bad/10 truncate" title={err}>
          {err}
        </div>
      )}

      {previewText !== null && (
        <div className="px-3 py-1.5 text-xs text-fg-soft border-b border-line bg-info/10 flex items-center gap-3">
          <span className="text-info">Server-side dry-run preview · left = current, right = result of apply</span>
          <button
            className="ml-auto text-fg-mute hover:text-fg"
            onClick={() => setPreviewText(null)}
          >
            Close preview
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {isLoading && !data ? (
          <div className="h-full flex items-center justify-center text-sm text-fg-mute">Loading…</div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-sm text-bad">
            {(error as Error).message}
          </div>
        ) : previewText !== null ? (
          <YAMLDiffEditor original={data ? YAML.stringify(stripManaged(data)) : ""} modified={previewText} />
        ) : (
          <YAMLEditor value={text} onChange={setText} />
        )}
      </div>

      <footer className="h-7 shrink-0 px-3 border-t border-line flex items-center gap-3 bg-bg-soft text-[11px] text-fg-mute">
        <span>{ref.group || "core"}/{ref.version}/{ref.resource}</span>
        {savedAt && (
          <span className="text-ok">saved {timeAgo(savedAt)}</span>
        )}
        <button className="ml-auto text-fg-mute hover:text-fg" onClick={onClose}>Close</button>
      </footer>
    </div>
  );
}

function parseGVR(gvr: string): GVR {
  const [group, version, resource] = gvr.split("/");
  return { group: group === "core" ? "" : (group ?? ""), version: version ?? "", resource: resource ?? "" };
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

function timeAgo(t: number): string {
  const d = Date.now() - t;
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  return `${Math.round(d / 60_000)}m ago`;
}
