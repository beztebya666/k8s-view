export type PodStatusKind = "ok" | "warn" | "bad" | "info" | "mute";

export type PodDisplayStatus = {
  label: string;
  kind: PodStatusKind;
  detail?: string;
  ready: number;
  total: number;
  restarts: number;
  phase: string;
  terminating: boolean;
};

export function podDisplayStatus(pod: any): PodDisplayStatus {
  if (!pod) return makeStatus("Unknown", "mute", { phase: "Unknown" });

  const status = pod.status ?? {};
  const phase = String(status.phase ?? "Unknown");
  const containerStatuses: any[] = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
  const initStatuses: any[] = Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : [];
  const total = pod.spec?.containers?.length ?? containerStatuses.length;
  const ready = containerStatuses.filter((c) => c?.ready).length;
  const restarts = [...containerStatuses, ...initStatuses]
    .reduce((sum, c) => sum + Number(c?.restartCount ?? 0), 0);

  let label = String(status.reason || phase || "Unknown");
  let initializing = false;

  for (let i = 0; i < initStatuses.length; i++) {
    const c = initStatuses[i];
    const terminated = c?.state?.terminated;
    if (terminated && Number(terminated.exitCode ?? 0) === 0) continue;

    if (terminated) {
      label = `Init:${terminatedReason(terminated)}`;
    } else if (c?.state?.waiting?.reason) {
      label = `Init:${c.state.waiting.reason}`;
    } else {
      label = `Init:${i}/${initStatuses.length}`;
    }
    initializing = true;
    break;
  }

  if (!initializing || isConditionTrue(status.conditions, "Initialized")) {
    let hasRunning = false;
    for (let i = containerStatuses.length - 1; i >= 0; i--) {
      const c = containerStatuses[i];
      if (c?.state?.waiting?.reason) {
        label = String(c.state.waiting.reason);
      } else if (c?.state?.terminated) {
        label = terminatedReason(c.state.terminated);
      } else if (c?.ready && c?.state?.running) {
        hasRunning = true;
      }
    }
    if ((label === "Completed" || label === "Succeeded") && hasRunning) {
      label = isConditionTrue(status.conditions, "Ready") ? "Running" : "NotReady";
    }
  }

  const terminating = !!pod.metadata?.deletionTimestamp;
  if (terminating) {
    label = status.reason === "NodeLost" ? "Unknown" : "Terminating";
  }

  return makeStatus(label, statusKind(label, phase, ready, total), {
    phase,
    ready,
    total,
    restarts,
    terminating,
    detail: status.message || status.reason || undefined,
  });
}

export function containerDisplayStatus(pod: any, name: string): PodDisplayStatus | null {
  if (!pod || !name) return null;
  const status = pod.status ?? {};
  const phase = String(status.phase ?? "Unknown");
  const all = [
    ...(Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : []),
    ...(Array.isArray(status.containerStatuses) ? status.containerStatuses : []),
    ...(Array.isArray(status.ephemeralContainerStatuses) ? status.ephemeralContainerStatuses : []),
  ];
  const c = all.find((x: any) => x?.name === name);
  if (!c) return null;

  let label = phase;
  let detail: string | undefined;
  if (pod.metadata?.deletionTimestamp) {
    label = status.reason === "NodeLost" ? "Unknown" : "Terminating";
    detail = "deletionTimestamp set";
  } else if (c.state?.waiting) {
    label = String(c.state.waiting.reason ?? "Waiting");
    detail = c.state.waiting.message;
  } else if (c.state?.terminated) {
    label = terminatedReason(c.state.terminated);
    detail = c.state.terminated.message
      ?? (c.state.terminated.exitCode !== undefined ? `exit ${c.state.terminated.exitCode}` : undefined);
  } else if (c.state?.running) {
    label = c.ready ? "Running" : "NotReady";
    detail = c.state.running.startedAt ? `started ${c.state.running.startedAt}` : undefined;
  }

  return makeStatus(label, statusKind(label, phase, c.ready ? 1 : 0, 1), {
    phase,
    ready: c.ready ? 1 : 0,
    total: 1,
    restarts: Number(c.restartCount ?? 0),
    terminating: !!pod.metadata?.deletionTimestamp,
    detail,
  });
}

export function podStatusClassName(kind: PodStatusKind): string {
  if (kind === "ok") return "chip-ok";
  if (kind === "warn") return "chip-warn";
  if (kind === "bad") return "chip-bad";
  if (kind === "info") return "chip-info";
  return "chip";
}

export function podControllerKey(pod: any): string | null {
  const ns = pod?.metadata?.namespace ?? "";
  const refs: any[] = pod?.metadata?.ownerReferences ?? [];
  const ctrl = refs.find((r) => r?.controller) ?? refs[0];
  if (!ctrl?.kind || !ctrl?.name) return pod?.metadata?.name ? `Pod/${ns}/${pod.metadata.name}` : null;
  if (ctrl.kind === "ReplicaSet") {
    return `Deployment/${ns}/${stripHashSuffix(ctrl.name)}`;
  }
  return `${ctrl.kind}/${ns}/${ctrl.name}`;
}

export function guessedPodControllerKey(ns: string, podName: string): string {
  const parts = podName.split("-");
  if (parts.length >= 3) return `Deployment/${ns}/${parts.slice(0, -2).join("-")}`;
  return `Pod/${ns}/${podName}`;
}

function makeStatus(
  label: string,
  kind: PodStatusKind,
  opts: Partial<Omit<PodDisplayStatus, "label" | "kind">> = {},
): PodDisplayStatus {
  return {
    label,
    kind,
    detail: opts.detail,
    ready: opts.ready ?? 0,
    total: opts.total ?? 0,
    restarts: opts.restarts ?? 0,
    phase: opts.phase ?? label,
    terminating: opts.terminating ?? false,
  };
}

function terminatedReason(t: any): string {
  if (t?.reason) return String(t.reason);
  const signal = Number(t?.signal ?? 0);
  if (signal) return `Signal:${signal}`;
  if (t?.exitCode !== undefined) return `ExitCode:${t.exitCode}`;
  return "Terminated";
}

function isConditionTrue(conditions: any, type: string): boolean {
  return Array.isArray(conditions) && conditions.some((c) => c?.type === type && c?.status === "True");
}

function statusKind(label: string, phase: string, ready: number, total: number): PodStatusKind {
  const s = label.toLowerCase();
  if (label === "Running") return total <= 0 || ready >= total ? "ok" : "warn";
  // "Completed" / "Succeeded" → blue (info): a deliberate end-state, worth
  // calling out. Truly unrecognised labels → muted grey ("Other"): we have
  // no opinion on them, so don't draw the eye. Bucket tones in
  // PodStatusFilterStrip match this convention.
  if (label === "Completed" || label === "Succeeded" || phase === "Succeeded") return "info";
  if (label === "Pending" || label === "Terminating" || label === "NotReady" || s.startsWith("init:")) return "warn";
  if (s.includes("creating") || s.includes("initializing") || s.includes("waiting")) return "warn";
  if (phase === "Failed" || phase === "Unknown") return "bad";
  if (/crash|error|err|fail|backoff|oom|evicted|invalid/i.test(label)) return "bad";
  return "mute";
}

function stripHashSuffix(s: string): string {
  const m = /^(.*)-([a-z0-9]{5,10})$/.exec(s);
  return m ? m[1] : s;
}
