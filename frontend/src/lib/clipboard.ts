// Clipboard helper.
//
// `navigator.clipboard` is gated to "secure contexts" — HTTPS, localhost
// (literal name), and file://. A user hitting k8s-view on a LAN IP
// (http://192.168.1.x:8080) has `navigator.clipboard === undefined`, so a
// raw `navigator.clipboard.writeText(...)` call throws TypeError and the
// surrounding try/catch can't even catch it cleanly when the chained
// `.catch()` is attached to undefined. That's the bug the user hit — the
// "Cannot read properties of undefined (reading 'writeText')" toasts.
//
// We fall back to the document.execCommand('copy') path which works in any
// origin where a focused textarea can capture a synchronous selection.
// Both branches return a boolean so callers can show a sane message and
// avoid the error-toast spam loop.

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / Document not focused / Secure context check
      // failed — fall through to the legacy path.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but selectable. Avoid display:none — that disables selection.
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.setAttribute("readonly", "");
  document.body.appendChild(ta);
  // Preserve the user's previous selection so copying via this helper
  // doesn't surprise them when the focus snaps back to the page.
  const previouslyFocused = document.activeElement as HTMLElement | null;
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    previouslyFocused?.focus?.();
  }
  return ok;
}
