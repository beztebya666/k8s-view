// REST helpers. Long-lived data goes over the WebSocket — these are for one-
// shot operations like "fetch the current YAML", "scale", "delete", etc.

export type ClusterInfo = {
  name: string;
  server: string;
  kubeconfig?: string;
  current: boolean;
  connected: boolean;
  version?: string;
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
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function jfetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep as text */ }
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText || `HTTP ${res.status}`;
    throw new APIError(res.status, msg);
  }
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
