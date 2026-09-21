"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { usePresence } from "./presence";
import { useLayer, useUi } from "./store";
import { Check, ChevronsUpDown } from "./icons";

/**
 * Every floating surface in the mockups. Behaviour and placement only: a Pop
 * knows which corner of it touches its anchor and says so in `--origin`, and
 * everything it looks like or moves like is the stylesheet's, off `data-state`.
 */

type Side = "bottom" | "top" | "right" | "left";
type Align = "start" | "center" | "end";
type Anchor = RefObject<HTMLElement | null> | { x: number; y: number };

const PopCtx = createContext<{ close: () => void; owns: boolean }>({ close: () => {}, owns: true });

function rectOf(anchor: Anchor) {
  if ("current" in anchor) return anchor.current?.getBoundingClientRect() ?? new DOMRect();
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

export function Pop({
  open,
  onClose,
  anchor,
  side = "bottom",
  align = "start",
  gap = 6,
  role = "menu",
  label,
  className = "",
  exitMs = 130,
  focus = true,
  at,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: Anchor;
  side?: Side;
  align?: Align;
  gap?: number;
  role?: "menu" | "dialog" | "listbox";
  label: string;
  className?: string;
  exitMs?: number;
  /** A menu raised by typing (slash, mention) leaves focus in the text. */
  focus?: boolean;
  /** Changes when the anchor has moved while open, to place it again. */
  at?: string | number;
  children: ReactNode;
}) {
  const layer = useLayer();
  const parent = useContext(PopCtx);
  const { mounted, state } = usePresence(open, exitMs);
  const el = useRef<HTMLDivElement>(null);
  // Read through a ref so a parent re-rendering (a streaming reply does, many
  // times a second) neither re-places an open menu nor steals its focus back.
  const latest = useRef({ anchor, onClose });
  useLayoutEffect(() => {
    latest.current = { anchor, onClose };
  });

  useLayoutEffect(() => {
    const pop = el.current;
    if (!mounted || !pop) return;
    const a = rectOf(latest.current.anchor);
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vertical = side === "bottom" || side === "top";
    const along = (start: number, size: number, own: number) =>
      align === "start" ? start : align === "end" ? start + size - own : start + size / 2 - own / 2;
    let x = vertical ? along(a.left, a.width, w) : side === "right" ? a.right + gap : a.left - gap - w;
    let y = vertical ? (side === "bottom" ? a.bottom + gap : a.top - gap - h) : along(a.top, a.height, h);
    let flipped = false;
    if (side === "bottom" && y + h > innerHeight - 8 && a.top - gap - h > 8) {
      y = a.top - gap - h;
      flipped = true;
    }
    if (side === "top" && y < 8) {
      y = a.bottom + gap;
      flipped = true;
    }
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    y = Math.max(8, Math.min(y, innerHeight - h - 8));
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    // The corner that touches the anchor, which is where the surface grows from.
    const oy = vertical ? ((side === "bottom") !== flipped ? "top" : "bottom") : align === "end" ? "bottom" : align === "center" ? "center" : "top";
    const ox = vertical ? (align === "end" ? "right" : align === "center" ? "center" : "left") : side === "right" ? "left" : "right";
    pop.style.setProperty("--origin", `${oy} ${ox}`);
  }, [mounted, open, side, align, gap, at]);

  useEffect(() => {
    if (!open) return;
    if (focus) {
      const pop = el.current;
      (pop?.querySelector<HTMLElement>("[data-autofocus], [role='menuitem'], [role='option']") ?? pop)?.focus({ preventScroll: true });
    }
    const away = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      const { anchor: a, onClose: close } = latest.current;
      if (target.closest("[data-ek-pop]")) return;
      if ("current" in a && a.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, focus]);

  if (!mounted || !layer) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      if ("current" in anchor) anchor.current?.focus({ preventScroll: true });
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled), [role='option']")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to < 0 || !items.length) return;
    e.preventDefault();
    items[to].focus({ preventScroll: true });
  };

  return createPortal(
    <PopCtx.Provider
      value={{
        owns: focus,
        close: () => {
          onClose();
          parent.close();
        },
      }}
    >
      <div
        ref={el}
        data-ek-pop
        data-state={state}
        data-side={side}
        role={role}
        aria-label={label}
        tabIndex={-1}
        className={`ek-pop ek-stagger ${className}`}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </PopCtx.Provider>,
    layer,
  );
}

export function Item({
  icon,
  label,
  hint,
  keys,
  end,
  danger,
  checked,
  disabled,
  keepOpen,
  onSelect,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: string;
  keys?: string;
  end?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  onSelect?: () => void;
}) {
  const { close, owns } = useContext(PopCtx);
  return (
    <button
      role="menuitem"
      disabled={disabled}
      data-danger={danger || undefined}
      className="ek-item"
      // A menu raised by typing never takes the caret out of the text.
      onPointerMove={(e) => owns && e.currentTarget.focus({ preventScroll: true })}
      onPointerDown={(e) => !owns && e.preventDefault()}
      onClick={() => {
        onSelect?.();
        if (!keepOpen) close();
      }}
    >
      {icon !== undefined && <span className="ek-item-icon">{icon}</span>}
      <span className="ek-item-text">
        <span className="ek-item-label">{label}</span>
        {hint && <span className="ek-item-hint">{hint}</span>}
      </span>
      {keys && <kbd className="ek-kbd">{keys}</kbd>}
      {end}
      {checked !== undefined && <Check width={14} height={14} className="ek-item-check" data-on={checked} />}
    </button>
  );
}

export const Sep = () => <div role="separator" className="ek-sep" />;
export const Group = ({ children }: { children: ReactNode }) => <div className="ek-group-label">{children}</div>;

/** A field that opens a list of its own values. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  lead,
  className = "",
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  label: string;
  lead?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={`ek-select ${className}`}
        onClick={() => setOpen((o) => !o)}
      >
        {lead && <span className="ek-select-lead">{lead}</span>}
        <span className="ek-select-value">{value}</span>
        <ChevronsUpDown width={12} height={12} className="ek-select-caret" />
      </button>
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} className="ek-pop-select">
        {options.map((o) => (
          <Item key={o} label={o} checked={o === value} onSelect={() => onChange(o)} />
        ))}
      </Pop>
    </>
  );
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

/** A modal that grows from the press that raised it (`--ox`/`--oy`). */
export function Sheet({
  open,
  label,
  className = "",
  exitMs = 200,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  className?: string;
  exitMs?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const layer = useLayer();
  const { origin } = useUi();
  const { mounted, state } = usePresence(open, exitMs);
  const sheet = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState({ x: 0, y: 0 });
  if (open && !mounted) setFrom(origin.current);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const root = sheet.current;
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? root)?.focus({ preventScroll: true });
    return () => before?.focus({ preventScroll: true });
  }, [open]);

  if (!mounted || !layer) return null;
  return createPortal(
    <div className="ek-modal" data-state={state}>
      <div className="ek-scrim" data-state={state} onPointerDown={onClose} />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-state={state}
        className={`ek-sheet ek-stagger ${className}`}
        style={{ "--ox": `${from.x}px`, "--oy": `${from.y}px` } as CSSProperties}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          const stops = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
          if (!stops.length) return;
          const first = stops[0];
          const last = stops[stops.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        {children}
      </div>
    </div>,
    layer,
  );
}

export function Toasts() {
  const layer = useLayer();
  const { ui, act } = useUi();
  if (!layer) return null;
  return createPortal(
    <div className="ek-toasts" role="status" aria-live="polite">
      {ui.toasts.map((t) => (
        <div key={t.id} className="ek-toast" data-state={t.leaving ? "closed" : "open"}>
          <span>{t.text}</span>
          {t.action && (
            <button className="ek-toast-act" onClick={() => act.dismiss(t.id)}>
              {t.action}
            </button>
          )}
        </div>
      ))}
    </div>,
    layer,
  );
}

/**
 * One tooltip for the whole surface, raised for anything carrying `data-tip`
 * (and `data-keys` for its shortcut). The first waits; once one has shown, the
 * next is immediate, so sweeping a toolbar reads it like a sentence.
 */
export function Tips() {
  const layer = useLayer();
  const [tip, setTip] = useState<{ text: string; keys?: string; x: number; y: number; below: boolean } | null>(null);
  const warm = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const root = layer?.parentElement;
    if (!root) return;
    const show = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      clearTimeout(timer.current);
      if (!el) return;
      const open = () => {
        const r = el.getBoundingClientRect();
        const below = el.dataset.tipSide === "bottom" || r.top < 48;
        setTip({ text: el.dataset.tip!, keys: el.dataset.keys, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
      };
      if (performance.now() - warm.current < 600) open();
      else timer.current = setTimeout(open, 420);
    };
    const hide = () => {
      clearTimeout(timer.current);
      setTip((t) => {
        if (t) warm.current = performance.now();
        return null;
      });
    };
    root.addEventListener("pointerover", show);
    root.addEventListener("pointerout", hide);
    root.addEventListener("pointerdown", hide, true);
    return () => {
      clearTimeout(timer.current);
      root.removeEventListener("pointerover", show);
      root.removeEventListener("pointerout", hide);
      root.removeEventListener("pointerdown", hide, true);
    };
  }, [layer]);

  if (!tip || !layer) return null;
  return createPortal(
    <div className="ek-tip" role="tooltip" data-below={tip.below} style={{ left: tip.x, top: tip.y }}>
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>,
    layer,
  );
}
