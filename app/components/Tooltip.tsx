"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const GAP = 8;
const EDGE = 8;
/** Long enough that sweeping a toolbar does not flash one per button. */
const DELAY = 300;

/**
 * A hover/focus tooltip that can style its own parts — the shortcut is set in
 * the mono face, dimmer than the name — which neither `title` nor a `data-tip`
 * pseudo-element can do.
 *
 * Positioned `fixed` from the anchor's measured rect rather than absolutely
 * inside it, so a panel that scrolls and a toolbar pinned to the window edge
 * both leave it whole. The listeners sit on the wrapper, not on the child, so a
 * disabled button — which swallows pointer events — still explains itself.
 */
export function Tooltip({
  label,
  hint,
  side = "top",
  className,
  children,
}: {
  label: string;
  /** A formatted keyboard shortcut; `shortcutHint` produces these. */
  hint?: string;
  side?: "top" | "bottom";
  /**
   * For the anchor, which is a real box in the layout: a tooltip around a
   * field in a grid has to carry the field's own sizing or it shrink-wraps it.
   */
  className?: string;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const a = anchor.current;
    const b = bubble.current;
    if (!open || !a || !b) return;
    const r = a.getBoundingClientRect();
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    let top = side === "top" ? r.top - h - GAP : r.bottom + GAP;
    // Flip, then clamp, rather than letting it leave the viewport.
    if (top < EDGE) top = r.bottom + GAP;
    if (top + h > window.innerHeight - EDGE) {
      top = Math.max(EDGE, r.top - h - GAP);
    }
    const left = Math.min(
      Math.max(EDGE, r.left + r.width / 2 - w / 2),
      window.innerWidth - w - EDGE,
    );
    setPos({ top, left });
  }, [open, side]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      ref={anchor}
      className={className ?? "inline-flex"}
      onPointerEnter={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOpen(true), DELAY);
      }}
      onPointerLeave={hide}
      // A tooltip left standing over the thing you just pressed is in the way.
      onPointerDown={hide}
      onFocusCapture={(e) => {
        if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) {
          setOpen(true);
        }
      }}
      onBlurCapture={hide}
    >
      {children}
      {open && (
        <div
          ref={bubble}
          aria-hidden
          className="pointer-events-none fixed flex items-center gap-2 px-[9px] py-1.5 text-[12px] leading-none whitespace-nowrap"
          style={{
            top: pos.top,
            left: pos.left,
            zIndex: "var(--z-tooltip)",
            borderRadius: "var(--radius)",
            background: "var(--foreground)",
            color: "var(--background)",
            animation: "ab-menu-in var(--dur-fast) var(--ease)",
          }}
        >
          {label}
          {hint && <span className="font-mono text-[11px] opacity-60">{hint}</span>}
        </div>
      )}
    </span>
  );
}
