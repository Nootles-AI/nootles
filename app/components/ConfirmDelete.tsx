"use client";

import { useEffect } from "react";

/**
 * What is about to be lost, and the two ways out.
 *
 * Kept apart from its surroundings because a deletion is proposed in two very
 * different places — the sidebar, where the user asked for it, and the chat,
 * where the agent did — and the sentence describing what goes must not drift
 * between them.
 */
export function ConfirmDelete({
  what,
  focusConfirm,
  onCancel,
  onConfirm,
}: {
  /** Names the page, already quoted; falls back to a phrase when unnamed. */
  what: string;
  focusConfirm?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <p className="text-sm font-medium">Delete {what}?</p>
      <p className="mt-1.5 text-[13px] text-muted">
        Its diagrams and history go too. This cannot be undone.
      </p>
      <div className="mt-4 flex justify-end gap-1">
        <button onClick={onCancel} className="nt-row px-2.5">
          Cancel
        </button>
        <button
          onClick={onConfirm}
          autoFocus={focusConfirm}
          className="nt-row px-2.5 font-medium text-danger"
        >
          Delete
        </button>
      </div>
    </>
  );
}

/**
 * The modal form, for a deletion the user started. It names the page, since the
 * menu was opened by a right-click that may not have been where you thought.
 *
 * Escape cancels. Worth stating because the alternative is a dialog you can
 * only leave by choosing one of two buttons, one of which is irreversible —
 * and the reflex when you realise you opened the wrong row is to hit Escape,
 * not to hunt for Cancel.
 */
export function ConfirmDeleteDialog({
  title,
  what,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** Overrides the phrase after "Delete", for a thing that is not just a page. */
  what?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <>
      <button
        aria-label="Cancel"
        onClick={onCancel}
        className="fixed inset-0 bg-foreground/15"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${title}`}
        className="nt-menu fixed left-1/2 top-1/3 w-[19rem] -translate-x-1/2 p-4"
        style={{ zIndex: "var(--z-modal)" }}
      >
        <ConfirmDelete
          what={what ?? `“${title}”`}
          focusConfirm
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </div>
    </>
  );
}
