// Pristine demo dataset for k8s-view — a realistic 3-node Kubernetes cluster's
// objects, keyed by GVR string ("group/version/resource", core group = "core").
/* eslint-disable @typescript-eslint/no-explicit-any */

const now = Date.now();
const ts = (msAgo: number) => new Date(now - msAgo).toISOString();
const D = 86_400_000, H = 3_600_000, M = 60_000;
let uidN = 1;
const uid = () => `uid-${(uidN++).toString(16).padStart(8, "0")}-demo`;

const meta = (name: string, ns: string | undefined, ageMs: number, labels: Record<string, string> = {}, extra: any = {}) => ({
  uid: uid(), name, ...(ns ? { namespace: ns } : {}), creationTimestamp: ts(ageMs), resourceVersion: String(100000 + uidN), labels, ...extra,
});

const NS = ["default", "kube-system", "monitoring", "ingress-nginx", "argocd", "cert-manager"];

function pods(): any[] {
  const defs: [string, string, string, string, number, number][] = [
    ["web-7d9f8c6b5-x2k9p", "default", "Running", "node-1", 0, 3 * D],
    ["web-7d9f8c6b5-q4m1z", "default", "Running", "node-2", 0, 3 * D],
    ["web-7d9f8c6b5-h8t3w", "default", "Running", "node-3", 1, 3 * D],
    ["api-5c8b9d7f6-h3n2k", "default", "Running", "node-1", 0, 2 * D],
    ["api-5c8b9d7f6-p9l4m", "default", "Running", "node-2", 0, 2 * D],
    ["postgres-0", "default", "Running", "node-3", 0, 12 * D],
    ["redis-0", "default", "Running", "node-1", 0, 12 * D],
    ["coredns-787d4945fb-abcde", "kube-system", "Running", "node-1", 0, 20 * D],
    ["coredns-787d4945fb-fghij", "kube-system", "Running", "node-2", 1, 20 * D],
    ["kube-apiserver-node-1", "kube-system", "Running", "node-1", 0, 20 * D],
    ["etcd-node-1", "kube-system", "Running", "node-1", 0, 20 * D],
    ["prometheus-0", "monitoring", "Running", "node-3", 0, 8 * D],
    ["grafana-66f8c-77abc", "monitoring", "Running", "node-2", 0, 8 * D],
    ["ingress-nginx-controller-x9z4f", "ingress-nginx", "Running", "node-2", 2, 9 * D],
    ["migrate-27839-pp4tk", "default", "Succeeded", "node-1", 0, 4 * H],
    ["broken-job-abc12", "default", "CrashLoopBackOff", "node-3", 8, 2 * H],
  ];
  return defs.map(([name, ns, phase, node, restarts, age]) => ({
    apiVersion: "v1", kind: "Pod", metadata: meta(name, ns, age, { app: name.split("-")[0] }, { ownerReferences: [{ kind: "ReplicaSet", name: name.split("-").slice(0, -1).join("-") }] }),
    spec: { nodeName: node, containers: [{ name: name.split("-")[0], image: `registry.k8s.io/${name.split("-")[0]}:v1.4.2`, resources: { requests: { cpu: "100m", memory: "128Mi" } } }] },
    status: { phase: phase === "CrashLoopBackOff" ? "Running" : phase, podIP: `10.244.${NS.indexOf(ns)}.${10 + restarts}`, hostIP: `10.0.1.${10 + Number(node.slice(-1))}`,
      containerStatuses: [{ name: name.split("-")[0], ready: phase === "Running", restartCount: restarts, state: phase === "CrashLoopBackOff" ? { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } } : { running: { startedAt: ts(age) } } }],
      conditions: [{ type: "Ready", status: phase === "Running" ? "True" : "False" }] },
  }));
}

function deployment(name: string, ns: string, replicas: number, ready: number, age: number) {
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: meta(name, ns, age, { app: name }), spec: { replicas, selector: { matchLabels: { app: name } }, template: { spec: { containers: [{ name, image: `registry.k8s.io/${name}:v1.4.2` }] } } }, status: { replicas, readyReplicas: ready, availableReplicas: ready, updatedReplicas: replicas, conditions: [{ type: "Available", status: ready >= replicas ? "True" : "False" }] } };
}
function service(name: string, ns: string, type: string, ip: string, port: number, age: number) {
  return { apiVersion: "v1", kind: "Service", metadata: meta(name, ns, age, { app: name }), spec: { type, clusterIP: ip, selector: { app: name }, ports: [{ port, targetPort: port, protocol: "TCP" }] }, status: {} };
}
function node(name: string, ip: string, ready: boolean, role: string) {
  return { apiVersion: "v1", kind: "Node", metadata: meta(name, undefined, 30 * D, { "kubernetes.io/hostname": name, ...(role ? { "node-role.kubernetes.io/control-plane": "" } : {}) }), spec: {}, status: {
    conditions: [{ type: "Ready", status: ready ? "True" : "False" }, { type: "MemoryPressure", status: "False" }, { type: "DiskPressure", status: "False" }],
    nodeInfo: { kubeletVersion: "v1.29.4", osImage: "Ubuntu 22.04.4 LTS", containerRuntimeVersion: "containerd://1.7.13", kernelVersion: "5.15.0-91-generic", architecture: "amd64" },
    capacity: { cpu: "8", memory: "32932392Ki", pods: "110" }, allocatable: { cpu: "7800m", memory: "31000000Ki", pods: "110" },
    addresses: [{ type: "InternalIP", address: ip }, { type: "Hostname", address: name }] } };
}

export function buildSeed() {
  const R: Record<string, any[]> = {};
  R["pods"] = pods();
  R["deployments"] = [deployment("web", "default", 3, 3, 3 * D), deployment("api", "default", 2, 2, 2 * D), deployment("grafana", "monitoring", 1, 1, 8 * D), deployment("argocd-server", "argocd", 1, 1, 15 * D), deployment("cert-manager", "cert-manager", 1, 0, 10 * D), deployment("ingress-nginx-controller", "ingress-nginx", 2, 2, 9 * D)];
  R["replicasets"] = [["web-7d9f8c6b5", "default", 3], ["api-5c8b9d7f6", "default", 2]].map(([n, ns, r]: any) => ({ apiVersion: "apps/v1", kind: "ReplicaSet", metadata: meta(n, ns, 3 * D, { app: String(n).split("-")[0] }, { ownerReferences: [{ kind: "Deployment", name: String(n).split("-")[0] }] }), spec: { replicas: r }, status: { replicas: r, readyReplicas: r } }));
  R["statefulsets"] = [["postgres", "default", 1], ["prometheus", "monitoring", 1]].map(([n, ns, r]: any) => ({ apiVersion: "apps/v1", kind: "StatefulSet", metadata: meta(n, ns, 12 * D, { app: n }), spec: { replicas: r, serviceName: n }, status: { replicas: r, readyReplicas: r } }));
  R["daemonsets"] = [["kube-proxy", "kube-system"], ["node-exporter", "monitoring"]].map(([n, ns]: any) => ({ apiVersion: "apps/v1", kind: "DaemonSet", metadata: meta(n, ns, 20 * D, { app: n }), spec: {}, status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3 } }));
  R["services"] = [service("kubernetes", "default", "ClusterIP", "10.96.0.1", 443, 30 * D), service("web", "default", "ClusterIP", "10.96.42.10", 80, 3 * D), service("api", "default", "ClusterIP", "10.96.42.20", 8080, 2 * D), service("postgres", "default", "ClusterIP", "10.96.42.30", 5432, 12 * D), service("redis", "default", "ClusterIP", "10.96.42.40", 6379, 12 * D), service("grafana", "monitoring", "ClusterIP", "10.96.50.10", 3000, 8 * D), service("prometheus", "monitoring", "ClusterIP", "10.96.50.20", 9090, 8 * D), service("ingress-nginx", "ingress-nginx", "LoadBalancer", "10.96.60.10", 443, 9 * D)];
  R["nodes"] = [node("node-1", "10.0.1.11", true, "cp"), node("node-2", "10.0.1.12", true, ""), node("node-3", "10.0.1.13", true, "")];
  R["namespaces"] = NS.concat(["kube-public", "kube-node-lease"]).map((n) => ({ apiVersion: "v1", kind: "Namespace", metadata: meta(n, undefined, 30 * D), spec: {}, status: { phase: "Active" } }));
  R["configmaps"] = [["coredns", "kube-system"], ["kube-root-ca.crt", "default"], ["app-config", "default"], ["grafana-dashboards", "monitoring"]].map(([n, ns]: any) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: meta(n, ns, 10 * D), data: { "config.yaml": "key: value\nlog_level: info" } }));
  R["secrets"] = [["db-credentials", "default", "Opaque"], ["tls-cert", "ingress-nginx", "kubernetes.io/tls"], ["argocd-secret", "argocd", "Opaque"]].map(([n, ns, t]: any) => ({ apiVersion: "v1", kind: "Secret", metadata: meta(n, ns, 10 * D), type: t, data: { token: "••••••••" } }));
  R["cronjobs"] = [["backup", "default"], ["cert-renew", "cert-manager"]].map(([n, ns]: any) => ({ apiVersion: "batch/v1", kind: "CronJob", metadata: meta(n, ns, 9 * D), spec: { schedule: "0 2 * * *", suspend: false }, status: { lastScheduleTime: ts(20 * H) } }));
  R["jobs"] = [["migrate-27839", "default", true], ["broken-job", "default", false]].map(([n, ns, ok]: any) => ({ apiVersion: "batch/v1", kind: "Job", metadata: meta(n, ns, 4 * H), spec: { completions: 1 }, status: ok ? { succeeded: 1, completionTime: ts(3 * H) } : { failed: 8, conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }] } }));
  R["ingresses"] = [["web", "default", "app.acme.io"], ["grafana", "monitoring", "grafana.acme.io"]].map(([n, ns, host]: any) => ({ apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: meta(n, ns, 9 * D), spec: { rules: [{ host, http: { paths: [{ path: "/", backend: { service: { name: n, port: { number: 80 } } } }] } }] }, status: { loadBalancer: { ingress: [{ ip: "10.96.60.10" }] } } }));
  R["persistentvolumeclaims"] = [["postgres-data", "default", "20Gi"], ["prometheus-data", "monitoring", "50Gi"]].map(([n, ns, size]: any) => ({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta(n, ns, 12 * D), spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: size } }, storageClassName: "standard" }, status: { phase: "Bound", capacity: { storage: size } } }));
  R["events"] = [
    ["Warning", "BackOff", "pod/broken-job-abc12", "Back-off restarting failed container app", 42, "kubelet", 2 * H],
    ["Normal", "Scheduled", "pod/web-7d9f8c6b5-x2k9p", "Successfully assigned default/web to node-1", 1, "default-scheduler", 3 * D],
    ["Normal", "Pulled", "pod/api-5c8b9d7f6-h3n2k", "Container image already present on machine", 1, "kubelet", 2 * D],
    ["Warning", "Unhealthy", "pod/cert-manager-x", "Readiness probe failed: connection refused", 6, "kubelet", 30 * M],
    ["Normal", "ScalingReplicaSet", "deployment/web", "Scaled up replica set web-7d9f8c6b5 to 3", 1, "deployment-controller", 3 * D],
    ["Normal", "SuccessfulCreate", "job/migrate-27839", "Created pod: migrate-27839-pp4tk", 1, "job-controller", 4 * H],
    ["Warning", "FailedMount", "pod/prometheus-0", "Unable to attach or mount volumes: timed out", 2, "kubelet", 8 * D],
  ].map(([type, reason, obj, message, count, component, age]: any) => ({ apiVersion: "v1", kind: "Event", metadata: meta(`${String(obj).split("/")[1]}.${reason}`, String(obj).includes("/") ? "default" : undefined, age), type, reason, message, count, source: { component }, involvedObject: { kind: String(obj).split("/")[0], name: String(obj).split("/")[1] }, lastTimestamp: ts(age), firstTimestamp: ts(age + H) }));

  return {
    clusters: [
      { name: "prod-eu", context: "prod-eu", connected: true, reachable: true, current: true, version: "v1.29.4", nodes: 3, source: "kubeconfig" },
      { name: "prod-us", context: "prod-us", connected: true, reachable: true, current: false, version: "v1.29.2", nodes: 5, source: "kubeconfig" },
      { name: "staging", context: "staging", connected: true, reachable: true, current: false, version: "v1.30.1", nodes: 2, source: "kubeconfig" },
      { name: "dev-laptop", context: "kind-dev", connected: true, reachable: true, current: false, version: "v1.29.0", nodes: 1, source: "kubeconfig" },
    ],
    resources: R,
    nodeMetrics: { "node-1": { cpu: 2400, cpuPct: 31, memory: 11 * 1024 ** 3, memPct: 34 }, "node-2": { cpu: 1800, cpuPct: 23, memory: 9 * 1024 ** 3, memPct: 28 }, "node-3": { cpu: 3100, cpuPct: 40, memory: 14 * 1024 ** 3, memPct: 44 } },
  };
}
