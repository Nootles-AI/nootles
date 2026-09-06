"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import Link from "next/link";

type Align = "start" | "end";
type Side = "top" | "bottom";

/**
 * An anchored menu with the keyboard contract users expect: Escape closes,
 * arrows move, Home/End jump, Tab closes, and focus returns to the trigger.
 *
 * Positioned `fixed` from the trigger's measured rect rather than absolutely
 * inside it, so a panel with `overflow: auto` can never clip it.
 */
export function Menu({
  trigger,
  children,
  side = "top",
  align = "start",
  label,
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
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 0,
  });

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
    let left = align === "start" ? r.left : r.right - w;
    left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    setPos({ top, left, width: r.width });
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
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
        onClick: () => (open ? close() : setOpen(true)),
        "aria-haspopup": "menu",
        "aria-expanded": open,
      })}
      {open && (
        <>
          {/* Pointer-only dismissal; keyboard users get Escape and Tab. */}
          <div
            className="fixed inset-0"
            style={{ zIndex: "var(--z-dropdown)" }}
            onMouseDown={() => close()}
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="nt-menu fixed"
            style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
          >
            {children(close)}
          </div>
        </>
      )}
    </>
  );
}

export function MenuItem({
  onClick,
  children,
  danger,
  ref,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  /** For a menu that has to move focus between its own items itself. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      role="menuitem"
      onClick={onClick}
      className={`nt-menu-item${danger ? " is-danger" : ""}`}
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
  children,
}: {
  href: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Link role="menuitem" href={href} onClick={onClick} className="nt-menu-item">
      {children}
    </Link>
  );
}
