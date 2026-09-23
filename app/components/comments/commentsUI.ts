"use client";

import { createContext, useContext } from "react";
import type { SelectedWords } from "./useCommentableSelection";

/**
 * What the comment surfaces outside this layer ask of it: the formatting
 * toolbar's Comment button, and the page header's comments button.
 */
export type CommentsUI = {
  /** Open the composer on words already captured from the selection. */
  start: (words: SelectedWords) => void;
  panelOpen: boolean;
  togglePanel: () => void;
  /** Open threads, for the header's count. */
  openCount: number;
  canRead: boolean;
};

export const CommentsUIContext = createContext<CommentsUI | null>(null);

export function useCommentsUI(): CommentsUI | null {
  return useContext(CommentsUIContext);
}

