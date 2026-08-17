"use client";

import {
  useEffect,
  useState,
  type AnimationEvent,
  type FormEvent,
  type ReactNode,
} from "react";

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
  scrimLabel = "Close",
  as = "div",
  onSubmit,
  onClose,
  children,
}: {
  label: string;
  /** What clicking the scrim means — "Cancel" when the dialog is a form. */
  scrimLabel?: string;
  /** "form" when the dialog IS the form, so Enter submits from any field. */
  as?: "div" | "form";
  onSubmit?: (e: FormEvent) => void;
  /** Called after the exit animation; unmount here. */
  onClose: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [closing, setClosing] = useState(false);
  const close = () => setClosing(true);
  const gone = (e: AnimationEvent<HTMLElement>) => {
    if (closing && e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setClosing(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const El = as;
  return (
    <>
      <button
        aria-label={scrimLabel}
        onClick={close}
        className={`nt-scrim${closing ? " is-closing" : ""}`}
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <El
        onSubmit={onSubmit}
        onAnimationEnd={gone}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`nt-dialog${closing ? " is-closing" : ""}`}
        style={{ zIndex: "var(--z-modal)" }}
      >
        {typeof children === "function" ? children(close) : children}
      </El>
    </>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-foreground/15"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="nt-menu fixed left-1/2 top-1/3 w-[19rem] -translate-x-1/2 p-4"
        style={{ zIndex: "var(--z-modal)" }}
      >
        {children}
      </div>
    </>
  );
}
