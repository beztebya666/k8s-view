// REST helpers. Long-lived data goes over the WebSocket — these are for one-
// shot operations like "fetch the current YAML", "scale", "delete", etc.

export type ClusterOrigin = "imported" | "in-cluster" | "host-kubeconfig";

export type ClusterInfo = {
  name: string;
  server: string;
  kubeconfig?: string;
  current: boolean;
  connected: boolean;
  /** True when the user clicked Disconnect — the cluster object stays in
   *  the picker but no informers run and the WebSocket /stream returns 409.
   *  Distinguishes "intentional pause" from "apiserver unreachable". */
  paused?: boolean;
  version?: string;
  /** Where this cluster came from. Older backends omit the field; treat
   *  the absence as "imported" so legacy clients still render. */
  origin?: ClusterOrigin;
};

export type ScannedContext = {
  path: string;
  context: string;
  cluster: string;
  server?: string;
  namespace?: string;
  user?: string;
  currentContext: boolean;
};

export type APIResource = {
  group: string;
  version: string;
  kind: string;
  name: string;            // plural
  singularName: string;
  namespaced: boolean;
  verbs: string[];
  shortNames?: string[];
  categories?: string[];
};

export class APIError extends Error {
  constructor(public status: number, message: string, public path?: string) {
    super(message);
  }
}

// --- 404 interceptor + per-cluster circuit breaker ------------------------
//
// Background: when the backend returns 404 for a cluster-scoped route
// (e.g. /api/v1/{cluster}/namespaces with a name that's no longer in the
// registry), the UI used to keep firing the same requests on every
// re-render. A single rogue cluster pointer produced hundreds of 404s per
// minute against the backend log.
//
// Two-stage defence:
//
//   1. **Interceptor.** Any 404 from a cluster-scoped path tells the app
//      the cluster has gone away — clear the active selection, tear down
//      its WebSocket stream, invalidate the cached cluster list, and let
//      the App component re-render its "Import kubeconfig" empty state.
//      This is the immediate UX recovery.
//
//   2. **Circuit breaker.** Until step 1's invalidation cycle settles,
//      stray in-flight requests for the same cluster would still fire. We
//      open the breaker per-cluster on the first 404 and short-circuit
//      every subsequent call for `BREAKER_RESET_MS` (3s). Reset is
//      automatic — re-imports of the same name come back live without a
//      page reload — and any successful 2xx response for that cluster
//      also resets the breaker eagerly. The 404 path stays log-clean
//      because the breaker rejects locally without hitting the network.

const BREAKER_RESET_MS = 3_000;

// Listeners that want to react to "cluster vanished" — App.tsx subscribes
// to clear app state + redirect, stream.ts subscribes to drop the WS.
type GoneListener = (cluster: string) => void;
const goneListeners = new Set<GoneListener>();
export function onClusterGone(fn: GoneListener): () => void {
  goneListeners.add(fn);
  return () => { goneListeners.delete(fn); };
}

const breakers = new Map<string, number>(); // cluster -> opened-at epoch ms
function breakerOpenFor(cluster: string): boolean {
  const opened = breakers.get(cluster);
  if (opened === undefined) return false;
  if (Date.now() - opened >= BREAKER_RESET_MS) {
    breakers.delete(cluster);
    return false;
  }
  return true;
}
function openBreaker(cluster: string) {
  breakers.set(cluster, Date.now());
}
function closeBreaker(cluster: string) {
  breakers.delete(cluster);
}

// extractClusterFromPath inspects an /api/v1/... URL and returns the
// cluster segment it touches, if any. Both prefixes match: the
// `/clusters/{name}/{verb}` admin routes AND the catch-all per-cluster
// `/{cluster}/{...}` subtree. Returns undefined for non-cluster paths
// (e.g. /api/v1/healthz, /api/v1/me) — those never trigger the breaker.
const RESERVED_FIRST_SEGMENT = new Set([
  "healthz", "version", "me", "clusters",
]);
function extractClusterFromPath(input: RequestInfo): string | undefined {
  const raw = typeof input === "string" ? input : input.url;
  if (!raw) return undefined;
  let pathname: string;
  try {
    pathname = new URL(raw, window.location.origin).pathname;
  } catch {
    return undefined;
  }
  const prefix = "/api/v1/";
  if (!pathname.startsWith(prefix)) return undefined;
  const tail = pathname.slice(prefix.length);
  if (!tail) return undefined;
  const segments = tail.split("/");
  const first = decodeURIComponent(segments[0] ?? "");
  if (!first) return undefined;
  // /api/v1/clusters/{name}/{verb} — cluster name is the SECOND segment.
  if (first === "clusters" && segments.length >= 3) {
    return decodeURIComponent(segments[1]);
  }
  // /api/v1/healthz, /me, /version — not cluster-scoped, skip.
  if (RESERVED_FIRST_SEGMENT.has(first)) return undefined;
  // /api/v1/{cluster}/... — first segment IS the cluster.
  return first;
}

async function jfetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const cluster = extractClusterFromPath(input);
  if (cluster && breakerOpenFor(cluster)) {
    // Short-circuit: don't pile network calls on a cluster we know is gone.
    // 503 keeps the shape consistent with "the backend isn't going to serve
    // this either" so callers don't have to learn a new status code.
    throw new APIError(503, `cluster "${cluster}" is unavailable`,
      typeof input === "string" ? input : input.url);
  }

  const res = await fetch(input, init);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep as text */ }
  if (!res.ok) {
    if (res.status === 404 && cluster) {
      openBreaker(cluster);
      // Fire listeners outside the throw so subscribers get notified even
      // if the awaiting caller doesn't catch the error.
      queueMicrotask(() => {
        for (const fn of goneListeners) {
          try { fn(cluster); } catch { /* listener errors must not break the request */ }
        }
      });
    }
    const msg = (body && body.error) || res.statusText || `HTTP ${res.status}`;
    throw new APIError(res.status, msg,
      typeof input === "string" ? input : input.url);
  }
  // Successful response — eagerly close the breaker for this cluster so a
  // re-import of the same name lights up immediately without waiting for
  // the 3s reset window.
  if (cluster) closeBreaker(cluster);
  return body as T;
}

export type WhoAmI = {
  id: string;
  kind: "device" | "oidc" | "ldap";
  displayName?: string;
};

export const api = {
  health: () => jfetch<{ status: string }>("/api/v1/healthz"),
  version: () => jfetch<{ version: string; commit: string }>("/api/v1/version"),
  whoAmI: () => jfetch<WhoAmI>("/api/v1/me"),
  adoptDevice: (id: string) =>
    jfetch<{ adopted: string }>("/api/v1/me/adopt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  clusters: () => jfetch<ClusterInfo[]>("/api/v1/clusters"),
  selectCluster: (name: string) =>
    jfetch<{ current: string }>(`/api/v1/clusters/${encodeURIComponent(name)}/select`, { method: "POST" }),

  removeCluster: (name: string) =>
    jfetch<{ removed: string }>(`/api/v1/clusters/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // Soft-disconnect: keep the cluster in the picker but stop every
  // informer / probe and reject new stream subscriptions until the user
  // calls connectCluster.
  disconnectCluster: (name: string) =>
    jfetch<{ disconnected: string }>(`/api/v1/clusters/${encodeURIComponent(name)}/disconnect`, { method: "POST" }),

  connectCluster: (name: string) =>
    jfetch<{ connected: string }>(`/api/v1/clusters/${encodeURIComponent(name)}/connect`, { method: "POST" }),

  importCluster: (opts: { kubeconfig?: string; path?: string; name?: string }) =>
    jfetch<{ imported: string[] }>(`/api/v1/clusters/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kubeconfig: opts.kubeconfig ?? "",
        path: opts.path ?? "",
        name: opts.name ?? "",
      }),
    }),

  scanKubeconfigs: () =>
    jfetch<{ contexts: ScannedContext[]; files: { path: string; contexts: ScannedContext[] }[] }>(
      `/api/v1/clusters/scan`,
    ),

  // Per-cluster apiserver version, proxied through k8s-view's backend.
  // Server returns either the full apimachinery `version.Info` payload, or
  // a stripped-down fallback `{ gitVersion, cached: true, error }` when the
  // apiserver is briefly unreachable but we still have a cached version.
  clusterVersion: (cluster: string) =>
    jfetch<{ gitVersion?: string; gitCommit?: string; platform?: string; cached?: boolean; error?: string }>(
      `/api/v1/${encodeURIComponent(cluster)}/version`,
    ),

  apiResources: (cluster: string) =>
    jfetch<APIResource[]>(`/api/v1/${encodeURIComponent(cluster)}/api-resources`),

  namespaces: (cluster: string) =>
    jfetch<string[]>(`/api/v1/${encodeURIComponent(cluster)}/namespaces`),

  getResource: (cluster: string, gvr: GVR, ns: string | null, name: string) =>
    jfetch<any>(resourceURL(cluster, gvr, ns, name)),

  applyResource: (cluster: string, gvr: GVR, ns: string | null, name: string, yamlOrJSON: string) =>
    jfetch<any>(resourceURL(cluster, gvr, ns, name), {
      method: "PUT",
      body: yamlOrJSON,
      headers: { "Content-Type": "application/yaml" },
    }),

  // Dry-run preview: server validates and computes the would-be post-merge
  // object without persisting. Used to render a "what will change" diff
  // before the user actually saves.
  applyResourceDryRun: (cluster: string, gvr: GVR, ns: string | null, name: string, yamlOrJSON: string) =>
    jfetch<any>(resourceURL(cluster, gvr, ns, name) + "?dryRun=All", {
      method: "PUT",
      body: yamlOrJSON,
      headers: { "Content-Type": "application/yaml" },
    }),

  deleteResource: (cluster: string, gvr: GVR, ns: string | null, name: string,
                   opts?: { propagation?: "Foreground" | "Background" | "Orphan"; force?: boolean }) => {
    const u = new URL(resourceURL(cluster, gvr, ns, name), window.location.origin);
    if (opts?.propagation) u.searchParams.set("propagation", opts.propagation);
    if (opts?.force) u.searchParams.set("force", "true");
    return jfetch<any>(u.toString().replace(window.location.origin, ""), { method: "DELETE" });
  },

  serverSideApply: (cluster: string, yamlOrJSON: string) =>
    jfetch<any>(`/api/v1/${encodeURIComponent(cluster)}/apply`, {
      method: "POST",
      body: yamlOrJSON,
      headers: { "Content-Type": "application/yaml" },
    }),

  scale: (cluster: string, gvr: GVR, ns: string, name: string, replicas: number) => {
    const u = new URL(`/api/v1/${cluster}/scale/${gvrPath(gvr)}/ns/${ns}/${name}`, window.location.origin);
    u.searchParams.set("replicas", String(replicas));
    return jfetch<any>(u.toString().replace(window.location.origin, ""), { method: "POST" });
  },
  restart: (cluster: string, gvr: GVR, ns: string, name: string) =>
    jfetch<any>(`/api/v1/${cluster}/restart/${gvrPath(gvr)}/ns/${ns}/${name}`, { method: "POST" }),

  // Deployment rollout history (kubectl rollout history equivalent).
  // Returns every owned ReplicaSet sorted by revision desc, plus the current
  // revision pointer. Empty list is a valid response (no RS owned yet).
  rolloutHistory: (cluster: string, ns: string, name: string) =>
    jfetch<RolloutHistory>(`/api/v1/${encodeURIComponent(cluster)}/rollouts/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`),

  // Roll a Deployment back to a specific revision (kubectl rollout undo
  // --to-revision=N). The server resolves the matching RS, copies its
  // template into spec.template, and patches the Deployment.
  rollbackDeployment: (
    cluster: string, ns: string, name: string,
    revision: number, opts?: { changeCause?: string },
  ) =>
    jfetch<RollbackResult>(`/api/v1/${encodeURIComponent(cluster)}/rollouts/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, changeCause: opts?.changeCause ?? "" }),
    }),

  cordon:   (cluster: string, name: string) => jfetch<any>(`/api/v1/${cluster}/nodes/${name}/cordon`,   { method: "POST" }),
  uncordon: (cluster: string, name: string) => jfetch<any>(`/api/v1/${cluster}/nodes/${name}/uncordon`, { method: "POST" }),
  drain:    (cluster: string, name: string) => jfetch<any>(`/api/v1/${cluster}/nodes/${name}/drain`,    { method: "POST" }),
  nodeShell: (cluster: string, name: string, opts?: { image?: string; pullSecret?: string; namespace?: string }) => {
    const u = new URL(`/api/v1/${encodeURIComponent(cluster)}/nodes/${encodeURIComponent(name)}/shell`, window.location.origin);
    if (opts?.image) u.searchParams.set("image", opts.image);
    if (opts?.pullSecret) u.searchParams.set("pullSecret", opts.pullSecret);
    if (opts?.namespace) u.searchParams.set("namespace", opts.namespace);
    return jfetch<{ namespace: string; name: string; node: string; image: string }>(
      u.toString().replace(window.location.origin, ""), { method: "POST" });
  },
  nodeShellCleanup: (cluster: string, ns: string, name: string) =>
    jfetch<any>(`/api/v1/${encodeURIComponent(cluster)}/node-shell/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
      { method: "DELETE" }),
  evictPod: (cluster: string, ns: string, name: string) =>
    jfetch<any>(`/api/v1/${encodeURIComponent(cluster)}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/evict`,
      { method: "POST" }),

  events: (cluster: string, ns: string) =>
    jfetch<any>(`/api/v1/${cluster}/events/${ns || "_all"}`),

  podMetrics: (cluster: string, ns: string) =>
    jfetch<any>(`/api/v1/${cluster}/metrics/pods/${ns || "_all"}`),
  nodeMetrics: (cluster: string) =>
    jfetch<any>(`/api/v1/${cluster}/metrics/nodes`),

  prometheusInfo: (cluster: string) =>
    jfetch<PrometheusInfo>(`/api/v1/${encodeURIComponent(cluster)}/prometheus/info`),
  promQuery: (cluster: string, query: string, time?: number) => {
    const u = new URL(`/api/v1/${encodeURIComponent(cluster)}/prometheus/query`, window.location.origin);
    u.searchParams.set("query", query);
    if (time !== undefined) u.searchParams.set("time", String(time));
    return jfetch<PromResponse>(u.toString().replace(window.location.origin, ""));
  },
  promQueryRange: (cluster: string, query: string, start: number, end: number, step: string) => {
    const u = new URL(`/api/v1/${encodeURIComponent(cluster)}/prometheus/query_range`, window.location.origin);
    u.searchParams.set("query", query);
    u.searchParams.set("start", String(start));
    u.searchParams.set("end", String(end));
    u.searchParams.set("step", step);
    return jfetch<PromResponse>(u.toString().replace(window.location.origin, ""));
  },
};

export type RolloutRevision = {
  revision: number;
  replicaSet: string;
  uid: string;
  created: string;
  replicas: number;
  readyReplicas: number;
  current: boolean;
  images: string[];
  changeCause?: string;
  template: any;
  labels?: Record<string, string>;
};

export type RolloutHistory = {
  deployment: string;
  namespace: string;
  currentRevision: number;
  revisions: RolloutRevision[];
};

export type RollbackResult = {
  result: {
    rolledBackTo: number;
    fromRevision: number;
    replicaSet: string;
    deployment: string;
    namespace: string;
  };
  deployment: any;
};

export type PrometheusInfo =
  | { detected: true; namespace: string; service: string; port: string; scheme: string }
  | { detected: false; reason: string };

export type PromResponse = {
  status: "success" | "error";
  errorType?: string;
  error?: string;
  data?: {
    resultType: "matrix" | "vector" | "scalar" | "string";
    result: PromSample[];
  };
};

export type PromSample = {
  metric: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
};

export type GVR = { group: string; version: string; resource: string };

export function gvrKey(g: GVR): string {
  return `${g.group || "_"}/${g.version}/${g.resource}`;
}

export function gvrPath(g: GVR): string {
  // Empty group is encoded as "core" so chi sees a non-empty segment.
  return `${g.group || "core"}/${g.version}/${g.resource}`;
}

export function gvrFromAPI(r: APIResource): GVR {
  return { group: r.group, version: r.version, resource: r.name };
}

export function gvrToWatchRef(g: GVR): string {
  // The backend's resolver accepts "group/version/resource" form.
  return `${g.group || ""}/${g.version}/${g.resource}`;
}

function resourceURL(cluster: string, gvr: GVR, ns: string | null, name: string): string {
  const base = `/api/v1/${encodeURIComponent(cluster)}/resource/${encodeURIComponent(gvr.group || "core")}/${encodeURIComponent(gvr.version)}/${encodeURIComponent(gvr.resource)}`;
  if (ns) {
    return `${base}/ns/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;
  }
  return `${base}/${encodeURIComponent(name)}`;
}
