// Per-GVR starter templates for the "Create resource" pane. The FAB on each
// resource page pre-selects the matching template so the user lands in an
// editor with valid scaffold instead of a blank screen — same UX as Lens.
//
// Template selection is fuzzy on the GVR string we already use across the
// app: "<group>/<version>/<Kind>", with the leading slash for the core API
// (e.g. "/v1/Pod"). Unknown GVRs fall back to GENERIC_TEMPLATE.

export type ResourceTemplate = {
  /** Display label inside the editor's template picker. */
  label: string;
  /** YAML body, ready to apply once the user fills in the placeholders. */
  yaml: string;
};

const POD: ResourceTemplate = {
  label: "Pod",
  yaml: `apiVersion: v1
kind: Pod
metadata:
  name: example
  namespace: default
spec:
  containers:
    - name: main
      image: nginx:1.27
      ports:
        - containerPort: 80
`,
};

const DEPLOYMENT: ResourceTemplate = {
  label: "Deployment",
  yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
};

const STATEFULSET: ResourceTemplate = {
  label: "StatefulSet",
  yaml: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: example
  namespace: default
spec:
  serviceName: example
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
};

const DAEMONSET: ResourceTemplate = {
  label: "DaemonSet",
  yaml: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: example
  namespace: default
spec:
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: nginx:1.27
`,
};

const JOB: ResourceTemplate = {
  label: "Job",
  yaml: `apiVersion: batch/v1
kind: Job
metadata:
  name: example
  namespace: default
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: main
          image: busybox:1.36
          command: ["sh", "-c", "echo hello"]
`,
};

const CRONJOB: ResourceTemplate = {
  label: "CronJob",
  yaml: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: example
  namespace: default
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: main
              image: busybox:1.36
              command: ["sh", "-c", "date"]
`,
};

const SERVICE: ResourceTemplate = {
  label: "Service",
  yaml: `apiVersion: v1
kind: Service
metadata:
  name: example
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: example
  ports:
    - port: 80
      targetPort: 80
      protocol: TCP
`,
};

const INGRESS: ResourceTemplate = {
  label: "Ingress",
  yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: default
spec:
  rules:
    - host: example.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example
                port:
                  number: 80
`,
};

const CONFIGMAP: ResourceTemplate = {
  label: "ConfigMap",
  yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  hello: world
`,
};

const SECRET: ResourceTemplate = {
  label: "Secret (Opaque)",
  yaml: `apiVersion: v1
kind: Secret
metadata:
  name: example
  namespace: default
type: Opaque
stringData:
  username: admin
  password: changeme
`,
};

const NAMESPACE: ResourceTemplate = {
  label: "Namespace",
  yaml: `apiVersion: v1
kind: Namespace
metadata:
  name: example
`,
};

const SERVICEACCOUNT: ResourceTemplate = {
  label: "ServiceAccount",
  yaml: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: example
  namespace: default
`,
};

const ROLE: ResourceTemplate = {
  label: "Role",
  yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: example
  namespace: default
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
`,
};

const ROLEBINDING: ResourceTemplate = {
  label: "RoleBinding",
  yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: example
  namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: example
subjects:
  - kind: ServiceAccount
    name: example
    namespace: default
`,
};

const HPA: ResourceTemplate = {
  label: "HorizontalPodAutoscaler",
  yaml: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
};

const PVC: ResourceTemplate = {
  label: "PersistentVolumeClaim",
  yaml: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example
  namespace: default
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`,
};

const NETWORKPOLICY: ResourceTemplate = {
  label: "NetworkPolicy",
  yaml: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: example
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: example
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: example
`,
};

const PDB: ResourceTemplate = {
  label: "PodDisruptionBudget",
  yaml: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example
  namespace: default
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: example
`,
};

export const GENERIC_TEMPLATE: ResourceTemplate = CONFIGMAP;

const TEMPLATES_BY_GVR: Record<string, ResourceTemplate> = {
  "/v1/Pod": POD,
  "/v1/Service": SERVICE,
  "/v1/ConfigMap": CONFIGMAP,
  "/v1/Secret": SECRET,
  "/v1/Namespace": NAMESPACE,
  "/v1/ServiceAccount": SERVICEACCOUNT,
  "/v1/PersistentVolumeClaim": PVC,
  "apps/v1/Deployment": DEPLOYMENT,
  "apps/v1/StatefulSet": STATEFULSET,
  "apps/v1/DaemonSet": DAEMONSET,
  "batch/v1/Job": JOB,
  "batch/v1/CronJob": CRONJOB,
  "networking.k8s.io/v1/Ingress": INGRESS,
  "networking.k8s.io/v1/NetworkPolicy": NETWORKPOLICY,
  "rbac.authorization.k8s.io/v1/Role": ROLE,
  "rbac.authorization.k8s.io/v1/RoleBinding": ROLEBINDING,
  "autoscaling/v2/HorizontalPodAutoscaler": HPA,
  "policy/v1/PodDisruptionBudget": PDB,
};

export function templateForGVR(gvr: string | null | undefined): ResourceTemplate {
  if (!gvr) return GENERIC_TEMPLATE;
  return TEMPLATES_BY_GVR[gvr] ?? GENERIC_TEMPLATE;
}

export function allTemplates(): Array<{ key: string; template: ResourceTemplate }> {
  return Object.entries(TEMPLATES_BY_GVR)
    .map(([key, template]) => ({ key, template }))
    .sort((a, b) => a.template.label.localeCompare(b.template.label));
}
