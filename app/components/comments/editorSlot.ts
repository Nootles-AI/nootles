"use client";

import { createContext, useContext, useEffect } from "react";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";

/**
 * The page's live editor, as its comment surfaces see it. The editor is built
 * inside `PageCommentsProvider`, below the surfaces that need its selection,
 * so it reports itself up here rather than being passed down — the workspace
 * and the share route alike, read-only or not.
 */
export class CommentsEditorSlot {
  private editor: LiveEditor | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): LiveEditor | null => this.editor;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Occupy the slot; the returned release is ignored once another editor has. */
  attach(editor: LiveEditor): () => void {
    this.set(editor);
    return () => {
      if (this.editor === editor) this.set(null);
    };
  }

  private set(editor: LiveEditor | null) {
    this.editor = editor;
    for (const listener of this.listeners) listener();
  }
}

export const CommentsEditorContext = createContext<CommentsEditorSlot | null>(null);

/** Report `editor` as the page's, for as long as it is mounted. */
export function useAttachCommentsEditor(editor: LiveEditor | null): void {
  const slot = useContext(CommentsEditorContext);
  useEffect(() => (slot && editor ? slot.attach(editor) : undefined), [slot, editor]);
}
