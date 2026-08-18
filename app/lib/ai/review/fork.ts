import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";

/**
 * The privacy envelope around an agent turn, on the Yjs pipeline.
 *
 * The pipeline's founding rule — "an agent edit is applied FOR REAL; the user
 * judges the document, not a rendering of one" — collides with sharing the
 * moment the document is shared: applied-for-real used to mean visible to
 * everyone before its own author said yes. BlockNote's fork extension is what
 * dissolves the collision: `fork()` clones the Y.Doc locally and rebinds the
 * editor to the clone, so the agent still edits the REAL document surface —
 * same applier, same hunks, same judging — while the shared doc hears
 * nothing. Merging with `keepChanges` applies only the fork's own changes as
 * one CRDT update, so anything collaborators did meanwhile survives, and the
 * merged edits land attributed to the reviewer: their AI, their write.
 *
 * On the legacy pipeline the extension simply isn't there and every function
 * here is a no-op — which IS the old behavior.
 */

type ForkApi = {
  store: { state: { isForked: boolean } };
  fork: (opts?: { initialUpdate?: Uint8Array }) => void;
  merge: (opts: { keepChanges: boolean }) => void;
};

function forkApi(editor: LiveEditor): ForkApi | null {
  return (editor.getExtension("yForkDoc") as unknown as ForkApi | undefined) ?? null;
}

export function isForked(editor: LiveEditor): boolean {
  return forkApi(editor)?.store.state.isForked ?? false;
}

export function ensureForked(editor: LiveEditor) {
  const fork = forkApi(editor);
  if (!fork || fork.store.state.isForked) return;
  try {
    fork.fork();
  } catch (error) {
    // Forking carries the selection into the clone, and a selection parked in
    // a contentless block — the caret left in a canvas or storyboard the user
    // just clicked — cannot be re-made as a TextSelection there, so fork()
    // throws. Measured in the field: the agent's whole edit then failed and it
    // REDREW everything, so a stray caret cost a turn's worth of drawing.
    // Park the selection somewhere textual and try once more.
    const view = (editor as unknown as { prosemirrorView?: EditorView })
      .prosemirrorView;
    if (!view) throw error;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.atStart(view.state.doc)),
    );
    fork.fork();
  }
}

/**
 * Ends the fork. `keep` carries the fork's changes into the shared doc (an
 * answer was given); `!keep` discards them wholesale (a confirmed rewind of a
 * turn nobody else ever saw).
 */
export function mergeFork(editor: LiveEditor, keep: boolean) {
  const fork = forkApi(editor);
  if (fork?.store.state.isForked) fork.merge({ keepChanges: keep });
}
