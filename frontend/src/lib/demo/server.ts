// In-browser "server" for the k8s-view demo: REST endpoints over the seeded
// cluster. Resource LISTS arrive via the informer WS (see stream.ts mock); this
// covers clusters, namespaces, api-resources, metrics, get/apply/delete + actions.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDB, saveDB } from "./db";

const realFetch = window.fetch.bind(window);
const db = () => getDB() as any;

const API_RESOURCES = [
  ["pods", "pod", true, "Pod", "", "v1"], ["services", "service", true, "Service", "", "v1"],
  ["nodes", "node", false, "Node", "", "v1"], ["namespaces", "namespace", false, "Namespace", "", "v1"],
  ["configmaps", "configmap", true, "ConfigMap", "", "v1"], ["secrets", "secret", true, "Secret", "", "v1"],
  ["events", "event", true, "Event", "", "v1"], ["persistentvolumeclaims", "pvc", true, "PersistentVolumeClaim", "", "v1"],
  ["deployments", "deployment", true, "Deployment", "apps", "v1"], ["replicasets", "replicaset", true, "ReplicaSet", "apps", "v1"],
  ["statefulsets", "statefulset", true, "StatefulSet", "apps", "v1"], ["daemonsets", "daemonset", true, "DaemonSet", "apps", "v1"],
  ["jobs", "job", true, "Job", "batch", "v1"], ["cronjobs", "cronjob", true, "CronJob", "batch", "v1"],
  ["ingresses", "ingress", true, "Ingress", "networking.k8s.io", "v1"],
].map(([resource, singularName, namespaced, kind, group, version]) => ({ name: resource, singularName, namespaced, kind, group, version, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] }));

type H = (m: RegExpMatchArray, q: URLSearchParams, body: any, method: string) => any;
const routes: [RegExp, string, H][] = [];
const on = (re: RegExp, methods: string, h: H) => routes.push([re, methods, h]);

on(/^\/api\/v1\/healthz$/, "GET", () => ({ status: "ok" }));
on(/^\/api\/v1\/version$/, "GET", () => ({ version: "1.0.0", commit: "demo" }));
on(/^\/api\/v1\/me$/, "GET", () => ({ id: "demo-device", kind: "device", displayName: "Demo" }));
on(/^\/api\/v1\/me\/adopt$/, "POST", () => ({ adopted: "demo-device" }));
on(/^\/api\/v1\/clusters$/, "GET", () => db().clusters);
on(/^\/api\/v1\/clusters\/scan$/, "GET", () => ({ contexts: [], files: [] }));
on(/^\/api\/v1\/clusters\/import$/, "POST", () => ({ imported: [] }));
on(/^\/api\/v1\/clusters\/([^/]+)\/select$/, "POST", (m) => { db().clusters.forEach((c: any) => (c.current = c.name === decodeURIComponent(m[1]))); saveDB(); return { current: decodeURIComponent(m[1]) }; });
on(/^\/api\/v1\/clusters\/([^/]+)\/connect$/, "POST", (m) => { const c = db().clusters.find((x: any) => x.name === decodeURIComponent(m[1])); if (c) { c.connected = true; c.reachable = true; } saveDB(); return { connected: decodeURIComponent(m[1]) }; });
on(/^\/api\/v1\/clusters\/([^/]+)\/disconnect$/, "POST", (m) => { const c = db().clusters.find((x: any) => x.name === decodeURIComponent(m[1])); if (c) c.connected = false; saveDB(); return { disconnected: decodeURIComponent(m[1]) }; });
on(/^\/api\/v1\/clusters\/([^/]+)$/, "DELETE", (m) => { const d = db(); d.clusters = d.clusters.filter((x: any) => x.name !== decodeURIComponent(m[1])); saveDB(); return { removed: decodeURIComponent(m[1]) }; });
on(/^\/api\/v1\/([^/]+)\/version$/, "GET", () => ({ gitVersion: "v1.29.4", gitCommit: "demo", platform: "linux/amd64" }));
on(/^\/api\/v1\/([^/]+)\/api-resources$/, "GET", () => API_RESOURCES);
on(/^\/api\/v1\/([^/]+)\/namespaces$/, "GET", () => db().resources["core/v1/namespaces"].map((n: any) => n.metadata.name));
on(/^\/api\/v1\/([^/]+)\/metrics\/nodes$/, "GET", () => db().nodeMetrics);
on(/^\/api\/v1\/([^/]+)\/metrics\/pods(\/.*)?$/, "GET", () => podMetrics());
// resource get: /resource/{group}/{version}/{resource}[/ns/{ns}]/{name}
on(/^\/api\/v1\/([^/]+)\/resource\/([^/]+)\/([^/]+)\/([^/]+)(?:\/ns\/([^/]+))?\/([^/]+)$/, "GET", (m) => {
  const gvr = `${m[2]}/${m[3]}/${m[4]}`; const name = decodeURIComponent(m[6]);
  const found = (db().resources[gvr] || []).find((x: any) => x.metadata.name === name);
  return found || { __status: 404 };
});
on(/^\/api\/v1\/([^/]+)\/resource\/.+$/, "PUT", (_m, _q, body) => { try { return JSON.parse(body); } catch { return { ok: true }; } });
on(/^\/api\/v1\/([^/]+)\/resource\/.+$/, "DELETE", () => ({ ok: true }));
on(/^\/api\/v1\/([^/]+)\/(scale|restart)\/.+$/, "POST", () => ({ ok: true }));
on(/^\/api\/v1\/([^/]+)\/nodes\/([^/]+)\/(cordon|uncordon|drain)$/, "POST", () => ({ ok: true }));
on(/^\/api\/v1\/([^/]+)\/apply$/, "POST", () => ({ ok: true }));
on(/^\/api\/v1\/([^/]+)\/.*\/portforward.*$/, "POST", () => ({ ok: true, port: 30022 }));

function podMetrics() {
  const out: Record<string, any> = {};
  for (const p of db().resources["core/v1/pods"]) out[`${p.metadata.namespace}/${p.metadata.name}`] = { cpu: Math.round(20 + Math.random() * 180), memory: Math.round((40 + Math.random() * 220) * 1024 * 1024) };
  return out;
}

export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).method : "GET") || "GET").toUpperCase();
  const u = new URL(raw, location.origin);
  if (!u.pathname.startsWith("/api/")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : undefined;
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 70));
  for (const [re, methods, h] of routes) {
    if (!methods.split(",").includes(method)) continue;
    const m = u.pathname.match(re);
    if (!m) continue;
    let out: any; try { out = h(m, u.searchParams, body, method); } catch (e) { return json({ error: String(e) }, 500); }
    if (out && out.__status) return json({ error: "not found" }, out.__status);
    return json(out, 200);
  }
  console.warn("[demo] unhandled", method, u.pathname);
  return json(method === "GET" ? [] : { ok: true }, 200);
}
function json(d: any, status: number) { return new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } }); }
