import { createExtension } from "@blocknote/core";
import type { Extension, ExtensionFactoryInstance } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceStep } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";

/** The attribute a nested numbered item's marker is read from (`editor.css`). */
export const MARKER_ATTR = "data-nt-marker";

/** a, b … z, aa, ab — bijective base 26, as CSS's `lower-alpha` counts. */
function alpha(n: number): string {
  let out = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  }
  return out;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function roman(n: number): string {
  let out = "";
  for (const [value, numeral] of ROMAN) {
    for (; n >= value; n -= value) out += numeral;
  }
  return out;
}

/**
 * What a numbered item shows at a nesting depth: 1. at the top, a. inside that,
 * i. inside that, then 1. again — Notion's cycle. `null` where BlockNote's own
 * decimal marker already says it.
 */
export function numberedMarker(index: number, depth: number): string | null {
  const level = depth % 3;
  return level === 1 ? alpha(index) : level === 2 ? roman(index) : null;
}

/**
 * Markers for every nested numbered item under the block group whose content
 * starts at `start`.
 *
 * Counting is BlockNote's, restated: an item continues the run of numbered
 * siblings right before it, and a run starts at its first item's `start`, or 1.
 * Depth counts numbered ancestors only — a list inside a bullet or a toggle is
 * a list of its own, not a sub-list.
 */
function markGroup(group: Node, start: number, depth: number, out: Decoration[]) {
  let run = 0;
  group.forEach((container, offset) => {
    const pos = start + offset;
    const content = container.firstChild!;
    const numbered = content.type.name === "numberedListItem";
    run = !numbered ? 0 : run ? run + 1 : Number(content.attrs.start) || 1;
    const marker = numbered ? numberedMarker(run, depth) : null;
    if (marker) {
      out.push(
        Decoration.node(pos + 1, pos + 1 + content.nodeSize, { [MARKER_ATTR]: marker }),
      );
    }
    const children = container.childCount > 1 ? container.child(1) : null;
    if (children) {
      markGroup(children, pos + 2 + content.nodeSize, depth + (numbered ? 1 : 0), out);
    }
  });
}

/**
 * Markers for the top-level blocks overlapping `from`–`to`. A marker depends
 * on its siblings and its ancestors, and both live inside the one top-level
 * block, so a change is answered by redrawing the top-level blocks it touched.
 */
export function markersBetween(doc: Node, from: number, to: number): Decoration[] {
  const out: Decoration[] = [];
  const root = doc.firstChild;
  if (!root) return out;
  root.forEach((container, offset) => {
    const pos = 1 + offset;
    if (pos > to || pos + container.nodeSize < from) return;
    const content = container.firstChild!;
    if (container.childCount > 1) {
      const numbered = content.type.name === "numberedListItem";
      markGroup(container.child(1), pos + 2 + content.nodeSize, numbered ? 1 : 0, out);
    }
  });
  return out;
}

/** The top-level block(s) a changed range sits in, widened to their edges. */
function topLevelSpan(doc: Node, from: number, to: number): [number, number] {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  return [
    $from.depth >= 2 ? $from.before(2) : from,
    $to.depth >= 2 ? $to.after(2) : to,
  ];
}

/**
 * Whether every step only edits words inside one line: typing, marks, an
 * inline paste. Those leave every marker as it was, so a keystroke stays O(1).
 * A deletion across two items does not qualify even though it ends inside one
 * line — the step started in another.
 */
function wordsOnly(tr: Transaction): boolean {
  return tr.steps.every((step, i) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const $from = tr.docs[i].resolve(step.from);
    const { slice } = step;
    return (
      $from.parent.isTextblock &&
      $from.sameParent(tr.docs[i].resolve(step.to)) &&
      slice.openStart === 0 &&
      slice.openEnd === 0 &&
      slice.content.content.every((node) => node.isInline)
    );
  });
}

/**
 * Where a transaction changed the document, in its final positions. An
 * attribute step maps nothing, so `changedRange` does not see it — and a
 * props-only `updateBlock`, a list's `start` included, is made of those.
 */
function changedSpan(tr: Transaction): { from: number; to: number } | null {
  let span = tr.changedRange();
  tr.steps.forEach((step, i) => {
    if (!(step instanceof AttrStep)) return;
    const pos = tr.mapping.slice(i + 1).map(step.pos);
    span = span
      ? { from: Math.min(span.from, pos), to: Math.max(span.to, pos) }
      : { from: pos, to: pos };
  });
  return span;
}

export function nextMarkers(tr: Transaction, previous: DecorationSet): DecorationSet {
  const mapped = previous.map(tr.mapping, tr.doc);
  const changed = changedSpan(tr);
  if (!changed || wordsOnly(tr)) return mapped;
  const [from, to] = topLevelSpan(tr.doc, changed.from, changed.to);
  return mapped
    .remove(mapped.find(from, to))
    .add(tr.doc, markersBetween(tr.doc, from, to));
}

const key = new PluginKey<DecorationSet>("nt-list-markers");

export const markersPlugin = () =>
  new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) =>
        DecorationSet.create(state.doc, markersBetween(state.doc, 0, state.doc.content.size)),
      apply: (tr, previous) => (tr.docChanged ? nextMarkers(tr, previous) : previous),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });

/**
 * A numbered list item whose nested levels count a. b. c. and then i. ii. iii.,
 * the way Notion's do, instead of 1. 2. 3. at every depth.
 *
 * BlockNote draws the marker from `data-index`, a plain string CSS can only
 * print as it stands; the letters and numerals have to be written out. They
 * are decorations, so the document is untouched and every reader of it — the
 * AI projection included — still sees an ordered list with its numbers.
 */
export function markersByDepth<
  Spec extends { extensions?: (Extension | ExtensionFactoryInstance)[] },
>(spec: Spec): Spec {
  return {
    ...spec,
    extensions: [
      ...(spec.extensions ?? []),
      // A factory, so every editor gets a plugin of its own.
      createExtension(() => ({
        key: "nt-list-markers",
        prosemirrorPlugins: [markersPlugin()],
      }))(),
    ],
  };
}
