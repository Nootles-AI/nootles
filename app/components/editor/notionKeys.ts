import { createExtension, getBlockInfoFromSelection } from "@blocknote/core";
import type { Extension, ExtensionFactoryInstance } from "@blocknote/core";

type AnyEditor = Parameters<NonNullable<Extension["keyboardShortcuts"]>[string]>[0]["editor"];

/**
 * Notion's ⌘⌥ turn-into row, in its order. ⌘⌥8, code, is the code block's own
 * key (`codeBlockKeys`): its caret has to follow the words into CodeMirror.
 */
export const TURN_INTO = {
  "Mod-Alt-0": { type: "paragraph" },
  "Mod-Alt-1": { type: "heading", props: { level: 1 } },
  "Mod-Alt-2": { type: "heading", props: { level: 2 } },
  "Mod-Alt-3": { type: "heading", props: { level: 3 } },
  "Mod-Alt-4": { type: "checkListItem" },
  "Mod-Alt-5": { type: "bulletListItem" },
  "Mod-Alt-6": { type: "numberedListItem" },
  "Mod-Alt-7": { type: "toggleListItem" },
} as const;

type TurnIntoTarget = (typeof TURN_INTO)[keyof typeof TURN_INTO];

/**
 * Every block in play, retyped: the caret's, or each one a selection spans —
 * text dragged across blocks and a block selection alike, as Notion's do. Only
 * a block with text qualifies: an image or a diagram has nothing to turn, and
 * is passed over. One transaction, so one undo.
 */
export function turnInto(editor: AnyEditor, target: TurnIntoTarget): boolean {
  if (!editor.isEditable) return false;
  const blocks = (
    editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]
  ).filter((block) => editor.schema.blockSchema[block.type]?.content === "inline");
  if (!blocks.length) return false;
  const props = "props" in target ? target.props : {};
  editor.transact(() => {
    for (const block of blocks) editor.updateBlock(block, { type: target.type, props });
  });
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
 * an equation, so it is declined — as is one holding an equation, a mention or
 * a line break, which the plain source would silently lose.
 */
export function inlineEquation(editor: AnyEditor): boolean {
  if (!editor.isEditable) return false;
  const { selection, doc } = editor.prosemirrorState;
  if (selection.empty) {
    editor.insertInlineContent([{ type: "math", props: { latex: "" } }, " "]);
    return true;
  }
  const { $from, $to } = selection;
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return false;
  let textOnly = true;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isInline && !node.isText) textOnly = false;
  });
  if (!textOnly) return false;
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
  if (!editor.isEditable) return false;
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
 * The editor's Notion keys that BlockNote does not bind as Notion does: the
 * ⌘⌥0–7 turn-into row, ⌘↵, ⌘⇧X for strikethrough beside BlockNote's ⌘⇧S, ⌘⇧E
 * for an inline equation, and Enter at the start of a heading.
 *
 * BlockNote binds ⌘⌥0–6 itself, for the caret's block only and ⌘⌥4–6 as
 * Heading 4–6; the paragraph and heading specs give them up in the schema, and
 * `#### ` still makes a Heading 4.
 */
export const notionKeysExtension = createExtension({
  key: "nt-notion-keys",
  keyboardShortcuts: {
    ...Object.fromEntries(
      Object.entries(TURN_INTO).map(([key, target]) => [
        key,
        ({ editor }: { editor: AnyEditor }) => turnInto(editor, target),
      ]),
    ),
    "Mod-Enter": ({ editor }) => toggleAtCaret(editor),
    "Mod-Shift-x": ({ editor }) => {
      if (!editor.isEditable) return false;
      editor.toggleStyles({ strike: true });
      return true;
    },
    "Mod-Shift-e": ({ editor }) => inlineEquation(editor),
    Enter: ({ editor }) => textAboveHeading(editor),
  },
});
