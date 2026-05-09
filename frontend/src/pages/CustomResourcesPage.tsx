// CustomResourcesPage — generic browser for any GVR, including CRDs.
// Reads ?gvr=group/version/Kind&namespaced=true from the URL, or falls back
// to a small picker so the user can browse anything.

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Search } from "lucide-react";
import { api, APIResource } from "../lib/api";
import { useApp } from "../stores/app";
import { ResourceTable } from "../components/ResourceTable";
import { columnsFor } from "./columns";
import { YAMLEditor } from "../components/YAMLEditor";

export function CustomResourcesPage() {
  const cluster = useApp((s) => s.cluster);
  const globalSearch = useApp((s) => s.search);
  const [params, setParams] = useSearchParams();
  const gvr = params.get("gvr") ?? "";
  const namespaced = params.get("namespaced") === "true";
  const action = params.get("action");
  const [filter, setFilter] = useState("");

  const { data: resources } = useQuery({
    enabled: !!cluster,
    queryKey: ["apiResources", cluster],
    queryFn: () => api.apiResources(cluster),
    staleTime: 60_000,
  });

  const filteredResources = useMemo<APIResource[]>(() => {
    const text = filter.trim().toLowerCase();
    const global = globalSearch.trim().toLowerCase();
    return (resources ?? [])
      .filter(isCustomAPIResource)
      .filter((r) => matchesAPIResource(r, global))
      .filter((r) => matchesAPIResource(r, text))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }, [resources, filter, globalSearch]);

  const groupedKinds = useMemo(() => {
    const groups = new Map<string, APIResource[]>();
    for (const r of filteredResources) {
      const key = r.group || "core";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === "core") return -1;
      if (b === "core") return 1;
      return a.localeCompare(b);
    });
  }, [filteredResources]);

  if (action === "create") {
    return <CreateResource cluster={cluster} onDone={() => setParams({})} />;
  }

  if (!gvr) {
    return (
      <div className="h-full flex flex-col">
        <header className="px-4 py-3 border-b border-line flex items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-medium tracking-tight">Custom Resources</h1>
            <div className="text-xs text-fg-mute">Only extra kinds added to the cluster by CustomResourceDefinitions.</div>
          </div>
          <span className="chip">CRD-backed</span>
          <span className="chip">{filteredResources.length.toLocaleString()} kinds</span>
          <div className="relative ml-auto">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
            <input
              className="input h-8 pl-7 w-[320px]"
              placeholder="Search custom kind, group, resource..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-auto">
          {!resources && <div className="p-4 text-sm text-fg-mute">loading...</div>}
          {resources && groupedKinds.length > 0 && (
            <div className="sticky top-0 z-20 h-8 px-4 grid grid-cols-[minmax(220px,1.2fr)_minmax(180px,1fr)_100px_minmax(160px,1fr)] items-center gap-4 border-b border-line bg-bg text-[11px] uppercase tracking-wide text-fg-mute">
              <div>Kind</div>
              <div>API Version</div>
              <div>Scope</div>
              <div>Resource</div>
            </div>
          )}
          {groupedKinds.map(([group, items]) => (
            <section key={group} className="border-b border-line">
              <div className="sticky top-8 z-10 h-8 px-4 flex items-center gap-2 bg-bg-soft border-b border-line text-xs text-fg-mute">
                <span className="font-semibold uppercase">{group}</span>
                <span>{items.length.toLocaleString()}</span>
              </div>
              <div className="divide-y divide-line/60">
                {items.map((r) => (
                  <button
                    key={`${r.group}-${r.version}-${r.kind}`}
                    className="w-full min-h-11 px-4 grid grid-cols-[minmax(220px,1.2fr)_minmax(180px,1fr)_100px_minmax(160px,1fr)] items-center gap-4 text-left hover:bg-bg-mute transition-colors"
                    onClick={() => setParams({ gvr: `${r.group || ""}/${r.version}/${r.kind}`, namespaced: String(r.namespaced) })}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{r.kind}</div>
                      {r.shortNames && r.shortNames.length > 0 && (
                        <div className="text-xs text-fg-mute truncate">{r.shortNames.join(", ")}</div>
                      )}
                    </div>
                    <div className="font-mono text-xs text-fg-soft truncate">{group}/{r.version}</div>
                    <div className={clsx("text-xs", r.namespaced ? "text-accent" : "text-fg-mute")}>
                      {r.namespaced ? "Namespaced" : "Cluster"}
                    </div>
                    <div className="font-mono text-xs text-fg-mute truncate">{r.name}</div>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {resources && groupedKinds.length === 0 && (
            <div className="p-4 text-sm text-fg-mute">No matching custom resource kinds</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <button className="btn" onClick={() => setParams({})}><ArrowLeft size={13} /></button>
        <h1 className="text-lg font-medium tracking-tight">{gvr.split("/").pop()}</h1>
        <span className="chip">{gvr.replace(/^\//, "core/")}</span>
        <button className="btn ml-auto" onClick={() => setParams({})}>Change kind</button>
      </header>
      <div className="flex-1 min-h-0">
        <ResourceTable
          cluster={cluster}
          gvr={gvr}
          namespaced={namespaced}
          columns={columnsFor(gvr)}
          rowHref={(it) => {
            const [g, v, k] = gvr.split("/");
            const resource = pluralise(k);
            const ns = it.metadata?.namespace;
            return ns
              ? `resource/${g || "core"}/${v}/${resource}/ns/${encodeURIComponent(ns)}/${encodeURIComponent(it.metadata.name)}`
              : `resource/${g || "core"}/${v}/${resource}/${encodeURIComponent(it.metadata.name)}`;
          }}
        />
      </div>
    </div>
  );
}

function matchesAPIResource(r: APIResource, raw: string): boolean {
  if (!raw) return true;
  return r.kind.toLowerCase().includes(raw)
    || r.name.toLowerCase().includes(raw)
    || (r.group || "core").toLowerCase().includes(raw)
    || r.version.toLowerCase().includes(raw)
    || (r.shortNames ?? []).some((s) => s.toLowerCase().includes(raw));
}

function pluralise(kind: string): string {
  const k = kind.toLowerCase();
  if (k.endsWith("s")) return k + "es";
  if (k.endsWith("y")) return k.slice(0, -1) + "ies";
  return k + "s";
}

const BUILT_IN_API_GROUPS = new Set([
  "",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "apps",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "autoscaling",
  "batch",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "policy",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
]);

function isCustomAPIResource(r: APIResource): boolean {
  return !!r.group && !BUILT_IN_API_GROUPS.has(r.group);
}

function CreateResource({ cluster, onDone }: { cluster: string; onDone: () => void }) {
  const [yaml, setYaml] = useState(EXAMPLE_YAML);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <h1 className="text-lg font-medium tracking-tight">Create resource</h1>
        <span className="chip">server-side apply</span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn" onClick={onDone}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true); setError(null);
              try {
                await api.serverSideApply(cluster, yaml);
                onDone();
              } catch (e: any) {
                setError(e.message);
              } finally { setBusy(false); }
            }}
          >Apply</button>
        </div>
      </header>
      {error && <div className="px-4 py-2 text-bad text-sm border-b border-line">{error}</div>}
      <div className="flex-1">
        <YAMLEditor value={yaml} onChange={setYaml} />
      </div>
    </div>
  );
}

const EXAMPLE_YAML = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  hello: world
`;
