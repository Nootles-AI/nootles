import { getBlockInfoFromSelection } from "@blocknote/core";
import type { Extension, ExtensionFactoryInstance } from "@blocknote/core";

/**
 * The four block types whose whole point is the list they belong to. Converting
 * one away does not just restyle a block — it breaks the run in two, and every
 * item after the break starts counting again from 1.
 */
const LIST_ITEM_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
]);

/**
 * Returning `undefined` from a rule's `replace` leaves the typed characters
 * where they are, which is exactly what BlockNote's own declining rules do.
 */
function declineInsideListItems(extension: Extension): Extension {
  if (!extension.inputRules?.length) return extension;
  return {
    ...extension,
    inputRules: extension.inputRules.map((rule) => ({
      ...rule,
      replace: (props: Parameters<typeof rule.replace>[0]) =>
        LIST_ITEM_TYPES.has(
          getBlockInfoFromSelection(props.editor.prosemirrorState).blockNoteType,
        )
          ? undefined
          : rule.replace(props),
    })),
  };
}

/**
 * A block whose markdown prefixes may not convert a list item.
 *
 * BlockNote already refuses this in one direction: `- ` and `1. ` typed inside
 * a heading stay as literal text, because both rules read the block they fired
 * in and decline when it is a heading. The rules pointing the other way never
 * got the mirror of that check, so a prefix at the start of a list item ate the
 * item. Writing "# of attendees" as list item 2 of 5 left an `<h1>`, a list
 * broken in two, and items 3–5 renumbered from 1; `> ` and `" ` did the same
 * through quote. One undo did not give it back either: it restored the item
 * with the typed prefix still in it (NT-38).
 *
 * A block type someone chose outranks two characters they typed. The way to a
 * heading or a quote from a list item is still the slash menu, the block-type
 * dropdown, or ⌘⌥1–6 — asked for rather than stumbled into.
 *
 * Only the input rules change. Rendering, props, keyboard shortcuts and
 * everything else about the block stay BlockNote's.
 */
export function keepListItems<
  Spec extends { extensions?: (Extension | ExtensionFactoryInstance)[] },
>(spec: Spec): Spec {
  return {
    ...spec,
    extensions: spec.extensions?.map((extension) =>
      typeof extension === "function"
        ? (context) => declineInsideListItems(extension(context))
        : declineInsideListItems(extension),
    ),
  };
}

type Editor = Parameters<NonNullable<Extension["keyboardShortcuts"]>[string]>[0]["editor"];

/**
 * BlockNote's own Enter, whose first rule is "removes a level of nesting if the
 * block is empty & indented, while the selection is also empty & at the start
 * of the block" (`KeyboardShortcutsExtension`). Every condition it reads is
 * read here, because declining a key BlockNote turns out not to want lands on
 * ProseMirror's plain Enter instead of on the outdent.
 */
function blockNoteWillStepOut(editor: Editor, type: string): boolean {
  const state = editor.prosemirrorState;
  const info = getBlockInfoFromSelection(state);
  if (!info.isBlockContainer || info.blockNoteType !== type) return false;
  return (
    info.blockContent.node.childCount === 0 &&
    state.selection.anchor === state.selection.head &&
    state.selection.$anchor.parentOffset === 0 &&
    state.doc.resolve(info.bnBlock.beforePos).depth > 1
  );
}

/**
 * A list item that steps out of an empty item rather than ending the list where
 * it stands.
 *
 * BlockNote's Enter already outdents an empty indented block — that is the
 * first rule it tries, and it is why an empty paragraph or heading one level in
 * comes back out a level when you press Enter on it. The four list items never
 * reach that rule: each registers its own Enter, whose first branch turns an
 * empty item into a paragraph wherever it sits, and a block spec's keymap runs
 * ahead of the editor's.
 *
 * One level in, that paragraph is neither the way out nor anything anyone asked
 * for. The item becomes a paragraph still nested under its parent, so leaving a
 * two-deep list takes two Enters, and an empty item in the middle of a run
 * leaves a paragraph between its siblings — which breaks the run in two and
 * restarts the numbering after it, the same damage `keepListItems` exists to
 * prevent (NT-65).
 *
 * So the item's own Enter declines exactly the case BlockNote already answers,
 * and the answer is the one Shift+Tab gives: the item steps out one level and
 * stays the kind of item it is, carrying its children and adopting the siblings
 * below it. A top-level item has no level to step out to and never declines, so
 * BlockNote's paragraph remains the way out of a list.
 *
 * Nothing else moves: a non-empty item still splits, a selection that spans
 * characters is still BlockNote's, and every other shortcut is untouched.
 */
export function stepOutOfEmptyItems<
  Spec extends {
    config: { type: string };
    extensions?: (Extension | ExtensionFactoryInstance)[];
  },
>(spec: Spec): Spec {
  const deferWhenIndented = (extension: Extension): Extension => {
    const enter = extension.keyboardShortcuts?.Enter;
    if (!enter) return extension;
    return {
      ...extension,
      keyboardShortcuts: {
        ...extension.keyboardShortcuts,
        Enter: (context) =>
          blockNoteWillStepOut(context.editor, spec.config.type)
            ? false
            : enter(context),
      },
    };
  };
  return {
    ...spec,
    extensions: spec.extensions?.map((extension) =>
      typeof extension === "function"
        ? (context) => deferWhenIndented(extension(context))
        : deferWhenIndented(extension),
    ),
  };
}
