"use client";

import type { ReactNode } from "react";

/* Below this the three fixed panels leave no usable column for the document
   (462px of chrome against a 560px viewport left 2px of text), so they stop
   being in-flow and become overlays the user summons. */
export const COMPACT = "(max-width: 1023px)";

/**
 * Where a summoned panel sits: fixed to its edge, at the modal rank over the
 * scrim. Props rather than a wrapper so a panel that must not remount when it
 * becomes a drawer — the chat, which owns an in-flight stream — can wear them
 * itself.
 */
export function drawerLayer(side: "left" | "right") {
  return {
    className: `fixed inset-y-0 ${side === "left" ? "left-0" : "right-0"} shadow-2xl`,
    style: { zIndex: "var(--z-modal)" },
  };
}

/** The wash under an open drawer; a press on it puts the drawer away. */
export function DrawerScrim({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button
      aria-label={label}
      onClick={onClose}
      className="fixed inset-0 bg-foreground/15"
      style={{ zIndex: "var(--z-overlay)" }}
    />
  );
}

/** A panel summoned over the document from the left edge. */
export function LeftDrawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <DrawerScrim label={label} onClose={onClose} />
      <div {...drawerLayer("left")}>{children}</div>
    </>
  );
}
