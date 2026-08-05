import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import { keyChip } from "./previewWidgets";

/**
 * First-touch hints, rendered in the document's own voice.
 *
 * A hint is faint text (or a key chip) sitting at the end of a named block —
 * no card, no scrim, nothing floating over the app. The plugin only paints;
 * showing, retiring and persistence are the hints coordinator's business.
 */

export type EditorHint = {
  /** The seeded block this hint sits in. */
  blockId: string;
  text?: string;
  /** A key to wear, in the same chip every other "press this" uses. */
  kbd?: string;
  /** Show only while the block has no text of its own. */
  onlyEmpty?: boolean;
};

const hintKey = new PluginKey<EditorHint[]>("nt-hint-text");

export function setEditorHints(view: EditorView, hints: EditorHint[]) {
  view.dispatch(view.state.tr.setMeta(hintKey, hints));
}

function hintWidget(hint: EditorHint) {
  return () => {
    const span = document.createElement("span");
    span.className = "nt-hint";
    if (hint.kbd) span.appendChild(keyChip(hint.kbd));
    if (hint.text) span.appendChild(document.createTextNode(hint.text));
    return span;
  };
}

function hintTextPlugin(): Plugin<EditorHint[]> {
  return new Plugin<EditorHint[]>({
    key: hintKey,
    state: {
      init: () => [],
      apply(tr, prev) {
        const meta = tr.getMeta(hintKey) as EditorHint[] | undefined;
        return meta ?? prev;
      },
    },
    props: {
      decorations(state): DecorationSet | null {
        const hints = hintKey.getState(state);
        if (!hints?.length) return null;

        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          const hint = hints.find((h) => h.blockId === node.attrs?.id);
          if (!hint) return;
          const content = node.firstChild;
          if (!content?.isTextblock) return false;
          if (hint.onlyEmpty && content.content.size > 0) return false;
          decos.push(
            Decoration.widget(pos + 2 + content.content.size, hintWidget(hint), {
              side: 1,
              ignoreSelection: true,
              key: `nt-hint-${hint.blockId}-${hint.kbd ?? ""}-${hint.text ?? ""}`,
            }),
          );
          return false;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },
  });
}

export const hintExtension = createExtension({
  key: "nt-hint-text",
  prosemirrorPlugins: [hintTextPlugin()],
});
