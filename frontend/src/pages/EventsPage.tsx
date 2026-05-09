import { useCallback, useState } from "react";
import { AlertTriangle, Search, X } from "lucide-react";
import clsx from "clsx";
import { useApp } from "../stores/app";
import { ResourceTable, WarningsToggle } from "../components/ResourceTable";
import type { Item } from "../lib/useResourceList";
import { columnsFor, issuesFor } from "./columns";

export function EventsPage() {
  const cluster = useApp((s) => s.cluster);
  const [localSearch, setLocalSearch] = useState("");
  const [issuesFirst, setIssuesFirst] = useState(false);
  const [issueCount, setIssueCount] = useState(0);
  // Warning-only toggle. The list itself is already live via the informer
  // stream (useResourceList → WS deltas), so no separate auto-refresh
  // wiring is needed — checking "Warnings only" filters in real time as
  // new Events arrive.
  const [warningOnly, setWarningOnly] = useState(false);
  const filter = useCallback(
    (it: Item) => !warningOnly || (it as any).type === "Warning",
    [warningOnly],
  );
  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Events</h1>
        <span className="chip">/v1/Event</span>
        <button
          type="button"
          aria-pressed={warningOnly}
          onClick={() => setWarningOnly((v) => !v)}
          title={warningOnly ? "Showing only Warning events" : "Show only Warning events"}
          className={clsx(
            "h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs font-medium border transition-colors",
            warningOnly
              ? "border-warn/50 bg-warn/15 text-warn"
              : "border-line text-fg-soft hover:text-warn hover:border-warn/40 hover:bg-warn/5",
          )}
        >
          <AlertTriangle size={13} strokeWidth={2.25} />
          <span>Warnings only</span>
        </button>
        <WarningsToggle
          count={issueCount}
          active={issuesFirst}
          onToggle={() => setIssuesFirst((v) => !v)}
        />
        <div className="ml-auto relative w-[min(360px,40vw)]">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
          <input
            className="input h-8 w-full pl-7 pr-8"
            placeholder="Search Events..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
          />
          {localSearch && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded grid place-items-center text-fg-mute hover:text-fg hover:bg-bg-mute"
              aria-label="Clear local search"
              title="Clear local search"
              onClick={() => setLocalSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <ResourceTable
          cluster={cluster}
          gvr="/v1/Event"
          namespaced={true}
          columns={columnsFor("/v1/Event")}
          localSearch={localSearch}
          filter={filter}
          issueAccessor={(it) => issuesFor("/v1/Event", it)}
          issuesFirst={issuesFirst}
          onIssueCountChange={setIssueCount}
        />
      </div>
    </div>
  );
}
