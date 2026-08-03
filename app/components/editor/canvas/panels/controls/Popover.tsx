"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * An anchored panel whose contents are a widget rather than a list of commands.
 *
 * `Menu` stays the app's one menu; it owns roving focus over `role="menuitem"`,
 * which a colour square has none of — and its key handler bails out when there
 * are none, so Escape would never close. Same fixed placement, different job.
 */
export function Popover({
  trigger,
  children,
  label,
  width,
}: {
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    "aria-haspopup": "dialog";
    "aria-expanded": boolean;
  }) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  width: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const t = triggerRef.current;
    const p = panelRef.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    const h = p.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
    setPos({ top, left });
  }, [width]);

  useLayoutEffect(() => {
    if (open) place();
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

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((v) => !v),
        "aria-haspopup": "dialog",
        "aria-expanded": open,
      })}
      {open && (
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: "var(--z-dropdown)" }}
            onMouseDown={close}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            className="nt-menu nt-ctl-pop fixed"
            style={{ top: pos.top, left: pos.left, width }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              close();
              triggerRef.current?.focus();
            }}
          >
            {children(close)}
          </div>
        </>
      )}
    </>
  );
}
