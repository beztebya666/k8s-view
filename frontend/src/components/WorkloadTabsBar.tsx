// WorkloadTabsBar — the Overview · Pods · Deployments · … strip.
//
// It used to live only on the Workloads overview page, so the tabs
// "appeared, then vanished" the moment you drilled into Deployments and
// you lost the cross-navigation. This shared bar is now rendered on the
// overview AND on every workload list page, so the tabs are always there
// and always point at the same routes.

import { useNavigate } from "react-router-dom";
import clsx from "clsx";

export const WORKLOAD_TABS = [
  { label: "Overview", route: "workloads" },
  { label: "Pods", route: "pods" },
  { label: "Deployments", route: "deployments" },
  { label: "DaemonSets", route: "daemonsets" },
  { label: "StatefulSets", route: "statefulsets" },
  { label: "ReplicaSets", route: "replicasets" },
  { label: "Jobs", route: "jobs" },
  { label: "CronJobs", route: "cronjobs" },
] as const;

// Resource-list gvr → the tab route it belongs to (null = not a workload
// list, so the bar isn't shown there).
const GVR_TO_ROUTE: Record<string, string> = {
  "/v1/Pod": "pods",
  "apps/v1/Deployment": "deployments",
  "apps/v1/DaemonSet": "daemonsets",
  "apps/v1/StatefulSet": "statefulsets",
  "apps/v1/ReplicaSet": "replicasets",
  "batch/v1/Job": "jobs",
  "batch/v1/CronJob": "cronjobs",
};

export function workloadRouteForGvr(gvr: string): string | null {
  return GVR_TO_ROUTE[gvr] ?? null;
}

export function WorkloadTabsBar({
  cluster, activeRoute,
}: {
  cluster: string;
  activeRoute: string;
}) {
  const navigate = useNavigate();
  return (
    <nav className="h-11 shrink-0 flex items-center justify-center gap-1 border-b border-line bg-bg-soft px-3 overflow-x-auto">
      {WORKLOAD_TABS.map((tab) => {
        const active = tab.route === activeRoute;
        return (
          <button
            key={tab.route}
            className={clsx(
              "h-full px-4 text-sm border-b-2 transition-colors whitespace-nowrap",
              active
                ? "border-accent text-fg font-medium"
                : "border-transparent text-fg-mute hover:text-fg",
            )}
            onClick={() => navigate(`/${encodeURIComponent(cluster)}/${tab.route}`)}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
