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
import type { AnyBlock } from "../projection";
import { replayable, replayOwnEdits } from "./undo";

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

/**
 * What a fork said when it was made, for the one question `landed` asks.
 *
 * Kept per fork doc, so it goes when the fork does. A fork this never saw —
 * one made before this ran — answers "there may be something of theirs in
 * there", which lands: the reading that loses nothing.
 */
const born = new WeakMap<Y.Doc, string>();

/**
 * The same moment as a page, for the edits a dropped fork still owes them.
 * Read back only when the answer to that question is yes.
 */
const bornPage = new WeakMap<Y.Doc, AnyBlock[]>();

/**
 * A fork's content with nothing of its items' identity in it. Yjs sorts
 * attributes and marks for exactly this comparison, so the same page written
 * twice reads the same both times.
 */
function contentOf(editor: LiveEditor): string {
  return bindingOf(editor).type.toString();
}

/**
 * The same of the SHARED doc, fork or no fork: the sync state's own `type`
 * names it throughout, where the binding follows the fork (see boundDoc).
 * Against `born` it answers one question — has anyone else written here since.
 */
function sharedContent(editor: LiveEditor): string | null {
  const state = ySyncPluginKey.getState(editor.prosemirrorState) as {
    type?: Y.XmlFragment;
  };
  return state.type?.toString() ?? null;
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
  const forked = boundDoc(editor);
  born.set(forked, contentOf(editor));
  bornPage.set(forked, editor.document as unknown as AnyBlock[]);
}

/**
 * How a fork ends. `kept` carries its changes into the shared doc as one step
 * of the person's history; `landed` is an answer that kept nothing (see
 * `undoable` in session.ts) — the fork is dropped and what the person put in it
 * meanwhile written again as a step of their own, or, where nothing here can
 * write it, landed whole as it used to be; `discarded` drops it wholesale,
 * whatever is in there (a rewind or a revert of a turn nobody else ever saw).
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
    // `landed` exists for the person's own typing, and the fork goes whatever
    // is in it. With none of their words in there it says exactly what it was
    // born saying (NT-45); with their words in there, landing it carries the
    // discard's churn along with them (NT-68). Either way, what lands is the
    // page written back as brand-new items — identical to read, and no longer
    // the ones the person's undo entries name. Yjs pops those dead entries
    // silently and undoes an older live one instead, so ⌘Z walked past their
    // last words and took the paragraph they were in. So the fork is dropped,
    // and what they put in it written again below, against the items the
    // shared doc already has.
    const theirs = end === "landed" && contentOf(editor) !== born.get(forked);
    // Unless the replay cannot speak for all of it. Dropping a fork on their
    // behalf is only honest while nobody else has written here: the replay
    // writes their blocks as the fork has them, and a collaborator's words in
    // one of those blocks are not in the fork to be written, where the CRDT
    // merge keeps both. Same for a fork this record does not know, one made
    // before this ran, and for a diagram (see `replayable`). Each of those
    // lands whole, as it always did: the reading that loses nothing.
    const alone = born.has(forked) && sharedContent(editor) === born.get(forked);
    const birth = theirs && alone ? bornPage.get(forked) : undefined;
    const theirPage = birth ? (editor.document as unknown as AnyBlock[]) : null;
    const replay = birth && theirPage && replayable(birth, theirPage)
      ? { birth, theirPage }
      : null;
    if (theirs && !replay) {
      fork.merge({ keepChanges: true });
      restoreSelection(editor, selection);
      return;
    }
    fork.merge({ keepChanges: false });
    if (replay) replayOwnEdits(editor, replay.birth, replay.theirPage);
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
  at: { anchor: number; head: number };
} | null;

/** The fork can be longer than shared truth, so its absolute caret cannot cross the swap. */
function parkSelection(editor: LiveEditor): ParkedSelection {
  const view = (editor as unknown as { prosemirrorView?: EditorView }).prosemirrorView;
  if (!view || !(view.state.selection instanceof TextSelection)) return null;
  const relative = getRelativeSelection(bindingOf(editor), view.state);
  const { anchor, head } = view.state.selection;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.atStart(view.state.doc))
      .setMeta("addToHistory", false),
  );
  return { view, relative, at: { anchor, head } };
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
  // A dropped fork takes the items the relative position names with it, so
  // there is nothing to resolve against. The page it left behind says the same
  // as the page they were looking at, so where they were is where they were.
  const clamp = (at: number) => Math.max(0, Math.min(at, doc.content.size));
  const from = anchor ?? clamp(parked.at.anchor);
  const to = head ?? clamp(parked.at.head);
  parked.view.dispatch(
    parked.view.state.tr
      .setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to)))
      .setMeta("addToHistory", false),
  );
}

function bindingOf(editor: LiveEditor): ProsemirrorBinding {
  return (ySyncPluginKey.getState(editor.prosemirrorState) as {
    binding: ProsemirrorBinding;
  }).binding;
}
