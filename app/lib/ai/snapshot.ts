"use client";

import { BlockNoteEditor, docToBlocks } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { Step } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import * as Y from "yjs";
import { schema } from "@/app/components/editor/schema";
import type { AnyBlock } from "./projection";

/**
 * A stored page, back as BlockNote blocks — from either pipeline.
 *
 * Both storage formats are ProseMirror-shaped but neither speaks BlockNote
 * blocks, which is what every AI path — projection, serialization, the
 * applier — reads and writes. A headless editor is what bridges them: it is
 * never mounted and holds no document, it exists only for its schema, which
 * the converters read node structure against.
 *
 * Built once per session. Constructing it means constructing the whole
 * schema, and reading five pages in one turn should not do that five times.
 */
let headless: BlockNoteEditor<
  (typeof schema)["blockSchema"],
  (typeof schema)["inlineContentSchema"],
  (typeof schema)["styleSchema"]
> | null = null;

function headlessEditor() {
  headless ??= BlockNoteEditor.create({ schema });
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
 * The Yjs pipeline's document as blocks: snapshot chunks and log updates in
 * any mix, in any order — application is commutative, so the caller only has
 * to hand over everything it fetched.
 */
export function blocksFromYUpdates(updates: ArrayBuffer[]): AnyBlock[] {
  const doc = new Y.Doc();
  for (const update of updates) {
    Y.applyUpdate(doc, new Uint8Array(update));
  }
  const blocks = yXmlFragmentToBlocks(
    headlessEditor(),
    doc.getXmlFragment("prosemirror"),
  ) as unknown as AnyBlock[];
  doc.destroy();
  return blocks;
}
