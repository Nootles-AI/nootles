"use client";

import { createContext, useContext } from "react";
import type { ProjectRole } from "@/convex/roles";

/**
 * Whether the surrounding editor is a reader, not an author — the share route,
 * and a workspace opened by anyone without the pen.
 *
 * A context rather than `editor.isEditable` because the custom blocks render
 * through portals and BlockNote applies `editable` after the first paint; a
 * provider above BlockNoteView is deterministic from the first render.
 *
 * Read-only takes away every verb that writes the document — typing, the
 * slash and `@` menus, drag handles, the formatting toolbar, diagram edits,
 * the AI lanes — and nothing that only reads it: text can still be selected,
 * which is what a commenter selects words to comment on with.
 */
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/**
 * Whether a resolved role reads the page rather than writes it. Only the
 * owner and an editor hold the pen; a commenter, a viewer and an operator
 * standing in (whom `projects.myRole` calls a viewer) all read — so a role
 * added later fails closed to read-only rather than open to editing.
 * `null`/`undefined` is a role still loading, which shows no chrome either way.
 */
export function readsOnly(role: ProjectRole | null | undefined): boolean {
  return role != null && role !== "owner" && role !== "editor";
}
