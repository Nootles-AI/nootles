import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Batch } from "@/convex/ai/operations";
import {
  ghostBlocksElement,
  ghostBlocksKey,
  previewElement,
  previewKey,
  renderInline,
  type GhostBlock,
  type Preview,
  type PreviewEdge,
  type PreviewNode,
} from "./previewWidgets";

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

export type { Preview, PreviewEdge, PreviewNode };

export type Suggestion =
  | {
      kind: "ghost";
      /** Plain text — this is what gets inserted on accept. */
      text: string;
      pos: number;
      streaming?: boolean;
      /**
       * The same completion with its inline markup intact, for rendering only.
       * Kept apart from `text` so accepting can never paste a literal `<code>`.
       */
      markup?: string;
    }
  | {
      kind: "action";
      /**
       * What the chip says, when there is something worth saying. Absent for a
       * completion we can only describe generically — there is no chip then, and
       * the tail or the preview is what shows it instead.
       */
      label?: string;
      pos: number;
      /**
       * Null while Tier 2 content is still being generated: the chip shows
       * immediately (so the suggestion feels instant) but Tab stays inert until
       * there is something real to apply.
       */
      batch: Batch | null;
      // When present (insertCode), render a faded preview of the block below the
      // line instead of just a chip.
      preview?: Preview;
      /**
       * Whole text blocks the completion adds after the current one. Blocks that
       * are only text get no preview chrome — they are drawn as the blocks they
       * will become, in the place they will land.
       */
      blocks?: GhostBlock[];
      /**
       * Prose the completion adds to the current block before opening the new
       * one. A suggestion that finishes "Here's a dia" into "…diagram of the
       * quadratic formula:" and then draws the diagram has to show BOTH halves,
       * or the preview looks like it appeared out of nowhere.
       */
      tail?: string;
    }
  | null;

const META = "ab-suggestion";
export const ghostTextKey = new PluginKey<Suggestion>("ab-suggestion");

// Tab pressed while content was still generating. Rather than do nothing (which
// reads as broken) we remember the intent and apply the moment the batch lands.
let armedAccept = false;

type ActionApply = (batch: Batch) => void;
let actionApplyHandler: ActionApply | null = null;
/** The action controller registers how an accepted action batch is applied+logged. */
export function setActionApplyHandler(fn: ActionApply | null) {
  actionApplyHandler = fn;
  // Teardown (page switch / unmount): drop any queued Tab. Leaving it set would
  // auto-apply the next page's first suggestion without the user asking.
  if (!fn) armedAccept = false;
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

/**
 * `live` = tokens are still arriving, so the cursor pulses. `head` = this is the
 * end of the suggestion; false when whole blocks follow below and the cursor
 * belongs at the end of those instead.
 */
function ghostWidget(source: string, live = false, head = true) {
  return () => {
    const span = document.createElement("span");
    span.className = "ab-ghost";
    renderInline(source, span);
    // The cursor marks the end of a suggestion, so it only belongs where there
    // is one. Whitespace-only and markup-only completions render no glyphs, and
    // the bar was left sitting in an empty block on its own.
    if (head && span.textContent?.trim()) {
      span.classList.add("ab-stream-head");
      if (live) span.classList.add("is-live");
    }
    return span;
  };
}

/** What the preview is, said in the head line the widget wears. */
function headOf(p: Preview): string {
  switch (p.kind) {
    case "code":
      return p.language;
    case "math":
      return "math";
    case "diagram":
      return `diagram (${p.nodes.length} shapes)`;
    case "table": {
      const cols = p.rows[0]?.length ?? 0;
      return `${p.rows.length - (p.header ? 1 : 0)}×${cols} table`;
    }
  }
}

function chipWidget(label: string, pending: boolean) {
  return () => {
    const span = document.createElement("span");
    span.className = pending ? "ab-action-chip is-pending" : "ab-action-chip";
    span.textContent = pending ? `${label}…` : `⇥ ${label}`;
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

        if (s.kind === "ghost") {
          if (!s.text.trim()) return null;
          return DecorationSet.create(state.doc, [
            Decoration.widget(s.pos, ghostWidget(s.markup ?? s.text, s.streaming), {
              side: 1,
              ignoreSelection: true,
              key: `ab-ghost-${s.pos}-${s.markup ?? s.text}-${s.streaming ? "s" : ""}`,
            }),
          ]);
        }

        const decos: Decoration[] = [];

        // The prose half of the completion, shown at the caret exactly like a
        // plain ghost — the block preview below is the other half of the same
        // suggestion, and Tab accepts them together.
        if (s.tail?.trim()) {
          // The cursor sits at the END of the suggestion, so the tail only
          // carries it when nothing is drawn below it.
          const head = !s.blocks?.length;
          decos.push(
            // The tail is the live edge while a block is still generating.
            Decoration.widget(s.pos, ghostWidget(s.tail, !s.batch, head), {
              side: 1,
              ignoreSelection: true,
              key: `ab-tail-${s.pos}-${s.tail}-${s.batch ? "r" : "s"}-${head ? "h" : ""}`,
            }),
          );
        }

        // Everything below the caret's line lands just after the current block,
        // which is exactly where accepting will put it.
        let after = s.pos;
        try {
          after = state.doc.resolve(s.pos).after();
        } catch {
          after = s.pos;
        }

        // With a preview, render a faded version of the real thing just below
        // the line — exactly where accepting will insert it.
        if (s.preview) {
          const p = s.preview;
          const label = `⇥ Tab to insert · ${headOf(p)}`;
          decos.push(
            Decoration.widget(after, () => previewElement(p, label), {
              side: 1,
              key: `ab-preview-${after}-${previewKey(p)}`,
            }),
          );
        } else if (s.blocks?.length) {
          const blocks = s.blocks;
          const live = !s.batch;
          decos.push(
            Decoration.widget(after, () => ghostBlocksElement(blocks, live), {
              side: 1,
              key: `ab-ghost-blocks-${after}-${live ? "s" : "r"}-${ghostBlocksKey(blocks)}`,
            }),
          );
        } else if (!s.tail && s.label) {
          // Only when there is nothing else to show, and only when it has
          // something to say. A chip next to streaming ghost text reads as two
          // competing suggestions rather than one, and a chip that can only
          // manage "Apply suggestion" is a control with no subject.
          const pending = s.batch === null;
          decos.push(
            Decoration.widget(s.pos, chipWidget(s.label, pending), {
              side: 1,
              ignoreSelection: true,
              key: `ab-chip-${s.pos}-${s.label}-${pending ? "p" : "r"}`,
            }),
          );
        }

        return DecorationSet.create(state.doc, decos);
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

/**
 * Show inline prose ghost text at the caret (empty text clears it).
 *
 * Both lanes share this single suggestion slot, and the action lane is much
 * slower (a diagram takes seconds). Without this guard a ghost completion
 * arriving mid-flight silently replaces an action chip or preview, which is why
 * previews appeared only sometimes. Actions win.
 */
export function setGhost(
  view: EditorView,
  text: string,
  streaming = false,
  markup?: string,
) {
  if (ghostTextKey.getState(view.state)?.kind === "action") return;
  const pos = view.state.selection.from;
  // Whitespace alone is not a suggestion; showing it would leave a bare caret.
  metaDispatch(
    view,
    text.trim() ? { kind: "ghost", text, pos, streaming, markup } : null,
  );
}

/** Show an action suggestion (chip, preview, or ghost blocks) with its batch. */
export function setAction(
  view: EditorView,
  action: Omit<Extract<Suggestion, { kind: "action" }>, "kind" | "pos">,
) {
  // The user already hit Tab while this was loading — honour it now rather than
  // making them press it again.
  if (action.batch && armedAccept) {
    armedAccept = false;
    if (ghostTextKey.getState(view.state)) metaDispatch(view, null);
    actionApplyHandler?.(action.batch);
    return;
  }
  metaDispatch(view, {
    kind: "action",
    pos: view.state.selection.from,
    ...action,
  });
}

export function clearSuggestion(view: EditorView) {
  armedAccept = false;
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
  // Content still generating: remember the Tab and apply as soon as it lands.
  // Consuming the key (true) matters — falling through would indent instead.
  if (!s.batch) {
    armedAccept = true;
    return true;
  }
  // action: clear the chip, then hand the batch to the registered applier.
  const batch = s.batch;
  clearSuggestion(view);
  actionApplyHandler?.(batch);
  return true;
}
