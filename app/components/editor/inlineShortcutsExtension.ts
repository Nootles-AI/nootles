import { createExtension } from "@blocknote/core";
import { closeHistory } from "prosemirror-history";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { closeTextStep } from "@/app/lib/history/textDomain";
import { inlineShortcut, LEAF, LOOKBEHIND } from "./inlineShortcuts";

/** Whichever history the doc keeps: its own Yjs step, or ProseMirror's. */
function endStep(view: EditorView) {
  if (!closeTextStep({ prosemirrorState: view.state })) {
    view.dispatch(closeHistory(view.state.tr));
  }
}

/**
 * Typography, `~strike~` and `$$equation$$`, as Notion replaces them while you
 * type — never inside inline code or a code block, where the characters are
 * the point.
 *
 * The typed character lands first, as its own write, and the replacement
 * follows as a step of its own, so ⌘Z straight after gives back exactly what
 * was typed — the escape hatch for someone who meant `->`. Both are ordinary
 * editor transactions, the same path every other edit takes to the document.
 */
export const inlineShortcutsExtension = createExtension({
  key: "nt-inline-shortcuts",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleTextInput(view, from, to, typed, deflt) {
          if (from !== to || view.composing) return false;
          const { state } = view;
          const $from = state.doc.resolve(from);
          const { parent } = $from;
          if (!parent.isTextblock || parent.type.spec.code) return false;
          const { code, strike } = state.schema.marks;
          if (code?.isInSet(state.storedMarks ?? $from.marks())) return false;

          const offset = $from.parentOffset;
          const before = parent.textBetween(Math.max(0, offset - LOOKBEHIND), offset, undefined, LEAF);
          const shortcut = inlineShortcut(before, typed);
          if (!shortcut) return false;
          const start = from + typed.length - shortcut.length;
          if (code && state.doc.rangeHasMark(start, from, code)) return false;
          const math = state.schema.nodes.math;
          if ((shortcut.kind === "strike" && !strike) || (shortcut.kind === "math" && !math)) {
            return false;
          }

          view.dispatch(deflt());
          const end = from + typed.length;
          // Something appended to that write moved the text; the literal stands.
          const literal = (before + typed).slice(-shortcut.length);
          if (view.state.doc.textBetween(start, end, undefined, LEAF) !== literal) return true;
          endStep(view);
          const tr = view.state.tr;
          if (shortcut.kind === "text") {
            tr.insertText(shortcut.text, start, end);
          } else if (shortcut.kind === "strike") {
            tr.delete(end - 1, end)
              .delete(start, start + 1)
              .addMark(start, end - 2, strike.create())
              .removeStoredMark(strike);
          } else {
            tr.replaceWith(start, end, math.create({ latex: shortcut.latex }));
          }
          view.dispatch(tr.scrollIntoView());
          endStep(view);
          return true;
        },
      },
    }),
  ],
});
