"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

type Align = "start" | "center" | "end";
type Side = "top" | "bottom";

/**
 * An anchored menu with the keyboard contract users expect: Escape closes,
 * arrows move, Home/End jump, Tab closes, and focus returns to the trigger.
 *
 * Positioned `fixed` from the trigger's measured rect rather than absolutely
 * inside it, so a panel with `overflow: auto` can never clip it. Portaled to
 * `document.body`: `fixed` alone still leaves it inside whatever stacking
 * context its trigger lives in (e.g. the sidebar's `.nt-panel`, which caps
 * every descendant at its own z-index), so a sibling like the sidebar's
 * resize handle could otherwise paint over it despite `--z-dropdown`.
 */
export function Menu({
  trigger,
  children,
  side = "top",
  align = "start",
  label,
  className,
  layer = "dropdown",
  focusRef,
}: {
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
  }) => ReactNode;
  children: (close: (opts?: { restoreFocus?: boolean }) => void) => ReactNode;
  side?: Side;
  align?: Align;
  label: string;
  /** A variant of the surface, for a menu that is a different object — the
   *  canvas toolbar's ink tool list, drawn like the bar it hangs from. */
  className?: string;
  /** "modal" for a menu raised inside a dialog: on the dialog's layer, and
   *  after it in the body, so the dialog does not cover it. */
  layer?: "dropdown" | "modal";
  /** Focuses the trigger, for a caller that hands focus back to it itself —
   *  after a dialog one of its items opened, say. */
  focusRef?: Ref<{ focus: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  // The menu outlives `open` by its exit animation. Everything that means
  // "open" — the click-catcher, focus, placement — still follows `open`, so a
  // menu on its way out can never swallow a click or hold focus.
  const [leaving, setLeaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(focusRef, () => ({ focus: () => triggerRef.current?.focus() }), []);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, origin: "top left" });

  // `close` is handed to the children render prop, so it must not touch a ref
  // during render. It only flips state; focus goes back to the trigger from an
  // effect once the menu has actually closed.
  //
  // `restoreFocus: false` is for an item that puts focus somewhere itself — a
  // rename opening a field, say. Without it the restore lands AFTER the field
  // has focused, pulls focus back to the trigger, and the field's blur commits
  // and closes it: the action appears to do nothing at all.
  // State rather than a ref precisely because `close` is handed to the render
  // prop: a callback that writes a ref cannot be created during render.
  const [restore, setRestore] = useState(true);
  const close = useCallback((opts?: { restoreFocus?: boolean }) => {
    setRestore(opts?.restoreFocus !== false);
    setOpen(false);
    setLeaving(true);
  }, []);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (restore) triggerRef.current?.focus();
  }, [open, restore]);

  const place = useCallback(() => {
    const t = triggerRef.current;
    const m = menuRef.current;
    if (!t || !m) return;
    const r = t.getBoundingClientRect();
    const h = m.offsetHeight;
    const w = Math.max(m.offsetWidth, r.width);
    const gap = 6;
    let top = side === "top" ? r.top - h - gap : r.bottom + gap;
    // Flip if it would leave the viewport.
    if (top < 8) top = r.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - gap);
    const wanted = { start: r.left, center: r.left + (r.width - w) / 2, end: r.right - w }[align];
    const left = Math.min(Math.max(8, wanted), window.innerWidth - w - 8);
    // Where it ended up, not where it was asked to go: the entrance grows from
    // the corner that actually touches the trigger — or, centred under it, from
    // the middle of that edge.
    const edge = { start: "left", center: "center", end: "right" }[align];
    const origin = `${top < r.top ? "bottom" : "top"} ${edge}`;
    setPos({ top, left, width: r.width, origin });
  }, [side, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  // Move focus into the menu once it's placed, so arrows work immediately.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [open]);

  const z = `var(--z-${layer})`;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      // Inside a dialog, Escape is the menu's alone: the dialog hears it on
      // `document`, and a palette page on its own tree, and either would
      // close or step back underneath the menu.
      if (layer === "modal") {
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      }
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <>
      {trigger({
        ref: triggerRef,
        // Through `close` rather than a bare toggle, so every path that shuts
        // the menu also resets whether focus comes back.
        onClick: () => {
          if (open) return close();
          setLeaving(false);
          setOpen(true);
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
      })}
      {(open || leaving) &&
        createPortal(
          <>
            {/* Pointer-only dismissal; keyboard users get Escape and Tab. */}
            {open && (
              <div
                className="fixed inset-0"
                style={{ zIndex: z }}
                onMouseDown={() => close()}
              />
            )}
            <div
              ref={menuRef}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              onAnimationEnd={(e) => {
                if (!open && e.target === e.currentTarget) setLeaving(false);
              }}
              className={`nt-menu fixed${className ? ` ${className}` : ""}${open ? "" : " is-closing"}`}
              style={
                {
                  top: pos.top,
                  left: pos.left,
                  minWidth: pos.width,
                  "--origin": pos.origin,
                  ...(layer === "modal" ? { zIndex: z } : {}),
                } as React.CSSProperties
              }
            >
              {children(close)}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({
  onClick,
  children,
  danger,
  disabled,
  describedBy,
  className,
  ref,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  /** Refused rather than left out, for a menu that says why beside it. It
   *  stays in the arrow keys' reach so the reason can be read. */
  disabled?: boolean;
  /** A line elsewhere in the menu that says why, when it is not beside it. */
  describedBy?: string;
  className?: string;
  /** For a menu that has to move focus between its own items itself. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      role="menuitem"
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onClick={disabled ? undefined : onClick}
      className={`nt-menu-item${danger ? " is-danger" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * An item that goes somewhere. A link rather than a button pushing a route,
 * so it keeps a link's affordances — a new tab from a modified click, an
 * address to copy — and the menu's arrow keys find it by its role like any
 * other item.
 */
export function MenuLink({
  href,
  onClick,
  current,
  children,
}: {
  href: string;
  onClick: () => void;
  /** The place this link leads is where you already are. */
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      role="menuitem"
      href={href}
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      className="nt-menu-item"
    >
      {children}
    </Link>
  );
}
