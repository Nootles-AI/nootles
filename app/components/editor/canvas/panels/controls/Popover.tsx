"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useColorPick } from "./colorPick";

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
  /**
   * Whether this popover's scrim goes inert (`pointer-events: none`) while a
   * colour-pick session (COLOR) is active, so a click on the canvas resolves
   * the pick instead of the scrim reading it as "close" first. Default
   * `true` — a `ColorField`/`GradientField` popover needs this; a popover
   * with nothing to do with colour can pass `false` to skip subscribing to
   * the pick-session store at all.
   */
  shield = true,
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
  shield?: boolean;
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
          {shield ? <ShieldedScrim onClose={close} /> : <div className="fixed inset-0" style={{ zIndex: "var(--z-dropdown)" }} onMouseDown={close} />}
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

/**
 * The scrim, for a popover that cares whether a colour-pick session is up.
 * Split into its own component so a `shield={false}` popover never mounts
 * `useColorPick`'s subscription at all — most of the panel's popovers (a
 * number field's stepper, a select) have nothing to do with picking and
 * should not re-render every time one starts or ends elsewhere.
 */
function ShieldedScrim({ onClose }: { onClose: () => void }) {
  const pick = useColorPick();
  return (
    <div
      className={`fixed inset-0 nt-ctl-scrim${pick.active ? " is-picking" : ""}`}
      style={{ zIndex: "var(--z-dropdown)" }}
      onMouseDown={pick.active ? undefined : onClose}
    />
  );
}
