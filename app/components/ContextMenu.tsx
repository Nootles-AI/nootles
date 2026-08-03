"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A menu anchored where the pointer was, in the shell's menu vocabulary.
 *
 * Point-anchored rather than element-anchored, which is the only thing that
 * separates it from {@link Menu} — same surface, same items, same keyboard
 * contract. Kept as its own component because a right-click has no trigger to
 * measure from and nothing to give focus back to when it closes.
 *
 * Focus is not restored on close, deliberately: every action that opens one of
 * these takes focus somewhere itself — a rename opens a field, a delete opens a
 * dialog, an open navigates — and a restore would land after them and undo it.
 */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  // Placed after measuring, so a menu opened near the right or bottom edge
  // folds back into the viewport instead of being clipped by it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      top: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)),
      left: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
    });
  }, [x, y]);

  // On the document rather than the menu: the pointer opened this, so nothing
  // inside it has focus yet and a local handler would never hear the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Arrows work from the moment it opens, and a keyboard user who reached it
  // via the context-menu key is not left outside it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
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
      onClose();
    }
  };

  return (
    <>
      {/* A second right-click moves the menu rather than opening the browser's
          own on top of it. */}
      <div
        className="fixed inset-0"
        style={{ zIndex: "var(--z-dropdown)" }}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="nt-menu fixed"
        style={{ top: pos.top, left: pos.left, minWidth: 168 }}
      >
        {children}
      </div>
    </>
  );
}
