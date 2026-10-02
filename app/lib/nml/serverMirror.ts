import { BlockNoteEditor } from "@blocknote/core";
import type * as Y from "yjs";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import type { LegacyBlock } from "./legacy";
import type { NmlDocument } from "./schema";
import { fragmentCanvasData, mapsHoldCanvas, withCanvasData, writeCanvasMaps } from "./canvasMaps";
import { NML_LEGACY_MIRROR_ORIGIN } from "./mirror";
import { blockNoteNmlMirrorHost } from "./mirrorBlockNote";
import { nmlToAnyBlocks } from "./model/projection";
import { decodeNmlDocument } from "./yjs";

/**
 * The compatibility mirror's NML → `prosemirror` half, for a write made with no
 * browser open: the same projection `NmlLegacyMirror.writeLegacyProjection`
 * makes, through the same BlockNote adapter, over the headless reader schema.
 *
 * A server-side canonical write (an MCP edit, its undo) calls this inside the
 * update it appends, so the compatibility root is never stale — a stale client,
 * a rollback, or a reader of the legacy root sees the agent's edit at once —
 * and every open client's own mirror, receiving both roots in one transaction,
 * finds its projection already in place and writes nothing, rather than N open
 * tabs each rewriting the fragment for the same change.
 *
 * A diagram the write changed (`before` is the document it was made against)
 * goes into its maps too, and its prop becomes their stamped mirror; any other
 * diagram the maps hold keeps the mirror its binding last wrote (NT-129).
 *
 * Needs a `document` global (linkedom on the server), as the adapter's test does.
 */

let editor: BlockNoteEditor | null = null;

function headless(): BlockNoteEditor {
  editor ??= BlockNoteEditor.create({ schema: readerSchema }) as unknown as BlockNoteEditor;
  return editor;
}

export function writeCompatibilityRoot(
  doc: Y.Doc,
  before: NmlDocument,
  resolveStorageUrl?: (storageId: string) => string | undefined,
): void {
  const after = decodeNmlDocument(doc);
  const held = fragmentCanvasData(doc.getXmlFragment("prosemirror"));
  doc.transact(() => {
    const changed = writeCanvasMaps(doc, before, after);
    const blocks = withCanvasData(
      nmlToAnyBlocks(after, { resolveStorageUrl }) as LegacyBlock[],
      (id) => changed.get(id) ?? (mapsHoldCanvas(doc, id) ? held.get(id) : undefined),
    );
    blockNoteNmlMirrorHost(headless() as never, doc).writeBlocks(blocks, NML_LEGACY_MIRROR_ORIGIN);
  }, NML_LEGACY_MIRROR_ORIGIN);
}
