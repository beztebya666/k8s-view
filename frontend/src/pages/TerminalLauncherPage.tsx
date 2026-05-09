import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Terminal, X } from "lucide-react";
import { api } from "../lib/api";
import { useResourceList } from "../lib/useResourceList";
import { useApp } from "../stores/app";
import { bottomRefToQuery, parseBottomList } from "../components/BottomPane";

// TerminalLauncherInline — slim variant of the full-page launcher used inside
// the bottom pane's "Terminal session" tab. Picks a pod/container and pushes
// an exec tab into the same pane on submit.
export function TerminalLauncherInline({ onClose }: { onClose?: () => void }) {
  const cluster = useApp((s) => s.cluster);
  const namespace = useApp((s) => s.namespace);
  const settings = useApp((s) => s.getClusterSettings(cluster));
  const [params, setParams] = useSearchParams();
  const [selectedNamespace, setSelectedNamespace] = useState(namespace || settings.terminalDefaultNamespace || "default");
  const pods = useResourceList(cluster, "/v1/Pod", selectedNamespace || undefined);
  const [podName, setPodName] = useState("");
  const [container, setContainer] = useState("");

  const { data: namespaces } = useQuery({
    enabled: !!cluster,
    queryKey: ["namespaces", cluster],
    queryFn: () => api.namespaces(cluster),
    staleTime: 60_000,
  });

  const namespaceOptions = useMemo(() => {
    const out = new Set<string>([...(namespaces ?? []), ...settings.accessibleNamespaces]);
    if (selectedNamespace) out.add(selectedNamespace);
    return [...out].sort();
  }, [namespaces, selectedNamespace, settings.accessibleNamespaces]);

  const runningPods = useMemo(() => pods.items
    .filter((p) => p.status?.phase === "Running")
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [pods.items]);

  const selectedPod = runningPods.find((p) => p.metadata.name === podName) ?? runningPods[0];
  const containers = selectedPod?.spec?.containers?.map((c: any) => c.name) ?? [];

  useEffect(() => {
    if (selectedPod && selectedPod.metadata.name !== podName) {
      setPodName(selectedPod.metadata.name);
    }
  }, [selectedPod, podName]);

  useEffect(() => {
    if (containers.length > 0 && !containers.includes(container)) {
      setContainer(containers[0]);
    }
  }, [containers, container]);

  const open = () => {
    if (!selectedNamespace || !podName) return;
    // Replace the current Terminal-session tab with a real exec tab on the
    // same pod/container. Looking up the active tab by index lets us swap in
    // place rather than appending a new tab on top of the picker.
    const existing = parseBottomList(params.get("b"));
    const idx = Math.max(0, Number(params.get("bt") ?? 0));
    const next = [...existing];
    const newRef = { action: "exec" as const, cluster, namespace: selectedNamespace, name: podName, container };
    if (idx >= next.length) next.push(newRef);
    else next[idx] = newRef;
    const np = new URLSearchParams(params);
    np.set("b", next.map((r) => bottomRefToQuery(r)).join("|"));
    if (idx === 0) np.delete("bt"); else np.set("bt", String(idx));
    setParams(np);
  };

  return (
    <div className="h-full flex flex-col bg-bg overflow-auto">
      <header className="h-9 px-3 border-b border-line flex items-center gap-2 bg-bg-soft text-xs">
        <span className="chip">Terminal session</span>
        <span className="text-fg-mute">{cluster}</span>
        {onClose && (
          <button
            className="ml-auto h-6 w-6 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        )}
      </header>
      <div className="p-4 grid grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end max-w-[880px]">
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-mute">Namespace</div>
          <select
            className="input h-8 w-full text-xs"
            value={selectedNamespace}
            onChange={(e) => {
              setSelectedNamespace(e.target.value);
              setPodName("");
              setContainer("");
            }}
          >
            {namespaceOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-mute">Pod</div>
          <select
            className="input h-8 w-full text-xs"
            value={podName}
            onChange={(e) => { setPodName(e.target.value); setContainer(""); }}
          >
            {runningPods.length === 0 && <option value="">No running pods</option>}
            {runningPods.map((p) => <option key={p.metadata.uid} value={p.metadata.name}>{p.metadata.name}</option>)}
          </select>
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-mute">Container</div>
          <select
            className="input h-8 w-full text-xs"
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            disabled={containers.length === 0}
          >
            {containers.length === 0 && <option value="">No containers</option>}
            {containers.map((c: string) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button className="btn-primary h-8" disabled={!podName || !container} onClick={open}>
          <Terminal size={12} /> Open
        </button>
      </div>
      {pods.error && <div className="px-4 pb-3 text-sm text-bad">{pods.error}</div>}
    </div>
  );
}

export function TerminalLauncherPage() {
  const cluster = useApp((s) => s.cluster);
  const namespace = useApp((s) => s.namespace);
  const settings = useApp((s) => s.getClusterSettings(cluster));
  const navigate = useNavigate();
  const [selectedNamespace, setSelectedNamespace] = useState(namespace || settings.terminalDefaultNamespace || "default");
  const pods = useResourceList(cluster, "/v1/Pod", selectedNamespace || undefined);
  const [podName, setPodName] = useState("");
  const [container, setContainer] = useState("");

  const { data: namespaces } = useQuery({
    enabled: !!cluster,
    queryKey: ["namespaces", cluster],
    queryFn: () => api.namespaces(cluster),
    staleTime: 60_000,
  });

  const namespaceOptions = useMemo(() => {
    const out = new Set<string>([...(namespaces ?? []), ...settings.accessibleNamespaces]);
    if (selectedNamespace) out.add(selectedNamespace);
    return [...out].sort();
  }, [namespaces, selectedNamespace, settings.accessibleNamespaces]);

  const runningPods = useMemo(() => pods.items
    .filter((p) => p.status?.phase === "Running")
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [pods.items]);

  const selectedPod = runningPods.find((p) => p.metadata.name === podName) ?? runningPods[0];
  const containers = selectedPod?.spec?.containers?.map((c: any) => c.name) ?? [];

  useEffect(() => {
    if (selectedPod && selectedPod.metadata.name !== podName) {
      setPodName(selectedPod.metadata.name);
    }
  }, [selectedPod, podName]);

  useEffect(() => {
    if (containers.length > 0 && !containers.includes(container)) {
      setContainer(containers[0]);
    }
  }, [containers, container]);

  const openShell = () => {
    if (!selectedNamespace || !podName) return;
    const url = new URL(
      `/${encodeURIComponent(cluster)}/pods/ns/${encodeURIComponent(selectedNamespace)}/${encodeURIComponent(podName)}/exec`,
      window.location.origin,
    );
    if (container) url.searchParams.set("container", container);
    if (settings.terminalDefaultShell) url.searchParams.set("command", settings.terminalDefaultShell);
    navigate(url.pathname + url.search);
  };

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-[760px]">
        <header className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-md bg-accent/15 text-accent flex items-center justify-center">
            <Terminal size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Terminal session</h1>
            <div className="text-sm text-fg-mute">{cluster}</div>
          </div>
        </header>

        <div className="border border-line bg-bg-soft p-5">
          <label className="block">
            <div className="mb-2 text-xs uppercase font-semibold text-fg-soft">Namespace</div>
            <select
              className="input h-9 w-full"
              value={selectedNamespace}
              onChange={(e) => {
                setSelectedNamespace(e.target.value);
                setPodName("");
                setContainer("");
              }}
            >
              {namespaceOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>

          <label className="block mt-5">
            <div className="mb-2 text-xs uppercase font-semibold text-fg-soft">Pod</div>
            <select
              className="input h-9 w-full"
              value={podName}
              onChange={(e) => {
                setPodName(e.target.value);
                setContainer("");
              }}
            >
              {runningPods.length === 0 && <option value="">No running pods</option>}
              {runningPods.map((p) => <option key={p.metadata.uid} value={p.metadata.name}>{p.metadata.name}</option>)}
            </select>
          </label>

          <label className="block mt-5">
            <div className="mb-2 text-xs uppercase font-semibold text-fg-soft">Container</div>
            <select
              className="input h-9 w-full"
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              disabled={containers.length === 0}
            >
              {containers.length === 0 && <option value="">No containers</option>}
              {containers.map((c: string) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          {pods.error && <div className="mt-4 text-sm text-bad">{pods.error}</div>}

          <div className="mt-6 flex items-center gap-2">
            <button className="btn-primary h-9" disabled={!podName || !container} onClick={openShell}>
              <Terminal size={14} /> Open shell
            </button>
            <button className="btn h-9" onClick={() => navigate(`/${encodeURIComponent(cluster)}/pods`)}>
              Browse pods
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
