"use client";

import { createContext, useContext } from "react";

/**
 * The sheet's top-right corner, for the main page to put its own controls in.
 *
 * The corner belongs to the workspace, which knows about rails; what goes in it
 * belongs to the page, which owns the state behind it. A portal into this slot
 * lets both stay where they are.
 */
export const CornerSlotContext = createContext<HTMLElement | null>(null);

export function useCornerSlot(): HTMLElement | null {
  return useContext(CornerSlotContext);
}
