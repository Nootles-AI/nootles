"use client";

import { createContext, useContext, type ReactNode } from "react";

type Panels = {
  /** Reveal the chat rail, collapsed or narrow-screen. Idempotent. */
  openChat: () => void;
  openSidebar: () => void;
};

const PanelsContext = createContext<Panels | null>(null);

/**
 * Opening the rails from outside the workspace.
 *
 * Exists for the first-run guide, which has to bring the chat panel out before
 * it can point at it — a step that says "ask it something" over a collapsed
 * rail is pointing at nothing. Deliberately only the two verbs it needs:
 * widths, drawers and the canvas swap stay the workspace's own business.
 */
export function PanelsProvider({
  value,
  children,
}: {
  value: Panels;
  children: ReactNode;
}) {
  return <PanelsContext value={value}>{children}</PanelsContext>;
}

/** Null outside the workspace, so callers that are optional can stay optional. */
export function usePanels(): Panels | null {
  return useContext(PanelsContext);
}
