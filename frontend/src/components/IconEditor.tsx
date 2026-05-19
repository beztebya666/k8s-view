// IconEditor — the shared cluster-icon customiser body: uploaded photo,
// emoji/initials presets, and hue. Rendered inside a popover by both the
// sidebar ClusterBadge and the Settings page "⋮" button so there's one
// editor, one behaviour, everywhere.

import { useRef, useState } from "react";
import clsx from "clsx";
import { Upload, Trash2 } from "lucide-react";
import { clusterColor } from "../lib/clusterColor";
import { downscaleImage } from "../lib/imageScale";
import { useApp } from "../stores/app";
import { notify_ } from "../lib/notifications";

export const HUE_PRESETS = [
  -1, // "auto" (deterministic from name)
  0, 18, 36, 54,
  78, 120, 150,
  180, 200, 220, 240,
  270, 300, 330,
];

// A handful of presets so "give it an avatar" is one click, no typing.
const EMOJI_PRESETS = ["🚀", "🔥", "⭐", "🛡️", "⚙️", "🌐", "🐳", "📦", "🧪", "💾", "🟢", "🔴"];

export function IconEditorBody({ name }: { name: string }) {
  const settings = useApp((s) => s.getClusterSettings(name));
  const setClusterSettings = useApp((s) => s.setClusterSettings);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await downscaleImage(file);
      setClusterSettings(name, { iconImage: dataUrl });
    } catch (e: any) {
      notify_.bad("Could not load image", e?.message ?? String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="w-[260px]">
      <Section title="Image">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void onPickFile(e.target.files?.[0])}
        />
        <div className="flex items-center gap-2">
          {settings.iconImage ? (
            <img src={settings.iconImage} alt="" className="h-8 w-8 rounded object-cover shrink-0" />
          ) : (
            <div className="h-8 w-8 rounded bg-bg-mute shrink-0" />
          )}
          <button
            type="button"
            className="btn h-7 flex-1 justify-center"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={12} />
            {busy ? "Loading…" : settings.iconImage ? "Replace" : "Upload image"}
          </button>
          {settings.iconImage && (
            <button
              type="button"
              className="btn h-7 w-7 justify-center !px-0"
              title="Remove image"
              onClick={() => setClusterSettings(name, { iconImage: "" })}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </Section>

      <Section title="Label">
        <input
          className="input h-7 w-full text-xs font-mono"
          placeholder="emoji or initials (max 3)"
          value={settings.iconLabel}
          maxLength={6}
          onChange={(e) => setClusterSettings(name, { iconLabel: e.target.value })}
        />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {EMOJI_PRESETS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={clsx(
                "h-7 w-7 rounded-sm border text-sm grid place-items-center",
                settings.iconLabel === emoji
                  ? "border-fg bg-bg-mute"
                  : "border-line/60 hover:border-fg-soft hover:bg-bg-mute",
              )}
              onClick={() => setClusterSettings(name, { iconLabel: emoji })}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Hue">
        <div className="grid grid-cols-8 gap-1">
          {HUE_PRESETS.map((hue) => {
            const swatch = clusterColor(name, hue >= 0 ? hue : undefined);
            const active = settings.iconHue === hue;
            return (
              <button
                key={hue}
                type="button"
                className={clsx("h-6 rounded-sm border", active ? "border-fg" : "border-line/60 hover:border-fg-soft")}
                style={{ background: hue < 0 ? "transparent" : swatch.hsl }}
                onClick={() => setClusterSettings(name, { iconHue: hue })}
                title={hue < 0 ? "Auto (from name)" : `hue ${hue}°`}
              >
                {hue < 0 && <span className="text-[10px] text-fg-soft font-mono">auto</span>}
              </button>
            );
          })}
        </div>
      </Section>

      <div className="mt-2.5 flex justify-end">
        <button
          type="button"
          className="text-[11px] text-fg-mute hover:text-fg"
          onClick={() => setClusterSettings(name, { iconLabel: "", iconHue: -1, iconImage: "" })}
        >
          Reset icon
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[10px] uppercase tracking-wider text-fg-mute mb-1.5">{title}</div>
      {children}
    </div>
  );
}
