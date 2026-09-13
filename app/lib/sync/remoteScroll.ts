import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";

/**
 * Somebody else's edit never scrolls this person's page (NT-19).
 *
 * y-prosemirror renders every change that arrives from the doc as one
 * transaction, and asks it to scroll to the LOCAL selection whenever any part
 * of that selection still touches the window. So while a collaborator types —
 * or an agent's turn lands — a selection or caret being scrolled out of view
 * is pulled straight back the moment its last line reaches the edge, and a
 * selection whose head is below the fold drags the page down to it. Reading
 * past your own selection becomes impossible.
 *
 * A page someone is reading holds still. What the scroll bought — a caret
 * pushed off-screen by someone else's edit being followed — comes back the
 * moment the person types, since their own keystroke scrolls to the caret as
 * it always has.
 *
 * Undo and redo also reach the editor through the doc, but they are this
 * person's own action and keep the scroll they had.
 */

type SyncMeta = { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean };

/** Whether this transaction is the doc re-rendering a change nobody here made. */
export function arrivedFromDoc(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as SyncMeta | undefined;
  return !!meta?.isChangeOrigin && !meta.isUndoRedoOperation;
}

const key = new PluginKey<boolean>("nt-remote-scroll");

export const remoteScrollPlugin = new Plugin<boolean>({
  key,
  state: {
    init: () => false,
    // Only a transaction that asks to scroll changes the answer, so within one
    // dispatch the last to ask decides: a local append after a remote change
    // still scrolls.
    apply: (tr, fromDoc) => (tr.scrolledIntoView ? arrivedFromDoc(tr) : fromDoc),
  },
  props: {
    handleScrollToSelection: (view) => key.getState(view.state) ?? false,
  },
});

export const remoteScrollExtension = createExtension({
  key: "nt-remote-scroll",
  prosemirrorPlugins: [remoteScrollPlugin],
});
