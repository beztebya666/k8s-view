import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowUpCircle, FileCode2, KeyRound, Lock, Power, Search, ShieldOff, TerminalSquare, X } from "lucide-react";
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

  // kubeadm ops are control-plane only and the most destructive thing in
  // the app, so they're triple-gated: hidden on workers, a danger
  // confirm explaining the blast radius, then a typed node-name prompt
  // (the backend also rejects a mismatched confirm token).
  const isControlPlane = (it: Item) =>
    Object.keys(it.metadata?.labels ?? {}).some(
      (k) => k === "node-role.kubernetes.io/control-plane" || k === "node-role.kubernetes.io/master",
    );

  const runKubeadm = useCallback(async (it: Item, op: "certs-renew" | "upgrade") => {
    const node = it.metadata.name;
    const ok = await modals.confirm({
      title: op === "certs-renew" ? `Renew kubeadm certificates on ${node}?` : `kubeadm upgrade ${node}?`,
      body: op === "certs-renew"
        ? "Runs `kubeadm certs renew all` on the host, then bounces the control-plane static pods (apiserver / controller-manager / scheduler / etcd) so they pick up the new certs. The API server is briefly unavailable during the bounce. Control-plane node only."
        : "Runs `kubeadm upgrade` on the host and restarts kubelet. This changes the control-plane version and is disruptive. Take an etcd backup first. Control-plane node only.",
      danger: true,
      okLabel: "Continue",
    });
    if (!ok) return;

    let version: string | undefined;
    if (op === "upgrade") {
      const v = await modals.prompt({
        title: `Target version for ${node}`,
        default: "",
        placeholder: "e.g. v1.30.2 — leave empty for `kubeadm upgrade node`",
        okLabel: "Next",
        validate: (s: string) => {
          const t = s.trim();
          if (!t) return null;
          return /^v?\d+\.\d+\.\d+/.test(t) ? null : "Expected a version like v1.30.2";
        },
      });
      if (v === null) return;
      version = v.trim() || undefined;
    }

    const typed = await modals.prompt({
      title: `Type "${node}" to confirm`,
      default: "",
      placeholder: node,
      okLabel: op === "certs-renew" ? "Renew certificates" : "Run upgrade",
      validate: (s: string) => (s.trim() === node ? null : "Type the exact node name to confirm."),
    });
    if (typed === null) return;

    try {
      const created = await api.nodeKubeadm(cluster, node, op, {
        version,
        image: settings.nodeShellImage || undefined,
        pullSecret: settings.nodeShellPullSecret || undefined,
      });
      notify_.info(
        op === "certs-renew" ? `Renewing certs on ${node}` : `kubeadm upgrade on ${node}`,
        `Pod ${created.namespace}/${created.name} — opening logs…`,
      );
      bottomPane.push({
        action: "logs",
        cluster,
        namespace: created.namespace,
        name: created.name,
        container: created.container,
      });
    } catch (e: any) {
      notify_.bad("kubeadm action failed", e.message);
    }
  }, [cluster, settings.nodeShellImage, settings.nodeShellPullSecret, bottomPane]);

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
            { label: "Renew certs (kubeadm)", icon: KeyRound, danger: true,
              hidden: (it: Item) => !isControlPlane(it),
              onClick: (it: Item) => void runKubeadm(it, "certs-renew") },
            { label: "Upgrade (kubeadm)", icon: ArrowUpCircle, danger: true,
              hidden: (it: Item) => !isControlPlane(it),
              onClick: (it: Item) => void runKubeadm(it, "upgrade") },
            { label: "Edit YAML", icon: FileCode2, onClick: editYaml },
          ]}
        />
        </EventIndexContext.Provider>
      </div>
      <CreateFab templateGvr="/v1/Node" />
    </div>
  );
}
