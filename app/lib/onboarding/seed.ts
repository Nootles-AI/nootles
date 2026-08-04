"use client";

import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "@/app/components/editor/schema";
import type { SeedBlock } from "./types";

/**
 * Template blocks as the ProseMirror JSON `prosemirror-sync` stores.
 *
 * Done by standing up a headless editor on the blocks and reading its state
 * back, rather than converting block by block. BlockNote wraps blocks in
 * container nodes of its own, and that wrapping is an implementation detail
 * that has changed between versions — asking the editor to build the document
 * means we never encode a guess about it.
 *
 * Browser-only, because the schema carries the custom blocks and those are
 * React components. First run is a browser flow, so this costs nothing; the
 * seeded JSON travels to Convex as data.
 */
export function docFromBlocks(blocks: SeedBlock[]): object {
  const editor = BlockNoteEditor.create({ schema, initialContent: blocks });
  return editor.prosemirrorState.doc.toJSON();
}
