"use client";

import { BlockNoteEditor, docToBlocks } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { Step } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import * as Y from "yjs";
import { readerSchema } from "./readerSchema";
import type { AnyBlock } from "./projection";

/**
 * A stored page, back as BlockNote blocks — from either pipeline.
 *
 * Both storage formats are ProseMirror-shaped but neither speaks BlockNote
 * blocks, which is what every AI path — projection, serialization, the
 * applier — reads and writes. A headless editor is what bridges them: it is
 * never mounted and holds no document, it exists only for its schema, which
 * the converters read node structure against. That is why the schema it holds
 * is `readerSchema` — the editor's shape without the editor's views.
 *
 * Built once per session. Constructing it means constructing the whole
 * schema, and reading five pages in one turn should not do that five times.
 */
let headless: BlockNoteEditor<
  (typeof readerSchema)["blockSchema"],
  (typeof readerSchema)["inlineContentSchema"],
  (typeof readerSchema)["styleSchema"]
> | null = null;

function headlessEditor() {
  headless ??= BlockNoteEditor.create({ schema: readerSchema });
  return headless;
}

/**
 * The legacy pipeline's document as a ProseMirror node: the snapshot, plus
 * the steps recorded since it — replaying them is what makes this the
 * document rather than an older copy of it, because a snapshot on its own is
 * only as current as the last debounce that happened to fire.
 */
export function nodeFromSnapshot(content: string, steps: string[] = []): Node {
  const { pmSchema } = headlessEditor();
  let doc = pmSchema.nodeFromJSON(JSON.parse(content));
  for (const step of steps) {
    const applied = Step.fromJSON(pmSchema, JSON.parse(step)).apply(doc);
    // A step that will not apply means the base is not the one it was recorded
    // against, and every step after it is written against that same base.
    if (!applied.doc) break;
    doc = applied.doc;
  }
  return doc;
}

export function blocksFromSnapshot(content: string, steps: string[] = []): AnyBlock[] {
  return docToBlocks(nodeFromSnapshot(content, steps)) as unknown as AnyBlock[];
}

/**
 * A Yjs document held open across reads.
 *
 * Application is commutative and idempotent, so a reader only ever has to be
 * handed what it has not seen — which is what lets a long-lived surface (a
 * thumbnail watching a page someone else is editing) pay for the edits rather
 * than for the document, every time.
 */
export function yReader() {
  const doc = new Y.Doc();
  return {
    apply(updates: readonly Uint8Array[]) {
      for (const update of updates) Y.applyUpdate(doc, update);
    },
    blocks(): AnyBlock[] {
      return yXmlFragmentToBlocks(
        headlessEditor(),
        doc.getXmlFragment("prosemirror"),
      ) as unknown as AnyBlock[];
    },
    destroy() {
      doc.destroy();
    },
  };
}

export type YReader = ReturnType<typeof yReader>;

/**
 * The Yjs pipeline's document as blocks: snapshot chunks and log updates in
 * any mix, in any order — for a caller that reads once and is done.
 */
export function blocksFromYUpdates(updates: ArrayBuffer[]): AnyBlock[] {
  const reader = yReader();
  reader.apply(updates.map((update) => new Uint8Array(update)));
  const blocks = reader.blocks();
  reader.destroy();
  return blocks;
}
