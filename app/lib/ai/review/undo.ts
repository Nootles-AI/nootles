import type { PartialBlock } from "@blocknote/core";
import type { Transaction } from "prosemirror-state";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { settleDiagrams } from "@/app/components/editor/canvas/collab/binding";
import { endTextHistory } from "@/app/lib/history/textDomain";
import type { AnyBlock } from "../projection";
import { asReview } from "./attribution";
import { takeBackDiagram } from "./diagram";
import { boundDoc, isForked } from "./fork";
import type { Change } from "./hunks";

/**
 * Taking back a hunk where it stands.
 *
 * Review is asynchronous by design — the change sits on the page and the user
 * reads it — so by the time an answer comes the page is rarely the page the
 * checkpoint was taken from. They have been typing; another turn may have
 * written elsewhere on it. Restoring the snapshot would take all of that with
 * it, silently and with no undo record spanning it.
 *
 * So only what the hunk itself did is undone: what it wrote goes, what it
 * rewrote goes back to what the checkpoint says, and whatever it took out of
 * place — deleted, or lifted out of something it deleted — goes back where the
 * checkpoint had it, subtree and all. Everything else on the page is left
 * exactly as it is, which is also what makes the result independent of the
 * order hunks are answered in — no hunk speaks for a block outside it, because
 * rule 2 puts every op on a block into the same hunk.
 *
 * The checkpoint, not the trace, is the authority on how a deleted block stood.
 * The trace read it as the op ran, which is after the same batch had already
 * carried its children elsewhere — put back from there, a retyped list comes
 * back empty and its items are stranded at the top level.
 *
 * One block is not answered at block grain: a diagram, whose prop is a whole
 * mirror of maps the page keeps per shape. Writing the checkpoint's prop back
 * there took the shapes the person moved while they were reading with it, so
 * the change's own write is taken back shape by shape instead (`./diagram.ts`).
 */

// The applier's loose handle; see app/lib/ai/apply.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPartialBlock = PartialBlock<any, any, any>;

export type Seat = {
  index: number;
  siblings: string[];
  at: number;
  ancestors: string[];
};

export function undoHunks(
  editor: LiveEditor,
  hunks: Change[],
  before: AnyBlock[],
  /** What the change wrote onto a block's props, for the ones it rewrote whole. */
  proposed: ReadonlyMap<string, Record<string, unknown>> = new Map(),
) {
  const place = seats(before);
  const was = new Map(descend(before).map((b) => [b.id, b]));
  const present = (id: string) => !!editor.getBlock(id);

  // A diagram's prop is a mirror that trails its maps, and the undo below is
  // about to read it as what the page now says. Settling brings each one level
  // with the maps first, so a shape moved seconds ago is part of "now" rather
  // than of the write that takes the change back. Asked only of a forked
  // editor, which is the only place a review's diagram has maps behind it: on
  // the legacy pipeline the prop IS the document and there is nothing to level.
  if (
    isForked(editor) &&
    hunks.some((h) => h.changed.some((id) => was.get(id)?.type === "canvas"))
  ) {
    settleDiagrams(boundDoc(editor));
  }

  const added = new Set(hunks.flatMap((h) => h.added));
  // Blocks the change took out of the place the checkpoint had them. Only ones
  // the checkpoint knows: a block this turn both wrote and deleted has nowhere
  // to go back to, and `added` is already taking it away.
  const displaced = new Set(
    [
      ...hunks.flatMap((h) => h.removed.map((b) => b.id)),
      ...hunks.flatMap((h) => h.moved),
    ].filter((id) => was.has(id)),
  );
  // Outermost only, and in the order the checkpoint had them: restoring a block
  // restores its subtree, and a run that went together comes back together —
  // each one anchors on the one restored before it.
  const roots = [...displaced]
    .filter((id) => !(place.get(id)?.ancestors ?? []).some((a) => displaced.has(a)))
    .sort((a, b) => (place.get(a)?.index ?? 0) - (place.get(b)?.index ?? 0));

  // A root still waiting to be put back is on the page but in the place the
  // change moved it to, so it cannot say where anything belongs — anchoring to
  // it would restore a block relative to the very displacement being undone,
  // and two blocks that swapped would come back exactly as they are. It becomes
  // an anchor the moment it is home.
  const pending = new Set(roots);
  const settled = (id: string) => present(id) && !pending.has(id);
  const where: Where = { present: settled, last: () => lastBlock(editor, settled) };

  // One transaction, kept out of the history. Undo belongs to the person
  // typing; a review answering itself into their undo stack means Cmd-Z brings
  // back a change they just discarded, and again, and again.
  asReview(() =>
    editor.transact((tr) => {
      tr.setMeta("addToHistory", false);

      for (const id of hunks.flatMap((h) => h.changed)) {
        const original = was.get(id);
        if (!original || !present(id)) continue;
        editor.updateBlock(id, {
          type: original.type,
          props: propsFor(editor, id, original, proposed.get(id)),
          ...(original.content !== undefined ? { content: original.content } : {}),
        } as AnyPartialBlock);
      }

      // Put back before taking away: a change that replaced everything on the
      // page leaves nothing to anchor against once its own blocks are gone.
      let orphan: string | null = null;
      for (const id of roots) {
        const block = was.get(id)!;
        // Whatever of its subtree is still standing elsewhere comes out first:
        // it is about to be restored under this block, and one id on two blocks
        // is exactly what the dialect cannot address.
        for (const inner of descend([block])) {
          if (present(inner.id)) editor.removeBlocks([inner.id]);
        }
        let anchor = anchorFor(id, place, where);
        if (!anchor) {
          orphan ??= nameEmptyBlock(tr);
          anchor = orphan ? { ref: orphan, placement: "after" } : null;
        }
        if (anchor) put(editor, block, anchor);
        pending.delete(id);
      }

      for (const id of added) {
        const block = editor.getBlock(id) as AnyBlock | undefined;
        if (!block) continue;
        // A block the user nested under the change is theirs. It takes the
        // place of the one being removed rather than going with it.
        const theirs = foreign(block, added);
        if (theirs.length) {
          editor.removeBlocks(theirs.map((b) => b.id));
          editor.insertBlocks(theirs as AnyPartialBlock[], id, "after");
        }
        editor.removeBlocks([id]);
      }

      if (orphan && present(orphan) && editor.document.length > 1) {
        editor.removeBlocks([orphan]);
      }
    }),
  );
}

/**
 * The props to write back onto a block the change rewrote.
 *
 * The checkpoint's, except where the block is a diagram: there the prop is one
 * whole-HTML mirror of maps the page keeps per shape, and writing the
 * checkpoint's back takes the shapes the person moved while they were reading
 * with it (NT-70). What the change itself did to that diagram is taken back
 * instead, shape by shape — see `takeBackDiagram`. Without the change's own
 * write to compare against there is nothing to be that precise with, and the
 * checkpoint's prop is still the honest answer.
 */
function propsFor(
  editor: LiveEditor,
  id: string,
  original: AnyBlock,
  proposal: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = original.props as Record<string, unknown>;
  const asked = proposal?.data;
  const live = (editor.getBlock(id)?.props as { data?: unknown } | undefined)?.data;
  if (
    original.type !== "canvas" ||
    typeof props.data !== "string" ||
    typeof asked !== "string" ||
    typeof live !== "string"
  ) {
    return props;
  }
  return { ...props, data: takeBackDiagram(props.data, asked, live) };
}

/**
 * Restores the page to the checkpoint wholesale, manual edits and all.
 *
 * Off the history, so where the write reaches the shared doc it is the end of
 * that history: ⌘Z of a kept change over this rewrite garbles the page (NT-44).
 * A forked page's write lands in the fork, which the shared doc never hears.
 */
export function restoreDocument(editor: LiveEditor, before: AnyBlock[]) {
  const shared = !isForked(editor);
  asReview(() =>
    editor.transact((tr) => {
      tr.setMeta("addToHistory", false);
      // `replaceBlocks` names what it removes, and a page the turn emptied is
      // holding a paragraph with no name.
      const held = editor.document
        .map((block) => block.id as string)
        .filter((id) => editor.getBlock(id));
      const named = held.length ? held : [nameEmptyBlock(tr)].filter((id) => id !== null);
      if (named.length) editor.replaceBlocks(named, before as AnyPartialBlock[]);
    }),
  );
  if (!shared) return;
  // Its diagrams' maps hear the rewrite now, not a render later — when a shared
  // doc's canvas would take the checkpoint's diagram, a state its maps have
  // already been in, for a collaborator's lagging mirror and keep the newer one.
  settleDiagrams(boundDoc(editor));
  endTextHistory(editor);
}

/**
 * Writes onto the page what the person themselves wrote inside a fork that is
 * not going to land.
 *
 * A fork holding their words was landed for them, and one `Y.applyUpdate`
 * carries a whole fork: the discard's own churn — `undoHunks` above, rewriting
 * what the change touched — travelled with their words and replaced the very
 * items their undo entries name. Yjs pops a dead entry silently and undoes an
 * older live one instead, so ⌘Z took the whole paragraph holding their last
 * words (NT-68; NT-45 is the same failure for a fork with nothing of theirs in
 * it, which is dropped rather than landed). Nothing at the merge can separate
 * the two — the fork has one clientID, and the agent's apply, their typing and
 * the rewrite interleave in one clock — so the fork is DROPPED like any other
 * and the difference between the page it was made from and the page they leave
 * is written again here.
 *
 * Only what differs is touched, and each block through its own call, so
 * y-prosemirror writes the characters that changed and nothing else (its text
 * update is a common-ends diff): every Yjs item the shared doc already has, and
 * every entry naming one, is left standing. Blocks nobody in the fork touched
 * are not written at all, which is what leaves a collaborator's work alone.
 *
 * One transaction, ON the history: the words they typed during a review are a
 * ⌘Z of their own, exactly as they are when the answer keeps something (see
 * `KEPT_CHANGE` in fork.ts). Off it, a deletion they made in the fork would
 * leave the entries naming what they deleted dead — the same bug, narrower.
 */
export function replayOwnEdits(editor: LiveEditor, birth: AnyBlock[], theirs: AnyBlock[]) {
  const was = new Map(descend(birth).map((b) => [b.id, b]));
  const now = new Map(descend(theirs).map((b) => [b.id, b]));
  const place = seats(theirs);
  const present = (id: string) => !!editor.getBlock(id);
  const where: Where = { present, last: () => lastBlock(editor, present) };

  asReview(() =>
    editor.transact(() => {
      // Gone first: a block they took off the page takes its subtree with it,
      // and what survived that deletion elsewhere is put back below.
      for (const id of was.keys()) {
        if (!now.has(id) && present(id)) editor.removeBlocks([id]);
      }

      // Then everything their page has that this one does not, outermost
      // first and in their order — a block they wrote, or one they lifted out
      // of something they deleted. Each anchors on the one placed before it.
      const placed = new Set<string>();
      for (const block of descend(theirs)) {
        if (present(block.id)) continue;
        if ((place.get(block.id)?.ancestors ?? []).some((a) => placed.has(a))) continue;
        const anchor = anchorFor(block.id, place, where);
        if (!anchor) continue;
        put(editor, block, anchor);
        placed.add(block.id);
      }

      for (const [id, block] of now) {
        const before = was.get(id);
        if (!before || !present(id) || unchanged(before, block)) continue;
        editor.updateBlock(id, {
          type: block.type,
          props: block.props,
          ...(block.content !== undefined ? { content: block.content } : {}),
        } as AnyPartialBlock);
      }
    }),
  );
}

/**
 * Whether {@link replayOwnEdits} can carry everything a fork holds.
 *
 * A diagram's truth is its CRDT maps, and nothing but the merge carries those:
 * written back as the block prop the replay has, they read to the shared doc's
 * canvas as its own mirror coming round again and are ignored. The prop asked
 * about here is that mirror, which `settleDiagrams` has just brought in line
 * with the maps, so it answers for them. A page whose diagram moved inside the
 * fork therefore lands whole, as it always did — the undo history is the price,
 * and it is the smaller loss of the two.
 */
export function replayable(birth: AnyBlock[], theirs: AnyBlock[]): boolean {
  const diagrams = (blocks: AnyBlock[]) =>
    new Map(
      descend(blocks)
        .filter((b) => b.type === "canvas")
        .map((b) => [b.id, JSON.stringify(b.props)] as const),
    );
  const was = diagrams(birth);
  const now = diagrams(theirs);
  return (
    was.size === now.size && [...now].every(([id, props]) => was.get(id) === props)
  );
}

/** A block as this comparison cares about it: its own words, type and props. */
function unchanged(a: AnyBlock, b: AnyBlock): boolean {
  return (
    a.type === b.type &&
    JSON.stringify(a.props) === JSON.stringify(b.props) &&
    JSON.stringify(a.content ?? null) === JSON.stringify(b.content ?? null)
  );
}

function put(editor: LiveEditor, block: AnyBlock, anchor: Anchor) {
  if (anchor.placement !== "in") {
    editor.insertBlocks([block as AnyPartialBlock], anchor.ref, anchor.placement);
    return;
  }
  // `insertBlocks` only ever makes a sibling, and nesting is the whole point of
  // this anchor, so the container is rewritten with the block back among its
  // children.
  const parent = editor.getBlock(anchor.ref);
  if (!parent) return;
  const children = (parent.children ?? []) as AnyBlock[];
  const at = Math.min(anchor.at, children.length);
  editor.updateBlock(anchor.ref, {
    children: [...children.slice(0, at), block, ...children.slice(at)],
  } as AnyPartialBlock);
}

/** The last block the editor can still address, for a change with no survivors. */
function lastBlock(editor: LiveEditor, present: (id: string) => boolean): Anchor | null {
  const document = editor.document;
  for (let i = document.length - 1; i >= 0; i--) {
    const id = document[i].id as string;
    if (present(id)) return { ref: id, placement: "after" };
  }
  return null;
}

/**
 * An id for the paragraph BlockNote keeps in an emptied document. The schema
 * makes that one, not an edit, so it has no id — and every way of writing a
 * block names one, which leaves an undo of "delete the whole page" with nowhere
 * to put the page back. Removed again once something real is beside it.
 */
function nameEmptyBlock(tr: Transaction): string | null {
  let named: string | null = null;
  tr.doc.descendants((node, pos) => {
    if (named) return false;
    const attrs = node.type.spec.attrs;
    if (!attrs || !("id" in attrs) || node.attrs.id) return true;
    named = `nt-restore-${crypto.randomUUID()}`;
    tr.setNodeAttribute(pos, "id", named);
    return false;
  });
  return named;
}

/** The outermost descendants of a block that the change did not write. */
function foreign(block: AnyBlock, added: ReadonlySet<string>): AnyBlock[] {
  return (block.children ?? []).flatMap((child) =>
    added.has(child.id) ? foreign(child, added) : [child],
  );
}

export type Anchor =
  | { ref: string; placement: "before" | "after" }
  | { ref: string; placement: "in"; at: number };

/**
 * The live document, as far as placing a block back in it needs to know.
 *
 * `last` is not a detail: a change that consumed every block at a level — four
 * paragraphs folded into one table on a page holding nothing else — leaves no
 * sibling and no ancestor to place against, and that is the case this whole
 * pipeline is written around. Answering `null` there once meant the undo fell
 * back to the end of the page while the decoration drew nothing at all, so the
 * user judged a replace with only the green side of it on screen.
 */
export type Where = {
  /** Whether a block is on the page AND standing where the checkpoint left it. */
  present: (id: string) => boolean;
  /** Where a block with no surviving neighbourhood goes. */
  last: () => Anchor | null;
};

/**
 * Where a displaced block belongs: beside the nearest sibling still on the
 * page, else back inside whatever contained it, else wherever `last` says.
 *
 * Inside rather than after the container, because `after` it is a level too
 * shallow — an outline one indent flatter than it was is a change nobody asked
 * for, and there is no undo spanning it.
 *
 * Shared with the review decorations, so the facsimile of a deleted block is
 * drawn in the place discarding the change would put it back. One function
 * because that has to be one answer.
 */
export function anchorFor(
  id: string,
  place: Map<string, Seat>,
  where: Where,
): Anchor | null {
  const seat = place.get(id);
  if (!seat) return null;
  for (let k = seat.at - 1; k >= 0; k--) {
    if (where.present(seat.siblings[k])) {
      return { ref: seat.siblings[k], placement: "after" };
    }
  }
  for (let k = seat.at + 1; k < seat.siblings.length; k++) {
    if (where.present(seat.siblings[k])) {
      return { ref: seat.siblings[k], placement: "before" };
    }
  }
  for (const ancestor of [...seat.ancestors].reverse()) {
    if (where.present(ancestor)) return { ref: ancestor, placement: "in", at: seat.at };
  }
  return where.last();
}

export function seats(blocks: AnyBlock[]): Map<string, Seat> {
  const out = new Map<string, Seat>();
  let index = 0;
  const walk = (level: AnyBlock[], ancestors: string[]) => {
    const siblings = level.map((b) => b.id);
    level.forEach((block, at) => {
      out.set(block.id, { index: index++, siblings, at, ancestors });
      if (block.children?.length) walk(block.children, [...ancestors, block.id]);
    });
  };
  walk(blocks, []);
  return out;
}

function descend(blocks: AnyBlock[]): AnyBlock[] {
  return blocks.flatMap((b) => [b, ...descend(b.children ?? [])]);
}
