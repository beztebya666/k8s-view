// CreateResourcePane — bottom-pane "Create resource" editor, scoped to a
// specific cluster. The pane header carries a colored pencil icon matching
// the cluster's hash color (Lens-style) so it's always obvious which cluster
// will receive the apply.
//
// The pane can be opened with an optional `templateGvr`: the FAB on each
// resource page passes the page's GVR so the user lands in an editor with a
// matching scaffold. Without a template the pane uses the generic ConfigMap
// example.

import { useEffect, useMemo, useState } from "react";
import { FilePen, RefreshCcw } from "lucide-react";
import { api } from "../lib/api";
import { YAMLEditor } from "./YAMLEditor";
import { allTemplates, templateForGVR } from "../lib/resourceTemplates";
import { clusterColor } from "../lib/clusterColor";

export function CreateResourcePane({
  cluster, templateGvr, onClose, onApplied,
}: {
  cluster: string;
  templateGvr?: string;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const initial = useMemo(() => templateForGVR(templateGvr), [templateGvr]);
  const [text, setText] = useState<string>(initial.yaml);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  const [pickerKey, setPickerKey] = useState<string>("");

  // Reset editor when the source template changes (re-open from a different
  // resource page). We compare on the YAML body so manual edits aren't lost
  // when the same template is re-selected.
  useEffect(() => {
    setText(initial.yaml);
    setErr(null);
  }, [initial.yaml]);

  const onApply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.serverSideApply(cluster, text);
      setAppliedAt(Date.now());
      onApplied?.();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPickTemplate = (key: string) => {
    setPickerKey(key);
    if (!key) return;
    const tpl = allTemplates().find((t) => t.key === key)?.template;
    if (tpl) {
      setText(tpl.yaml);
      setErr(null);
    }
  };

  const tint = clusterColor(cluster);

  return (
    <div className="h-full flex flex-col bg-bg">
      <header className="h-9 shrink-0 px-3 border-b border-line flex items-center gap-3 bg-bg-soft text-xs">
        <FilePen size={13} style={{ color: tint.hsl }} />
        <span className="text-fg">Create resource</span>
        <span
          className="px-1.5 py-px rounded text-[10px] font-medium"
          style={{ color: tint.hsl, background: tint.bg, border: `1px solid ${tint.bg}` }}
          title="Target cluster"
        >
          {cluster}
        </span>
        <span className="text-fg-mute">— Apply will server-side apply.</span>

        <select
          className="ml-auto input h-7 text-xs"
          value={pickerKey}
          onChange={(e) => onPickTemplate(e.target.value)}
          title="Insert a template"
        >
          <option value="">{`Template: ${initial.label}`}</option>
          {allTemplates().map((t) => (
            <option key={t.key} value={t.key}>{t.template.label}</option>
          ))}
        </select>

        <button
          type="button"
          className="btn h-7"
          onClick={() => { setText(initial.yaml); setErr(null); setPickerKey(""); }}
          title="Reset editor to the original template"
          disabled={busy}
        >
          <RefreshCcw size={12} />
          Reset
        </button>
        <button
          type="button"
          className="btn-primary h-7"
          onClick={onApply}
          disabled={busy || !text.trim()}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
      </header>

      {err && (
        <div className="px-3 py-1.5 text-xs text-bad border-b border-bad/30 bg-bad/10 truncate" title={err}>
          {err}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <YAMLEditor value={text} onChange={setText} />
      </div>

      <footer className="h-7 shrink-0 px-3 border-t border-line flex items-center gap-3 bg-bg-soft text-[11px] text-fg-mute">
        <span>cluster: {cluster}</span>
        {appliedAt && (
          <span className="text-ok">applied {timeAgo(appliedAt)}</span>
        )}
        <button className="ml-auto text-fg-mute hover:text-fg" onClick={onClose}>Close</button>
      </footer>
    </div>
  );
}

function timeAgo(t: number): string {
  const d = Date.now() - t;
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  return `${Math.round(d / 60_000)}m ago`;
}
