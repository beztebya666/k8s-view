import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FileCode2, Lock, Power, Search, ShieldOff, TerminalSquare, X } from "lucide-react";
import { useApp } from "../stores/app";
import { ResourceTable, WarningsToggle } from "../components/ResourceTable";
import { columnsFor, issuesFor } from "./columns";
import { api } from "../lib/api";
import { Item } from "../lib/useResourceList";
import { modals } from "../components/Modals";
import { CreateFab } from "../components/CreateFab";
import { useEventIndex, eventsForItem, EventIndexContext } from "../lib/eventsIndex";
import { useBottomPane } from "../components/BottomPane";
import { notify_ } from "../lib/notifications";

export function NodesPage() {
  const cluster = useApp((s) => s.cluster);
  const [, setSearchParams] = useSearchParams();
  const [localSearch, setLocalSearch] = useState("");
  const [issuesFirst, setIssuesFirst] = useState(false);
  const [issueCount, setIssueCount] = useState(0);
  const events = useEventIndex(cluster, true);
  const bottomPane = useBottomPane();
  const settings = useApp((s) => s.getClusterSettings(cluster));

  // "Edit YAML" opens the right detail panel on the YAML tab — same panel
  // pattern used everywhere else, no full-screen page swap.
  const editYaml = useCallback((it: Item) => {
    const ref = `core/v1/nodes/${encodeURIComponent(it.metadata.name)}`;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("d", ref);
      next.set("tab", "yaml");
      return next;
    });
  }, [setSearchParams]);

  return (
    <div className="h-full flex flex-col relative">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Nodes</h1>
        <span className="chip">/v1/Node</span>
        <WarningsToggle
          count={issueCount}
          active={issuesFirst}
          onToggle={() => setIssuesFirst((v) => !v)}
        />
        <div className="ml-auto relative w-[min(360px,40vw)]">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
          <input
            className="input h-8 w-full pl-7 pr-8"
            placeholder="Search Nodes..."
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
        <EventIndexContext.Provider value={{ index: events, gvr: "/v1/Node" }}>
        <ResourceTable
          cluster={cluster}
          gvr="/v1/Node"
          namespaced={false}
          columns={columnsFor("/v1/Node")}
          localSearch={localSearch}
          issueAccessor={(it) => issuesFor("/v1/Node", it, eventsForItem(events, "/v1/Node", it))}
          issuesFirst={issuesFirst}
          onIssueCountChange={setIssueCount}
          rowHref={(it) => `resource/core/v1/nodes/${encodeURIComponent(it.metadata.name)}`}
          actions={[
            { label: "Cordon", icon: Lock,
              onClick: (it: Item) => api.cordon(cluster, it.metadata.name)
                .catch((e) => modals.alert({ title: "Cordon failed", body: e.message, tone: "bad" })) },
            { label: "Uncordon", icon: ShieldOff,
              onClick: (it: Item) => api.uncordon(cluster, it.metadata.name)
                .catch((e) => modals.alert({ title: "Uncordon failed", body: e.message, tone: "bad" })) },
            { label: "Drain", icon: Power, danger: true,
              onClick: async (it: Item) => {
                const ok = await modals.confirm({
                  title: `Drain node ${it.metadata.name}?`,
                  body: "Every pod that isn't a DaemonSet or mirror pod will be evicted.",
                  danger: true,
                  okLabel: "Drain",
                });
                if (!ok) return;
                try {
                  const r = await api.drain(cluster, it.metadata.name);
                  await modals.alert({
                    title: `Drained ${it.metadata.name}`,
                    body: `Evicted ${r.evicted}, skipped ${r.skipped}.`,
                  });
                } catch (e: any) {
                  await modals.alert({ title: "Drain failed", body: e.message, tone: "bad" });
                }
              } },
            { label: "Open node shell", icon: TerminalSquare,
              onClick: async (it: Item) => {
                try {
                  const created = await api.nodeShell(cluster, it.metadata.name, {
                    image: settings.nodeShellImage || undefined,
                    pullSecret: settings.nodeShellPullSecret || undefined,
                  });
                  notify_.info(`Spawning node-shell on ${it.metadata.name}`,
                    `Pod ${created.namespace}/${created.name} — opening exec…`);
                  bottomPane.push({
                    action: "exec",
                    cluster,
                    namespace: created.namespace,
                    name: created.name,
                    container: "shell",
                  });
                } catch (e: any) {
                  notify_.bad("node-shell failed", e.message);
                }
              } },
            { label: "Edit YAML", icon: FileCode2, onClick: editYaml },
          ]}
        />
        </EventIndexContext.Provider>
      </div>
      <CreateFab templateGvr="/v1/Node" />
    </div>
  );
}
