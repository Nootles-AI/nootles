import type { PartialBlock } from "@blocknote/core";
import type { Transaction } from "prosemirror-state";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import type { AnyBlock } from "../projection";
import { asReview } from "./attribution";
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

export function undoHunks(editor: LiveEditor, hunks: Change[], before: AnyBlock[]) {
  const place = seats(before);
  const was = new Map(descend(before).map((b) => [b.id, b]));
  const present = (id: string) => !!editor.getBlock(id);

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
          props: original.props,
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

/** Restores the page to the checkpoint wholesale, manual edits and all. */
export function restoreDocument(editor: LiveEditor, before: AnyBlock[]) {
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
