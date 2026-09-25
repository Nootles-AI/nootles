import { createExtension, defaultBlockSpecs } from "@blocknote/core";
import { InputRule, inputRules } from "@handlewithcare/prosemirror-inputrules";
import type { Node as PMNode } from "prosemirror-model";
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";

/** An empty paragraph block — somewhere to write that nobody has written in. */
function isEmptyParagraph(node: PMNode | null | undefined): boolean {
  return (
    node?.type.name === "blockContainer" &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.content.size === 0
  );
}

/**
 * Puts the caret in the block directly below the divider whose block container
 * starts at `containerPos`, making that block if it is not an empty paragraph.
 *
 * "Below" is the divider's first child when it has any, else its next sibling:
 * the next block in reading order. Only an empty paragraph is reused — landing
 * at the start of a written line would splice whatever is typed next into it.
 */
export function caretBelowDivider(tr: Transaction, containerPos: number): Transaction {
  const container = tr.doc.nodeAt(containerPos);
  if (!container) return tr;
  const at =
    container.childCount > 1
      ? containerPos + 1 + container.child(0).nodeSize + 1
      : containerPos + container.nodeSize;

  if (!isEmptyParagraph(tr.doc.resolve(at).nodeAfter)) {
    const { blockContainer, paragraph } = tr.doc.type.schema.nodes;
    tr.insert(at, blockContainer.createAndFill(null, paragraph.create())!);
  }
  // Into the block container, then into its paragraph.
  return tr.setSelection(TextSelection.create(tr.doc, at + 2));
}

/**
 * `---` as the whole of a text block, Notion's way: the block becomes a divider
 * and the caret goes on below it. `state` already holds the third dash; the
 * dashes run from `start` to `end`.
 *
 * BlockNote's own rule converts the block and then puts the "text cursor" in
 * it, which for a block with no content is a node selection on the divider —
 * invisible here, and somewhere keystrokes do not land. It also fires on `---`
 * typed ahead of existing text and throws that text away; this one fires only
 * when the dashes are the whole block.
 */
export function dashesToDivider(
  state: EditorState,
  start: number,
  end: number,
): Transaction | null {
  const $start = state.doc.resolve(start);
  if (
    !$start.parent.type.isInGroup("blockContent") ||
    $start.node(-1).type.name !== "blockContainer" ||
    end !== $start.end()
  ) {
    return null;
  }
  const tr = state.tr.replaceWith(
    $start.before(),
    $start.after(),
    state.schema.nodes.divider.create(),
  );
  return caretBelowDivider(tr, $start.before(-1)).scrollIntoView();
}

/**
 * Typing while a divider is node-selected — after a click on it, or a
 * Backspace that stepped onto it from an empty line — writes on the line
 * below it. BlockNote drops every printable key on a node selection, with
 * nothing on screen to say so.
 */
export function typeBelowDivider(state: EditorState, text: string): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  if (selection.node.type.name !== "divider") return null;
  return caretBelowDivider(state.tr, selection.$from.before())
    .insertText(text)
    .scrollIntoView();
}

/**
 * BlockNote's divider, with its `---` rule replaced by {@link dashesToDivider}
 * and typing on a selected divider caught by {@link typeBelowDivider}.
 * Rendering, parsing and the block's place in the schema stay BlockNote's.
 */
export const dividerBlockSpec = {
  ...defaultBlockSpecs.divider,
  extensions: [
    createExtension({
      key: "nt-divider",
      prosemirrorPlugins: [
        inputRules({
          rules: [
            new InputRule(/^---$/, (state, _match, start, end) =>
              dashesToDivider(state, start, end),
            ),
          ],
        }),
        new Plugin({
          props: {
            handleKeyDown(view, event) {
              if (event.ctrlKey || event.metaKey || event.isComposing) return false;
              if (event.key.length !== 1) return false;
              const tr = typeBelowDivider(view.state, event.key);
              if (!tr) return false;
              view.dispatch(tr);
              event.preventDefault();
              return true;
            },
          },
        }),
      ],
      // Ahead of BlockNote's own guard, which swallows every printable key
      // while anything is node-selected.
      runsBefore: ["nodeSelectionKeyboard"],
    }),
  ],
};
