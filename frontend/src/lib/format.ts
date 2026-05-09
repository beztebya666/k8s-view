// Small formatting helpers used everywhere — duration, byte sizes, CPU, etc.
// Kept out of components so list rows stay cheap.

import { clusterNow } from "./clock";

// age — compact two-unit duration ("3h2m", "5m23s", "2d4h"). The second
// unit is dropped only when it's zero, so the display stays at most 6
// characters but never silently rounds away precision. Updated every
// second by the parent's tick so a 14-second-old object shows "14s",
// not "1m" or worse.
//
// `now` is the cluster's wall-clock time in epoch ms (see clock.ts). It is
// derived from the last server probe + monotonic `performance.now()`, so
// it is independent of the user's wall clock. If the clock module hasn't
// completed its first probe yet `now` will be NaN; in that case we fall
// back to "—" rather than displaying garbage that depends on Date.now().
export function age(iso?: string, now: number = clusterNow()): string {
  if (!iso) return "—";
  if (!Number.isFinite(now)) return "—";
  const t = new Date(iso).getTime();
  const total = Math.max(0, Math.floor((now - t) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) {
    const s = total - m * 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    const mm = m - h * 60;
    return mm ? `${h}h${mm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  if (d < 14) {
    const hh = h - d * 24;
    return hh ? `${d}d${hh}h` : `${d}d`;
  }
  if (d < 365) {
    const w = Math.floor(d / 7);
    const dd = d - w * 7;
    return dd ? `${w}w${dd}d` : `${w}w`;
  }
  const y = Math.floor(d / 365);
  const days = d - y * 365;
  return days ? `${y}y${days}d` : `${y}y`;
}

export function bytes(n?: number): string {
  if (n === undefined || n === null || isNaN(n)) return "—";
  const u = ["B","KiB","MiB","GiB","TiB","PiB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

const cpuRegex = /^(\d+(?:\.\d+)?)(m|n|u)?$/;
export function cpuToMillicores(s?: string): number {
  if (!s) return 0;
  const m = cpuRegex.exec(s);
  if (!m) {
    // could be "100m" already
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n * 1000;
  }
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case "n": return v / 1_000_000;
    case "u": return v / 1_000;
    case "m": return v;
    default:  return v * 1000;
  }
}

export function memToBytes(s?: string): number {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)([KMGTP]i?)?$/.exec(s);
  if (!m) return parseFloat(s) || 0;
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case "Ki": return v * 1024;
    case "Mi": return v * 1024 ** 2;
    case "Gi": return v * 1024 ** 3;
    case "Ti": return v * 1024 ** 4;
    case "Pi": return v * 1024 ** 5;
    case "K":  return v * 1000;
    case "M":  return v * 1000 ** 2;
    case "G":  return v * 1000 ** 3;
    case "T":  return v * 1000 ** 4;
    case "P":  return v * 1000 ** 5;
    default:   return v;
  }
}

export function shortName(name?: string, max = 48): string {
  if (!name) return "";
  return name.length <= max ? name : name.slice(0, max - 1) + "…";
}

// Format CPU usage in millicores → "1.42 cores" / "215m" / "0".
export function formatMillicores(m?: number): string {
  if (m === undefined || m === null || !Number.isFinite(m)) return "—";
  if (m <= 0) return "0";
  if (m >= 1000) return `${(m / 1000).toFixed(2)} cores`;
  if (m >= 10) return `${Math.round(m)}m`;
  return `${m.toFixed(1)}m`;
}
