// Select — minimalist headless dropdown that replaces native <select> across
// the app. Keyboard navigation, theme tokens, portalled menu (so overflow-
// hidden parents don't clip it), no external deps.
//
// Why not the browser <select>: native dropdowns ignore our theme tokens,
// render a white system menu in dark mode on Windows, and look out of place
// next to the rest of the chrome. They also don't support per-option icons /
// helper text.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import clsx from "clsx";

export type SelectOption<T extends string | number> = {
  value: T;
  label: string;
  /** Inline secondary text rendered next to the label (e.g., counts). */
  hint?: string;
  /** Optional icon component (lucide) painted on the left. */
  icon?: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  disabled?: boolean;
};

type Props<T extends string | number> = {
  value: T;
  onChange: (next: T) => void;
  options: SelectOption<T>[];
  /** Override the rendered button label. */
  display?: (current: SelectOption<T> | undefined) => React.ReactNode;
  className?: string;
  /** Extra class on the menu — useful for width overrides. */
  menuClassName?: string;
  buttonHeight?: 7 | 8 | 9; // tailwind h-7/8/9 for matching neighboring controls
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** Placeholder shown when no value matches. */
  placeholder?: string;
};

export function Select<T extends string | number>({
  value, onChange, options, display, className, menuClassName,
  buttonHeight = 7, disabled, title, ariaLabel, placeholder = "Select…",
}: Props<T>) {
  const id = useId();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const current = useMemo(() => options.find((o) => o.value === value), [options, value]);
  const enabledOptions = useMemo(() => options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled), [options]);

  const close = useCallback(() => setOpen(false), []);

  // Re-position the menu against the trigger and re-clamp to the viewport.
  // We use fixed positioning + portal because the call sites live inside
  // overflow-hidden / overflow-auto containers (top toolbar, bottom pane,
  // …) that would otherwise clip a 200-px dropdown.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      const menuW = Math.max(rect.width, 180);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8));
      const top = rect.bottom + 4;
      setPos({ left, top, width: menuW });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        btnRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => nextEnabled(enabledOptions, h, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => nextEnabled(enabledOptions, h, -1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const pick = enabledOptions[highlight]?.o;
        if (pick) {
          onChange(pick.value);
          close();
          btnRef.current?.focus();
        }
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, enabledOptions, highlight, onChange, close]);

  // When opening, snap the highlight to the currently selected row.
  useEffect(() => {
    if (!open) return;
    const idx = enabledOptions.findIndex(({ o }) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
  }, [open, enabledOptions, value]);

  const renderedLabel = display
    ? display(current)
    : current
      ? <SelectLabel option={current} />
      : <span className="text-fg-mute">{placeholder}</span>;

  const heightClass = buttonHeight === 7 ? "h-7" : buttonHeight === 8 ? "h-8" : "h-9";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id={id}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className={clsx(
          "btn justify-between gap-2 px-2.5 text-xs",
          heightClass,
          className,
        )}
        onClick={() => !disabled && setOpen((s) => !s)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="min-w-0 flex-1 text-left truncate">{renderedLabel}</span>
        <ChevronDown size={11} className={clsx("shrink-0 text-fg-mute transition-transform", open && "rotate-180")} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-labelledby={id}
          className={clsx(
            "fixed z-[1500] max-h-[280px] overflow-y-auto rounded-md border border-line bg-bg-soft py-1 text-xs shadow-[0_18px_48px_rgb(0_0_0/0.55)]",
            menuClassName,
          )}
          style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {options.map((o, i) => {
            const enabledIdx = enabledOptions.findIndex((eo) => eo.i === i);
            const isHighlighted = enabledIdx === highlight;
            const isSelected = o.value === value;
            const Icon = o.icon;
            return (
              <button
                key={String(o.value)}
                role="option"
                aria-selected={isSelected}
                disabled={o.disabled}
                className={clsx(
                  "w-full text-left px-2.5 py-1.5 flex items-center gap-2 transition-colors",
                  o.disabled
                    ? "text-fg-mute cursor-not-allowed"
                    : "text-fg-soft hover:text-fg",
                  isHighlighted && !o.disabled && "bg-bg-mute text-fg",
                  isSelected && !o.disabled && "text-fg",
                )}
                onMouseEnter={() => {
                  if (enabledIdx >= 0) setHighlight(enabledIdx);
                }}
                onClick={() => {
                  if (o.disabled) return;
                  onChange(o.value);
                  close();
                  btnRef.current?.focus();
                }}
              >
                {Icon && <Icon size={12} strokeWidth={1.7} className="shrink-0 text-fg-mute" />}
                <span className="flex-1 min-w-0 truncate">{o.label}</span>
                {o.hint && <span className="text-[10px] text-fg-mute shrink-0">{o.hint}</span>}
                {isSelected && <Check size={12} className="shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

function SelectLabel<T extends string | number>({ option }: { option: SelectOption<T> }) {
  const Icon = option.icon;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {Icon && <Icon size={12} strokeWidth={1.7} className="shrink-0 text-fg-mute" />}
      <span className="truncate">{option.label}</span>
    </span>
  );
}

function nextEnabled<T extends string | number>(
  enabled: { o: SelectOption<T>; i: number }[],
  current: number,
  delta: 1 | -1,
): number {
  if (enabled.length === 0) return 0;
  const next = (current + delta + enabled.length) % enabled.length;
  return next;
}
