"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { spineForProject, WorkspaceHistory } from "./spine";

/**
 * The spine, as React sees it: one context, one global key handler, and a
 * subscription hook for the toolbars that show whether ⌘Z has anything to do.
 *
 * The handler owns ⌘Z / ⌘⇧Z / ⌘Y for the whole workspace, in the CAPTURE
 * phase — before ProseMirror's keymap, before the canvas keymap, before
 * MathLive — so every surface answers to one timeline instead of whichever
 * local stack the focus happened to sit in. That is the fix for the whole
 * class of "tracked but unreachable" mutations: a checkbox in a side panel
 * writes an undoable entry, and the key now reaches it from the panel.
 */

/**
 * Marks a subtree whose text entries are ON the spine — the document, the
 * canvas (shape labels), the panels whose commits land in a tracked store.
 * Focus in an UNMARKED input keeps the browser's native undo: the chat
 * composer, a search box, a sidebar rename mid-edit are local drafts, and
 * hijacking ⌘Z there to revert a document edit would be hostile.
 */
export const UNDO_SCOPE_ATTR = "data-nt-undo";

/** Spread onto the root of any surface whose edits are spine-tracked. */
export const undoScope = { [UNDO_SCOPE_ATTR]: "" } as const;

const WorkspaceHistoryContext = createContext<WorkspaceHistory | null>(null);

/** The Yjs pipeline is where the text domain lives; without it the old
 *  per-surface bindings stay in charge. */
const YJS_ON = process.env.NEXT_PUBLIC_YJS === "1";

export function WorkspaceHistoryProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const spine = YJS_ON ? spineForProject(projectId) : null;

  useEffect(() => {
    if (!spine) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;

      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        isTextEntry(active) &&
        !active.closest(`[${UNDO_SCOPE_ATTR}]`)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void (isUndo ? spine.undo() : spine.redo());
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [spine]);

  return (
    <WorkspaceHistoryContext value={spine}>{children}</WorkspaceHistoryContext>
  );
}

function isTextEntry(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "MATH-FIELD";
}

/** The spine, or null outside the workspace (the share route, legacy sync). */
export function useWorkspaceHistory(): WorkspaceHistory | null {
  return useContext(WorkspaceHistoryContext);
}

const noop = () => () => {};
const never = () => false;

/** Whether the spine has anything to undo/redo, as reactive state. */
export function useSpineState(spine: WorkspaceHistory | null): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const canUndo = useSyncExternalStore(
    spine ? spine.subscribe : noop,
    spine ? spine.canUndo : never,
    never,
  );
  const canRedo = useSyncExternalStore(
    spine ? spine.subscribe : noop,
    spine ? spine.canRedo : never,
    never,
  );
  return { canUndo, canRedo };
}
