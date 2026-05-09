// YAMLEditor — locally-bundled Monaco. Production k8s clusters typically
// have no internet on the management network, so the @monaco-editor/react
// default of fetching the editor from a CDN fails ("Monaco initialization:
// error" in the console, "Preparing editor…" stuck forever). We import
// monaco-editor from node_modules and hand the instance to the loader so
// nothing leaves the browser.
//
// We pull only the editor API + the YAML basic-language contribution; the
// JSON / CSS / TS workers are excluded to keep the bundle modest.

import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import Editor, { DiffEditor, loader } from "@monaco-editor/react";
import { useEffect, useState } from "react";
import { useApp } from "../stores/app";

// One-time wiring: tell Monaco which worker constructor to use, and tell the
// React wrapper to use our locally-imported instance instead of CDN-fetched
// loader scripts. Both must happen before the first <Editor /> mounts.
let configured = false;
function ensureMonacoConfigured() {
  if (configured) return;
  configured = true;
  // The "_label" arg names the worker (e.g. "json", "css"). For YAML we only
  // need the base editor worker — return it for everything.
  (self as any).MonacoEnvironment = {
    getWorker(_workerId: string, _label: string) {
      return new EditorWorker();
    },
  };
  loader.config({ monaco });
  // Define a theme that matches our CSS palette so the editor stops looking
  // out of place against the app chrome. Re-defined on each theme switch
  // below, but the dark variant needs to exist at boot for the first paint.
  registerAppThemes();
}

function registerAppThemes() {
  monaco.editor.defineTheme("k8sview-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background":            "#0b0d10",
      "editor.foreground":            "#e6e6e6",
      "editorLineNumber.foreground":  "#3a3f48",
      "editorLineNumber.activeForeground": "#9aa1ad",
      "editor.lineHighlightBackground": "#161922",
      "editor.selectionBackground":   "#264f78",
      "editorIndentGuide.background1":"#1a1d24",
      "editorIndentGuide.activeBackground1": "#2a2e36",
      "editorCursor.foreground":      "#60a5fa",
      "editorWidget.background":      "#121419",
      "editorWidget.border":          "#262930",
      "scrollbar.shadow":             "#00000000",
      "scrollbarSlider.background":         "#191b21",
      "scrollbarSlider.hoverBackground":    "#262930",
      "scrollbarSlider.activeBackground":   "#2a2e36",
    },
  });
  monaco.editor.defineTheme("k8sview-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background":            "#fafafc",
      "editor.foreground":            "#16181c",
      "editorLineNumber.foreground":  "#9aa1ad",
      "editorLineNumber.activeForeground": "#37404f",
      "editor.lineHighlightBackground": "#eef0f5",
      "editorWidget.background":      "#f4f4f7",
      "editorWidget.border":          "#dcdce2",
    },
  });
}

ensureMonacoConfigured();

export function YAMLEditor({
  value, onChange, readOnly,
}: { value: string; onChange?: (v: string) => void; readOnly?: boolean }) {
  const theme = useApp((s) => s.theme);
  const monacoTheme = theme === "light" ? "k8sview-light" : "k8sview-dark";
  return (
    <Editor
      defaultLanguage="yaml"
      value={value}
      loading={<div className="h-full flex items-center justify-center text-sm text-fg-mute">Preparing editor…</div>}
      onChange={(v) => onChange?.(v ?? "")}
      theme={monacoTheme}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
        fontSize: 13,
        lineNumbers: "on",
        renderWhitespace: "selection",
        wordWrap: "on",
        scrollBeyondLastLine: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        tabSize: 2,
        automaticLayout: true,
      }}
    />
  );
}

// YAMLDiffEditor — side-by-side comparison used by "Save with diff": the
// user can review what's about to PUT to the API server before they click
// confirm. Monaco computes the diff incrementally so even 5 KB manifests
// render in one frame.
export function YAMLDiffEditor({
  original, modified, height,
}: { original: string; modified: string; height?: string | number }) {
  const theme = useApp((s) => s.theme);
  const monacoTheme = theme === "light" ? "k8sview-light" : "k8sview-dark";
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language="yaml"
      theme={monacoTheme}
      height={height}
      loading={<div className="h-full flex items-center justify-center text-sm text-fg-mute">Computing diff…</div>}
      options={{
        renderSideBySide: true,
        readOnly: true,
        renderIndicators: true,
        ignoreTrimWhitespace: false,
        minimap: { enabled: false },
        fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
        fontSize: 13,
        scrollBeyondLastLine: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        automaticLayout: true,
      }}
    />
  );
}

export function YAMLEditorWarmup() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const schedule = window.requestIdleCallback
      ? window.requestIdleCallback(() => setReady(true), { timeout: 1500 })
      : window.setTimeout(() => setReady(true), 700);
    return () => {
      if (typeof schedule === "number") {
        window.clearTimeout(schedule);
      } else {
        window.cancelIdleCallback(schedule);
      }
    };
  }, []);

  if (!ready) return null;

  return (
    <div className="fixed -left-[10000px] top-0 h-px w-px overflow-hidden opacity-0 pointer-events-none" aria-hidden>
      <Editor
        height="1px"
        width="1px"
        defaultLanguage="yaml"
        value="apiVersion: v1"
        theme="k8sview-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          lineNumbers: "off",
          scrollbar: { vertical: "hidden", horizontal: "hidden" },
          automaticLayout: false,
        }}
      />
    </div>
  );
}
