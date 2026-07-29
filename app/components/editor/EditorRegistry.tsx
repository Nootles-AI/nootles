"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { getVersion } from "prosemirror-collab";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";

// The same loosely-typed handle the applier takes; see app/lib/ai/apply.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LiveEditor = BlockNoteEditor<any, any, any>;

type Entry = { editor: LiveEditor; loaded: boolean };

/**
 * The open editors, by page.
 *
 * This is how the agent reaches a document — one live editor, the same object
 * the user is typing into, so an AI edit runs the applier a human action runs.
 *
 * `editorFor` deliberately waits, because a page's editor exists before its
 * content does. `useBlockNoteSync` builds the editor from the last SNAPSHOT and
 * only then applies the steps taken since (measured on this deployment: a
 * snapshot nine steps behind its document). An editor handed over in that window
 * is a document missing its most recent blocks, and an edit diffed against it
 * compiles a `removeBlock` for every one of them. Waiting costs a round trip.
 */
export class EditorRegistry {
  private entries = new Map<string, Entry>();
  private waiting = new Map<string, Set<(editor: LiveEditor) => void>>();

  register(pageId: string, editor: LiveEditor, loaded: boolean) {
    this.entries.set(pageId, { editor, loaded });
    if (!loaded) return;
    const waiters = this.waiting.get(pageId);
    if (!waiters) return;
    this.waiting.delete(pageId);
    for (const resolve of waiters) resolve(editor);
  }

  /** Ignored if the page has since registered a different editor. */
  unregister(pageId: string, editor: LiveEditor) {
    if (this.entries.get(pageId)?.editor === editor) this.entries.delete(pageId);
  }

  editorFor(pageId: string, timeoutMs: number = AI.chat.editorWaitMs): Promise<LiveEditor> {
    const entry = this.entries.get(pageId);
    if (entry?.loaded) return Promise.resolve(entry.editor);

    return new Promise((resolve, reject) => {
      const waiters = this.waiting.get(pageId) ?? new Set();
      this.waiting.set(pageId, waiters);

      const settle = (editor: LiveEditor) => {
        clearTimeout(timer);
        resolve(editor);
      };
      // A page that never loads has to fail this one call. Left to hang it would
      // take the whole turn with it, and the model would never learn why.
      const timer = setTimeout(() => {
        waiters.delete(settle);
        if (!waiters.size) this.waiting.delete(pageId);
        reject(
          new Error(
            `Page ${pageId} did not finish loading, so its document cannot be read or edited. Say that, rather than answering from memory.`,
          ),
        );
      }, timeoutMs);

      waiters.add(settle);
    });
  }
}

const RegistryContext = createContext<EditorRegistry | null>(null);

export function EditorRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new EditorRegistry());
  return <RegistryContext value={registry}>{children}</RegistryContext>;
}

export function useEditorRegistry(): EditorRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error("Missing <EditorRegistryProvider>");
  return registry;
}

/**
 * Publishes this page's editor, and marks it loaded once its document has caught
 * up with the server.
 *
 * `localVersion >= serverVersion` is the whole guard. prosemirror-collab counts
 * the steps a document has applied, and prosemirror-sync starts that count at
 * the snapshot's version — so while the editor is still fetching the steps taken
 * since, it is measurably behind, by exactly the blocks that are missing.
 */
export function useRegisterEditor(
  pageId: Id<"pages"> | undefined,
  editor: LiveEditor | null,
  docId: string,
) {
  const registry = useEditorRegistry();
  // The same subscription prosemirror-sync itself watches, so Convex serves both
  // from one.
  const serverVersion = useQuery(api.prosemirror.latestVersion, { id: docId });

  const localVersion = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        // Every transaction, not `editor.onChange`: confirming steps we sent
        // ourselves advances the collab version without touching the document,
        // and BlockNote only emits a change when the document changed — so the
        // gate would shut on a local edit with nothing left to reopen it.
        const tiptap = editor?._tiptapEditor;
        tiptap?.on("transaction", onStoreChange);
        return () => void tiptap?.off("transaction", onStoreChange);
      },
      [editor],
    ),
    () => (editor ? getVersion(editor.prosemirrorState) : -1),
    () => -1,
  );

  const loaded =
    editor !== null &&
    serverVersion !== undefined &&
    localVersion >= (serverVersion ?? 0);

  useEffect(() => {
    if (!pageId || !editor) return;
    registry.register(pageId, editor, loaded);
    return () => registry.unregister(pageId, editor);
  }, [registry, pageId, editor, loaded]);
}
