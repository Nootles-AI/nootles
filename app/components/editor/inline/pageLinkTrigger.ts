import { createExtension, SuggestionMenu } from "@blocknote/core";
import { Plugin, type EditorState } from "prosemirror-state";

/** Typed to link a page, as in Notion and every wiki before it. */
export const PAGE_LINK_TRIGGER = "[[";

/**
 * Whether a "[" typed at `from` completes a "[[" that should open the page
 * menu: after another "[" in running text, outside code of either kind, and
 * with no menu already open — a second menu would take the first one's place.
 */
export function opensPageLink(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  menuShown: boolean,
): boolean {
  if (text !== "[" || from !== to || menuShown) return false;
  const $from = state.doc.resolve(from);
  if ($from.parentOffset === 0 || $from.parent.type.spec.code) return false;
  const marks = state.storedMarks ?? $from.marks();
  if (marks.some((mark) => mark.type.spec.code)) return false;
  return state.doc.textBetween(from - 1, from) === "[";
}

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
          const menu = editor.getExtension(SuggestionMenu);
          if (!opensPageLink(view.state, from, to, text, !!menu?.shown())) return false;
          view.dispatch(view.state.tr.delete(from - 1, from));
          menu?.openSuggestionMenu(PAGE_LINK_TRIGGER, { deleteTriggerCharacter: true });
          return true;
        },
      },
    }),
  ],
}));
