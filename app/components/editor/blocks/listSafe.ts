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
