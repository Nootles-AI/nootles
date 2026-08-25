"use client";

import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "@/app/components/editor/schema";
import { yUpdateFrom } from "@/app/lib/sync/migrate";
import type { SeedBlock } from "./types";

/**
 * Template blocks as the Yjs update a seeded page's document is born from.
 *
 * Done by standing up a headless editor on the blocks and reading its state
 * back, rather than converting block by block. BlockNote wraps blocks in
 * container nodes of its own, and that wrapping is an implementation detail
 * that has changed between versions — asking the editor to build the document
 * means we never encode a guess about it.
 *
 * Converted here rather than served as ProseMirror JSON, because the pipeline
 * a document is born on is the one it stays on: seeding the legacy side would
 * make every new account's first open pay a migration before it can read.
 *
 * Browser-only, because the schema carries the custom blocks and those are
 * React components. First run is a browser flow, so this costs nothing.
 */
export function seedUpdate(blocks: SeedBlock[]): ArrayBuffer {
  const editor = BlockNoteEditor.create({ schema, initialContent: blocks });
  return yUpdateFrom(editor.prosemirrorState.doc);
}
