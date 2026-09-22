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
  dropTrackedPositions(editor);
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
  followBinding(editor);
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
  const merge = (keepChanges: boolean) => {
    fork.merge({ keepChanges });
    followBinding(editor);
  };
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
      merge(true);
      restoreSelection(editor, selection);
      return;
    }
    merge(false);
    if (replay) replayOwnEdits(editor, replay.birth, replay.theirPage);
    restoreSelection(editor, selection);
    return;
  }
  // BlockNote's `keepChanges` merge with the landing done here, so that it
  // carries an origin: the same update, onto the same doc, after the same swap.
  merge(false);
  const shared = boundDoc(editor);
  Y.applyUpdate(shared, Y.encodeStateAsUpdate(forked, Y.encodeStateVector(shared)), KEPT_CHANGE);
  restoreSelection(editor, selection);
}

/**
 * The doc the editor is bound to now — the fork's while it is forked. Read off
 * the binding, which follows the swap; the sync state's own `type` does not
 * (see `followBinding`), and `fragmentOf` in history/textDomain.ts reads that
 * stale `type` on purpose, to stay wired to the shared doc throughout.
 */
export function boundDoc(editor: LiveEditor): Y.Doc {
  return bindingOf(editor).doc;
}

/**
 * Puts the sync state's `doc` back on the doc the editor now edits.
 *
 * A swap replaces the ySync plugin with one bound to the other doc, but
 * ProseMirror carries a plugin's state field across a reconfigure by key, so
 * the fields y-prosemirror fills in `init` — `type` and `doc` — keep naming
 * the doc the editor was bound to FIRST. The binding is fresh; those two are
 * not. Nootles reads the binding everywhere it asks that question itself, so
 * the staleness was invisible here — but y-prosemirror and BlockNote read the
 * state, and pair its `doc` with the binding's `type`.
 *
 * BlockNote's `yPositionMapping` is where that pairing bites: it mints a
 * relative position against `binding.type` and resolves it against
 * `state.doc`, and a relative position resolves only in the doc whose items it
 * names. Forked, those are two different docs, so EVERY tracked position came
 * back null — and BlockNote turns that into a throw from the suggestion menu's
 * `apply` and `decorations`, which runs inside `EditorView.dispatch`. Typing
 * `:` during a review therefore killed the transaction after the browser had
 * already put the character in the DOM: the editor kept accepting text it
 * never committed, and the block held only the words typed before it (NT-69).
 *
 * Only `doc` is corrected. `type` keeps naming the shared fragment, which is
 * the contract `boundDoc` and the text undo domain are written against.
 */
function followBinding(editor: LiveEditor) {
  const state = ySyncPluginKey.getState(editor.prosemirrorState) as {
    doc: Y.Doc;
    binding: ProsemirrorBinding;
  } | null;
  if (!state?.binding) return;
  // In place, as BlockNote's own fork writes the undo stack back: the swap has
  // already happened, and this is the state every transaction after it carries
  // forward. A transaction of our own here would land between the merge and
  // the selection it is holding for the person.
  state.doc = state.binding.doc;
}

/**
 * Closes anything holding a position across the fork.
 *
 * A relative position names the items of one doc. `followBinding` makes the
 * ones minted INSIDE a fork resolvable, but it can only run once `fork()` has
 * returned, and the swap dispatches on the way through — with `doc` and the
 * binding disagreeing, which is the state it exists to get out of. Measured: a
 * menu left open threw from in there, and the agent's whole turn failed with
 * it. Nothing could repair the way OUT either, whenever the fork is dropped:
 * its items go with it, so there is nothing left for a position to name.
 *
 * The only thing that holds one is BlockNote's suggestion menu — `/`, `@`, and
 * the emoji picker's `:` — which tracks where its query began. So a menu open
 * when the agent's edit arrives closes. It was offering to complete a query in
 * a page that has just been rewritten under it, and the honest end of that is
 * to close rather than to guess. The way back out is `parkSelection`, which
 * closes it a beat before the merge, for its own reasons.
 */
function dropTrackedPositions(editor: LiveEditor) {
  // Meta-only and read before `queryStartPos` is, so it lands even while the
  // menu holds a position that no longer resolves.
  (editor.getExtension("suggestionMenu") as { closeMenu?: () => void } | undefined)
    ?.closeMenu?.();
}

type ParkedSelection = {
  view: EditorView;
  relative: ReturnType<typeof getRelativeSelection>;
  at: { anchor: number; head: number };
} | null;

/**
 * The fork can be longer than shared truth, so its absolute caret cannot cross
 * the swap.
 *
 * This is also what closes an open suggestion menu on the way out, and it has
 * to keep doing so: the menu tracks where its query began, and no position
 * survives a fork being dropped (see `dropTrackedPositions`). Moving the caret
 * to the start takes it out of the query's block, which is one of the menu's
 * own reasons to close — and it happens HERE, a beat before the swap, while
 * that position still resolves. A menu can only be open on a collapsed text
 * selection, so the early return below cannot be the case that has one.
 */
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
