// Modals — in-house replacements for native window.alert / confirm / prompt.
//
// Native dialogs feel out-of-place against the rest of the UI (different
// font, different colours, OS chrome) and they block the JS event loop while
// open, which interferes with our WebSocket buffers. This module exposes a
// promise-based API plus a `<ModalsHost />` overlay that renders the dialog
// using the same tokens as the rest of the app.
//
// Usage:
//   import { useModals } from "../components/Modals";
//   const modals = useModals();
//   if (await modals.confirm({ title: "Delete pod?", danger: true })) ...
//   await modals.alert({ title: "Couldn't reach the cluster", body: msg });
//   const v = await modals.prompt({ title: "Scale to", default: "3" });

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Info, Minus, Plus, X } from "lucide-react";
import clsx from "clsx";

type AlertOpts = {
  title: string;
  body?: React.ReactNode;
  okLabel?: string;
  tone?: "info" | "warn" | "bad";
};

type ConfirmOpts = AlertOpts & {
  cancelLabel?: string;
  okLabel?: string;
  danger?: boolean;
  // Optional third (destructive) button — e.g. "Force delete". Clicking
  // it still resolves the confirm `true`; `onForce` fires first so the
  // caller can branch. Backward-compatible: existing callers omit both.
  forceLabel?: string;
  onForce?: () => void;
};

type PromptOpts = {
  title: string;
  body?: React.ReactNode;
  default?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
  validate?: (v: string) => string | null;
  /** Render a Lens-style slider + numeric input + step buttons instead of a
   *  bare text field. The value passed to validate/resolve is still a string
   *  (the integer in decimal) so existing callers don't change. */
  slider?: {
    min: number;
    max: number;
    step?: number;
    /** Optional label rendered above the slider — e.g. "Current replica scale: 3". */
    currentLabel?: string;
    /** Label prefix on the slider readout (defaults to "Value"). */
    readoutLabel?: string;
  };
};

type ModalsApi = {
  alert(opts: AlertOpts): Promise<void>;
  confirm(opts: ConfirmOpts): Promise<boolean>;
  prompt(opts: PromptOpts): Promise<string | null>;
};

const ModalsCtx = createContext<ModalsApi | null>(null);

type Pending =
  | ({ kind: "alert"; resolve: () => void } & AlertOpts)
  | ({ kind: "confirm"; resolve: (v: boolean) => void } & ConfirmOpts)
  | ({ kind: "prompt"; resolve: (v: string | null) => void } & PromptOpts);

export function ModalsProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Pending[]>([]);

  const push = useCallback((p: Pending) => {
    setStack((s) => [...s, p]);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => s.slice(0, -1));
  }, []);

  const api = useMemo<ModalsApi>(() => ({
    alert(opts) {
      return new Promise<void>((resolve) => {
        push({ kind: "alert", resolve, ...opts });
      });
    },
    confirm(opts) {
      return new Promise<boolean>((resolve) => {
        push({ kind: "confirm", resolve, ...opts });
      });
    },
    prompt(opts) {
      return new Promise<string | null>((resolve) => {
        push({ kind: "prompt", resolve, ...opts });
      });
    },
  }), [push]);

  // Wire the imperative module-level helpers used outside of React (route
  // handlers etc.) to the live provider instance.
  useEffect(() => {
    moduleApi = api;
    return () => { if (moduleApi === api) moduleApi = null; };
  }, [api]);

  const top = stack[stack.length - 1];

  return (
    <ModalsCtx.Provider value={api}>
      {children}
      {top && createPortal(
        <ModalHost
          key={stack.length}
          pending={top}
          onResolved={pop}
        />,
        document.body,
      )}
    </ModalsCtx.Provider>
  );
}

export function useModals(): ModalsApi {
  const v = useContext(ModalsCtx);
  if (!v) throw new Error("useModals must be used inside <ModalsProvider>");
  return v;
}

// Module-level escape hatch for code paths that aren't components — set by
// the provider on mount.
let moduleApi: ModalsApi | null = null;

function ensureApi(): ModalsApi {
  if (!moduleApi) {
    throw new Error("Modals API used before <ModalsProvider> mounted");
  }
  return moduleApi;
}

export const modals = {
  alert: (opts: AlertOpts) => ensureApi().alert(opts),
  confirm: (opts: ConfirmOpts) => ensureApi().confirm(opts),
  prompt: (opts: PromptOpts) => ensureApi().prompt(opts),
};

function ModalHost({ pending, onResolved }: { pending: Pending; onResolved: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const okBtnRef = useRef<HTMLButtonElement | null>(null);
  const [value, setValue] = useState<string>(
    pending.kind === "prompt" ? (pending.default ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);

  const resolveAlert = useCallback(() => {
    if (pending.kind !== "alert") return;
    pending.resolve();
    onResolved();
  }, [pending, onResolved]);

  const resolveConfirm = useCallback((v: boolean) => {
    if (pending.kind !== "confirm") return;
    pending.resolve(v);
    onResolved();
  }, [pending, onResolved]);

  const resolvePrompt = useCallback((v: string | null) => {
    if (pending.kind !== "prompt") return;
    if (v !== null && pending.validate) {
      const e = pending.validate(v);
      if (e) { setError(e); return; }
    }
    pending.resolve(v);
    onResolved();
  }, [pending, onResolved]);

  useEffect(() => {
    if (pending.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      okBtnRef.current?.focus();
    }
  }, [pending.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (pending.kind === "alert") resolveAlert();
        else if (pending.kind === "confirm") resolveConfirm(false);
        else resolvePrompt(null);
      } else if (e.key === "Enter") {
        // For prompts we let the form's native submit handle it so validation
        // runs; for confirm/alert we resolve OK on Enter.
        if (pending.kind === "alert") { e.preventDefault(); resolveAlert(); }
        if (pending.kind === "confirm") { e.preventDefault(); resolveConfirm(true); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending.kind, resolveAlert, resolveConfirm, resolvePrompt]);

  const tone: "info" | "warn" | "bad" =
    pending.kind === "confirm" && pending.danger
      ? "bad"
      : (pending.kind === "alert" ? (pending.tone ?? "info") : "info");

  const Icon = tone === "bad" || tone === "warn" ? AlertTriangle : Info;
  const iconClass =
    tone === "bad" ? "text-bad" :
    tone === "warn" ? "text-warn" : "text-accent";

  const onClose = () => {
    if (pending.kind === "alert") resolveAlert();
    else if (pending.kind === "confirm") resolveConfirm(false);
    else resolvePrompt(null);
  };

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={pending.title}
    >
      <div
        className="w-full max-w-[440px] rounded-md border border-line bg-bg-soft shadow-[0_24px_64px_rgb(0_0_0/0.55)] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 px-5 pt-5 pb-3">
          <Icon size={18} className={clsx("mt-0.5 shrink-0", iconClass)} />
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold leading-snug text-fg">{pending.title}</h2>
            {pending.kind !== "prompt" && pending.body && (
              <div className="mt-1.5 text-sm text-fg-soft break-words">
                {pending.body}
              </div>
            )}
          </div>
          <button
            className="h-7 w-7 -mr-2 -mt-2 rounded-md flex items-center justify-center text-fg-mute hover:text-fg hover:bg-bg-mute"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={14} />
          </button>
        </header>

        {pending.kind === "prompt" && (
          <form
            className="px-5 pb-2"
            onSubmit={(e) => { e.preventDefault(); resolvePrompt(value); }}
          >
            {pending.body && (
              <div className="mb-2 text-sm text-fg-soft">{pending.body}</div>
            )}
            {pending.slider ? (
              <SliderField
                spec={pending.slider}
                value={value}
                onChange={(v) => { setValue(v); if (error) setError(null); }}
                inputRef={inputRef}
              />
            ) : (
              <input
                ref={inputRef}
                className="input h-9 w-full"
                value={value}
                placeholder={pending.placeholder}
                onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
              />
            )}
            {error && <div className="mt-2 text-xs text-bad">{error}</div>}
          </form>
        )}

        <footer className="px-5 pb-5 pt-2 flex items-center justify-end gap-2">
          {pending.kind === "alert" && (
            <button
              ref={okBtnRef}
              className="btn-primary h-8 min-w-[80px] justify-center"
              onClick={resolveAlert}
            >
              {pending.okLabel ?? "OK"}
            </button>
          )}
          {pending.kind === "confirm" && (
            <>
              <button
                className="btn h-8 min-w-[80px] justify-center"
                onClick={() => resolveConfirm(false)}
              >
                {pending.cancelLabel ?? "Cancel"}
              </button>
              {pending.forceLabel && (
                <button
                  className="btn-bad h-8 min-w-[80px] justify-center"
                  onClick={() => { pending.onForce?.(); resolveConfirm(true); }}
                >
                  {pending.forceLabel}
                </button>
              )}
              <button
                ref={okBtnRef}
                className={clsx(
                  "h-8 min-w-[80px] justify-center",
                  pending.danger ? "btn-bad" : "btn-primary",
                )}
                onClick={() => resolveConfirm(true)}
              >
                {pending.okLabel ?? (pending.danger ? "Delete" : "OK")}
              </button>
            </>
          )}
          {pending.kind === "prompt" && (
            <>
              <button
                className="btn h-8 min-w-[80px] justify-center"
                onClick={() => resolvePrompt(null)}
              >
                {pending.cancelLabel ?? "Cancel"}
              </button>
              <button
                ref={okBtnRef}
                className="btn-primary h-8 min-w-[80px] justify-center"
                onClick={() => resolvePrompt(value)}
              >
                {pending.okLabel ?? "OK"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// SliderField — Lens-style slider + numeric input + step buttons. Rendered
// inside the prompt modal when `opts.slider` is set. Internally we keep the
// canonical state on the parent (string), so validation and resolution are
// unchanged; this widget is just an alternative editor view of that string.
function SliderField({
  spec, value, onChange, inputRef,
}: {
  spec: NonNullable<PromptOpts["slider"]>;
  value: string;
  onChange: (next: string) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  const min = spec.min;
  const max = spec.max;
  const step = spec.step ?? 1;
  const numeric = Number.parseInt(value, 10);
  // Clamp the slider to the spec range while letting the input show whatever
  // the user typed — that way a manual "12" in a [0,10] slider still
  // displays "12" in the field, surfaces the validation error, and the
  // slider sits at its max instead of jumping back to a clamped value.
  const sliderValue = Number.isFinite(numeric)
    ? Math.max(min, Math.min(max, numeric))
    : min;

  const set = (n: number) => onChange(String(Math.max(min, Math.min(max, n))));
  const dec = () => set((Number.isFinite(numeric) ? numeric : min) - step);
  const inc = () => set((Number.isFinite(numeric) ? numeric : min) + step);

  // Lens layout: read-only labels on top (current + desired), interactive
  // controls below on a single row. The desired value appears once — in the
  // top label — so we don't repeat it three times across slider, label, and
  // input. The numeric input on the right is intentionally tiny: it's the
  // escape hatch for "I want to type a specific number past the slider max",
  // not the primary affordance.
  return (
    <div className="flex flex-col gap-2.5">
      {spec.currentLabel && (
        <div className="text-xs text-fg-mute">{spec.currentLabel}</div>
      )}
      <div className="text-xs text-fg-soft">
        {spec.readoutLabel ?? "Value"}:{" "}
        <span className="text-fg font-medium">{Number.isFinite(numeric) ? numeric : "—"}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={sliderValue}
          onChange={(e) => onChange(e.target.value)}
          className="modal-slider flex-1 min-w-0"
          aria-label={spec.readoutLabel ?? "Value"}
        />
        <button
          type="button"
          onClick={dec}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-line text-fg-soft hover:text-fg hover:bg-bg-mute disabled:opacity-40 shrink-0"
          disabled={Number.isFinite(numeric) && numeric <= min}
          aria-label="Decrease"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onClick={inc}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-line text-fg-soft hover:text-fg hover:bg-bg-mute disabled:opacity-40 shrink-0"
          disabled={Number.isFinite(numeric) && numeric >= max}
          aria-label="Increase"
        >
          <Plus size={13} />
        </button>
        <input
          ref={inputRef}
          className="input h-7 w-14 text-center shrink-0"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Type exact value"
        />
      </div>
    </div>
  );
}
