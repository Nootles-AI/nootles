import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Batch } from "@/convex/ai/operations";

/**
 * The suggestion plugin: at the caret it shows AT MOST ONE suggestion, either
 *  - a "ghost" — inline prose continuation (FIM), accepted by inserting text; or
 *  - an "action" — a hint chip for a structured edit (the planner's compiled op
 *    batch), accepted by applying the batch.
 * Decorations produce no PM steps, so suggestions are local-only and never sync;
 * accepting is what mutates the doc.
 *
 * The plugin renders and holds state; the React controllers drive it via the
 * set/clear helpers. Applying an action needs the BlockNote editor + Convex, so
 * it's delegated to a handler the action controller registers.
 */

export type Suggestion =
  | { kind: "ghost"; text: string; pos: number }
  | { kind: "action"; label: string; pos: number; batch: Batch }
  | null;

const META = "ab-suggestion";
export const ghostTextKey = new PluginKey<Suggestion>("ab-suggestion");

type ActionApply = (batch: Batch) => void;
let actionApplyHandler: ActionApply | null = null;
/** The action controller registers how an accepted action batch is applied+logged. */
export function setActionApplyHandler(fn: ActionApply | null) {
  actionApplyHandler = fn;
}

// Showing/clearing a suggestion is a meta-only transaction (no doc/selection
// change). This flag lets the two suggestion controllers ignore those so they
// don't mistake a suggestion appearing for a user edit and clear each other.
let suppressDepth = 0;
export function isSuggestionDispatch(): boolean {
  return suppressDepth > 0;
}
function metaDispatch(view: EditorView, value: Suggestion) {
  suppressDepth++;
  try {
    view.dispatch(view.state.tr.setMeta(META, value));
  } finally {
    suppressDepth--;
  }
}

function ghostWidget(text: string) {
  return () => {
    const span = document.createElement("span");
    span.className = "ab-ghost";
    span.textContent = text;
    return span;
  };
}

function chipWidget(label: string) {
  return () => {
    const span = document.createElement("span");
    span.className = "ab-action-chip";
    span.textContent = `⇥ ${label}`;
    return span;
  };
}

export function ghostTextPlugin(): Plugin<Suggestion> {
  return new Plugin<Suggestion>({
    key: ghostTextKey,
    state: {
      init: () => null,
      apply(tr, prev): Suggestion {
        const meta = tr.getMeta(META) as Suggestion | undefined;
        if (meta !== undefined) return meta; // explicit set/clear wins
        if (tr.docChanged) return null; // typing or accepting clears
        if (prev) {
          const sel = tr.selection;
          if (!sel.empty || sel.from !== prev.pos) return null; // caret moved away
        }
        return prev;
      },
    },
    props: {
      decorations(state): DecorationSet | null {
        const s = ghostTextKey.getState(state);
        if (!s) return null;
        const dom =
          s.kind === "ghost"
            ? s.text
              ? ghostWidget(s.text)
              : null
            : chipWidget(s.label);
        if (!dom) return null;
        const deco = Decoration.widget(s.pos, dom, {
          side: 1,
          ignoreSelection: true,
          key: `ab-sugg-${s.pos}-${s.kind === "ghost" ? s.text : s.label}`,
        });
        return DecorationSet.create(state.doc, [deco]);
      },
    },
  });
}

export function currentSuggestion(state: EditorState): Suggestion {
  return ghostTextKey.getState(state) ?? null;
}

export function hasSuggestion(state: EditorState): boolean {
  return !!ghostTextKey.getState(state);
}

export function hasGhost(state: EditorState): boolean {
  return ghostTextKey.getState(state)?.kind === "ghost";
}

/** Show inline prose ghost text at the caret (empty text clears it). */
export function setGhost(view: EditorView, text: string) {
  const pos = view.state.selection.from;
  metaDispatch(view, text ? { kind: "ghost", text, pos } : null);
}

/** Show an action hint chip at the caret, carrying its validated op batch. */
export function setAction(view: EditorView, label: string, batch: Batch) {
  const pos = view.state.selection.from;
  metaDispatch(view, { kind: "action", label, pos, batch });
}

export function clearSuggestion(view: EditorView) {
  if (!ghostTextKey.getState(view.state)) return;
  metaDispatch(view, null);
}

/** Accept whichever suggestion is showing. Returns false if there is none. */
export function acceptSuggestion(view: EditorView): boolean {
  const s = ghostTextKey.getState(view.state);
  if (!s) return false;
  if (s.kind === "ghost") {
    if (!s.text) return false;
    const tr = view.state.tr.insertText(s.text, s.pos);
    tr.setSelection(TextSelection.create(tr.doc, s.pos + s.text.length));
    tr.setMeta(META, null);
    view.dispatch(tr);
    return true;
  }
  // action: clear the chip, then hand the batch to the registered applier.
  clearSuggestion(view);
  actionApplyHandler?.(s.batch);
  return true;
}
