"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { requireOwner } from "../auth";
import { withToken } from "./account";
import { pacer, type Paced } from "./pacing";
import { json } from "./rest";

/**
 * Reading a Notion workspace: the page tree first, then one page's blocks.
 *
 * Split in two because the wizard needs the tree long before it needs any
 * content — you pick what to import from a list, and only then is it worth
 * spending a few hundred requests walking those pages. Notion pages children a
 * hundred at a time and rate limits at roughly three requests a second, so a
 * large page is minutes of wall clock; keeping the tree cheap is what makes the
 * picker feel instant.
 */

/** A page nested deeper than this is pathological; NML flattens past 4 anyway. */
const MAX_BLOCK_DEPTH = 12;

type NotionParent =
  | { type: "workspace"; workspace: true }
  | { type: "page_id"; page_id: string }
  | { type: "database_id"; database_id: string }
  | { type: "block_id"; block_id: string };

type SearchPage = {
  id: string;
  object: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: NotionParent;
  icon?: { type: string; emoji?: string } | null;
  properties?: Record<string, unknown>;
};

export type PageNode = {
  id: string;
  title: string;
  emoji?: string;
  hasFileIcon?: boolean;
  children: PageNode[];
};

/**
 * Every page this connection was granted, as a tree.
 *
 * What comes back is exactly what the user ticked in Notion's consent picker
 * and nothing else — which is why the wizard has to offer a way back to Notion
 * to grant more, rather than treating a short list as an error.
 */
export const listPages = action({
  args: {},
  handler: async (ctx): Promise<PageNode[]> => {
    const ownerId = await requireOwner(ctx);
    const paced = pacer(ctx, ownerId);
    return await withToken(ctx, ownerId, async (token) => {
      const pages: SearchPage[] = [];
      let cursor: string | undefined;
      do {
        const body: Record<string, unknown> = {
          filter: { property: "object", value: "page" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        };
        const page = await paced(() =>
          json<{ results: SearchPage[]; next_cursor: string | null; has_more: boolean }>(
            token,
            "/search",
            { method: "POST", body },
          ),
        );
        if (!page) break;
        pages.push(...page.results);
        cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor);

      return treeOf(pages.filter((page) => !page.archived && !page.in_trash));
    });
  },
});

/**
 * One page's blocks, children walked in place.
 *
 * The converter takes a tree; Notion serves a list per parent. Assembling it
 * here keeps `app/lib/notion/convert.ts` pure and testable, which is where the
 * decisions that are hard to get right actually live.
 */
export const fetchBlocks = action({
  args: { pageId: v.string() },
  handler: async (ctx, args): Promise<unknown[]> => {
    const ownerId = await requireOwner(ctx);
    const paced = pacer(ctx, ownerId);
    return await withToken(ctx, ownerId, (token) => children(paced, token, args.pageId, 0));
  },
});

type Block = { id: string; type: string; has_children?: boolean; children?: Block[] };

/** As much of a page as a thumbnail shows above its crop. */
const OPENING_BLOCKS = 30;
/** Requests one preview may take from the connection's queue, the first included. */
const OPENING_REQUESTS = 4;
/**
 * The blocks that are nothing without their children: a table's rows are its
 * children, and a column's content is. A list item or a toggle draws as
 * itself, so its children are not worth a turn in the queue.
 */
const HOLLOW = new Set(["table", "column_list", "column", "synced_block"]);

/**
 * The opening of a page, for a picture of it before it is imported.
 *
 * `fetchBlocks` reads a page to the end, which is minutes on a large one and
 * every turn of it taken from the queue an import is waiting in. A preview
 * wants the first screenful and wants it now, so this reads one short list and
 * then spends what is left of a small, fixed number of requests filling in the
 * blocks that would otherwise draw empty. The shape is `fetchBlocks`'s own, so
 * the same converter reads it.
 */
export const fetchOpening = action({
  args: { pageId: v.string() },
  handler: async (ctx, args): Promise<unknown[]> => {
    const ownerId = await requireOwner(ctx);
    const paced = pacer(ctx, ownerId);
    return await withToken(ctx, ownerId, async (token) => {
      let left = OPENING_REQUESTS;
      const read = async (blockId: string): Promise<Block[]> => {
        if (left <= 0) return [];
        left--;
        const page = await paced(() =>
          json<{ results: Block[] }>(token, `/blocks/${blockId}/children`, {
            query: { page_size: OPENING_BLOCKS },
          }),
        );
        return page?.results ?? [];
      };
      const fill = async (blocks: Block[], depth: number) => {
        for (const block of blocks) {
          if (!block.has_children || !HOLLOW.has(block.type) || depth >= 3) continue;
          block.children = await read(block.id);
          await fill(block.children, depth + 1);
        }
      };
      const blocks = await read(args.pageId);
      await fill(blocks, 1);
      return blocks;
    });
  },
});

async function children(paced: Paced, token: string, blockId: string, depth: number): Promise<Block[]> {
  if (depth >= MAX_BLOCK_DEPTH) return [];
  const out: Block[] = [];
  let cursor: string | undefined;
  do {
    const page = await paced(() =>
      json<{ results: Block[]; next_cursor: string | null; has_more: boolean }>(
        token,
        `/blocks/${blockId}/children`,
        { query: { page_size: 100, start_cursor: cursor } },
      ),
    );
    if (!page) break;
    for (const block of page.results) {
      // A child page is a page in its own right — its content belongs to the
      // page it becomes, not inlined into its parent. The converter only needs
      // to know it was there in order to link to it.
      if (block.has_children && block.type !== "child_page") {
        block.children = await children(paced, token, block.id, depth + 1);
      }
      out.push(block);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** The title property, whatever the workspace happens to have called it. */
function titleOf(page: SearchPage): string {
  for (const value of Object.values(page.properties ?? {})) {
    if (typeof value !== "object" || value === null) continue;
    const property = value as { type?: string; title?: { plain_text?: string }[] };
    if (property.type === "title" && Array.isArray(property.title)) {
      const text = property.title.map((run) => run.plain_text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "Untitled";
}

/**
 * Notion's flat search result as a forest.
 *
 * A page whose parent was not granted becomes a root here rather than being
 * dropped: it is reachable, so it is importable, and hiding it because its
 * parent is invisible would be the picker lying about what was shared.
 */
function treeOf(pages: SearchPage[]): PageNode[] {
  const nodes = new Map<string, PageNode>();
  for (const page of pages) {
    const emoji = page.icon?.type === "emoji" ? page.icon.emoji : undefined;
    nodes.set(page.id, {
      id: page.id,
      title: titleOf(page),
      ...(emoji ? { emoji } : {}),
      ...(page.icon && page.icon.type !== "emoji" ? { hasFileIcon: true } : {}),
      children: [],
    });
  }
  const roots: PageNode[] = [];
  for (const page of pages) {
    const node = nodes.get(page.id)!;
    const parentId = page.parent?.type === "page_id" ? page.parent.page_id : undefined;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: PageNode[]) => {
    list.sort((a, b) => a.title.localeCompare(b.title));
    list.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}
