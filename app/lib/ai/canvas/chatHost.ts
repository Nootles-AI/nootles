"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { loadIconCatalog } from "@/app/components/editor/canvas/icons/registry";
import { peekSceneStore, sceneStoreKey } from "@/app/components/editor/canvas/engine/useScene";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { Batch } from "@/convex/ai/operations";
import { findBlock } from "../html/serialize";
import { fetchPage, notApplied, storedBlocks, type ToolContext } from "../chat/clientTools";
import { retryableMutationResult } from "../chat/mutationResult";
import { project, type AnyBlock } from "../projection";
import { resolveBatch, warnRejected } from "../validate";
import { refused, type CanvasHost, type CanvasRead, type Refusal, type WriteReceipt } from "./host";

/**
 * `toCanvasHost(ctx)` — the only file in `app/lib/ai/canvas/` that touches an
 * editor, a review session, or Convex. Every other file in this directory is
 * pure: a `Scene` in, a plan out. This is the seam where a plan becomes a
 * real, reviewable change — see `host.ts`'s module doc for why the interface
 * is shaped the way it is.
 */

/** `"<storyboard-id>:<n>"` — a shot's own address, which none of the 13
 *  tools can act on today (TOOLS.md §4.2/§0.3). */
const SHOT_ADDRESS = /^(.+):(\d+)$/;

/** `null`/`Refusal`/a real read, from a document already in hand plus the
 *  block's live store when there is one — shared by both the open-page and
 *  closed-page branches of `readScene` below. */
function readFrom(
  blocks: AnyBlock[],
  blockId: string,
  pageId: string,
): CanvasRead | Refusal | null {
  const index = project(blocks).index;
  const m = SHOT_ADDRESS.exec(blockId);
  if (m && index.blocks.get(m[1])?.type === "storyboard") {
    return refused(
      `The "${blockId}" address is a storyboard shot; shots are rewritten whole through edit_page for now.`,
    );
  }
  const entry = index.blocks.get(blockId);
  if (entry === undefined || entry.type !== "canvas") return null;
  const block = findBlock(blocks, blockId);
  if (!block) return null;
  const scene =
    peekSceneStore(sceneStoreKey(blockId))?.getScene() ??
    migrateLegacyCanvas(String(block.props.data ?? ""));
  return { pageId, blockId, scene };
}

export function toCanvasHost(ctx: ToolContext): CanvasHost {
  return {
    async readScene(blockId, pageId) {
      const resolvedPageId = pageId ?? ctx.openPageId();
      if (!resolvedPageId) {
        throw new Error("No page is open. Call list_pages, then open_page.");
      }
      if (resolvedPageId === ctx.openPageId()) {
        const editor = await ctx.editorFor(resolvedPageId as Id<"pages">);
        const document = editor.document as unknown as AnyBlock[];
        return readFrom(document, blockId, resolvedPageId);
      }
      const page = await fetchPage(ctx, resolvedPageId as Id<"pages">);
      const blocks = await storedBlocks(ctx, page.docId);
      return readFrom(blocks, blockId, resolvedPageId);
    },

    async writeScene(read, next): Promise<WriteReceipt | Refusal> {
      const pageId = read.pageId as Id<"pages">;
      ctx.openPage(pageId);
      const editor = await ctx.editorFor(pageId);
      const data = serializeScene(next);
      if (data === serializeScene(read.scene)) {
        return { added: 0, removed: 0, changed: 0, hunks: 0 };
      }
      const document = editor.document as unknown as AnyBlock[];
      const index = project(document).index;
      const batch: Batch = {
        ops: [{ kind: "updateBlockProps", blockId: read.blockId, props: { data } }],
      };
      const resolved = resolveBatch(batch, index);
      if (!resolved.ok) {
        warnRejected("canvas-tool", resolved);
        return refused(notApplied(resolved.errors, index));
      }
      try {
        return await ctx.review.stage({ pageId, editor, batch: resolved.batch });
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[canvas-tool] stage failed\n  ", error);
        }
        return refused(
          retryableMutationResult(
            "The change could not be applied just now — nothing on the diagram changed, and",
            "this was not a problem with what you sent. Call the same tool once more with the",
            "SAME arguments.",
          ),
        );
      }
    },

    async prepareParse() {
      await loadIconCatalog();
    },
  };
}
