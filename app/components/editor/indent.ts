import { createExtension, type Extension } from "@blocknote/core";
import { Fragment, NodeRange, Slice } from "prosemirror-model";
import type { Node as PMNode, NodeType } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorState, Selection, Transaction } from "prosemirror-state";
import { canJoin, liftTarget, ReplaceAroundStep } from "prosemirror-transform";
import { BlockRangeSelection } from "./blockSelection";

export type IndentDirection = "in" | "out";

/** A contiguous run of sibling blocks: before the first, after the last. */
type Run = { from: number; to: number };

/**
 * The blocks a selection touches, grouped into runs of adjacent siblings.
 *
 * A block is touched when the selection reaches its own content — not merely
 * a descendant's — so a caret in a nested item touches that item and never
 * its parent. Only the outermost touched blocks are kept: a child moves with
 * its parent, as it does when the parent is dragged.
 */
function touchedRuns(selection: Selection, doc: PMNode): Run[] {
  if (selection instanceof BlockRangeSelection) {
    const last = selection.positions.length - 1;
    if (last < 0) return [];
    return [
      {
        from: selection.positions[0],
        to: selection.positions[last] + selection.nodes[last].nodeSize,
      },
    ];
  }

  let { from, to } = selection;
  if (selection instanceof NodeSelection) {
    // A content-less block (a diagram, an album) is selected by its content node.
    from = to = selection.from + 1;
  } else if (from < to && selection.$to.parentOffset === 0) {
    // A selection that ends at the very start of a block never reached it —
    // what a triple-click leaves behind.
    to = selection.$to.before() - 1;
  }

  const roots: { pos: number; node: PMNode }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const content = node.firstChild;
    const start = pos + 1;
    const end = start + (content?.nodeSize ?? 0);
    if (start <= to && end >= from) {
      roots.push({ pos, node });
      return false;
    }
    return true;
  });

  const runs: Run[] = [];
  for (const { pos, node } of roots) {
    const previous = runs[runs.length - 1];
    if (previous && previous.to === pos) previous.to = pos + node.nodeSize;
    else runs.push({ from: pos, to: pos + node.nodeSize });
  }
  return runs;
}

/**
 * Nests a run under the block before it, joining that block's children if it
 * has any. BlockNote's `sinkItem`, handed the range instead of reading it off
 * the selection.
 */
function sink(tr: Transaction, range: NodeRange, item: NodeType, group: NodeType): boolean {
  if (range.startIndex === 0) return false;
  const before = range.parent.child(range.startIndex - 1);
  if (before.type !== item) return false;
  const nested = before.lastChild?.type === group;
  const inner = Fragment.from(nested ? item.create() : null);
  const slice = new Slice(
    Fragment.from(item.create(null, Fragment.from(group.create(null, inner)))),
    nested ? 3 : 1,
    0,
  );
  tr.step(
    new ReplaceAroundStep(
      range.start - (nested ? 3 : 1),
      range.end,
      range.start,
      range.end,
      slice,
      1,
      true,
    ),
  );
  return true;
}

/**
 * Lifts a run out to sit after its parent block; the siblings below it become
 * its last block's children, so nothing after it changes depth. BlockNote's
 * `liftToOuterList`, handed the range. A top-level run has nowhere to go.
 */
function lift(tr: Transaction, range: NodeRange, item: NodeType, group: NodeType): boolean {
  if (range.depth < 1 || range.$from.node(range.depth - 1).type !== item) return false;

  const end = range.end;
  const endOfGroup = range.$to.end(range.depth);
  if (end < endOfGroup) {
    const last = range.parent.child(range.endIndex - 1);
    const nested = last.lastChild?.type === group;
    tr.step(
      new ReplaceAroundStep(
        end - (nested ? 2 : 1),
        endOfGroup,
        end,
        endOfGroup,
        new Slice(Fragment.from(item.create(null, group.create())), nested ? 2 : 1, 0),
        nested ? 0 : 1,
        true,
      ),
    );
    range = new NodeRange(tr.doc.resolve(range.$from.pos), tr.doc.resolve(endOfGroup), range.depth);
  }

  const target = liftTarget(range);
  if (target == null) return false;
  tr.lift(range, target);

  const $after = tr.doc.resolve(tr.mapping.map(end, -1) - 1);
  if (canJoin(tr.doc, $after.pos) && $after.nodeBefore!.type === $after.nodeAfter!.type) {
    tr.join($after.pos);
  }
  return true;
}

/**
 * Tab and Shift+Tab over whatever the selection touches, the way Notion does
 * it: every run of touched siblings moves one level, and a run that cannot
 * (nothing above it to nest under, or already at the top) stays where it is.
 * The selection maps through the steps, so it is still there afterwards.
 *
 * Returns whether the document changed.
 */
export function indentSelection(tr: Transaction, direction: IndentDirection): boolean {
  const item = tr.doc.type.schema.nodes.blockContainer;
  const group = tr.doc.type.schema.nodes.blockGroup;
  if (!item || !group) return false;

  const runs = touchedRuns(tr.selection, tr.doc);
  let changed = false;
  // Last first, so a run's move never shifts one not yet taken; the mapping
  // still covers it, since a nest reaches back into the block before.
  for (let i = runs.length - 1; i >= 0; i--) {
    const from = tr.mapping.map(runs[i].from, 1);
    const to = tr.mapping.map(runs[i].to, -1);
    const $from = tr.doc.resolve(from);
    const range = new NodeRange($from, tr.doc.resolve(to), $from.depth);
    const moved = direction === "in" ? sink(tr, range, item, group) : lift(tr, range, item, group);
    changed ||= moved;
  }
  return changed;
}

/** Whether the selection sits wholly inside one table, where Tab moves between cells. */
function inTable(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "table") return $to.pos <= $from.end(depth);
  }
  return false;
}

type Editor = Parameters<NonNullable<Extension["keyboardShortcuts"]>[string]>[0]["editor"];

function press(direction: IndentDirection) {
  return ({ editor }: { editor: Editor }): boolean => {
    const view = editor.prosemirrorView;
    if (!view || !view.editable) return false;
    if (inTable(view.state)) return false;
    const tr = view.state.tr;
    if (indentSelection(tr, direction)) view.dispatch(tr.scrollIntoView());
    // Claimed even when nothing moved. Declining hands the key to the browser,
    // which moves focus out of the page — to the canvas toolbar, or up into the
    // title — and every key after it lands there.
    return true;
  };
}

/**
 * Tab and Shift+Tab indent and outdent, and never let focus out of the page.
 *
 * BlockNote's own handlers decline in three places, and each decline is a
 * focus jump: when the block cannot move (the first block, a first child, a
 * top-level Shift+Tab), and whenever a text selection is showing its
 * formatting toolbar — which is every multi-block selection. These handle
 * every case, so theirs is never reached.
 *
 * Runs after the completion extension, whose Tab accepts a showing
 * suggestion, and defers inside a table, whose Tab moves between cells.
 */
export const indentExtension = createExtension({
  key: "nt-indent",
  keyboardShortcuts: {
    Tab: press("in"),
    "Shift-Tab": press("out"),
  },
});
