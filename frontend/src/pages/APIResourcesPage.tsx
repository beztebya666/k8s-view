import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, APIResource } from "../lib/api";
import { useApp } from "../stores/app";

export function APIResourcesPage() {
  const cluster = useApp((s) => s.cluster);
  const globalSearch = useApp((s) => s.search);
  const { data, isLoading } = useQuery({
    enabled: !!cluster,
    queryKey: ["apiResources", cluster],
    queryFn: () => api.apiResources(cluster),
    staleTime: 60_000,
  });
  const [filter, setFilter] = useState("");
  const navigate = useNavigate();

  const filtered = useMemo<APIResource[]>(() => {
    const f = filter.trim().toLowerCase();
    const global = globalSearch.trim().toLowerCase();
    return (data ?? [])
      .filter((r) => matchesAPIResource(r, global))
      .filter((r) => matchesAPIResource(r, f))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }, [data, filter, globalSearch]);

  const grouped = useMemo(() => {
    const m = new Map<string, APIResource[]>();
    for (const r of filtered) {
      const g = r.group || "core";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(r);
    }
    return Array.from(m.entries()).sort(([a], [b]) => {
      if (a === "core") return -1;
      if (b === "core") return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-line flex items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-medium tracking-tight">API Resources</h1>
          <div className="text-xs text-fg-mute">Every resource kind currently served by the Kubernetes API.</div>
        </div>
        <span className="chip">built-in + CRD</span>
        <span className="chip">{filtered.length.toLocaleString()} kinds</span>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-mute" />
          <input
            className="input h-8 pl-7 w-[320px]"
            placeholder="Search kind, group, resource..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading && <div className="p-4 text-fg-mute text-sm">loading...</div>}
        {!isLoading && grouped.length > 0 && (
          <div className="sticky top-0 z-20 h-8 px-4 grid grid-cols-[minmax(220px,1.2fr)_minmax(160px,1fr)_110px_minmax(160px,1fr)] items-center gap-4 border-b border-line bg-bg text-[11px] uppercase tracking-wide text-fg-mute">
            <div>Kind</div>
            <div>API Version</div>
            <div>Scope</div>
            <div>Resource</div>
          </div>
        )}
        {grouped.map(([group, resources]) => (
          <section key={group} className="border-b border-line">
            <div className="sticky top-8 z-10 h-8 px-4 flex items-center gap-2 bg-bg-soft border-b border-line text-xs text-fg-mute">
              <span className="font-semibold uppercase">{group}</span>
              <span>{resources.length.toLocaleString()}</span>
            </div>
            <div className="divide-y divide-line/60">
              {resources.map((r) => (
                <button
                  key={`${r.group}-${r.version}-${r.kind}`}
                  className="w-full min-h-11 px-4 grid grid-cols-[minmax(220px,1.2fr)_minmax(160px,1fr)_110px_minmax(160px,1fr)] items-center gap-4 text-left hover:bg-bg-mute transition-colors"
                  onClick={() => {
                    const gvr = `${r.group || ""}/${r.version}/${r.kind}`;
                    navigate(`/${encodeURIComponent(cluster)}/custom?gvr=${encodeURIComponent(gvr)}&namespaced=${r.namespaced}`);
                  }}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.kind}</div>
                    {(r.shortNames?.length ?? 0) > 0 && (
                      <div className="text-xs text-fg-mute truncate">{r.shortNames!.join(", ")}</div>
                    )}
                  </div>
                  <div className="font-mono text-xs text-fg-soft truncate">{group}/{r.version}</div>
                  <div className={r.namespaced ? "text-xs text-accent" : "text-xs text-fg-mute"}>
                    {r.namespaced ? "Namespaced" : "Cluster"}
                  </div>
                  <div className="font-mono text-xs text-fg-mute truncate">{r.name}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
        {data && grouped.length === 0 && (
          <div className="p-4 text-sm text-fg-mute">No matching kinds</div>
        )}
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
