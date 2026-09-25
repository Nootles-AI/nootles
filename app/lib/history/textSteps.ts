import { createExtension } from "@blocknote/core";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceStep, type Step } from "prosemirror-transform";

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
 * `- ` gives back the literal dash rather than the empty line before it.
 */

/** Whether this step only edits the characters of one text block. */
function typesIntoOneTextblock(step: Step, doc: ProseMirrorNode): boolean {
  if (!(step instanceof ReplaceStep)) return false;
  const { from, to, slice } = step;
  if (slice.openStart > 0 || slice.openEnd > 0) return false;
  let inline = true;
  slice.content.forEach((node) => {
    if (!node.isInline) inline = false;
  });
  if (!inline) return false;
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

/** The last dispatch, as its undo step needs it. */
export type TextStep = {
  /** Whether it closes the typing run before it and opens a new one after. */
  boundary: boolean;
};

const textStepKey = new PluginKey<TextStep>("nt-text-step");

export function textStepOf(state: EditorState): TextStep | undefined {
  return textStepKey.getState(state);
}

export const textStepsExtension = createExtension({
  key: "ntTextSteps",
  prosemirrorPlugins: [
    new Plugin<TextStep>({
      key: textStepKey,
      state: {
        init: () => ({ boundary: false }),
        // A plugin's repair rides in the edit that caused it; it never
        // decides that edit's grain.
        apply: (tr, value) =>
          tr.getMeta("appendedTransaction") ? value : { boundary: breaksTypingRun(tr) },
      },
    }),
  ],
});
