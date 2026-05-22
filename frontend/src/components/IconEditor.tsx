// IconEditor — the shared cluster-icon customiser body: an uploaded photo
// and emoji/initials presets sit in ONE picker grid, plus a hue row.
// Rendered inside a popover by both the sidebar ClusterBadge and the
// Settings page "⋮" button so there's one editor, one behaviour, everywhere.
//
// The custom photo is just another tile in the icon grid — click it to show
// the photo, click an emoji to show that emoji. Both stay on file, so
// flipping back and forth never loses the upload. `resolveClusterIcon`
// below is the single source of truth every render site uses.

import { useRef, useState } from "react";
import clsx from "clsx";
import { Upload, Trash2 } from "lucide-react";
import { clusterColor } from "../lib/clusterColor";
import { downscaleImage } from "../lib/imageScale";
import { useApp, type ClusterSettings } from "../stores/app";
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

export type ClusterIcon =
  | { kind: "image"; src: string }
  | { kind: "label"; text: string }
  | { kind: "none" };

/** Decide which icon source a cluster actually renders. An explicit
 *  `iconKind` wins (with a graceful fallback when the chosen source is
 *  empty); legacy settings with no `iconKind` keep the original
 *  image-takes-precedence behaviour. The one place this logic lives — every
 *  badge / avatar render site calls it. */
export function resolveClusterIcon(
  s: Pick<ClusterSettings, "iconImage" | "iconLabel" | "iconKind">,
): ClusterIcon {
  const text = s.iconLabel.trim();
  const image: ClusterIcon = s.iconImage ? { kind: "image", src: s.iconImage } : { kind: "none" };
  const label: ClusterIcon = text ? { kind: "label", text } : { kind: "none" };
  if (s.iconKind === "label") return label.kind !== "none" ? label : image;
  if (s.iconKind === "image") return image.kind !== "none" ? image : label;
  // Legacy / unset — uploaded photo first, exactly as before.
  return image.kind !== "none" ? image : label;
}

export function IconEditorBody({ name }: { name: string }) {
  const settings = useApp((s) => s.getClusterSettings(name));
  const setClusterSettings = useApp((s) => s.setClusterSettings);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const icon = resolveClusterIcon(settings);
  const hasImage = !!settings.iconImage;

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await downscaleImage(file);
      // Uploading is an explicit "show this" — select the image straight away.
      setClusterSettings(name, { iconImage: dataUrl, iconKind: "image" });
    } catch (e: any) {
      notify_.bad("Could not load image", e?.message ?? String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="w-[260px]">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void onPickFile(e.target.files?.[0])}
      />

      <Section title="Icon">
        {/* One unified picker: the uploaded photo is the first tile, emoji
            presets follow. Whichever is highlighted is what the badge shows. */}
        <div className="flex flex-wrap gap-1">
          {hasImage ? (
            <button
              type="button"
              title="Use custom image"
              aria-label="Use custom image"
              className={clsx(
                "h-7 w-7 rounded-sm overflow-hidden grid place-items-center border",
                icon.kind === "image"
                  ? "border-fg ring-2 ring-inset ring-fg"
                  : "border-line/60 hover:border-fg-soft",
              )}
              onClick={() => setClusterSettings(name, { iconKind: "image" })}
            >
              <img src={settings.iconImage} alt="" className="h-full w-full object-cover" />
            </button>
          ) : (
            <button
              type="button"
              title="Upload a custom image"
              aria-label="Upload a custom image"
              disabled={busy}
              className="h-7 w-7 rounded-sm border border-dashed border-line text-fg-mute hover:text-fg hover:border-fg-soft grid place-items-center disabled:opacity-50"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={12} />
            </button>
          )}
          {EMOJI_PRESETS.map((emoji) => {
            const active = icon.kind === "label" && settings.iconLabel === emoji;
            return (
              <button
                key={emoji}
                type="button"
                className={clsx(
                  "h-7 w-7 rounded-sm border text-sm grid place-items-center",
                  active
                    ? "border-fg bg-bg-mute"
                    : "border-line/60 hover:border-fg-soft hover:bg-bg-mute",
                )}
                onClick={() => setClusterSettings(name, { iconLabel: emoji, iconKind: "label" })}
              >
                {emoji}
              </button>
            );
          })}
        </div>
        <input
          className="input mt-1.5 h-7 w-full text-xs font-mono"
          placeholder="emoji or initials (max 3)"
          value={settings.iconLabel}
          maxLength={6}
          onChange={(e) => setClusterSettings(name, { iconLabel: e.target.value, iconKind: "label" })}
        />
        {hasImage && (
          <div className="mt-1.5 flex items-center gap-2 text-[11px]">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-fg-mute hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={11} />
              {busy ? "Loading…" : "Replace image"}
            </button>
            <span className="text-line">·</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-fg-mute hover:text-bad"
              onClick={() => setClusterSettings(name, { iconImage: "", iconKind: "label" })}
            >
              <Trash2 size={11} />
              Remove image
            </button>
          </div>
        )}
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
          onClick={() => setClusterSettings(name, { iconLabel: "", iconHue: -1, iconImage: "", iconKind: "label" })}
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
