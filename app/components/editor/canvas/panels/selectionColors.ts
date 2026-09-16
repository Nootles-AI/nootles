/**
 * Selection colours — every distinct colour used across a selection's own
 * subtree, and the ops that rewrite one of them everywhere it appears.
 *
 * Pure: no React. `SelectionColorsSection.tsx` is the thin component that
 * renders this and turns a field edit into `run(recolorOps(...))` — one
 * `store.dispatch`, one undo entry, exactly like any other panel edit.
 *
 * A colour is found by `findColorTokens` (`controls/colorTokens.ts`) inside
 * a small, fixed list of style properties — never every custom property on a
 * node, which is what keeps a hidden-effect marker like `--nt-off-box-shadow`
 * (an internal "this effect is off but keep its value" flag, not a colour a
 * user picked) out of the list for free: it is never one of the properties
 * scanned in the first place.
 */

import { blocksToLabel, labelBlocks } from "../scene/label";
import { walk } from "../scene/types";
import type { NodeId, Scene, SceneNode, SceneOp, StylePatch } from "../scene/types";
import { findColorTokens, replaceColorTokens, type ColorToken } from "./controls/colorTokens";
import { formatColor, parseColor } from "./controls/color";

export interface SelectionColor {
  /** Grouping key: `var:--name` for a whole-value reference, else the
   *  canonical `formatColor(rgba)` of a literal. Recomputed from the live
   *  value every render, so it changes mid-drag — never use this as a React
   *  list key, or the row being edited remounts on its own edit. Use {@link id}. */
  key: string;
  /**
   * A React key that survives the value it names changing. The comma-joined
   * traversal positions of every token this entry currently groups — stable
   * across a pure recolour (same nodes, same properties, same slots, only the
   * text in them changes) because it is assigned from document structure, not
   * from any colour. It moves only when membership itself changes: two rows
   * coalescing because a drag made them equal, or one splitting apart — cases
   * where a fresh mount is the right call, not a bug.
   */
  id: string;
  /** The first authored spelling seen, in document order — what the field shows. */
  authored: string;
  /** Distinct (nodeId, property) uses; a gradient with two stops of one colour counts once per stop. */
  uses: number;
  bound: string | null;
}

export interface ColorUse {
  nodeId: NodeId;
  where: "style" | "label";
  prop: string;
  token: ColorToken;
}

/** Every property whose value might carry an authored colour. Fixed and
 *  short on purpose — this is the whole reason a `--nt-off-*` internal
 *  custom property is never a candidate. */
const STYLE_PROPS = [
  "background",
  "background-color",
  "background-image",
  "border",
  "border-color",
  "outline",
  "outline-color",
  "fill",
  "stroke",
  "color",
  "box-shadow",
  "text-decoration-color",
] as const;

/** A label run's own style carries at most these two colour properties. */
const LABEL_PROPS = ["color", "background-color"] as const;

const VAR_NAME = /^var\(\s*(--[A-Za-z0-9_-]+)/i;

/** The grouping key for one token's text, and the variable name when it is
 *  a whole `var()` reference — shared by `collectSelectionColors` (building
 *  the summary) and `recolorOps` (finding every token that key stands for). */
function keyOf(text: string): { key: string; bound: string | null } {
  const varName = VAR_NAME.exec(text)?.[1];
  if (varName) return { key: `var:${varName}`, bound: varName };
  const rgba = parseColor(text);
  return { key: rgba ? formatColor(rgba) : text, bound: null };
}

function forEachToken(nodes: readonly SceneNode[], visit: (use: ColorUse) => void): void {
  walk(nodes, (node) => {
    for (const prop of STYLE_PROPS) {
      const raw = node.style[prop];
      if (raw === undefined) continue;
      for (const token of findColorTokens(raw)) visit({ nodeId: node.id, where: "style", prop, token });
    }
    if (!node.label) return;
    for (const block of labelBlocks(node.label)) {
      for (const run of block.runs) {
        if (run.kind !== "text" || !run.marks.style) continue;
        for (const prop of LABEL_PROPS) {
          const raw = run.marks.style[prop];
          if (raw === undefined) continue;
          for (const token of findColorTokens(raw)) visit({ nodeId: node.id, where: "label", prop, token });
        }
      }
    }
  });
}

/** Distinct colours across `nodes` and every descendant, document order.
 *  `scene` is accepted for symmetry with every other reader in this package
 *  (and room for a future scene-level check, e.g. a diagram-wide default)
 *  but this implementation only ever walks the selection's own subtree. */
export function collectSelectionColors(scene: Scene, nodes: readonly SceneNode[]): SelectionColor[] {
  void scene;
  const order: string[] = [];
  const byKey = new Map<string, SelectionColor>();
  const membersByKey = new Map<string, number[]>();
  // Assigned purely by traversal order — `STYLE_PROPS`, the node walk, and a
  // label's own block/run order are all independent of what colour a slot
  // currently holds — so the same edit that changes a value never reassigns
  // this, and `id` below stays put while a drag runs through it.
  let position = 0;

  forEachToken(nodes, ({ token }) => {
    const slot = position++;
    const { key, bound } = keyOf(token.text);
    const existing = byKey.get(key);
    if (existing) {
      existing.uses++;
      membersByKey.get(key)!.push(slot);
      return;
    }
    byKey.set(key, { key, id: "", authored: token.text, uses: 1, bound });
    membersByKey.set(key, [slot]);
    order.push(key);
  });

  return order.map((key) => {
    const entry = byKey.get(key)!;
    entry.id = membersByKey.get(key)!.join(",");
    return entry;
  });
}

/**
 * Ops that replace every use of `key` with `value`: one `setStyle` per node
 * touched (only the properties that changed), one `setLabel` per label
 * touched (only when a run's own colour changed). Untouched declarations are
 * byte-identical — `replaceColorTokens` only rewrites the matched spans.
 * Empty when `key` is absent from the subtree.
 */
export function recolorOps(scene: Scene, nodes: readonly SceneNode[], key: string, value: string): SceneOp[] {
  void scene;
  const ops: SceneOp[] = [];

  walk(nodes, (node) => {
    const decls: StylePatch = {};
    for (const prop of STYLE_PROPS) {
      const raw = node.style[prop];
      if (raw === undefined) continue;
      const hits = findColorTokens(raw).filter((t) => keyOf(t.text).key === key);
      if (hits.length === 0) continue;
      const next = replaceColorTokens(raw, hits, () => value);
      if (next !== raw) decls[prop] = next;
    }
    if (Object.keys(decls).length > 0) {
      ops.push({ type: "setStyle", ids: [node.id], decls });
    }

    if (!node.label) return;
    let labelChanged = false;
    const blocks = labelBlocks(node.label).map((block) => ({
      ...block,
      runs: block.runs.map((run) => {
        if (run.kind !== "text" || !run.marks.style) return run;
        let runChanged = false;
        const style: Record<string, string> = { ...run.marks.style };
        for (const prop of LABEL_PROPS) {
          const raw = style[prop];
          if (raw === undefined) continue;
          const hits = findColorTokens(raw).filter((t) => keyOf(t.text).key === key);
          if (hits.length === 0) continue;
          const next = replaceColorTokens(raw, hits, () => value);
          if (next !== raw) {
            style[prop] = next;
            runChanged = true;
          }
        }
        if (!runChanged) return run;
        labelChanged = true;
        return { ...run, marks: { ...run.marks, style } };
      }),
    }));
    if (labelChanged) {
      ops.push({ type: "setLabel", id: node.id, label: blocksToLabel(blocks) });
    }
  });

  return ops;
}
