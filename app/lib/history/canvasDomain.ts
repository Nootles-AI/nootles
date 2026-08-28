"use client";

import { useEffect } from "react";
import type { SceneStore } from "@/app/components/editor/canvas/engine/useScene";
import type { DomainStep, WorkspaceHistory } from "./spine";

/**
 * A diagram's side of the spine: one domain per canvas block (and per
 * storyboard shot), bridging the SceneStore's own history.
 *
 * The store already speaks the spine's language. Its entries are pushed one
 * at a time (`push` events, selection-only entries as focus stops), its
 * bounded stack trims oldest-first (`trim`), and a collaborator's merge
 * resets it whole (`clear` — the documented "fresh undo horizon", which the
 * spine renders as tombstones rather than a hole in the timeline). Undo and
 * redo refuse while a gesture bracket is open, which is exactly "blocked".
 */
export function canvasDomainId(blockId: string, shotId?: string): string {
  return shotId ? `canvas:${blockId}:${shotId}` : `canvas:${blockId}`;
}

export function useCanvasUndoDomain(
  spine: WorkspaceHistory | null,
  store: SceneStore | null,
  blockId: string,
  pageId: string | null,
  shotId?: string,
): void {
  useEffect(() => {
    if (!spine || !store || !pageId) return;
    const id = canvasDomainId(blockId, shotId);

    const offHistory = store.onHistory((event) => {
      if (event.type === "push") {
        spine.record(id, event.selectionOnly ? "focus" : "edit");
      } else if (event.type === "trim") {
        spine.trim(id);
      } else {
        spine.drop(id);
      }
    });

    const step = (direction: "undo" | "redo"): DomainStep => {
      const moved = direction === "undo" ? store.undo() : store.redo();
      if (moved) return { consumed: 1, redoable: true };
      return store.gesturing() ? "blocked" : { consumed: 0, redoable: false };
    };

    const unregister = spine.register(
      id,
      { undo: () => step("undo"), redo: () => step("redo") },
      pageId,
    );

    return () => {
      offHistory();
      unregister();
    };
  }, [spine, store, blockId, pageId, shotId]);
}
