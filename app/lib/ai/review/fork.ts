import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  getRelativeSelection,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  type ProsemirrorBinding,
} from "y-prosemirror";
import * as Y from "yjs";
import { settleDiagrams } from "@/app/components/editor/canvas/collab/binding";
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

/**
 * The origin a kept change reaches the shared doc under, and the one the
 * document's undo domain tracks (see history/textDomain.ts): what the person
 * said yes to is theirs, and ⌘Z takes it back. BlockNote's own merge lands it
 * under the editor, which no undo manager tracks — the change arrived off the
 * timeline, and ⌘Z walked past it into the typing it had just rewritten,
 * undoing that typing inside the agent's blocks.
 */
export const KEPT_CHANGE = "review-kept";

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
 * How a fork ends. `kept` carries its changes into the shared doc as one step
 * of the person's history; `landed` carries them in off it, for an answer that
 * kept nothing but whose fork still holds the person's own typing (see
 * `undoable` in session.ts); `discarded` drops them wholesale (a rewind or a
 * revert of a turn nobody else ever saw).
 */
export type ForkEnd = "kept" | "landed" | "discarded";

export function mergeFork(editor: LiveEditor, end: ForkEnd) {
  const fork = forkApi(editor);
  if (!fork?.store.state.isForked) return;
  const forked = boundDoc(editor);
  const selection = parkSelection(editor);
  // An answer writes the page and lands in the same task; what lands has to
  // be what the page now says, diagrams included (see settleDiagrams).
  if (end !== "discarded") settleDiagrams(forked);
  if (end !== "kept") {
    fork.merge({ keepChanges: end === "landed" });
    restoreSelection(editor, selection);
    return;
  }
  // BlockNote's `keepChanges` merge with the landing done here, so that it
  // carries an origin: the same update, onto the same doc, after the same swap.
  fork.merge({ keepChanges: false });
  const shared = boundDoc(editor);
  Y.applyUpdate(shared, Y.encodeStateAsUpdate(forked, Y.encodeStateVector(shared)), KEPT_CHANGE);
  restoreSelection(editor, selection);
}

/**
 * The doc the editor is bound to now — the fork's while it is forked. Read off
 * the binding, because the sync state's own `doc` names the shared doc
 * throughout: ProseMirror keeps a plugin's state field across the swap.
 */
export function boundDoc(editor: LiveEditor): Y.Doc {
  return bindingOf(editor).doc;
}

type ParkedSelection = {
  view: EditorView;
  relative: ReturnType<typeof getRelativeSelection>;
} | null;

/** The fork can be longer than shared truth, so its absolute caret cannot cross the swap. */
function parkSelection(editor: LiveEditor): ParkedSelection {
  const view = (editor as unknown as { prosemirrorView?: EditorView }).prosemirrorView;
  if (!view || !(view.state.selection instanceof TextSelection)) return null;
  const relative = getRelativeSelection(bindingOf(editor), view.state);
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.atStart(view.state.doc))
      .setMeta("addToHistory", false),
  );
  return { view, relative };
}

function restoreSelection(editor: LiveEditor, parked: ParkedSelection) {
  if (!parked) return;
  const binding = bindingOf(editor);
  const { doc } = parked.view.state;
  const anchor = relativePositionToAbsolutePosition(
    binding.doc,
    binding.type,
    parked.relative.anchor,
    binding.mapping,
  );
  const head = relativePositionToAbsolutePosition(
    binding.doc,
    binding.type,
    parked.relative.head,
    binding.mapping,
  );
  if (anchor === null || head === null) return;
  parked.view.dispatch(
    parked.view.state.tr
      .setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head)))
      .setMeta("addToHistory", false),
  );
}

function bindingOf(editor: LiveEditor): ProsemirrorBinding {
  return (ySyncPluginKey.getState(editor.prosemirrorState) as {
    binding: ProsemirrorBinding;
  }).binding;
}
