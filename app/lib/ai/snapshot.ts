"use client";

import { BlockNoteEditor, docToBlocks } from "@blocknote/core";
import { Step } from "prosemirror-transform";
import { schema } from "@/app/components/editor/schema";
import type { AnyBlock } from "./projection";

/**
 * A stored page, back as BlockNote blocks.
 *
 * prosemirror-sync persists a page as ProseMirror JSON, but every AI path —
 * projection, serialization, the applier — speaks BlockNote blocks. A headless
 * editor is what bridges them: it is never mounted and holds no document, it
 * exists only for its `pmSchema`, which carries the BlockNote schema that
 * `docToBlocks` reads back off the node it is handed.
 *
 * Built once per session. Constructing it means constructing the whole schema,
 * and reading five pages in one turn should not do that five times.
 */
let headless: BlockNoteEditor<
  (typeof schema)["blockSchema"],
  (typeof schema)["inlineContentSchema"],
  (typeof schema)["styleSchema"]
> | null = null;

/**
 * `steps` are the edits recorded since that snapshot was written, as
 * `getSteps` returns them. Replaying them is what makes this the document
 * rather than an older copy of it — prosemirror-sync's own reader does the
 * same, because a snapshot on its own is only as current as the last debounce
 * that happened to fire.
 */
export function blocksFromSnapshot(content: string, steps: string[] = []): AnyBlock[] {
  headless ??= BlockNoteEditor.create({ schema });
  const { pmSchema } = headless;

  let doc = pmSchema.nodeFromJSON(JSON.parse(content));
  for (const step of steps) {
    const applied = Step.fromJSON(pmSchema, JSON.parse(step)).apply(doc);
    // A step that will not apply means the base is not the one it was recorded
    // against, and every step after it is written against that same base.
    if (!applied.doc) break;
    doc = applied.doc;
  }

  return docToBlocks(doc) as unknown as AnyBlock[];
}
