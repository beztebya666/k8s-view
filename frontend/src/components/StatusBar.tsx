// StatusBar — thin always-visible footer with cluster/connection state,
// active port-forwards count, and build info. Lens has the same idea: a
// 22-px strip that lets the user see, at a glance, whether they still
// have a working session and what background work the app is holding.

import { useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Network, Wifi, WifiOff } from "lucide-react";
import clsx from "clsx";
import { api } from "../lib/api";
import { useApp, useClusterLabel } from "../stores/app";
import { activeCount, subscribe as subscribePF, getSnapshot as pfSnapshot } from "../lib/portForwards";

export function StatusBar() {
  const cluster = useApp((s) => s.cluster);
  const clusterLabel = useClusterLabel(cluster);
  const navigate = useNavigate();

  const { data: clusters } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.clusters,
    refetchInterval: 30_000,
    retry: false,
  });
  const here = clusters?.find((c) => c.name === cluster);
  const connected = here?.connected ?? false;
  const version = here?.version;

  const { data: build } = useQuery({
    queryKey: ["version"],
    queryFn: api.version,
    staleTime: Infinity,
    retry: false,
  });

  // Re-render on any port-forward change so the chip count is live.
  useSyncExternalStore(subscribePF, pfSnapshot);
  const pfCount = activeCount();

  return (
    <footer
      className="h-[22px] shrink-0 border-t border-line bg-bg-soft text-[11px] text-fg-mute flex items-center px-3 gap-3"
      role="contentinfo"
      aria-label="Status bar"
    >
      <span
        className={clsx(
          "inline-flex items-center gap-1",
          connected ? "text-ok" : here ? "text-bad" : "text-fg-mute",
        )}
        title={connected ? "Cluster API reachable" : here ? "Cluster API unreachable" : "No cluster selected"}
      >
        {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
        <span className="font-medium text-fg">{clusterLabel || "—"}</span>
      </span>
      {version && <span title="Server Kubernetes version">k8s {version}</span>}

      <button
        type="button"
        className={clsx(
          "inline-flex items-center gap-1 hover:text-fg transition-colors",
          pfCount > 0 && "text-accent",
        )}
        onClick={() => cluster && navigate(`/${encodeURIComponent(cluster)}/portforwards`)}
        title="Port forwards"
      >
        <Network size={11} />
        <span>{pfCount} forward{pfCount === 1 ? "" : "s"}</span>
      </button>

      <span className="ml-auto inline-flex items-center gap-1" title="App build">
        <Activity size={11} />
        <span>k8s-view {build?.version ?? "dev"}</span>
        {build?.commit && (
          <span className="text-fg-mute">· {build.commit.slice(0, 7)}</span>
        )}
      </span>
    </footer>
  );
}
