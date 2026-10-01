import { createExtension, type ExtensionOptions } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import { ySyncPluginKey } from "y-prosemirror";
import { NML_LIMITS } from "@/app/lib/nml/schema";
import { NML_LIST_TYPES } from "@/app/lib/nml/view/projection";

/**
 * Canonical NML holds four levels of blocks, and only list and toggle items
 * hold children there: a block nested under anything else is hoisted to that
 * block's own level. So a block's level is one more than the list and toggle
 * items above it, and no edit may take one past the limit — on a served page
 * the mirror would refuse it, and a legacy page holding one could never
 * migrate (NT-127).
 */
const MAX_DEPTH = NML_LIMITS.maxBlockDepth;

const KEY = "nt-depth-limit";
const pluginKey = new PluginKey(KEY);

/** Whether `container` is a list or toggle item, the only blocks NML lets hold children. */
export function holdsChildren(container: PMNode): boolean {
  return NML_LIST_TYPES.has(container.firstChild?.type.name ?? "");
}

function childGroup(container: PMNode): PMNode | null {
  return container.childCount > 1 && container.lastChild?.type.name === "blockGroup"
    ? container.lastChild
    : null;
}

/** The level of the block container that starts at `pos`. */
export function depthAt(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  let depth = 1;
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "blockContainer" && holdsChildren(node)) depth++;
  }
  return depth;
}

/** Whether `container` and everything under it fit when it sits at `depth`. */
export function fitsAt(container: PMNode, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const group = childGroup(container);
  if (!group) return true;
  const below = holdsChildren(container) ? depth + 1 : depth;
  let fits = true;
  group.forEach((child) => {
    fits &&= fitsAt(child, below);
  });
  return fits;
}

/** The level a container nested under `parent` takes, `parent` sitting at `depth`. */
export function depthUnder(parent: PMNode, depth: number): number {
  return holdsChildren(parent) ? depth + 1 : depth;
}

/**
 * Whether `container`, sitting at `depth`, may keep the blocks under it. A
 * list or toggle item may until the last level. Anything else may only while
 * the page is not served: canonical NML would hoist its children to its own
 * level, so on a served page the surface hoists them first (NT-128).
 */
function keepsChildren(container: PMNode, depth: number, hoistLeaves: boolean): boolean {
  return holdsChildren(container) ? depth < MAX_DEPTH : !hoistLeaves;
}

/** The outermost blocks holding children they may not keep. */
function misshapen(doc: PMNode, hoistLeaves: boolean): { pos: number; node: PMNode }[] {
  const found: { pos: number; node: PMNode }[] = [];
  const visit = (group: PMNode, start: number, depth: number) => {
    group.forEach((container, offset) => {
      const children = childGroup(container);
      if (!children) return;
      const pos = start + offset;
      if (!keepsChildren(container, depth, hoistLeaves)) {
        found.push({ pos, node: container });
        return;
      }
      visit(children, pos + 2 + container.firstChild!.nodeSize, depthUnder(container, depth));
    });
  };
  const root = doc.firstChild;
  if (root?.type.name === "blockGroup") visit(root, 1, 1);
  return found;
}

/**
 * `container` reshaped as canonical NML holds it. Past the last level it and
 * everything under it become siblings with no children, in document order. A
 * block that holds no children in NML is followed by its children instead,
 * each keeping the nesting it may.
 */
function reshape(container: PMNode, depth: number, hoistLeaves: boolean): PMNode[] {
  const content = container.firstChild!;
  const group = childGroup(container);
  if (!group) return [container];
  const flat = holdsChildren(container) && depth >= MAX_DEPTH;
  const children: PMNode[] = [];
  group.forEach((child) => {
    children.push(...(flat ? flatten(child) : reshape(child, depthUnder(container, depth), hoistLeaves)));
  });
  if (!flat && keepsChildren(container, depth, hoistLeaves)) {
    return [container.type.create(container.attrs, [content, group.type.create(group.attrs, children)], container.marks)];
  }
  return [container.type.create(container.attrs, content, container.marks), ...children];
}

/** `container` and every block under it, in document order, with no children. */
function flatten(container: PMNode): PMNode[] {
  const own = container.type.create(container.attrs, container.firstChild!, container.marks);
  const below: PMNode[] = [];
  childGroup(container)?.forEach((child) => below.push(...flatten(child)));
  return [own, ...below];
}

/** The block whose own content holds `pos`, and how far into it `pos` is. */
function locate(doc: PMNode, pos: number): { id: string; offset: number } | null {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name !== "blockContainer") continue;
    const start = $pos.before(d) + 1;
    return pos <= start + node.firstChild!.nodeSize ? { id: node.attrs.id as string, offset: pos - start } : null;
  }
  return null;
}

function find(doc: PMNode, { id, offset }: { id: string; offset: number }): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "blockContainer" && node.attrs.id === id) found = pos + 1 + offset;
    return true;
  });
  return found;
}

/**
 * Whether a step can change what nests under what. Typing inside one line
 * cannot, and is skipped, so the check never costs a keystroke.
 */
function reshapes(tr: Transaction): boolean {
  return tr.steps.some((step, index) => {
    if (step instanceof ReplaceAroundStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const doc = tr.docs[index];
    if (!doc.resolve(step.from).sameParent(doc.resolve(step.to))) return true;
    let blocks = false;
    step.slice.content.descendants((node) => {
      blocks ||= node.type.name === "blockContainer" || node.type.name === "blockGroup";
      return !blocks;
    });
    return blocks;
  });
}

/**
 * A remote edit — a collaborator's, the canonical mirror's projection, or an
 * undo replayed through Yjs — was made within the limit wherever it began.
 * Repairing it here too would have every client repair it at once, and the
 * copies would merge.
 */
function remote(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  // prosemirror-collab marks the steps it receives with `rebased`.
  return !!sync?.isChangeOrigin || tr.getMeta("rebased") !== undefined;
}

/**
 * Where the local edits landed in the final document. Only what they touched is
 * repaired: a legacy page may already hold deeper nesting from before the
 * limit, and an edit elsewhere on it must not rearrange that.
 */
function touched(transactions: readonly Transaction[], local: Set<Transaction>): [number, number][] {
  const maps = transactions.flatMap((tr) => tr.mapping.maps.map((map) => ({ map, local: local.has(tr) })));
  const ranges: [number, number][] = [];
  maps.forEach(({ map, local }, index) => {
    if (!local) return;
    map.forEach((_oldStart, _oldEnd, from, to) => {
      for (const later of maps.slice(index + 1)) {
        from = later.map.map(from, -1);
        to = later.map.map(to, 1);
      }
      ranges.push([from, to]);
    });
  });
  return ranges;
}

function repair(state: EditorState, ranges: [number, number][], hoistLeaves: boolean): Transaction | null {
  const found = misshapen(state.doc, hoistLeaves).filter(({ pos, node }) =>
    ranges.some(([from, to]) => from < pos + node.nodeSize && to > pos));
  if (!found.length) return null;
  const tr = state.tr;
  const selection = state.selection instanceof TextSelection ? state.selection : null;
  // Every block keeps its ID, so the caret follows its line wherever it went.
  const anchor = selection && locate(state.doc, selection.anchor);
  const head = selection && locate(state.doc, selection.head);
  // Last first, so an earlier block's position still holds when it is reached.
  for (const { pos, node } of found.reverse()) {
    tr.replaceWith(pos, pos + node.nodeSize, reshape(node, depthAt(state.doc, pos), hoistLeaves));
  }
  if (selection) {
    const to = (from: number, at: { id: string; offset: number } | null) =>
      (at && find(tr.doc, at)) ?? tr.mapping.map(from);
    tr.setSelection(TextSelection.create(tr.doc, to(selection.anchor, anchor), to(selection.head, head)));
  }
  return tr.setMeta(KEY, true);
}

/**
 * Brings anything an edit nested past the limit — a paste, a drop, a list
 * item made of a line holding children — back to the last level, in order,
 * inside the same dispatch, so the edit and its repair are one undo step. On a
 * served page it hoists what an edit left under a block NML gives no children
 * the same way: left for the mirror, the shape showed until the next
 * projection flattened it, and that untracked projection let a later ⌘Z bring
 * the block back twice (NT-128). Tab never gets this far: it declines a run
 * that would not fit (`indent.ts`).
 */
export function depthLimitPlugin(enabled: () => boolean, hoistLeaves: () => boolean = () => false): Plugin {
  return new Plugin({
    key: pluginKey,
    hoistLeaves,
    appendTransaction: (transactions, _oldState, newState) => {
      if (!enabled()) return null;
      const local = new Set(transactions.filter((tr) => tr.docChanged && !remote(tr) && reshapes(tr)));
      return local.size ? repair(newState, touched(transactions, local), hoistLeaves()) : null;
    },
  });
}

/** Whether a block that holds no children in NML may take them here. */
export function leavesTakeChildren(state: EditorState): boolean {
  const plugin = pluginKey.get(state);
  return !(plugin?.spec.hoistLeaves as (() => boolean) | undefined)?.();
}

type Options = {
  /** Viewers must never repair a document they are not allowed to write. */
  enabled: () => boolean;
  /** The page is served from canonical NML, where only list and toggle items hold children. */
  served?: () => boolean;
};

export const depthLimitExtension = createExtension(
  ({ options }: ExtensionOptions<Options>) => ({
    key: KEY,
    prosemirrorPlugins: [depthLimitPlugin(() => options.enabled(), () => options.served?.() ?? false)],
  }),
);
