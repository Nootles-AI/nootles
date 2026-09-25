import { createExtension } from "@blocknote/core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { ReplaceStep, type Step } from "prosemirror-transform";
import {
  getRelativeSelection,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  type ProsemirrorBinding,
} from "y-prosemirror";

/**
 * What the document's undo steps are made of, read off the editor's own
 * transactions — the Yjs side only ever sees the doc diff, which cannot tell
 * a keystroke from an Enter.
 *
 * Yjs folds every tracked write that lands within 500ms of the previous one
 * into the same stack item, and someone working steadily never pauses that
 * long: half a minute of typing, Enters, list shortcuts and indents came back
 * as one ⌘Z. The editor keeps Notion's grain instead. A typing run —
 * characters in and out of one text block — is one step; anything that
 * reshapes a block (a split, a merge, a type change, an indent, a paste) is a
 * step of its own, closing the run before it and starting a fresh one after.
 * A markdown shortcut's conversion is such a step too, so the first ⌘Z after
 * `- ` gives back the literal dash rather than the empty line before it, and
 * so is anything put in a line that is not characters — a mention, an inline
 * equation — so ⌘Z takes back what the menu inserted, not the words before it.
 */

/** Whether this step only edits the characters of one text block. */
function typesIntoOneTextblock(step: Step, doc: ProseMirrorNode): boolean {
  if (!(step instanceof ReplaceStep)) return false;
  const { from, to, slice } = step;
  if (slice.openStart > 0 || slice.openEnd > 0) return false;
  let characters = true;
  slice.content.forEach((node) => {
    if (!node.isText) characters = false;
  });
  if (!characters) return false;
  const $from = doc.resolve(from);
  return $from.parent.isTextblock && $from.sameParent(doc.resolve(to));
}

/** Whether a transaction must stand as an undo step of its own. */
export function breaksTypingRun(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  const ui = tr.getMeta("uiEvent");
  if (ui === "paste" || ui === "drop" || ui === "cut") return true;
  return tr.steps.some((step, i) => !typesIntoOneTextblock(step, tr.docs[i]));
}

/**
 * A selection as the shared doc names it, which outlives the edits after it:
 * an undo re-renders the whole page, and absolute positions from before it
 * point at nothing in particular.
 */
export type RelativeSelection = ReturnType<typeof getRelativeSelection>;

function bindingOf(state: EditorState): ProsemirrorBinding | null {
  const sync = ySyncPluginKey.getState(state) as { binding?: ProsemirrorBinding } | undefined;
  return sync?.binding ?? null;
}

/** The selection now, while the shared doc still matches `state`. */
export function relativeSelection(state: EditorState): RelativeSelection | null {
  const binding = bindingOf(state);
  return binding ? getRelativeSelection(binding, state) : null;
}

/** Puts a remembered selection on `tr`; false when it no longer resolves. */
export function restoreSelection(
  tr: Transaction,
  state: EditorState,
  selection: RelativeSelection,
): boolean {
  const binding = bindingOf(state);
  if (!binding || selection.anchor === null || selection.head === null) return false;
  if (selection.type === "all") {
    tr.setSelection(new AllSelection(tr.doc));
    return true;
  }
  const size = tr.doc.content.size;
  const resolve = (pos: unknown) => {
    const at = relativePositionToAbsolutePosition(binding.doc, binding.type, pos, binding.mapping);
    return at !== null && at <= size ? at : null;
  };
  const anchor = resolve(selection.anchor);
  if (anchor === null) return false;
  if (selection.type === "node") {
    const node = tr.doc.nodeAt(anchor);
    if (!node || !NodeSelection.isSelectable(node)) return false;
    tr.setSelection(NodeSelection.create(tr.doc, anchor));
    return true;
  }
  const head = resolve(selection.head);
  if (head === null) return false;
  tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)));
  return true;
}

/** The last dispatch, as its undo step needs it. */
export type TextStep = {
  /** Whether it closes the typing run before it and opens a new one after. */
  boundary: boolean;
  /** The selection it started from — where undoing it puts the caret. */
  before: RelativeSelection | null;
  /** The {@link asOneStep} call it was made inside, if any. */
  group: number | null;
  /**
   * The editor appended a repair to a re-render from the shared doc, and the
   * sync plugin, which sits its own re-renders out, has not written it.
   */
  unwritten: boolean;
};

let groups = 0;
let group: number | null = null;

/**
 * Makes every edit `run` dispatches one undo step, whatever their shapes: an
 * accepted AI change lands op by op, and ⌘Z takes it back whole, as Notion
 * does, never leaving half of it on the page.
 */
export function asOneStep<T>(run: () => T): T {
  if (group !== null) return run();
  group = ++groups;
  try {
    return run();
  } finally {
    group = null;
  }
}

const idle = (): TextStep => ({ boundary: false, before: null, group, unwritten: false });

function isChangeOrigin(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return !!sync?.isChangeOrigin;
}

const textStepKey = new PluginKey<TextStep>("nt-text-step");

export function textStepOf(state: EditorState): TextStep | undefined {
  return textStepKey.getState(state);
}

export const textStepsPlugin = new Plugin<TextStep>({
  key: textStepKey,
  state: {
    init: () => idle(),
    apply: (tr, value, oldState) => {
      // A plugin's repair rides in the edit that caused it; it never
      // decides that edit's grain.
      const root = tr.getMeta("appendedTransaction") as Transaction | undefined;
      if (root) {
        return tr.docChanged && isChangeOrigin(root) ? { ...value, unwritten: true } : value;
      }
      // The page redrawn from the shared doc — a collaborator's edit, an
      // undo — is no one's edit here, and the doc it would be measured
      // against has already moved on.
      if (isChangeOrigin(tr)) return idle();
      // Off-history writes (a diagram's own store, a repair) are no one's
      // step and must not cut the run they land in the middle of.
      if (!tr.docChanged || tr.getMeta("addToHistory") === false) return idle();
      // Measured now, before the sync plugin's view writes this edit, so
      // the shared doc still matches the state it is measured against.
      return {
        boundary: breaksTypingRun(tr),
        before: relativeSelection(oldState),
        group,
        unwritten: false,
      };
    },
  },
  // The unwritten repair is written as soon as the redraw lets go of the
  // sync plugin, as nobody's history. Left for the next keystroke or caret
  // blink, it reached the doc as a fresh edit of the person's: the redo
  // stack emptied and a phantom step landed on their timeline.
  view: () => ({
    update: (view) => {
      if (!textStepKey.getState(view.state)?.unwritten) return;
      queueMicrotask(() => {
        if (view.isDestroyed || !textStepKey.getState(view.state)?.unwritten) return;
        view.dispatch(view.state.tr.setMeta("addToHistory", false));
      });
    },
  }),
});

export const textStepsExtension = createExtension({
  key: "ntTextSteps",
  prosemirrorPlugins: [textStepsPlugin],
});
