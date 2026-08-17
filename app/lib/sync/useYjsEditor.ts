"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import {
  BlockNoteEditor,
  type BlockNoteEditorOptions,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { watchFimFlash } from "./fimFlash";
import { createRemoteCarets } from "./remoteCarets";
import {
  acquireProvider,
  releaseProvider,
  type YConvexProvider,
} from "./YConvexProvider";

/**
 * A BlockNote editor bound to a Yjs doc synced through Convex — the successor
 * to `useBlockNoteSync`, with one structural difference that removes a whole
 * class of problems: the editor is only constructed AFTER the initial sync,
 * so it is born holding the complete document. There is no window where an
 * editor exists but trails the server, which is the window the old
 * loaded-gate machinery existed to paper over.
 */
type AnyEditorOptions = Partial<
  BlockNoteEditorOptions<BlockSchema, InlineContentSchema, StyleSchema>
>;

// Unconstrained on purpose, and `editorOptions` deliberately loose: BlockNote's
// editor and options types are invariant in their schema (through
// `initialContent`), so no useful bound admits a concrete schema's values.
// The casts below are the same hop useBlockNoteSync makes.
export function useYjsEditor<E>({
  docId,
  user,
  editorOptions,
}: {
  docId: string;
  /** Shown to collaborators on this person's caret and in the facepile. */
  user: { name: string; color: string; imageUrl?: string };
  /** BlockNote editor options — the schema in here decides the editor type. */
  editorOptions: object;
}): { editor: E | null; provider: YConvexProvider | null; isLoading: boolean } {
  const client = useConvex();

  // Held in state and acquired in an effect — the sanctioned shape for an
  // external subscription (like the layout restores): acquisition refcounts a
  // module-level instance, so it must run exactly once per mount, which render
  // and useMemo (StrictMode double-invokes both) cannot promise.
  /* eslint-disable react-hooks/set-state-in-effect */
  const [provider, setProvider] = useState<YConvexProvider | null>(null);
  useEffect(() => {
    const acquired = acquireProvider(client, docId);
    setProvider(acquired);
    return () => {
      setProvider(null);
      releaseProvider(docId);
    };
  }, [client, docId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const synced = useSyncExternalStore(
    provider ? (cb) => provider.subscribe(cb) : () => () => {},
    () => provider?.synced ?? false,
    () => false,
  );

  const made = useMemo(() => {
    if (!provider || !synced) return null;
    const carets = createRemoteCarets(provider.awareness);
    const editor = BlockNoteEditor.create(
      withCollaboration({
        ...(editorOptions as AnyEditorOptions),
        collaboration: {
          fragment: provider.doc.getXmlFragment("prosemirror"),
          // A seed only — the effect below is what keeps this current.
          user: { name: user.name, color: user.color },
          provider: { awareness: provider.awareness },
          // "always" is what turns BlockNote's own label logic off; the caret
          // layer owns arrival, activity and hover as one lifecycle.
          showCursorLabels: "always",
          renderCursor: carets.render,
        },
      }),
      // The schema in editorOptions decides the real editor type; `create`'s
      // signature can't see through the Partial, same hop useBlockNoteSync
      // makes with its own type parameter.
    ) as unknown as E;
    return { editor, carets };
    // The options object is rebuilt by callers every render; the editor must
    // not be. It rebuilds only for a different document — who you are travels
    // through awareness below, because rebuilding for a name arriving late
    // would take the caret, the selection and the undo history with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, synced]);
  const editor = made?.editor ?? null;

  useEffect(() => made?.carets.attach(), [made]);

  // Identity reaches collaborators without a rebuild — Clerk hydrates a beat
  // after the page mounts. Running from the moment the provider exists also
  // puts the person on the presence channel before the initial sync lands.
  useEffect(() => {
    // Extra fields ride along on the awareness user (the type allows any
    // string field), which is how the facepile learns the photo.
    provider?.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      ...(user.imageUrl ? { imageUrl: user.imageUrl } : {}),
    });
  }, [provider, user.name, user.color, user.imageUrl]);

  // Parity with the old pipeline's warnOnUnsyncedClose: leaving with unsent
  // edits deserves the browser's are-you-sure.
  useEffect(() => {
    if (!provider) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (provider.hasUnsyncedChanges) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [provider]);

  // Other people's accepted completions arrive wearing the accent (fimFlash).
  useEffect(() => {
    if (!provider || !editor) return;
    return watchFimFlash(provider, () => {
      const holder = editor as unknown as {
        _tiptapEditor?: { view?: import("prosemirror-view").EditorView };
      };
      return holder._tiptapEditor?.view ?? null;
    });
  }, [provider, editor]);

  return { editor, provider, isLoading: editor === null };
}
