import { createExtension, getBlockInfoFromSelection } from "@blocknote/core";
import type { Extension, ExtensionFactoryInstance } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";

type AnyEditor = Parameters<NonNullable<Extension["keyboardShortcuts"]>[string]>[0]["editor"];

/** The block types ⌘⌥4–8 turn the caret's block into, in Notion's order. */
export const TURN_INTO = {
  "Mod-Alt-4": "checkListItem",
  "Mod-Alt-5": "bulletListItem",
  "Mod-Alt-6": "numberedListItem",
  "Mod-Alt-7": "toggleListItem",
  "Mod-Alt-8": "codeBlock",
} as const;

type TurnIntoType = (typeof TURN_INTO)[keyof typeof TURN_INTO];

/** Hard breaks become newlines; inline atoms (math, chips, ticks) carry no text. */
function plainText(editor: AnyEditor): string {
  const info = getBlockInfoFromSelection(editor.prosemirrorState);
  if (!info.isBlockContainer) return "";
  const { node } = info.blockContent;
  return node.textBetween(0, node.content.size, "\n", (leaf: PMNode) =>
    leaf.type.name === "hardBreak" ? "\n" : "",
  );
}

/**
 * The caret's block, retyped — BlockNote's own ⌘⌥0–3 and ⌘⇧6–9 to the letter,
 * extended to the rest of Notion's row. Only a block with text qualifies, as
 * theirs: an image or a diagram has nothing to turn.
 *
 * A code block keeps the words as its code, since its content lives in a prop
 * rather than inline.
 */
export function turnInto(editor: AnyEditor, type: TurnIntoType): boolean {
  const { block } = editor.getTextCursorPosition();
  if (editor.schema.blockSchema[block.type]?.content !== "inline") return false;
  if (type === "codeBlock") {
    editor.updateBlock(block, { type, props: { code: plainText(editor) } });
  } else {
    editor.updateBlock(block, { type, props: {} });
  }
  return true;
}

function isToggle(block: { type: string; props: Record<string, unknown> }): boolean {
  return (
    block.type === "toggleListItem" ||
    (block.type === "heading" && block.props.isToggleable === true)
  );
}

/**
 * ⌘↵: ticks the to-dos in play, or opens / closes the toggle the caret is in.
 *
 * Several to-dos flip together, the way Notion's do: all ticked when any was
 * not, all unticked when every one was. One transaction, so one undo.
 *
 * Whether a toggle is open is not document state — BlockNote keeps it per
 * viewer, beside the block — so the key presses the block's own chevron: the
 * one path that opening a toggle has, whoever asks.
 */
export function toggleAtCaret(editor: AnyEditor): boolean {
  const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  const todos = blocks.filter((block) => block.type === "checkListItem");
  if (todos.length) {
    if (!editor.isEditable) return false;
    const checked = !todos.every((block) => block.props.checked === true);
    editor.transact(() => {
      for (const block of todos) editor.updateBlock(block, { props: { checked } });
    });
    return true;
  }
  if (blocks.length !== 1 || !isToggle(blocks[0])) return false;
  const chevron = editor.domElement?.querySelector<HTMLButtonElement>(
    `[data-node-type="blockContainer"][data-id="${CSS.escape(blocks[0].id)}"] .bn-toggle-button`,
  );
  chevron?.click();
  return !!chevron;
}

/**
 * ⌘⇧E. A selection becomes an inline equation whose source is the selected
 * text; a bare caret gets an empty one, exactly as the "Math equation" slash
 * item inserts it. A selection that leaves its line has no single place to put
 * an equation, so it is declined.
 */
export function inlineEquation(editor: AnyEditor): boolean {
  const { selection } = editor.prosemirrorState;
  if (selection.empty) {
    editor.insertInlineContent([{ type: "math", props: { latex: "" } }, " "]);
    return true;
  }
  const { $from, $to } = selection;
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return false;
  const latex = editor.getSelectedText();
  editor.insertInlineContent([{ type: "math", props: { latex } }], {
    updateSelection: true,
  });
  return true;
}

/**
 * Enter at the very start of a heading with words in it: Notion opens a text
 * line above and leaves the heading, and the caret, where they were.
 *
 * BlockNote splits there instead, and a split keeps the type on both halves —
 * an empty heading above, and the words carried into a new block below, under
 * a new id that any comment or AI edit anchored to the old one no longer finds.
 * Inserting above changes neither the heading nor its id; the caret maps past
 * the new line and stays put.
 */
export function textAboveHeading(editor: AnyEditor): boolean {
  const state = editor.prosemirrorState;
  const { selection } = state;
  if (!selection.empty || selection.$from.parentOffset !== 0) return false;
  const info = getBlockInfoFromSelection(state);
  if (!info.isBlockContainer || info.blockNoteType !== "heading") return false;
  if (info.blockContent.node.content.size === 0) return false;
  const { block } = editor.getTextCursorPosition();
  editor.insertBlocks([{ type: "paragraph" }], block, "before");
  return true;
}

/**
 * A block spec with some of its own shortcuts given up, so the editor's can
 * have the keys. Binding one again from outside would leave two keymaps at the
 * same priority racing for it, won by whichever registered first.
 */
export function withoutShortcuts<
  Spec extends { extensions?: (Extension | ExtensionFactoryInstance)[] },
>(spec: Spec, keys: readonly string[]): Spec {
  const drop = (extension: Extension): Extension =>
    extension.keyboardShortcuts
      ? {
          ...extension,
          keyboardShortcuts: Object.fromEntries(
            Object.entries(extension.keyboardShortcuts).filter(
              ([key]) => !keys.includes(key),
            ),
          ),
        }
      : extension;
  return {
    ...spec,
    extensions: spec.extensions?.map((extension) =>
      typeof extension === "function"
        ? (context) => drop(extension(context))
        : drop(extension),
    ),
  };
}

/**
 * The editor's Notion keys that BlockNote does not bind itself: the rest of
 * the ⌘⌥ turn-into row, ⌘↵, ⌘⇧X for strikethrough beside BlockNote's ⌘⇧S,
 * ⌘⇧E for an inline equation — and Enter at the start of a heading, where
 * BlockNote does answer, but not as Notion does.
 *
 * ⌘⌥4–6 were BlockNote's Heading 4–6; the heading spec gives them up in the
 * schema, and `#### ` still makes one.
 */
export const notionKeysExtension = createExtension({
  key: "nt-notion-keys",
  keyboardShortcuts: {
    ...Object.fromEntries(
      Object.entries(TURN_INTO).map(([key, type]) => [
        key,
        ({ editor }: { editor: AnyEditor }) => turnInto(editor, type),
      ]),
    ),
    "Mod-Enter": ({ editor }) => toggleAtCaret(editor),
    "Mod-Shift-x": ({ editor }) => {
      editor.toggleStyles({ strike: true });
      return true;
    },
    "Mod-Shift-e": ({ editor }) => inlineEquation(editor),
    Enter: ({ editor }) => textAboveHeading(editor),
  },
});
