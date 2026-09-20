"use client";

import { useEffect, useReducer } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import { convertPage, type NotionBlock } from "@/app/lib/notion";
import { toBlockNote } from "@/app/lib/notion/toBlockNote";
import type { AnyBlock } from "@/app/lib/ai/projection";

/**
 * How long the highlight has to rest on a page before its opening is read.
 * Arrowing down a list passes over rows nobody is looking at, and each read is
 * a turn taken from the queue an import will want.
 */
const REST_MS = 220;

/**
 * Openings already read, for as long as the tab lives. `null` is a page that
 * could not be read, remembered so that passing over it again does not ask
 * again. Notion's file links in here die within the hour, which outlasts any
 * sitting with the picker.
 */
const read = new Map<string, readonly AnyBlock[] | null>();

/**
 * The opening of a Notion page as the blocks it would import as, for a picture
 * of it before it is chosen. `undefined` while it is being read, `null` if it
 * could not be.
 *
 * It goes through the import's own converter, so the picture is of the page
 * Nootles would make — a database shows as the stub it becomes — and not of
 * the page Notion has.
 */
export function useOpening(pageId: string | null): readonly AnyBlock[] | null | undefined {
  const convex = useConvex();
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!pageId || read.has(pageId)) return;
    let live = true;
    const timer = setTimeout(async () => {
      let blocks: readonly AnyBlock[] | null = null;
      try {
        const raw = (await convex.action(api.notion.pages.fetchOpening, { pageId })) as NotionBlock[];
        blocks = picture(pageId, raw);
      } catch {
        // Left null: the pane says less, and the list is unaffected.
      }
      read.set(pageId, blocks);
      if (live) redraw();
    }, REST_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [convex, pageId]);

  return pageId ? read.get(pageId) : null;
}

function picture(pageId: string, raw: NotionBlock[]): AnyBlock[] {
  const converted = convertPage(pageId, raw);
  // Notion's own links, used as they are: good for an hour, and the picture is
  // on screen for seconds. The import copies the files; a preview need not.
  const media = new Map(converted.assets.map((asset) => [asset.blockId, asset.url]));
  const stubs = new Map(
    converted.ledger.filter((e) => e.reason === "stubbed").map((e) => [e.blockId, e]),
  );
  return named(toBlockNote(converted.blocks, media, stubs), pageId);
}

/** The renderer keys on ids, and blocks bound for a new document have none yet. */
function named(blocks: AnyBlock[], prefix: string): AnyBlock[] {
  return blocks.map((block, i) => {
    const id = `${prefix}.${i}`;
    return { ...block, id, props: block.props ?? {}, children: named(block.children ?? [], id) };
  });
}
