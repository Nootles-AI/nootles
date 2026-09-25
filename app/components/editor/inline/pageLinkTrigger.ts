import { createExtension, SuggestionMenu } from "@blocknote/core";
import { Plugin } from "prosemirror-state";

/** Typed to link a page, as in Notion and every wiki before it. */
export const PAGE_LINK_TRIGGER = "[[";

/**
 * Opens the page menu on a second "[".
 *
 * BlockNote takes multi-character triggers, but its matcher compares the typed
 * character plus the TWO before it against the two-character trigger, so "[["
 * only ever opened at the very start of a line. This matches it anywhere, then
 * hands BlockNote the trigger through its own entry point, which re-types the
 * pair so its query tracking and cleanup work exactly as they do for "@".
 */
export const pageLinkTriggerExtension = createExtension(({ editor }) => ({
  key: "nt-page-link-trigger",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          const { $from } = view.state.selection;
          if (
            text !== "[" ||
            from !== to ||
            $from.parentOffset === 0 ||
            $from.parent.type.spec.code ||
            view.state.doc.textBetween(from - 1, from) !== "["
          ) {
            return false;
          }
          view.dispatch(view.state.tr.delete(from - 1, from));
          editor.getExtension(SuggestionMenu)?.openSuggestionMenu(PAGE_LINK_TRIGGER, {
            deleteTriggerCharacter: true,
          });
          return true;
        },
      },
    }),
  ],
}));
