// Frontend-side kubectl-describe synthesis. We already have the full
// object + cluster events on the panel; rendering them as the text block
// kubectl users are used to skimming is a small format pass over the
// JSON, no new backend route needed.
//
// The output is intentionally close to `kubectl describe` so muscle
// memory transfers: column-aligned key/value blocks, "Conditions:"
// table, "Events:" table sorted oldest-first.

const COLUMN = 24;

export function describe(obj: any, events: any[] = []): string {
  if (!obj || typeof obj !== "object") return "no object";
  const out: string[] = [];
  const meta = obj.metadata ?? {};
  out.push(line("Name", meta.name));
  if (meta.namespace) out.push(line("Namespace", meta.namespace));
  if (obj.kind) out.push(line("Kind", obj.kind));
  if (obj.apiVersion) out.push(line("API Version", obj.apiVersion));
  if (meta.uid) out.push(line("UID", meta.uid));
  if (meta.creationTimestamp) out.push(line("Created", meta.creationTimestamp));
  if (meta.deletionTimestamp) out.push(line("Deletion", meta.deletionTimestamp));
  if (meta.resourceVersion) out.push(line("Resource Version", meta.resourceVersion));

  const labels = meta.labels ?? {};
  out.push(...kvBlock("Labels", labels));
  const annotations = meta.annotations ?? {};
  out.push(...kvBlock("Annotations", annotations));

  const owners = meta.ownerReferences ?? [];
  if (owners.length > 0) {
    out.push(line("Controlled By", owners.map((o: any) => `${o.kind}/${o.name}`).join(", ")));
  }

  if (obj.spec) {
    out.push("");
    out.push("Spec:");
    out.push(...indented(summarise(obj.spec, /* depth */ 3)));
  }

  if (obj.status) {
    out.push("");
    out.push("Status:");
    const conds = (obj.status.conditions ?? []) as any[];
    if (conds.length > 0) {
      out.push("  Conditions:");
      out.push("    Type                          Status   Reason                          Last Transition");
      for (const c of conds) {
        out.push(
          "    " +
            String(c.type ?? "").padEnd(30) +
            String(c.status ?? "").padEnd(9) +
            String(c.reason ?? "—").padEnd(32) +
            String(c.lastTransitionTime ?? c.lastUpdateTime ?? "—"),
        );
      }
    }
    const otherStatus = { ...obj.status };
    delete otherStatus.conditions;
    out.push(...indented(summarise(otherStatus, 2)));
  }

  if (events.length > 0) {
    const sorted = events.slice().sort((a, b) => eventTime(a) - eventTime(b));
    out.push("");
    out.push("Events:");
    out.push("  Type      Reason                Age      From                          Message");
    for (const e of sorted) {
      out.push(
        "  " +
          String(e.type ?? "").padEnd(10) +
          String(e.reason ?? "").padEnd(22) +
          eventAge(e).padEnd(9) +
          String(e.source?.component ?? e.reportingComponent ?? "—").padEnd(30) +
          String(e.message ?? "").replace(/\s+/g, " "),
      );
    }
  }
  return out.join("\n");
}

function line(key: string, value: unknown): string {
  return key.padEnd(COLUMN) + (value === undefined || value === null ? "—" : String(value));
}

function kvBlock(label: string, map: Record<string, string>): string[] {
  const keys = Object.keys(map ?? {}).sort();
  if (keys.length === 0) return [line(label, "<none>")];
  const out: string[] = [`${label}:`];
  for (const k of keys) out.push("  " + k + "=" + map[k]);
  return out;
}

// Minimal pretty-printer: only goes `depth` deep then collapses to JSON.
// Aligns nicely for the typical spec/status which are 2–3 levels of map.
function summarise(value: unknown, depth: number, indent = 0): string[] {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return [pad + "<nil>"];
  if (Array.isArray(value)) {
    if (value.length === 0) return [pad + "[]"];
    if (depth <= 0) return [pad + JSON.stringify(value)];
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(pad + "- ");
      const inner = summarise(value[i], depth - 1, indent + 1);
      // Inline scalar arrays so they don't sprawl.
      if (inner.length === 1) out[out.length - 1] += inner[0].trim();
      else out.push(...inner);
    }
    return out;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [pad + "{}"];
    if (depth <= 0) return [pad + JSON.stringify(value)];
    const out: string[] = [];
    for (const [k, v] of entries) {
      if (v === null || typeof v !== "object" || (Array.isArray(v) && isScalarArray(v))) {
        const printed = Array.isArray(v) ? (v as any[]).join(", ") : String(v);
        out.push(pad + k + ": " + (printed === "" ? "—" : printed));
      } else {
        out.push(pad + k + ":");
        out.push(...summarise(v, depth - 1, indent + 1));
      }
    }
    return out;
  }
  return [pad + String(value)];
}

function isScalarArray(arr: unknown[]): boolean {
  return arr.every((x) => x === null || (typeof x !== "object"));
}

function indented(lines: string[]): string[] {
  return lines.map((l) => "  " + l);
}

function eventTime(e: any): number {
  const ts = e?.lastTimestamp ?? e?.eventTime ?? e?.metadata?.creationTimestamp;
  return ts ? new Date(ts).getTime() : 0;
}

function eventAge(e: any): string {
  const ts = eventTime(e);
  if (!ts) return "—";
  const ms = Date.now() - ts;
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
