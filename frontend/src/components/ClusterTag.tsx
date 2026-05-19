// ClusterTag — the "PROD" (or any) badge the user wanted "светящим в
// ебало" everywhere a cluster shows up. One source of truth (cluster
// settings), one component, dropped into the cluster picker and every
// tab so a production cluster is unmistakable at a glance.

import clsx from "clsx";
import { useApp } from "../stores/app";

const TONE_CLASS: Record<string, string> = {
  bad: "border-bad/50 bg-bad/20 text-bad",
  warn: "border-warn/50 bg-warn/20 text-warn",
  ok: "border-ok/50 bg-ok/20 text-ok",
  info: "border-info/50 bg-info/20 text-info",
  accent: "border-accent/50 bg-accent/20 text-accent",
};

export function ClusterTag({
  cluster, className, size = "sm",
}: {
  cluster: string;
  className?: string;
  size?: "xs" | "sm";
}) {
  const tag = useApp((s) => s.clusterSettings[cluster]?.tag ?? "");
  const tone = useApp((s) => s.clusterSettings[cluster]?.tagTone ?? "bad");
  const text = tag.trim();
  if (!text) return null;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border font-semibold uppercase tracking-wider shrink-0",
        size === "xs" ? "h-4 px-1 text-[9px]" : "h-5 px-1.5 text-[10px]",
        TONE_CLASS[tone] ?? TONE_CLASS.bad,
        className,
      )}
      title={`Environment tag: ${text}`}
    >
      {text}
    </span>
  );
}
