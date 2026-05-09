// The sidebar groups every resource into kubectl-like buckets. Anything not
// in this list is reachable through the "Custom Resources" page, so the user
// can never lose access to a CRD just because we didn't know about it.

import {
  Activity, Boxes, Box, Server, Layers, Network, HardDrive, Lock, ScrollText,
  Settings2, BookText, Users, FileLock2, Globe2, Key, FileCog, GitBranch,
  Workflow, Tags, Group, Container, Cog, ShieldCheck, GaugeCircle, AppWindow,
} from "lucide-react";

export type NavItem = {
  label: string;
  to: string;             // /:cluster/<route>
  icon: any;
  /** GVR string the page should subscribe to. Empty for static pages. */
  gvr?: string;
  /** Whether the resource is namespaced. */
  namespaced?: boolean;
};

export type NavSection = {
  /** Section heading. Omit (undefined) for headerless groups — Lens uses
   *  this for the Overview/Applications/Nodes top strip and for the
   *  standalone Namespaces/Events rows further down. */
  label?: string;
  items: NavItem[];
};

// Layout follows Lens v6.5.2: headerless top strip, then folders, with
// Namespaces and Events sitting between Storage and Access Control as
// standalone rows. Webhook configs live under Config (where the API group
// admissionregistration logically belongs), and Ingress Classes / Replication
// Controllers fill the gaps that earlier matched Lens-but-we-missed.
export const SECTIONS: NavSection[] = [
  {
    items: [
      { label: "Overview",     to: "overview",     icon: GaugeCircle },
      { label: "Applications", to: "applications", icon: AppWindow },
      { label: "Nodes",        to: "nodes",        icon: Server,   gvr: "/v1/Node" },
    ],
  },
  {
    label: "Workloads",
    items: [
      { label: "Overview",               to: "workloads",            icon: GaugeCircle },
      { label: "Pods",                   to: "pods",                 icon: Container,  gvr: "/v1/Pod",                       namespaced: true },
      { label: "Deployments",            to: "deployments",          icon: Box,        gvr: "apps/v1/Deployment",            namespaced: true },
      { label: "DaemonSets",             to: "daemonsets",           icon: Group,      gvr: "apps/v1/DaemonSet",             namespaced: true },
      { label: "StatefulSets",           to: "statefulsets",         icon: Layers,     gvr: "apps/v1/StatefulSet",           namespaced: true },
      { label: "ReplicaSets",            to: "replicasets",          icon: Workflow,   gvr: "apps/v1/ReplicaSet",            namespaced: true },
      { label: "ReplicationControllers", to: "replicationcontrollers", icon: Workflow, gvr: "/v1/ReplicationController",     namespaced: true },
      { label: "Jobs",                   to: "jobs",                 icon: GitBranch,  gvr: "batch/v1/Job",                  namespaced: true },
      { label: "CronJobs",               to: "cronjobs",             icon: GitBranch,  gvr: "batch/v1/CronJob",              namespaced: true },
    ],
  },
  {
    label: "Config",
    items: [
      { label: "ConfigMaps",                      to: "configmaps",       icon: FileCog,     gvr: "/v1/ConfigMap",  namespaced: true },
      { label: "Secrets",                         to: "secrets",          icon: Key,         gvr: "/v1/Secret",     namespaced: true },
      { label: "ResourceQuotas",                  to: "quotas",           icon: Tags,        gvr: "/v1/ResourceQuota", namespaced: true },
      { label: "LimitRanges",                     to: "limitranges",      icon: Tags,        gvr: "/v1/LimitRange", namespaced: true },
      { label: "HorizontalPodAutoscalers",        to: "hpa",              icon: Cog,         gvr: "autoscaling/v2/HorizontalPodAutoscaler", namespaced: true },
      { label: "PodDisruptionBudgets",            to: "pdb",              icon: Cog,         gvr: "policy/v1/PodDisruptionBudget", namespaced: true },
      { label: "PriorityClasses",                 to: "priorityclasses",  icon: Tags,        gvr: "scheduling.k8s.io/v1/PriorityClass" },
      { label: "RuntimeClasses",                  to: "runtimeclasses",   icon: Tags,        gvr: "node.k8s.io/v1/RuntimeClass" },
      { label: "Leases",                          to: "leases",           icon: Tags,        gvr: "coordination.k8s.io/v1/Lease", namespaced: true },
      { label: "MutatingWebhookConfigurations",   to: "mwc",              icon: ShieldCheck, gvr: "admissionregistration.k8s.io/v1/MutatingWebhookConfiguration" },
      { label: "ValidatingWebhookConfigurations", to: "vwc",              icon: ShieldCheck, gvr: "admissionregistration.k8s.io/v1/ValidatingWebhookConfiguration" },
    ],
  },
  {
    label: "Network",
    items: [
      { label: "Services",        to: "services",        icon: Network,     gvr: "/v1/Service",                          namespaced: true },
      { label: "Endpoints",       to: "endpoints",       icon: Network,     gvr: "discovery.k8s.io/v1/EndpointSlice",    namespaced: true },
      { label: "Ingresses",       to: "ingresses",       icon: Globe2,      gvr: "networking.k8s.io/v1/Ingress",         namespaced: true },
      { label: "IngressClasses",  to: "ingressclasses",  icon: Globe2,      gvr: "networking.k8s.io/v1/IngressClass" },
      { label: "NetworkPolicies", to: "networkpolicies", icon: ShieldCheck, gvr: "networking.k8s.io/v1/NetworkPolicy",   namespaced: true },
      { label: "Port Forwarding", to: "portforwards",    icon: Network },
    ],
  },
  {
    label: "Storage",
    items: [
      { label: "PersistentVolumeClaims", to: "pvc",        icon: HardDrive, gvr: "/v1/PersistentVolumeClaim", namespaced: true },
      { label: "PersistentVolumes",      to: "pv",         icon: HardDrive, gvr: "/v1/PersistentVolume" },
      { label: "StorageClasses",         to: "sc",         icon: HardDrive, gvr: "storage.k8s.io/v1/StorageClass" },
      { label: "CSIDrivers",             to: "csidrivers", icon: HardDrive, gvr: "storage.k8s.io/v1/CSIDriver" },
      { label: "CSINodes",               to: "csinodes",   icon: HardDrive, gvr: "storage.k8s.io/v1/CSINode" },
    ],
  },
  {
    items: [
      { label: "Namespaces", to: "namespaces", icon: Boxes,    gvr: "/v1/Namespace" },
      { label: "Events",     to: "events",     icon: Activity, gvr: "/v1/Event", namespaced: true },
    ],
  },
  {
    label: "Access Control",
    items: [
      { label: "ServiceAccounts",     to: "sa",                  icon: Users,     gvr: "/v1/ServiceAccount",                                  namespaced: true },
      { label: "ClusterRoles",        to: "clusterroles",        icon: Lock,      gvr: "rbac.authorization.k8s.io/v1/ClusterRole" },
      { label: "Roles",               to: "roles",               icon: FileLock2, gvr: "rbac.authorization.k8s.io/v1/Role",                   namespaced: true },
      { label: "ClusterRoleBindings", to: "clusterrolebindings", icon: Lock,      gvr: "rbac.authorization.k8s.io/v1/ClusterRoleBinding" },
      { label: "RoleBindings",        to: "rolebindings",        icon: FileLock2, gvr: "rbac.authorization.k8s.io/v1/RoleBinding",            namespaced: true },
    ],
  },
  {
    label: "Custom Resources",
    items: [
      { label: "Definitions",   to: "crds",   icon: BookText,
        gvr: "apiextensions.k8s.io/v1/CustomResourceDefinition" },
      { label: "Browse",        to: "custom", icon: ScrollText },
      { label: "API Resources", to: "apis",   icon: Settings2 },
    ],
  },
];
