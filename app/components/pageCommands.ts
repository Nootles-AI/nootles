"use client";

import { createContext, useContext, type RefObject } from "react";
import type { PageMode } from "./editor/ai/useTabCompletion";

/**
 * What the open page lets the workspace's ⌘K do to it.
 *
 * The page owns the write and its undo entry; the palette only asks. A ref,
 * not state: the palette reads it once, when it opens, and nothing re-renders
 * the workspace because the page did.
 */
export type ModeCommand = {
  mode: PageMode;
  set: (mode: PageMode) => void;
};

export const PageCommandsContext =
  createContext<RefObject<ModeCommand | null> | null>(null);

export function usePageCommands(): RefObject<ModeCommand | null> | null {
  return useContext(PageCommandsContext);
}
