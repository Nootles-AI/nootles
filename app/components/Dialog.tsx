"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/**
 * Where the last press landed, so a dialog can grow out of whatever raised it.
 * A keystroke forgets it: a dialog opened from the keyboard was not raised from
 * anywhere, and grows from its own centre like before.
 */
let pressed: { x: number; y: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      pressed = { x: e.clientX, y: e.clientY };
    },
    true,
  );
  document.addEventListener("keydown", () => (pressed = null), true);
}

/**
 * The modal contract, extracted from the two dialogs that each carried a
 * private copy of it: a scrim you can click, an Escape that always works, and
 * a leaving that is animated — so it outlives the decision to leave. The
 * dialog plays itself out and tells the caller to unmount it once it has,
 * rather than the moment you click; arriving gently and then vanishing on the
 * spot is the version that feels broken.
 *
 * Children get `close` because the decision to leave belongs to the content
 * (a Cancel button, a Done button) while the leaving itself belongs here.
 */
export function Dialog({
  label,
  labelledBy,
  scrimLabel = "Close",
  as = "div",
  className,
  onSubmit,
  onClose,
  children,
}: {
  label?: string;
  /** Added to the box, for a dialog that is not the stock two-column form. */
  className?: string;
  /** The id of a heading inside, when the dialog's name is one that changes. */
  labelledBy?: string;
  /** What clicking the scrim means — "Cancel" when the dialog is a form. */
  scrimLabel?: string;
  /** "form" when the dialog IS the form, so Enter submits from any field. */
  as?: "div" | "form";
  onSubmit?: (e: FormEvent) => void;
  /** Called after the exit animation; unmount here. */
  onClose: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const ref = useRef<HTMLDivElement & HTMLFormElement>(null);
  const [closing, setClosing] = useState(false);
  const close = () => setClosing(true);
  const gone = (e: AnimationEvent<HTMLElement>) => {
    if (closing && e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setClosing(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const keepFocus = useModalFocus(ref);

  // Before the first paint, so the entrance already scales from the press. The
  // offsets are layout values — the box as placed, not as the entrance is
  // currently transforming it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pressed) return;
    el.style.transformOrigin = `${pressed.x - el.offsetLeft}px ${pressed.y - el.offsetTop}px`;
  }, []);

  const El = as;
  // To the body, not in place: an in-place dialog inherits its opener's
  // stacking context (a panel's, say) and paints under the rest of the shell
  // however high its own z-index — and its scrim's backdrop blur samples only
  // that ancestor's pixels instead of the page.
  return createPortal(
    <>
      <button
        aria-label={scrimLabel}
        onClick={close}
        className={`nt-scrim${closing ? " is-closing" : ""}`}
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <El
        ref={ref}
        onSubmit={onSubmit}
        onAnimationEnd={gone}
        onKeyDown={keepFocus}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`nt-dialog${className ? ` ${className}` : ""}${closing ? " is-closing" : ""}`}
        style={{ zIndex: "var(--z-modal)" }}
      >
        {typeof children === "function" ? children(close) : children}
      </El>
    </>,
    document.body,
  );
}

/**
 * The small box, for a dialog that is one sentence and a choice — the shape
 * ConfirmDeleteDialog established. It borrows the menu surface (and its
 * entrance), leaves instantly, and sits high enough that the question reads
 * before the pointer moves.
 */
export function DialogBox({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const keepFocus = useModalFocus(ref);

  return createPortal(
    <>
      <button
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-foreground/15"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={keepFocus}
        className="nt-menu fixed left-1/2 top-1/3 w-[19rem] -translate-x-1/2 p-4"
        style={{ zIndex: "var(--z-modal)" }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where focus goes while a modal is up, and where it goes back to.
 *
 * `aria-modal` hides the page from a screen reader but not from the Tab key,
 * so without this a keyboard user opening a dialog from the sidebar walks the
 * whole sidebar behind the scrim before reaching the first field. On mount
 * the dialog takes focus unless something inside already asked for it (an
 * `autoFocus` field lands first); Tab wraps at its edges; and on unmount focus
 * goes back to the control that opened it — but only if nothing else has
 * claimed focus meanwhile, because an action that moves focus itself must not
 * be undone by the restore landing after it.
 */
function useModalFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const opener = document.activeElement;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      const active = document.activeElement;
      const unclaimed = !active || active === document.body || el?.contains(active);
      if (unclaimed && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [ref]);

  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(TABBABLE)).filter(
      (item) => item.tabIndex >= 0,
    );
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}
