"use client";

import { createContext, useContext } from "react";

/**
 * Whether the surrounding editor is a viewer, not an author — the share route.
 *
 * A context rather than `editor.isEditable` because the custom blocks render
 * through portals and BlockNote applies `editable` after the first paint; a
 * provider above BlockNoteView is deterministic from the first render.
 */
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
