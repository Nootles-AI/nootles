import { Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
} from "@codemirror/view";

/**
 * Inline ghost completion inside a code block, mirroring the document lane: the
 * suggestion is a widget decoration (so it produces no document change and never
 * syncs), and Tab turns it into real text.
 */

export const setCodeGhost = StateEffect.define<{ text: string; streaming: boolean } | null>();

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly block: boolean,
    /** Tokens still arriving — the head pulses rather than sitting steady. */
    readonly streaming = false,
    /** This widget ends the suggestion, so it carries the caret marker. */
    readonly head = false,
  ) {
    super();
  }
  eq(other: GhostWidget) {
    return (
      other.text === this.text &&
      other.block === this.block &&
      other.streaming === this.streaming &&
      other.head === this.head
    );
  }
  toDOM() {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = "nt-cm-ghost";
    // Set here rather than in the stylesheet: CodeMirror injects its own rules
    // for content children, which win over ours and collapse the indentation.
    el.style.whiteSpace = "pre";
    // Head only on the trailing widget, so there is exactly one caret marker.
    // It sits on an inner span — the cursor is its `::after` — so the Tab key
    // can land to the cursor's right once the stream settles.
    const text = document.createElement("span");
    text.textContent = this.text;
    el.appendChild(text);
    if (this.head) {
      text.classList.add("nt-stream-head");
      if (this.streaming) text.classList.add("is-live");
      else {
        const key = document.createElement("span");
        key.className = "nt-key";
        key.textContent = "Tab";
        el.appendChild(key);
      }
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define<{
  text: string;
  pos: number;
  streaming: boolean;
} | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCodeGhost)) {
        return e.value
          ? { ...e.value, pos: tr.state.selection.main.head }
          : null;
      }
    }
    // Any edit or cursor move invalidates it.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  // A completion usually spans several lines, and an inline widget can only
  // render one — the rest would be clipped off the right edge. So the first
  // line sits at the caret and the remainder becomes a block widget below it.
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const v = state.field(f);
      if (!v) return Decoration.none;
      const [first, ...rest] = v.text.split("\n");
      const decos = [];
      if (first) {
        decos.push(
          Decoration.widget({
            // Head goes on whichever widget ends the suggestion.
            widget: new GhostWidget(first, false, v.streaming, !rest.length),
            side: 1,
          }).range(v.pos),
        );
      }
      if (rest.length) {
        decos.push(
          Decoration.widget({
            widget: new GhostWidget(rest.join("\n"), true, v.streaming, true),
            side: 1,
            block: true,
          }).range(state.doc.lineAt(v.pos).to),
        );
      }
      return Decoration.set(decos, true);
    }),
});

export function currentCodeGhost(view: EditorView): string | null {
  return view.state.field(ghostField, false)?.text ?? null;
}

export function acceptCodeGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost?.text) return false;
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: ghost.text },
    selection: { anchor: pos + ghost.text.length },
    effects: setCodeGhost.of(null),
  });
  return true;
}

/** Tab accepts a showing ghost, otherwise falls through to normal indentation. */
export const codeGhostExtension = [
  ghostField,
  // Above indentWithTab, which also binds Tab.
  Prec.highest(
    keymap.of([
    {
      key: "Tab",
      run: (view) => acceptCodeGhost(view),
    },
    {
      key: "Escape",
      run: (view) => {
        if (!currentCodeGhost(view)) return false;
        view.dispatch({ effects: setCodeGhost.of(null) });
        return true;
      },
    },
    ]),
  ),
];
