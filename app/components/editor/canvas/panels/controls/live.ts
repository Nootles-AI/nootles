"use client";

import { createContext, useContext } from "react";

/**
 * A continuous panel edit — a scrub, a slider, a drag inside a colour picker.
 *
 * `begin` and `end` bracket it in the scene store's history, so a gesture that
 * emits sixty changes is still one undo entry. Holds nest: the panel opens one
 * for every pointer that goes down in it, and a control may open its own.
 */
export type LiveEdit = { begin: () => void; end: () => void };

/**
 * Present where previewing every frame is cheap — the style panel's sections,
 * which write ops into the store. A control that finds one should emit on every
 * move rather than only on release; where it is null, the surrounding fields
 * round-trip through the document instead and are committed once, at the end.
 */
export const LiveEditContext = createContext<LiveEdit | null>(null);

export function useLiveEdit(): LiveEdit | null {
  return useContext(LiveEditContext);
}
