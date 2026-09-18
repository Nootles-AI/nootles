import { createExtension, type ExtensionOptions } from "@blocknote/core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, type EditorState, type Transaction } from "prosemirror-state";

type Options = {
  /** Viewers must never repair a document they are not allowed to write. */
  enabled: () => boolean;
};

const KEY = "nt-trailing-paragraph";

/** A real empty paragraph, with no nested blocks beneath it. */
function isEmptyParagraph(node: ProseMirrorNode | null | undefined): boolean {
  return (
    node?.type.name === "blockContainer" &&
    node.childCount === 1 &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.content.size === 0
  );
}

function repair(state: EditorState, initial = false): Transaction | null {
  const root = state.doc.lastChild;
  if (isEmptyParagraph(root?.lastChild)) return null;

  const paragraph = state.schema.nodes.paragraph?.createAndFill();
  const block = paragraph
    ? state.schema.nodes.blockContainer?.createAndFill(undefined, paragraph)
    : null;
  if (!root || root.type.name !== "blockGroup" || !block) return null;

  const transaction = state.tr.insert(state.doc.content.size - 1, block);
  // Repairing an old document on open is infrastructure, not an undo step.
  // Repairs appended to a real edit remain in that edit's history event.
  if (initial) transaction.setMeta("addToHistory", false);
  return transaction.setMeta(KEY, true);
}

/**
 * Maintains the page's terminal writing row inside the same ProseMirror
 * dispatch as the edit that consumed, converted, moved, or deleted it.
 *
 * BlockNote's built-in trailing block is only a decoration. This extension
 * makes the paragraph document content, so it is synchronized by both the
 * legacy step pipeline and Yjs/NML compatibility mirror.
 */
export const trailingParagraphExtension = createExtension(
  ({ options }: ExtensionOptions<Options>) => ({
    key: KEY,
    prosemirrorPlugins: [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!options.enabled() || !transactions.some((tr) => tr.docChanged)) {
            return null;
          }
          return repair(newState);
        },
        view(view) {
          // Initial content constructs editor state rather than dispatching a
          // transaction, so appendTransaction has nothing to observe. Repair
          // once after all plugin views have mounted.
          queueMicrotask(() => {
            if (!options.enabled() || view.isDestroyed) return;
            const transaction = repair(view.state, true);
            if (transaction) view.dispatch(transaction);
          });
          return {};
        },
      }),
    ],
  }),
);
